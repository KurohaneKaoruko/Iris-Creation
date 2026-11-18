//! 发布态前端路径与服务启动回归：不依赖仓库 CWD，不使用真实用户数据。
use iris_creation::{
  desktop,
  server::{self, ServerConfig},
};

#[tokio::test]
async fn packaged_frontend_health_rpc_and_assets_work_on_a_free_port() {
  let root = std::env::temp_dir().join(format!("iris-startup-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(root.join("frontend/assets")).unwrap();
  std::fs::write(
    root.join("frontend/index.html"),
    "<html>Iris packaged frontend</html>",
  )
  .unwrap();
  std::fs::write(
    root.join("frontend/assets/app-hash.js"),
    "console.log('Iris')",
  )
  .unwrap();
  let dist = desktop::frontend_dir(&root, None).unwrap();
  let addr = server::start(ServerConfig {
    host: "127.0.0.1".into(),
    port: 0,
    static_dir: Some(dist),
    data_dir: None,
  })
  .await
  .unwrap();
  assert_ne!(addr.port(), 0);
  let client = reqwest::Client::builder()
    .no_proxy()
    .timeout(std::time::Duration::from_secs(5))
    .build()
    .unwrap();
  let health = client
    .get(format!("http://{addr}/api/health"))
    .send()
    .await
    .unwrap();
  assert!(health.status().is_success());
  assert!(health
    .text()
    .await
    .unwrap()
    .contains("iris-creation-server"));
  let page = client.get(format!("http://{addr}/")).send().await.unwrap();
  assert!(page.status().is_success());
  assert!(page.text().await.unwrap().contains("packaged frontend"));
  let asset = client
    .get(format!("http://{addr}/assets/app-hash.js"))
    .send()
    .await
    .unwrap();
  assert!(asset.status().is_success());
  assert!(asset
    .headers()
    .get("cache-control")
    .unwrap()
    .to_str()
    .unwrap()
    .contains("immutable"));
  let missing = client
    .get(format!("http://{addr}/assets/not-found.js"))
    .send()
    .await
    .unwrap();
  assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
  let rpc = client
    .post(format!("http://{addr}/api/rpc/ping"))
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
  assert!(rpc.status().is_success());
  assert!(rpc.text().await.unwrap().contains("ok"));
  std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn missing_frontend_fails_before_a_blank_window_can_open() {
  let result = server::start(ServerConfig {
    host: "127.0.0.1".into(),
    port: 0,
    static_dir: Some(std::env::temp_dir().join(format!("iris-missing-{}", uuid::Uuid::new_v4()))),
    data_dir: None,
  })
  .await;
  assert!(result.unwrap_err().contains("index.html not found"));
}
