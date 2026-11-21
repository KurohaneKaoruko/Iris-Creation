//! Explicit media operations on the user's chosen provider. The browser never receives provider keys or signed download URLs.
use super::{creative::{managed_dir, read_limited, regular_file, write_atomic}, provider_client_builder};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::Duration};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub(crate) const IMPORT_LIMIT: usize = 10 * 1024 * 1024;
const RUNWAY_INPUT_LIMIT: usize = 3 * 1024 * 1024;
const IMAGE_LIMIT: usize = 24 * 1024 * 1024;
const VIDEO_LIMIT: usize = 128 * 1024 * 1024;
const RUNWAY_BASE: &str = "https://api.dev.runwayml.com";
const RUNWAY_MODEL: &str = "gen4.5";
const RUNWAY_VERSION: &str = "2024-11-06";
const IMAGE_BASE: &str = "https://api.openai.com/v1";
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
static ACTIVE: OnceLock<Mutex<HashSet<(PathBuf, Uuid)>>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct MediaSettings {
  image_base: String,
  image_model: String,
  video_base: String,
}

impl Default for MediaSettings {
  fn default() -> Self {
    Self { image_base: IMAGE_BASE.into(), image_model: String::new(), video_base: RUNWAY_BASE.into() }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSettingsView {
  settings: MediaSettings,
  image_key_configured: bool,
  video_key_configured: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMediaSettings {
  settings: MediaSettings,
  image_key: Option<String>,
  video_key: Option<String>,
}

#[derive(Copy, Clone)]
enum Channel { Image, Video }

fn is_loopback(url: &Url) -> bool {
  matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn base_url(raw: &str) -> Result<Url, String> {
  let url = Url::parse(raw.trim().trim_end_matches('/')).map_err(|_| "媒体服务地址格式无效。")?;
  if url.host_str().is_none() || !(url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url)))
    || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
    return Err("媒体服务须使用 HTTPS（本机可用 HTTP）；地址不可包含密码、查询参数或片段。".into());
  }
  Ok(url)
}

fn endpoint(base: &Url, suffix: &str) -> String { format!("{}{suffix}", base.as_str().trim_end_matches('/')) }

fn key_id(channel: Channel, base: &Url) -> String {
  let label = match channel { Channel::Image => "image", Channel::Video => "video" };
  format!("iris-creative-{label}-{}", blake3::hash(base.as_str().as_bytes()).to_hex())
}

fn get_key(channel: Channel, base: &Url) -> Result<Option<String>, String> {
  crate::secrets::get_api_key(&key_id(channel, base)).map_err(|_| "无法读取媒体服务密钥。".into())
}

fn require_key(channel: Channel, base: &Url) -> Result<String, String> {
  get_key(channel, base)?.ok_or_else(|| "请在「媒体服务」为该服务地址配置 API Key。".into())
}

fn load_settings() -> Result<MediaSettings, String> {
  let path = crate::app_data::config_file_path("creative-media.json")?;
  match read_limited(&path, 16 * 1024)? {
    Some(raw) => serde_json::from_slice(&raw).map_err(|_| "媒体服务配置损坏，未覆盖原文件。".into()),
    None => Ok(MediaSettings::default()),
  }
}

pub(crate) fn get_settings() -> Result<MediaSettingsView, String> {
  let settings = load_settings()?;
  Ok(MediaSettingsView {
    image_key_configured: get_key(Channel::Image, &base_url(&settings.image_base)?)?.is_some(),
    video_key_configured: get_key(Channel::Video, &base_url(&settings.video_base)?)?.is_some(),
    settings,
  })
}

pub(crate) fn save_settings(request: SaveMediaSettings) -> Result<MediaSettingsView, String> {
  let _guard = SETTINGS_WRITE.lock().map_err(|_| "媒体设置保存锁不可用。")?;
  load_settings()?;
  let image = base_url(&request.settings.image_base)?;
  let video = base_url(&request.settings.video_base)?;
  let model = request.settings.image_model.trim();
  if model.len() > 160 || model.chars().any(char::is_control) { return Err("图像模型名不合法。".into()); }
  if image.as_str().len() > 1200 || video.as_str().len() > 1200 { return Err("媒体服务地址过长。".into()); }
  for (channel, base, key) in [(Channel::Image, &image, request.image_key), (Channel::Video, &video, request.video_key)] {
    if let Some(key) = key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
      crate::secrets::set_api_key(&key_id(channel, base), key).map_err(|_| "保存媒体服务密钥失败。")?;
    }
  }
  let settings = MediaSettings { image_base: image.to_string(), image_model: model.into(), video_base: video.to_string() };
  let path = crate::app_data::config_file_path("creative-media.json")?;
  write_atomic(&path, &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?)?;
  get_settings()
}

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MediaKind { Import, Image, Edit, Video }

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum JobState { Submitting, Waiting, Ready, Failed, Interrupted }

#[derive(Debug, Copy, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Format { Png, Jpg, Webp, Mp4 }

impl Format {
  fn extension(self) -> &'static str { match self { Self::Png => "png", Self::Jpg => "jpg", Self::Webp => "webp", Self::Mp4 => "mp4" } }
  fn mime(self) -> &'static str { match self { Self::Png => "image/png", Self::Jpg => "image/jpeg", Self::Webp => "image/webp", Self::Mp4 => "video/mp4" } }
}

fn raster_format(bytes: &[u8]) -> Result<Format, String> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Ok(Format::Png); }
  if bytes.starts_with(b"\xff\xd8\xff") { return Ok(Format::Jpg); }
  if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { return Ok(Format::Webp); }
  Err("只支持 PNG、JPEG 或 WebP 位图；未保存无效的媒体文件。".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Asset { format: Format, bytes: u64 }

#[derive(Deserialize, Serialize)]
struct RemoteTask { id: Uuid, base: String }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJob {
  id: Uuid,
  shot_id: Option<Uuid>,
  source_id: Option<Uuid>,
  kind: MediaKind,
  state: JobState,
  prompt: String,
  model: String,
  created_at: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  asset: Option<Asset>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  remote: Option<RemoteTask>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  error: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  progress: Option<u8>,
  #[serde(default)]
  process: Option<Uuid>,
}

impl MediaJob {
  fn new(kind: MediaKind, shot_id: Option<Uuid>, source_id: Option<Uuid>, prompt: String, model: String) -> Self {
    Self { id: Uuid::new_v4(), shot_id, source_id, kind, state: JobState::Submitting, prompt, model,
      created_at: chrono::Utc::now().timestamp_millis(), asset: None, remote: None, error: None, progress: None,
      process: Some(process_id()) }
  }

  pub(crate) fn is_import(&self) -> bool { self.kind == MediaKind::Import }
  pub(crate) fn is_ready(&self) -> bool { self.state == JobState::Ready }
}

pub(crate) fn media_id(job: &MediaJob) -> Uuid { job.id }

fn process_id() -> Uuid {
  static ID: OnceLock<Uuid> = OnceLock::new();
  *ID.get_or_init(Uuid::new_v4)
}

fn job_from_disk(path: &Path, id: Uuid) -> Result<MediaJob, String> {
  let raw = read_limited(path, 128 * 1024)?.ok_or("未找到该媒体任务。")?;
  let mut job: MediaJob = serde_json::from_slice(&raw).map_err(|_| "媒体任务记录损坏。")?;
  if job.id != id { return Err("媒体任务记录与文件名不一致。".into()); }
  if job.state == JobState::Submitting && job.process != Some(process_id()) {
    job.state = JobState::Interrupted;
    job.error = Some("上次提交未确认，供应商可能已接单；请先检查供应商记录，不会自动重试。".into());
  }
  Ok(job)
}

fn read_job(root: &Path, id: Uuid) -> Result<MediaJob, String> {
  let dir = managed_dir(root, &["creative", "jobs"], false)?.ok_or("未找到该媒体任务。")?;
  job_from_disk(&dir.join(format!("{id}.json")), id)
}

pub(crate) fn get(root: &Path, id: Uuid) -> Result<MediaJob, String> { read_job(root, id) }

fn save_job(root: &Path, job: &MediaJob) -> Result<(), String> {
  let dir = managed_dir(root, &["creative", "jobs"], true)?.ok_or("媒体任务目录不可用。")?;
  write_atomic(&dir.join(format!("{}.json", job.id)), &serde_json::to_vec_pretty(job).map_err(|e| e.to_string())?)
}

#[derive(Serialize)]
pub(crate) struct MediaLibrary { jobs: Vec<MediaJob>, skipped: usize }

pub(crate) fn is_imported_image(root: &Path, id: Uuid) -> Result<bool, String> {
  let job = read_job(root, id)?;
  if !job.is_import() || !job.is_ready() { return Ok(false); }
  let (path, mime) = file(root, id)?;
  if !mime.starts_with("image/") { return Ok(false); }
  let bytes = read_limited(&path, IMPORT_LIMIT)?.ok_or("图片素材已移动。")?;
  image_dimensions(&bytes)?;
  Ok(true)
}

pub(crate) fn list(root: &Path) -> Result<MediaLibrary, String> {
  let mut jobs = Vec::new();
  let mut skipped = 0;
  if let Some(dir) = managed_dir(root, &["creative", "jobs"], false)? {
    for entry in fs::read_dir(dir).map_err(|e| format!("读取素材库失败：{e}"))? {
      let Ok(entry) = entry else { skipped += 1; continue };
      let path = entry.path();
      if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
      let Some(id) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| Uuid::parse_str(s).ok()) else { continue; };
      match job_from_disk(&path, id) { Ok(job) => jobs.push(job), Err(_) => skipped += 1 }
    }
  }
  jobs.sort_by_key(|job| (std::cmp::Reverse(job.created_at), job.id));
  Ok(MediaLibrary { jobs, skipped })
}

fn asset_path(root: &Path, id: Uuid, format: Format, create: bool) -> Result<PathBuf, String> {
  let dir = managed_dir(root, &["creative", "assets"], create)?.ok_or("素材文件已移动或删除。")?;
  Ok(dir.join(format!("{id}.{}", format.extension())))
}

fn save_asset(root: &Path, job: &mut MediaJob, format: Format, bytes: &[u8]) -> Result<(), String> {
  write_atomic(&asset_path(root, job.id, format, true)?, bytes)?;
  job.asset = Some(Asset { format, bytes: bytes.len() as u64 });
  job.state = JobState::Ready;
  Ok(())
}

pub(crate) fn file(root: &Path, id: Uuid) -> Result<(PathBuf, &'static str), String> {
  let job = read_job(root, id)?;
  let asset = job.asset.filter(|_| job.state == JobState::Ready).ok_or("素材尚未生成。")?;
  let path = asset_path(root, id, asset.format, false)?;
  regular_file(&path)?.filter(|meta| meta.len() == asset.bytes).ok_or("素材文件已丢失或被修改。")?;
  Ok((path, asset.format.mime()))
}

pub(crate) fn image_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
  raster_format(bytes)?;
  let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
    .map_err(|_| "无法读取图片格式。")?.into_dimensions()
    .map_err(|_| "无法读取图片尺寸；请使用完整的 PNG、JPEG 或 WebP 文件。")?;
  if width == 0 || height == 0 || width > 12000 || height > 12000 || u64::from(width) * u64::from(height) > 48_000_000 {
    return Err("图片尺寸过大；最大边长为 12000 像素且总像素不超过 48 MP。".into());
  }
  Ok((width, height))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodedImage {
  pub mime: String,
  pub base64: String,
  pub bytes: usize,
}

pub(crate) fn encoded_reference(root: &Path, id: Uuid) -> Result<EncodedImage, String> {
  if !is_imported_image(root, id)? { return Err("只支持作品中已验证的导入图片。".into()); }
  let (path, mime) = file(root, id)?;
  let bytes = read_limited(&path, IMPORT_LIMIT)?.ok_or("参考图片已移动。")?;
  Ok(EncodedImage { mime: mime.into(), base64: STANDARD.encode(&bytes), bytes: bytes.len() })
}

pub(crate) fn import(root: &Path, shot: Option<Uuid>, bytes: &[u8]) -> Result<MediaJob, String> {
  if bytes.len() > IMPORT_LIMIT { return Err("导入图片不能超过 10 MB。".into()); }
  let format = raster_format(bytes)?;
  image_dimensions(bytes)?;
  let mut job = MediaJob::new(MediaKind::Import, shot, None, String::new(), String::new());
  save_asset(root, &mut job, format, bytes)?;
  save_job(root, &job)?;
  Ok(job)
}

fn source_data_uri(root: &Path, id: Uuid, limit: usize) -> Result<String, String> {
  let (path, mime) = file(root, id)?;
  if !mime.starts_with("image/") { return Err("只能选择图片作为参考素材。".into()); }
  let data = read_limited(&path, limit)?.ok_or("参考图已丢失。")?;
  if raster_format(&data)?.mime() != mime { return Err("参考图文件已被修改。".into()); }
  Ok(format!("data:{mime};base64,{}", STANDARD.encode(data)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateMedia {
  kind: MediaKind,
  shot_id: Option<Uuid>,
  source_id: Option<Uuid>,
  prompt: String,
  #[serde(default)]
  portrait: bool,
  duration: Option<u8>,
}

struct ActiveJob((PathBuf, Uuid));

impl ActiveJob {
  fn new(root: &Path, id: Uuid) -> Result<Self, String> {
    let key = (root.to_owned(), id);
    let mut active = ACTIVE.get_or_init(Mutex::default).lock().map_err(|_| "媒体任务锁不可用。")?;
    if active.contains(&key) { return Err("该任务正在处理，请稍后查询。".into()); }
    if active.len() >= 3 { return Err("当前有 3 项媒体操作进行中，请稍后再试。".into()); }
    active.insert(key.clone());
    Ok(Self(key))
  }
}

impl Drop for ActiveJob {
  fn drop(&mut self) {
    if let Some(Ok(mut active)) = ACTIVE.get().map(Mutex::lock) { active.remove(&self.0); }
  }
}

fn media_client() -> Result<Client, String> {
  provider_client_builder()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(240))
    .build().map_err(|_| "无法初始化媒体服务连接。".into())
}

fn network_error(e: reqwest::Error) -> String {
  if e.is_timeout() { "媒体服务响应超时。".into() } else { "无法连接或读取媒体服务，请检查网络和服务地址。".into() }
}

async fn response(request: RequestBuilder) -> Result<Response, String> {
  let response = request.send().await.map_err(network_error)?;
  let status = response.status();
  if status.is_success() { return Ok(response); }
  Err(match status.as_u16() {
    401 | 403 => format!("HTTP {status}：请检查媒体服务密钥、账户权限及模型授权。"),
    404 => "HTTP 404：未找到接口或任务；请确认地址使用所选协议，任务也可能已过期。".into(),
    429 => "HTTP 429：媒体服务限流或额度不足，请稍后查询并检查账户额度。".into(),
    400 | 422 => format!("HTTP {status}：服务拒绝请求。请检查模型、输入图片和生成参数。"),
    _ => format!("媒体服务返回 HTTP {status}。"),
  })
}

async fn response_json(request: RequestBuilder, limit: usize) -> Result<Value, String> {
  let mut response = response(request).await?;
  if response.content_length().is_some_and(|n| n > limit as u64) { return Err("媒体服务响应超过大小限制。".into()); }
  let mut raw = Vec::new();
  while let Some(bytes) = response.chunk().await.map_err(network_error)? {
    if raw.len() + bytes.len() > limit { return Err("媒体服务响应超过大小限制。".into()); }
    raw.extend_from_slice(&bytes);
  }
  serde_json::from_slice(&raw).map_err(|_| "媒体服务没有返回所选协议的 JSON 结果。".into())
}

fn runway(request: RequestBuilder, key: &str) -> RequestBuilder {
  request.bearer_auth(key).header("X-Runway-Version", RUNWAY_VERSION)
}

pub(crate) fn generate(root: PathBuf, request: GenerateMedia) -> Result<MediaJob, String> {
  let prompt = request.prompt.trim();
  let limit = if request.kind == MediaKind::Video { 1000 } else { 4000 };
  if prompt.is_empty() || prompt.encode_utf16().count() > limit { return Err(format!("提示词必须为 1–{limit} 字符。")); }
  let settings = load_settings()?;
  let (channel, base, model) = match request.kind {
    MediaKind::Video => (Channel::Video, base_url(&settings.video_base)?, RUNWAY_MODEL.to_owned()),
    MediaKind::Image | MediaKind::Edit if !settings.image_model.is_empty() => (Channel::Image, base_url(&settings.image_base)?, settings.image_model),
    MediaKind::Image | MediaKind::Edit => return Err("请在「媒体服务」填写支持图像生成或编辑的模型名。".into()),
    MediaKind::Import => return Err("请使用导入图片功能。".into()),
  };
  let duration = request.duration.unwrap_or(5);
  if request.kind == MediaKind::Video && !(2..=10).contains(&duration) { return Err("视频镜头时长须为 2–10 秒。".into()); }
  if request.kind == MediaKind::Edit && request.source_id.is_none() { return Err("请选择要编辑的图片。".into()); }
  if request.kind == MediaKind::Image && request.source_id.is_some() { return Err("如要使用参考图，请选择图片编辑。".into()); }
  let key = require_key(channel, &base)?;
  let client = media_client()?;
  let mut job = MediaJob::new(request.kind, request.shot_id, request.source_id, prompt.to_owned(), model);
  let guard = ActiveJob::new(&root, job.id)?;
  let source = job.source_id.map(|id| source_data_uri(&root, id, if job.kind == MediaKind::Video { RUNWAY_INPUT_LIMIT } else { IMPORT_LIMIT })).transpose()?;
  save_job(&root, &job)?;
  let snapshot = read_job(&root, job.id)?;
  tokio::spawn(async move {
    let _guard = guard;
    let result = if job.kind == MediaKind::Video {
      submit_video(&mut job, &client, &base, &key, source, request.portrait, duration).await
    } else {
      generate_image(&root, &mut job, &client, &base, &key, source, request.portrait).await
    };
    if let Err(e) = result { job.state = JobState::Failed; job.error = Some(e); }
    if save_job(&root, &job).is_err() { eprintln!("[iris] could not record media job {}", job.id); }
  });
  Ok(snapshot)
}

async fn generate_image(root: &Path, job: &mut MediaJob, client: &Client, base: &Url, key: &str, source: Option<String>, portrait: bool) -> Result<(), String> {
  let mut body = json!({ "model": job.model, "prompt": job.prompt, "n": 1, "size": if portrait { "1024x1536" } else { "1536x1024" } });
  let route = if let Some(image) = source {
    body["images"] = json!([{ "image_url": image }]);
    "/images/edits"
  } else { "/images/generations" };
  let value = response_json(client.post(endpoint(base, route)).bearer_auth(key).json(&body), IMAGE_LIMIT * 4 / 3 + 65536).await?;
  let encoded = value.pointer("/data/0/b64_json").and_then(Value::as_str).ok_or("接口未返回 b64_json 图片；仅返回 URL 的图像接口暂不支持。")?;
  let bytes = STANDARD.decode(encoded).map_err(|_| "服务返回的图像编码无效。")?;
  if bytes.len() > IMAGE_LIMIT { return Err("图像结果超过 24 MB。".into()); }
  let format = raster_format(&bytes)?;
  save_asset(root, job, format, &bytes)
}

async fn submit_video(job: &mut MediaJob, client: &Client, base: &Url, key: &str, source: Option<String>, portrait: bool, duration: u8) -> Result<(), String> {
  let mut body = json!({ "model": RUNWAY_MODEL, "promptText": job.prompt, "ratio": if portrait { "720:1280" } else { "1280:720" }, "duration": duration });
  let route = if let Some(image) = source {
    body["promptImage"] = json!(image);
    "/v1/image_to_video"
  } else { "/v1/text_to_video" };
  let value = response_json(runway(client.post(endpoint(base, route)), key).json(&body), 64 * 1024).await?;
  let id = value.get("id").and_then(Value::as_str).and_then(|id| Uuid::parse_str(id).ok()).ok_or("供应商未返回有效任务 ID；不会自动重试。")?;
  job.remote = Some(RemoteTask { id, base: base.to_string() });
  job.state = JobState::Waiting;
  Ok(())
}

pub(crate) async fn refresh(root: &Path, id: Uuid) -> Result<MediaJob, String> {
  let _guard = ActiveJob::new(root, id)?;
  let mut job = read_job(root, id)?;
  if job.state != JobState::Waiting { return Ok(job); }
  let task = job.remote.as_ref().ok_or("媒体任务缺少供应商任务号。")?;
  let base = base_url(&task.base)?;
  let key = require_key(Channel::Video, &base)?;
  let client = media_client()?;
  let value = response_json(runway(client.get(endpoint(&base, &format!("/v1/tasks/{}", task.id))), &key), 64 * 1024).await?;
  let status = value.get("status").and_then(Value::as_str).ok_or("任务查询响应缺少状态。")?;
  match status {
    "PENDING" | "THROTTLED" | "RUNNING" => {
      job.progress = value.get("progress").and_then(Value::as_f64).filter(|n| (0.0..=1.0).contains(n)).map(|n| (n * 100.0).round() as u8);
    }
    "FAILED" | "CANCELLED" => {
      job.state = JobState::Failed;
      job.error = Some(if status == "CANCELLED" { "供应商已取消该视频任务。" } else { "供应商未能完成视频任务。可在服务控制台查看原因。" }.into());
    }
    "SUCCEEDED" => {
      let output = value.pointer("/output/0").and_then(Value::as_str).ok_or("任务完成但没有提供可下载的视频。")?;
      let bytes = download_video(root, job.id, &client, output_url(&base, output)?).await?;
      job.asset = Some(Asset { format: Format::Mp4, bytes });
      job.state = JobState::Ready;
      job.progress = Some(100);
    }
    _ => return Err("媒体服务返回未知任务状态。".into()),
  }
  save_job(root, &job)?;
  Ok(job)
}

fn output_url(base: &Url, raw: &str) -> Result<Url, String> {
  let url = Url::parse(raw).map_err(|_| "视频下载地址无效。")?;
  let official_cdn = base.origin().ascii_serialization() == RUNWAY_BASE
    && url.scheme() == "https" && url.port().is_none()
    && url.host_str().is_some_and(|host| host.ends_with(".cloudfront.net"));
  if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
    || (url.origin() != base.origin() && !official_cdn) {
    return Err("视频结果不在已配置服务或支持的 Runway CDN 上，未下载。".into());
  }
  Ok(url)
}

async fn download_video(root: &Path, id: Uuid, client: &Client, url: Url) -> Result<u64, String> {
  // Signed downloads do not receive the provider API key. Redirects are disabled.
  let mut response = response(client.get(url)).await?;
  if response.content_length().is_some_and(|n| n > VIDEO_LIMIT as u64) { return Err("视频超过 128 MB。".into()); }
  let path = asset_path(root, id, Format::Mp4, true)?;
  regular_file(&path)?;
  let temp = path.with_file_name(format!(".video-{}.tmp", Uuid::new_v4()));
  let result = async {
    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await.map_err(media_io_error)?;
    let mut len = 0usize;
    let mut header = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
      len += chunk.len();
      if len > VIDEO_LIMIT { return Err("视频超过 128 MB。".into()); }
      if header.len() < 12 {
        header.extend_from_slice(&chunk[..chunk.len().min(12 - header.len())]);
        if header.len() == 12 && header.get(4..8) != Some(b"ftyp") { return Err("下载结果不是 MP4 视频。".into()); }
      }
      file.write_all(&chunk).await.map_err(media_io_error)?;
    }
    if header.len() < 12 { return Err("视频文件为空或不完整。".into()); }
    file.sync_all().await.map_err(media_io_error)?;
    drop(file);
    tokio::fs::rename(&temp, &path).await.map_err(media_io_error)?;
    Ok(len as u64)
  }.await;
  if result.is_err() { let _ = tokio::fs::remove_file(&temp).await; }
  result
}

fn media_io_error(e: std::io::Error) -> String { format!("保存视频失败：{e}") }

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::creative::TestProject;

  #[test]
  fn credentials_and_downloads_are_bound_to_service() {
    let official = base_url(RUNWAY_BASE).unwrap();
    assert!(output_url(&official, "https://dnznrvs05pmza.cloudfront.net/output.mp4?signature=test").is_ok());
    assert!(output_url(&official, "https://cloudfront.net.other.test/output.mp4").is_err());
    assert!(output_url(&official, "http://127.0.0.1:55/output.mp4").is_err());
    assert!(base_url("https://someone:pass@gateway.example/v1").is_err());
    assert!(base_url("http://gateway.example/v1").is_err());
    let relay = base_url("https://gateway.example/tenant").unwrap();
    assert!(output_url(&relay, "https://gateway.example/a.mp4?signature=test").is_ok());
    assert!(output_url(&relay, "https://dnznrvs05pmza.cloudfront.net/output.mp4").is_err());
    assert_ne!(key_id(Channel::Video, &official), key_id(Channel::Video, &relay));
    assert_ne!(key_id(Channel::Video, &relay), key_id(Channel::Image, &relay));
  }

  #[test]
  fn imports_only_raster_images_into_their_own_project() {
    let a = TestProject::new();
    let b = TestProject::new();
    assert!(import(&a.0, None, b"<svg></svg>").is_err());
    let image = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=").unwrap();
    let first = import(&a.0, None, &image).unwrap();
    let second = import(&a.0, None, &image).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(file(&a.0, first.id).unwrap().1, "image/png");
    assert!(file(&b.0, first.id).is_err());
    assert_eq!(list(&a.0).unwrap().jobs.len(), 2);
  }

  #[test]
  fn image_headers_are_checked_and_dimension_bounded_without_decoding_pixels() {
    let valid = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=").unwrap();
    assert_eq!(image_dimensions(&valid).unwrap(), (1, 1));
    assert!(image_dimensions(b"\x89PNG\r\n\x1a\nnot-an-image").is_err());
    // Keep the PNG checksum valid so this exercises size validation, not corruption.
    let mut huge = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12_001, 1).write_to(&mut huge, image::ImageFormat::Png).unwrap();
    assert!(image_dimensions(huge.get_ref()).unwrap_err().contains("尺寸过大"));
    assert!(image_dimensions(b"<svg width=\"99999\" height=\"99999\"></svg>").is_err());
  }

  #[test]
  fn abandoned_submission_is_never_retried_implicitly() {
    let root = TestProject::new();
    let mut job = MediaJob::new(MediaKind::Video, None, None, "fixture".into(), RUNWAY_MODEL.into());
    job.process = Some(Uuid::new_v4());
    save_job(&root.0, &job).unwrap();
    assert_eq!(read_job(&root.0, job.id).unwrap().state, JobState::Interrupted);
  }
}
