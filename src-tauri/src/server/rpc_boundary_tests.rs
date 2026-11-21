//! Exercise the actual Web RPC dispatch against isolated, disposable projects.
use super::*;
use std::{fs, path::PathBuf};

struct Project {
  base: PathBuf,
  root: PathBuf,
  outside: PathBuf,
  ctx: ServerContext,
}

impl Project {
  fn new() -> Self {
    let base = std::env::temp_dir().join(format!("iris-rpc-boundary-{}", uuid::Uuid::new_v4()));
    let root = base.join("work");
    let outside = base.join("other");
    for dir in [root.join("stories"), root.join(".novel/.settings"), outside.clone()] {
      fs::create_dir_all(dir).unwrap();
    }
    let root = fs::canonicalize(root).unwrap();
    let ctx = test_context();
    *ctx.app_state.workspace_root.lock().unwrap() = Some(root.clone());
    fs::write(root.join("stories/one.md"), "原稿").unwrap();
    fs::write(outside.join("secret.md"), "其他作品的内容").unwrap();
    Self { base, root, outside, ctx }
  }

  async fn call(&self, command: &str, mut args: Value) -> Result<Value, String> {
    args["workspaceRoot"] = json!(self.root.to_str().unwrap());
    dispatch(&self.ctx, command, args).await
  }

  fn assert_unchanged(&self) {
    assert_eq!(fs::read_to_string(self.root.join("stories/one.md")).unwrap(), "原稿");
    assert_eq!(fs::read_to_string(self.outside.join("secret.md")).unwrap(), "其他作品的内容");
    assert!(!self.root.join(".novel/.history").exists());
  }
}

impl Drop for Project {
  fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); }
}

fn file_commands(path: &str) -> Vec<(&'static str, Value)> {
  vec![
    ("read_text", json!({"relativePath":path})),
    ("write_text", json!({"relative_path":path,"content":"bad"})),
    ("write_text_if_current", json!({"path":path,"content":"bad","expectedCurrent":"原稿"})),
    ("create_file", json!({"path":path})),
    ("create_dir", json!({"path":path})),
    ("delete_entry", json!({"path":path})),
    ("rename_entry", json!({"from":path,"to":"renamed.md"})),
    ("rename_entry", json!({"from":"stories/one.md","to":path})),
  ]
}

#[tokio::test]
async fn filesystem_rpc_requires_an_open_work_and_rejects_unsafe_paths() {
  let empty = test_context();
  for (command, args) in file_commands("stories/one.md") {
    assert!(dispatch(&empty, command, args).await.is_err(), "unopened workspace: {command}");
  }
  let p = Project::new();
  let absolute = p.outside.join("secret.md").to_string_lossy().into_owned();
  for path in ["../other/secret.md", "..\\other\\secret.md", "C:\\outside\\secret.md", "stories/bad\nname.md", ".novel/work.json.", &absolute] {
    for (command, args) in file_commands(path) {
      assert!(p.call(command, args).await.is_err(), "unsafe {command}: {path:?}");
    }
  }
  p.assert_unchanged();
}

#[tokio::test]
async fn filesystem_rpc_preserves_formats_and_normalizes_both_path_separators() {
  let p = Project::new();
  for extension in ["md", "markdown", "txt"] {
    let path = format!(".\\stories\\compat.{extension}");
    p.call("write_text", json!({"path":path,"content":"兼容正文"})).await.unwrap();
    assert_eq!(p.call("read_text", json!({"relative_path":format!("./stories//compat.{extension}")})).await.unwrap(), json!("兼容正文"));
  }
  dispatch(&p.ctx, "write_text", json!({
    "workspace_root":p.root.to_str(), "relative_path":".novel/.settings/chapters.json", "content":"{\"chapters\":[]}"
  })).await.unwrap();
  assert_eq!(fs::read_to_string(p.root.join(".novel/.settings/chapters.json")).unwrap(), "{\"chapters\":[]}");
}

#[tokio::test]
async fn stale_workspace_and_oversized_text_rpc_leave_manuscript_untouched() {
  let p = Project::new();
  let mut commands = file_commands("stories/one.md");
  commands.push(("list_workspace_tree", json!({"maxDepth":4})));
  for (command, mut args) in commands {
    args["workspace_root"] = json!(p.outside.to_str());
    let err = dispatch(&p.ctx, command, args).await.unwrap_err();
    assert!(err.contains("作品已切换"), "stale scope: {command}: {err}");
  }
  let oversized = "界".repeat(16 * 1024 * 1024 / 3 + 1);
  for command in ["write_text", "write_text_if_current"] {
    let err = p.call(command, json!({"path":"stories/one.md","content":oversized,"expected_current":"原稿"})).await.unwrap_err();
    assert!(err.contains("16 MiB"));
  }
  let large = fs::File::create(p.root.join("stories/large.txt")).unwrap();
  large.set_len(16 * 1024 * 1024 + 1).unwrap();
  assert!(p.call("read_text", json!({"path":"stories/large.txt"})).await.unwrap_err().contains("16 MiB"));
  p.assert_unchanged();
}

#[tokio::test]
async fn generic_rpc_cannot_mutate_managed_stores_or_their_ancestors() {
  let p = Project::new();
  fs::create_dir_all(p.root.join("scenes")).unwrap();
  fs::write(p.root.join(".novel/work.json"), r#"{"kind":"screenplay"}"#).unwrap();
  for path in [".git/config", ".novel/snapshots/task.md", "creative/storyboard.json", "creative/references/image.png"] {
    let target = p.root.join(path);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, "protected").unwrap();
    for (command, args) in file_commands(path).into_iter().filter(|(command, _)| *command != "read_text") {
      assert!(p.call(command, args).await.is_err(), "managed {command}: {path}");
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "protected");
  }
  for path in [".novel", ".novel/work.json", ".novel/.history/new.md", "creative", "creative/references"] {
    for (command, args) in file_commands(path).into_iter().filter(|(command, _)| *command != "read_text") {
      assert!(p.call(command, args).await.is_err(), "managed ancestor {command}: {path}");
    }
  }
  assert_eq!(fs::read_to_string(p.root.join(".novel/work.json")).unwrap(), r#"{"kind":"screenplay"}"#);
  p.assert_unchanged();
}

#[cfg(unix)]
#[tokio::test]
async fn rpc_reads_references_writes_and_tree_cannot_follow_links() {
  use std::os::unix::fs::symlink;
  let p = Project::new();
  symlink(&p.outside, p.root.join("linked")).unwrap();
  symlink(p.outside.join("secret.md"), p.root.join("stories/escape.md")).unwrap();
  for path in ["linked/secret.md", "stories/escape.md", "linked/new.md"] {
    for (command, args) in file_commands(path) {
      assert!(p.call(command, args).await.is_err(), "linked {command}: {path}");
    }
  }
  let refs = p.call("resolve_inline_references", json!({"payload":{"input":"#file:stories/escape.md"}})).await.unwrap();
  assert!(!refs["resolved_input"].as_str().unwrap().contains("其他作品的内容"));
  assert!(p.call("export_work", json!({"format":"md"})).await.is_err());
  let tree = p.call("list_workspace_tree", json!({"maxDepth":4})).await.unwrap();
  let tree = tree.to_string();
  assert!(!tree.contains("linked") && !tree.contains("escape.md"));
  assert!(!p.outside.join("new.md").exists());
  p.assert_unchanged();
}

#[tokio::test]
async fn media_rpc_rejects_invalid_inputs_before_creating_assets() {
  use base64::{engine::general_purpose::STANDARD, Engine};
  let p = Project::new();
  fs::create_dir_all(p.root.join("scenes")).unwrap();
  fs::write(p.root.join(".novel/work.json"), r#"{"kind":"screenplay"}"#).unwrap();
  let png = crate::services::local_assets::fixture_png();
  let invalid = [
    "not-base64!".to_string(), String::new(), STANDARD.encode(b"<svg/>"), STANDARD.encode(&png[..png.len()/2]),
    "A".repeat((crate::services::local_assets::IMPORT_LIMIT + 2) / 3 * 4 + 4),
  ];
  for encoded in invalid {
    assert!(p.call("import_storyboard_image", json!({
      "shotId":null,"role":"reference","name":"边界测试","originalName":"input.png","base64":encoded
    })).await.is_err());
    assert!(!p.root.join("creative").exists());
  }
  let board = p.call("import_storyboard_image", json!({
    "shotId":null,"role":"reference","name":"合法图片","originalName":"input.png","base64":STANDARD.encode(&png)
  })).await.unwrap();
  let asset = &board["assets"][0];
  assert_eq!(fs::read(p.root.join(asset["path"].as_str().unwrap())).unwrap(), png);
  assert_eq!(p.call("read_creative_image", json!({"id":asset["id"]})).await.unwrap()["mime"], "image/png");
  p.assert_unchanged();
}
