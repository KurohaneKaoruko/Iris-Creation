//! 本地服务端：以 HTTP/WS 暴露与 Tauri 命令等价的 API。
//!
//! 设计要点：
//! - `POST /api/rpc/{command}`：与 Tauri invoke 等价的统一 RPC 端点，
//!   请求体为命令参数的 JSON 对象，返回 `{"ok": result}` 或 `{"err": message}`。
//! - `/ws`：WebSocket 事件通道，转发 EventSink 上的全部流式事件；
//!   客户端可发送 `{"type":"cancel","streamId":...}` 取消流任务。
//! - 静态托管前端构建产物（默认 `../webui/dist`）。
//! - 默认绑定 `127.0.0.1`，端口可配置；来源校验（Host/Origin）防 DNS rebinding。

use crate::event_sink::{BroadcastEventSink, SharedEventSink};
use crate::state::AppState;
use axum::{
  body::Body,
  extract::{DefaultBodyLimit, Path, State, WebSocketUpgrade},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Response},
  routing::{get, post},
  Router,
};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub struct ServerConfig {
  pub host: String,
  pub port: u16,
  pub static_dir: Option<PathBuf>,
  pub data_dir: Option<PathBuf>,
}

impl Default for ServerConfig {
  fn default() -> Self {
    Self {
      host: "127.0.0.1".to_string(),
      port: 8765,
      static_dir: None,
      data_dir: None,
    }
  }
}

#[derive(Clone)]
pub struct ServerContext {
  pub app_state: Arc<AppState>,
  pub event_sink: SharedEventSink,
  pub broadcast: BroadcastEventSink,
}

async fn prepare(config: ServerConfig) -> Result<(tokio::net::TcpListener, Router), String> {
  if let Some(dir) = &config.data_dir {
    crate::app_data::set_storage_root_override(dir.clone());
  }

  let addr: SocketAddr = format!("{}:{}", config.host, config.port)
    .parse()
    .map_err(|e| format!("invalid bind address: {e}"))?;

  let dist_dir = config
    .static_dir
    .clone()
    .or_else(|| {
      std::env::var("IRIS_CREATION_STATIC_DIR")
        .ok()
        .map(PathBuf::from)
    })
    .unwrap_or_else(|| PathBuf::from("../webui/dist"));

  let index_file = dist_dir.join("index.html");
  if config.static_dir.is_some() && !index_file.is_file() {
    return Err(format!(
      "frontend index.html not found: {}",
      index_file.display()
    ));
  }
  // 先解析静态资源并 bind；端口冲突不能污染进程级 OnceLock 事件总线。
  let listener = tokio::net::TcpListener::bind(addr)
    .await
    .map_err(|e| format!("bind {addr} failed: {e}"))?;

  let broadcast = BroadcastEventSink::new(256);
  crate::event_sink::global::init(Arc::new(broadcast.clone()));
  let ctx = ServerContext {
    app_state: Arc::new(AppState::default()),
    event_sink: Arc::new(broadcast.clone()),
    broadcast,
  };
  let serve_frontend = tower_http::services::ServeDir::new(&dist_dir)
    // 用 fallback（而非 not_found_service）：后者会把响应状态强制覆盖为 404，
    // SPA 路由需要 200 + index.html。缓存头由下方 Router 中间件统一附加。
    .fallback(tower::service_fn(
      move |req: axum::http::Request<axum::body::Body>| {
        // SPA fallback：非 API/WS 路径全部回退到 index.html
        let index = index_file.clone();
        let path = req.uri().path();
        let is_api = path.starts_with("/api/") || path == "/ws";
        let is_asset = path.starts_with("/assets/")
          || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'));
        async move {
          if is_api || is_asset {
            return Ok::<_, std::convert::Infallible>(
              axum::http::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(axum::body::Body::from("not found"))
                .unwrap(),
            );
          }
          match tokio::fs::read(&index).await {
            Ok(bytes) => Ok(
              axum::http::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/html; charset=utf-8")
                .header("cache-control", "no-cache")
                .body(axum::body::Body::from(bytes))
                .unwrap(),
            ),
            Err(_) => Ok(
              axum::http::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(axum::body::Body::from(
                  "frontend dist not built (run pnpm run build first)",
                ))
                .unwrap(),
            ),
          }
        }
      },
    ));

  let app = Router::new()
    .route("/api/health", get(health))
    .route("/api/rpc/{command}", post(rpc))
    .route("/api/creative-media/{id}", get(creative_media_file))
    .route("/ws", get(ws_upgrade))
    .fallback_service(serve_frontend)
    // A PNG compressed to JSON/base64 expands by about one third; media import is
    // additionally bounded and magic-checked by its RPC before any bytes are stored.
    .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
    .with_state(ctx)
    // 静态资源缓存策略：HTML/杂项快速 revalidate，带哈希的 /assets/ 长缓存
    .layer(axum::middleware::from_fn(
      |req: axum::http::Request<axum::body::Body>, next: axum::middleware::Next| async move {
        let path = req.uri().path().to_string();
        let mut res = next.run(req).await;
        if path.starts_with("/api/") || path == "/ws" {
          return Ok::<_, std::convert::Infallible>(res);
        }
        let value = if path.starts_with("/assets/") && res.status().is_success() {
          // 带内容哈希的文件名：内容变→文件名变，可安全长缓存
          axum::http::HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
          // index.html / favicon 等：浏览器每次 revalidate（配合 ETag 多为 304）
          axum::http::HeaderValue::from_static("no-cache")
        };
        res.headers_mut().insert("cache-control", value);
        Ok::<_, std::convert::Infallible>(res)
      },
    ));

  Ok((listener, app))
}

/// 绑定并启动内嵌服务，返回实际地址；桌面端用端口 0 避免与其他应用冲突。
pub async fn start(config: ServerConfig) -> Result<SocketAddr, String> {
  let (listener, app) = prepare(config).await?;
  let addr = listener
    .local_addr()
    .map_err(|e| format!("read bound address failed: {e}"))?;
  tokio::spawn(async move {
    if let Err(e) = axum::serve(listener, app).await {
      eprintln!("[iris-creation-server] server stopped: {e}");
    }
  });
  Ok(addr)
}

/// 独立服务端一直运行，直到进程退出。
pub async fn run(config: ServerConfig) -> Result<(), String> {
  let (listener, app) = prepare(config).await?;
  let addr = listener
    .local_addr()
    .map_err(|e| format!("read bound address failed: {e}"))?;
  println!("[iris-creation-server] listening on http://{addr}");
  axum::serve(listener, app)
    .await
    .map_err(|e| format!("server error: {e}"))
}

async fn health() -> impl IntoResponse {
  json!({ "ok": true, "app": "iris-creation-server" }).to_string()
}

fn error_response(status: StatusCode, message: &str) -> Response {
  Response::builder()
    .status(status)
    .header("content-type", "text/plain; charset=utf-8")
    .header("cache-control", "no-store")
    .body(Body::from(message.to_string()))
    .unwrap_or_else(|_| Body::from("内部错误").into_response())
}

/// 按任务 ID 流式返回媒体产物。只服务当前已打开作品 creative/assets/ 内经
/// 哈希/长度校验的普通文件；视频最大 128 MB，不能走 16 MiB 的 JSON RPC 通道。
/// Range 请求支持视频拖动进度条。
async fn creative_media_file(
  State(ctx): State<ServerContext>,
  Path(id): Path<String>,
  headers: HeaderMap,
) -> Response {
  use tokio::io::{AsyncReadExt, AsyncSeekExt};
  if !origin_allowed(&headers) {
    return error_response(StatusCode::FORBIDDEN, "forbidden origin");
  }
  let Ok(id) = uuid::Uuid::parse_str(&id) else {
    return error_response(StatusCode::NOT_FOUND, "素材 ID 无效");
  };
  let Ok(root) = crate::services::workspace::get_workspace_root(&ctx.app_state) else {
    return error_response(StatusCode::CONFLICT, "作品未打开");
  };
  // job 元数据与文件校验走阻塞线程池；此处不做网络请求。
  let located = tokio::task::spawn_blocking(move || crate::services::creative_media::file(&root, id))
    .await
    .unwrap_or_else(|_| Err("读取媒体文件异常退出。".to_string()));
  let Ok((path, mime)) = located else {
    return error_response(StatusCode::NOT_FOUND, "素材未就绪或已移除");
  };
  let mut file = match tokio::fs::File::open(&path).await {
    Ok(file) => file,
    Err(_) => return error_response(StatusCode::NOT_FOUND, "素材文件已丢失"),
  };
  let len = match file.metadata().await {
    Ok(meta) => meta.len(),
    Err(_) => return error_response(StatusCode::NOT_FOUND, "素材文件已丢失"),
  };
  if len == 0 { return error_response(StatusCode::NOT_FOUND, "素材文件已丢失"); }
  let (start, end) = match headers
    .get("range")
    .and_then(|value| value.to_str().ok())
    .map(|raw| parse_range(raw, len))
  {
    Some(Ok(range)) => range,
    Some(Err(())) => return error_response(StatusCode::RANGE_NOT_SATISFIABLE, "Range 无效"),
    None => (0, len.saturating_sub(1)),
  };
  if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
    return error_response(StatusCode::NOT_FOUND, "素材文件已丢失");
  }

  // remaining 必须放进 unfold 状态（而非闭包捕获）：async move 每次取的是副本，
  // u64 是 Copy，捕获的计数跨迭代不会更新。
  let remaining = end - start + 1;
  let stream = futures_util::stream::unfold((file, remaining), |(mut file, mut remaining)| async move {
    if remaining == 0 { return None; }
    let chunk_len = remaining.min(64 * 1024) as usize;
    let mut buffer = vec![0u8; chunk_len];
    match file.read_exact(&mut buffer).await {
      Ok(_) => {
        remaining -= chunk_len as u64;
        Some((Ok(axum::body::Bytes::from(buffer)), (file, remaining)))
      }
      Err(e) => Some((Err(e), (file, 0))),
    }
  });

  let mut builder = Response::builder()
    .header("content-type", mime)
    .header("accept-ranges", "bytes")
    .header("cache-control", "no-store")
    .header("content-length", end - start + 1);
  if headers.contains_key("range") {
    builder = builder
      .status(StatusCode::PARTIAL_CONTENT)
      .header("content-range", format!("bytes {start}-{end}/{len}"));
  }
  builder
    .body(Body::from_stream(stream))
    .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "内部错误"))
}

/// `bytes=start-end`（单段；end 可省略，也支持 `bytes=-N` 后缀形式）。
/// 返回闭区间 [start, end]；空文件只有 (0, 0) 一种退化情形，直接整段返回。
fn parse_range(raw: &str, len: u64) -> Result<(u64, u64), ()> {
  if len == 0 { return Err(()); }
  let Some(spec) = raw.trim().strip_prefix("bytes=") else {
    return Err(());
  };
  let Some((start_raw, end_raw)) = spec.split_once('-') else {
    return Err(());
  };
  if start_raw.is_empty() {
    let n: u64 = end_raw.parse().map_err(|_| ())?;
    if n == 0 { return Err(()); }
    return Ok((len.saturating_sub(n), len - 1));
  }
  let start: u64 = start_raw.parse().map_err(|_| ())?;
  if start >= len { return Err(()); }
  let end = if end_raw.is_empty() { len - 1 } else { end_raw.parse::<u64>().map_err(|_| ())?.min(len - 1) };
  if end < start { return Err(()); }
  Ok((start, end))
}


/// 来源校验：仅允许本机回环来源（防 DNS rebinding / 跨站访问）。
fn origin_allowed(headers: &HeaderMap) -> bool {
  fn host_is_local(host: &str) -> bool {
    // IPv6 字面量在 Host/Origin 中必带方括号（如 "[::1]:8765"），按 ] 定界取地址本体
    if let Some(rest) = host.strip_prefix('[') {
      if let Some((inner, _port)) = rest.split_once(']') {
        return inner == "::1";
      }
      return false;
    }
    let h = host.split(':').next().unwrap_or("").trim();
    h == "127.0.0.1" || h == "localhost" || h.is_empty()
  }
  fn url_host_is_local(url: &str) -> bool {
    // 从 origin URL 中取出 host 部分（scheme://host[:port]/），再按本机 host 判定
    let after_scheme = url.split("://").nth(1).unwrap_or("");
    let host = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    host_is_local(host)
  }
  // Host header 必须是本机
  if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
    if !host_is_local(host) {
      return false;
    }
  }
  // 若带 Origin，也必须是本机（精确 host 匹配，防 https://127.0.0.1.evil.com 子串绕过）
  if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
    if !url_host_is_local(origin) {
      return false;
    }
  }
  true
}

async fn rpc(
  State(ctx): State<ServerContext>,
  Path(command): Path<String>,
  headers: HeaderMap,
  body: axum::body::Bytes,
) -> impl IntoResponse {
  if !origin_allowed(&headers) {
    return (
      StatusCode::FORBIDDEN,
      json!({"error": "forbidden origin"}).to_string(),
    );
  }
  let args: Value = if body.is_empty() {
    json!({})
  } else {
    match serde_json::from_slice(&body) {
      Ok(v) => v,
      Err(e) => {
        return (
          StatusCode::BAD_REQUEST,
          json!({ "error": format!("invalid json body: {e}") }).to_string(),
        )
      }
    }
  };
  match crate::server::rpc_dispatch::dispatch(&ctx, &command, args).await {
    Ok(v) => (StatusCode::OK, json!({ "ok": v }).to_string()),
    Err(e) => (StatusCode::OK, json!({ "err": e }).to_string()),
  }
}

async fn ws_upgrade(
  State(ctx): State<ServerContext>,
  ws: WebSocketUpgrade,
  headers: HeaderMap,
) -> impl IntoResponse {
  if !origin_allowed(&headers) {
    return axum::response::Response::builder()
      .status(StatusCode::FORBIDDEN)
      .body(axum::body::Body::from("forbidden origin"))
      .unwrap();
  }
  // Subscribe before completing the handshake so a fast RPC after `onopen` cannot miss early tokens.
  let rx = ctx.broadcast.subscribe();
  ws.on_upgrade(move |socket| ws_handle(ctx, socket, rx))
}

async fn ws_handle(ctx: ServerContext, socket: axum::extract::ws::WebSocket, mut rx: tokio::sync::broadcast::Receiver<(String, Value)>) {
  use futures_util::{SinkExt, StreamExt};
  let (mut tx, mut rx_from_client) = socket.split();
  loop {
    tokio::select! {
      // 服务端事件 -> 客户端
      ev = rx.recv() => {
        match ev {
          Ok((event, payload)) => {
            let msg = json!({ "event": event, "payload": payload }).to_string();
            if tx.send(axum::extract::ws::Message::Text(msg.into())).await.is_err() {
              break;
            }
          }
          // A skipped frame could include a token or terminal error. Close rather than reporting partial text as complete.
          Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => break,
          Err(_) => break,
        }
      }
      // 客户端指令 -> 取消等
      msg = rx_from_client.next() => {
        match msg {
          Some(Ok(axum::extract::ws::Message::Text(text))) => {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
              if v["type"] == "cancel" {
                if let Some(sid) = v["streamId"].as_str() {
                  let _ = crate::services::ai_stream::cancel_stream(sid);
                  crate::event_sink::EventSink::emit(&*ctx.event_sink, "ai_stream_done", json!({ "streamId": sid, "cancelled": true }));
                }
              }
            }
          }
          Some(Ok(_)) => {}
          Some(Err(_)) | None => break,
        }
      }
    }
  }
}

#[cfg(test)]
mod media_endpoint_tests {
  use super::*;
  use axum::http::Request;
  use std::{fs, path::PathBuf};
  use tower::util::ServiceExt;

  struct TempProject {
    base: PathBuf,
    root: PathBuf,
  }

  impl TempProject {
    fn new() -> Self {
      let base = std::env::temp_dir().join(format!("iris-media-endpoint-{}", uuid::Uuid::new_v4()));
      let root = base.join("work");
      fs::create_dir_all(&root).unwrap();
      let root = fs::canonicalize(&root).unwrap();
      Self { base, root }
    }
  }

  impl Drop for TempProject {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); }
  }

  #[tokio::test]
  async fn media_endpoint_serves_ready_assets_with_ranges_and_scopes_to_workspace() {
    let project = TempProject::new();
    let ctx = super::rpc_dispatch::test_context();
    let state = ctx.app_state.clone();
    *state.workspace_root.lock().unwrap() = Some(project.root.clone());
    let router = Router::new()
      .route("/api/creative-media/{id}", get(creative_media_file))
      .with_state(ctx);

    let png = crate::services::local_assets::fixture_png();
    let job = crate::services::creative_media::import(&project.root, None, &png).unwrap();
    let url = format!("/api/creative-media/{}", crate::services::creative_media::media_id(&job));

    let full = router
      .clone()
      .oneshot(Request::get(&url).header("host", "127.0.0.1:8765").body(Body::empty()).unwrap())
      .await
      .unwrap();
    assert_eq!(full.status(), StatusCode::OK);
    assert_eq!(full.headers()["content-type"], "image/png");
    assert_eq!(full.headers()["content-length"], png.len().to_string());
    let bytes = axum::body::to_bytes(full.into_body(), 64 * 1024 * 1024).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    let partial = router
      .clone()
      .oneshot(Request::get(&url).header("host", "127.0.0.1:8765").header("range", "bytes=2-5").body(Body::empty()).unwrap())
      .await
      .unwrap();
    assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(partial.headers()["content-range"], format!("bytes 2-5/{}", png.len()));
    let slice = axum::body::to_bytes(partial.into_body(), 1024).await.unwrap();
    assert_eq!(&slice[..], &png[2..=5]);

    // 后缀 Range（视频拖动常见形式）
    let suffix = router
      .clone()
      .oneshot(Request::get(&url).header("host", "127.0.0.1:8765").header("range", "bytes=-3").body(Body::empty()).unwrap())
      .await
      .unwrap();
    assert_eq!(suffix.status(), StatusCode::PARTIAL_CONTENT);
    let tail = axum::body::to_bytes(suffix.into_body(), 1024).await.unwrap();
    assert_eq!(&tail[..], &png[png.len() - 3..]);

    // 未就绪/不存在的任务、格式错误的 ID、外来 Origin 全部拒绝。
    let missing = uuid::Uuid::new_v4();
    for (path, expect) in [(format!("/api/creative-media/{missing}"), StatusCode::NOT_FOUND), ("/api/creative-media/not-a-uuid".to_string(), StatusCode::NOT_FOUND)] {
      let response = router
        .clone()
        .oneshot(Request::get(&path).header("host", "127.0.0.1:8765").body(Body::empty()).unwrap())
        .await
        .unwrap();
      assert_eq!(response.status(), expect, "{path}");
    }
    let foreign = router
      .clone()
      .oneshot(Request::get(&url).header("host", "127.0.0.1:8765").header("origin", "https://evil.com").body(Body::empty()).unwrap())
      .await
      .unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);

    // 换工作区后旧素材不可读（素材归属原作品）。
    *state.workspace_root.lock().unwrap() = None;
    let gone = router
      .oneshot(Request::get(&url).header("host", "127.0.0.1:8765").body(Body::empty()).unwrap())
      .await
      .unwrap();
    assert_eq!(gone.status(), StatusCode::CONFLICT);
  }
}
#[cfg(test)]
mod origin_tests {
  use super::*;
  use axum::http::HeaderMap;

  fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
      map.insert(
        axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
        v.parse().unwrap(),
      );
    }
    map
  }

  #[test]
  fn range_parsing_accepts_single_ranges_and_rejects_the_rest() {
    assert_eq!(parse_range("bytes=0-0", 10).unwrap(), (0, 0));
    assert_eq!(parse_range("bytes=0-", 10).unwrap(), (0, 9));
    assert_eq!(parse_range("bytes=5-", 10).unwrap(), (5, 9));
    assert_eq!(parse_range("bytes=8-99", 10).unwrap(), (8, 9));
    assert_eq!(parse_range("bytes=-4", 10).unwrap(), (6, 9));
    assert!(parse_range("bytes=10-", 10).is_err());
    assert!(parse_range("bytes=9-8", 10).is_err());
    assert!(parse_range("bytes=-0", 10).is_err());
    assert!(parse_range("bytes=0-1,5-6", 10).is_err(), "multi-range not supported");
    assert!(parse_range("items=0-", 10).is_err());
    assert!(parse_range("bytes=0-", 0).is_err(), "empty file has no valid range");
  }

  #[test]
  fn local_origins_pass() {
    assert!(origin_allowed(&headers(&[])));
    assert!(origin_allowed(&headers(&[("host", "127.0.0.1:8765")])));
    assert!(origin_allowed(&headers(&[
      ("host", "127.0.0.1:8765"),
      ("origin", "http://127.0.0.1:1421")
    ])));
    assert!(origin_allowed(&headers(&[
      ("host", "localhost:8765"),
      ("origin", "http://localhost:1421")
    ])));
    assert!(origin_allowed(&headers(&[
      ("host", "[::1]:8765"),
      ("origin", "http://[::1]:1421")
    ])));
  }

  #[test]
  fn foreign_hosts_rejected() {
    assert!(!origin_allowed(&headers(&[("host", "evil.com")])));
    assert!(!origin_allowed(&headers(&[
      ("host", "127.0.0.1:8765"),
      ("origin", "https://evil.com")
    ])));
  }

  #[test]
  fn origin_substring_bypass_rejected() {
    // 旧实现 origin.contains("127.0.0.1") 会让以下来源通过，现必须拒绝
    assert!(!origin_allowed(&headers(&[
      ("host", "127.0.0.1:8765"),
      ("origin", "https://127.0.0.1.evil.com")
    ])));
    assert!(!origin_allowed(&headers(&[
      ("host", "localhost:8765"),
      ("origin", "http://localhost.evil.com")
    ])));
  }
}

pub mod rpc_dispatch;
