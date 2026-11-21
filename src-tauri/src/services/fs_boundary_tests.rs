//! 通用文件接口的作品边界：使用完全隔离的临时目录，不访问真实作品。
use super::*;
use crate::services::local_assets::{self, AssetRole};

struct Project {
  base: PathBuf,
  root: PathBuf,
  outside: PathBuf,
  state: AppState,
}

impl Project {
  fn new() -> Self {
    let base = std::env::temp_dir().join(format!("iris-fs-boundary-{}", uuid::Uuid::new_v4()));
    let root = base.join("work");
    let outside = base.join("other");
    for dir in [root.join("stories"), root.join(".novel/.settings"), outside.clone()] {
      fs::create_dir_all(dir).unwrap();
    }
    let root = fs::canonicalize(root).unwrap();
    let state = AppState::default();
    *state.workspace_root.lock().unwrap() = Some(root.clone());
    fs::write(root.join("stories/one.txt"), "原稿").unwrap();
    fs::write(outside.join("secret.md"), "其他作品的内容").unwrap();
    Self { base, root, outside, state }
  }

  fn workspace(&self) -> &str { self.root.to_str().unwrap() }
}

impl Drop for Project {
  fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); }
}

#[test]
fn rejects_parent_absolute_drive_and_control_paths_without_mutation() {
  let p = Project::new();
  let absolute = p.outside.join("secret.md").to_string_lossy().into_owned();
  for invalid in ["../other/secret.md", "..\\other\\secret.md", "C:\\outside\\secret.md", "stories/bad\nname.md", &absolute] {
    assert!(read_text_scoped(&p.state, invalid, Some(p.workspace())).is_err(), "read: {invalid:?}");
    assert!(write_text_scoped(&p.state, invalid, "禁止的写入", None, Some(p.workspace())).is_err(), "write: {invalid:?}");
    assert!(create_dir_scoped(&p.state, invalid, Some(p.workspace())).is_err(), "mkdir: {invalid:?}");
    assert!(create_file_scoped(&p.state, invalid, Some(p.workspace())).is_err(), "create: {invalid:?}");
    assert!(rename_entry_scoped(&p.state, "stories/one.txt", invalid, Some(p.workspace())).is_err(), "rename: {invalid:?}");
    assert!(delete_entry_scoped(&p.state, invalid, Some(p.workspace())).is_err(), "delete: {invalid:?}");
  }
  assert_eq!(fs::read_to_string(p.root.join("stories/one.txt")).unwrap(), "原稿");
  assert_eq!(fs::read_to_string(p.outside.join("secret.md")).unwrap(), "其他作品的内容");
  assert!(!p.root.join(".novel/.history").exists());
}

#[test]
fn rejects_portable_path_aliases_and_empty_mutation_targets() {
  let p = Project::new();
  for path in [".novel/work.json.", ".novel /work.json", "stories/bad.txt "] {
    assert!(write_text_scoped(&p.state, path, "bad", None, Some(p.workspace())).is_err(), "write: {path:?}");
    assert!(create_file_scoped(&p.state, path, Some(p.workspace())).is_err(), "create: {path:?}");
  }
  for path in ["", ".", "./"] {
    assert!(delete_entry_scoped(&p.state, path, Some(p.workspace())).is_err());
    assert!(rename_entry_scoped(&p.state, path, "renamed", Some(p.workspace())).is_err());
    assert!(rename_entry_scoped(&p.state, "stories/one.txt", path, Some(p.workspace())).is_err());
  }
  assert_eq!(fs::read_to_string(p.root.join("stories/one.txt")).unwrap(), "原稿");
}

#[test]
fn preserves_txt_chapters_and_internal_json_compatibility() {
  let p = Project::new();
  write_text_scoped(&p.state, "./stories//one.txt", "新的正文", Some("原稿"), Some(p.workspace())).unwrap();
  let metadata = r#"{"chapters":[]}"#;
  write_text_scoped(&p.state, ".novel/.settings/chapters.json", metadata, None, Some(p.workspace())).unwrap();
  assert_eq!(read_text_scoped(&p.state, "stories/one.txt", Some(p.workspace())).unwrap(), "新的正文");
  assert_eq!(read_text_scoped(&p.state, ".novel/.settings/chapters.json", Some(p.workspace())).unwrap(), metadata);
}

#[test]
fn generic_actions_cannot_mutate_managed_history_identity_or_git() {
  let p = Project::new();
  for file in [".novel/.history/revisions.json", ".novel/snapshots/task.md", ".novel/work.json", ".git/config"] {
    let path = p.root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "protected").unwrap();
    assert!(write_text_scoped(&p.state, file, "corrupt", None, Some(p.workspace())).is_err(), "write: {file}");
    assert!(create_file_scoped(&p.state, file, Some(p.workspace())).is_err(), "create: {file}");
    assert!(delete_entry_scoped(&p.state, file, Some(p.workspace())).is_err(), "delete: {file}");
    assert!(rename_entry_scoped(&p.state, file, "renamed.md", Some(p.workspace())).is_err(), "rename from: {file}");
    assert!(rename_entry_scoped(&p.state, "stories/one.txt", file, Some(p.workspace())).is_err(), "rename to: {file}");
    assert_eq!(fs::read_to_string(path).unwrap(), "protected");
  }
  assert!(delete_entry_scoped(&p.state, ".novel", Some(p.workspace())).is_err());
  assert!(rename_entry_scoped(&p.state, ".novel", "metadata", Some(p.workspace())).is_err());
  assert!(create_dir_scoped(&p.state, ".novel/.history/extra", Some(p.workspace())).is_err());
  assert_eq!(fs::read_to_string(p.root.join("stories/one.txt")).unwrap(), "原稿");
  assert!(!p.root.join("renamed.md").exists());
}

#[test]
fn stale_workspace_requests_cannot_access_the_new_work() {
  let p = Project::new();
  let stale = p.outside.to_str();
  assert!(read_text_scoped(&p.state, "stories/one.txt", stale).is_err());
  assert!(write_text_scoped(&p.state, "stories/one.txt", "错误工程", None, stale).is_err());
  assert!(create_file_scoped(&p.state, "created.md", stale).is_err());
  assert!(create_dir_scoped(&p.state, "created", stale).is_err());
  assert!(delete_entry_scoped(&p.state, "stories/one.txt", stale).is_err());
  assert!(rename_entry_scoped(&p.state, "stories/one.txt", "renamed.md", stale).is_err());
  assert_eq!(fs::read_to_string(p.root.join("stories/one.txt")).unwrap(), "原稿");
}

#[test]
fn oversized_utf8_writes_and_file_reads_are_bounded_before_history() {
  let p = Project::new();
  let oversized = "界".repeat(16 * 1024 * 1024 / 3 + 1);
  assert!(write_text_scoped(&p.state, "stories/one.txt", &oversized, Some("原稿"), Some(p.workspace())).is_err());
  assert_eq!(fs::read_to_string(p.root.join("stories/one.txt")).unwrap(), "原稿");
  assert!(!p.root.join(".novel/.history").exists());
  let file = fs::File::create(p.root.join("stories/large.txt")).unwrap();
  file.set_len(16 * 1024 * 1024 + 1).unwrap();
  assert!(read_text_scoped(&p.state, "stories/large.txt", Some(p.workspace())).is_err());
}

#[test]
fn text_at_the_byte_limit_is_still_readable_and_writable() {
  let p = Project::new();
  let content = "a".repeat(MAX_TEXT_BYTES);
  write_text_scoped(&p.state, "stories/limit.txt", &content, None, Some(p.workspace())).unwrap();
  assert_eq!(read_text_scoped(&p.state, "stories/limit.txt", Some(p.workspace())).unwrap(), content);
}

#[cfg(unix)]
#[test]
fn file_and_parent_symlinks_cannot_escape_or_alias_managed_storage() {
  use std::os::unix::fs::symlink;
  let p = Project::new();
  symlink(&p.outside, p.root.join("linked")).unwrap();
  symlink(p.outside.join("secret.md"), p.root.join("file.md")).unwrap();
  for file in ["linked/secret.md", "file.md"] {
    assert!(read_text_scoped(&p.state, file, Some(p.workspace())).is_err());
    assert!(write_text_scoped(&p.state, file, "escape", None, Some(p.workspace())).is_err());
    assert!(delete_entry_scoped(&p.state, file, Some(p.workspace())).is_err());
    assert!(rename_entry_scoped(&p.state, file, "renamed.md", Some(p.workspace())).is_err());
  }
  assert!(create_file_scoped(&p.state, "linked/new.md", Some(p.workspace())).is_err());
  assert!(create_dir_scoped(&p.state, "linked/new-dir", Some(p.workspace())).is_err());
  assert!(rename_entry_scoped(&p.state, "stories/one.txt", "linked/new.md", Some(p.workspace())).is_err());
  fs::create_dir_all(p.root.join(".novel/.history")).unwrap();
  symlink(p.root.join(".novel/.history"), p.root.join("alias")).unwrap();
  assert!(write_text_scoped(&p.state, "alias/corrupt.md", "bad", None, Some(p.workspace())).is_err());
  let tree = list_workspace_tree_scoped(&p.state, 8, Some(p.workspace())).unwrap();
  assert!(!tree.children.iter().any(|entry| ["linked", "file.md", "alias"].contains(&entry.name.as_str())));
  assert_eq!(fs::read_to_string(p.outside.join("secret.md")).unwrap(), "其他作品的内容");
  assert!(!p.outside.join("new.md").exists());
  assert!(!p.outside.join("new-dir").exists());
}

#[cfg(unix)]
#[test]
fn inline_references_quality_checks_and_exports_cannot_follow_links() {
  use std::os::unix::fs::symlink;
  let p = Project::new();
  symlink(p.outside.join("secret.md"), p.root.join("stories/escape.md")).unwrap();
  let resolved = resolve_inline_references(&p.state, ResolveInlineReferencesRequest {
    input: "参考 #file:stories/escape.md".into(), selection_text: None,
    active_file_path: None, active_file_content: None,
  }).unwrap();
  assert!(!resolved.resolved_input.contains("其他作品的内容"));
  assert!(export_work(&p.state, "md").is_err());
  assert!(validate_novel_task_quality(&p.state, NovelTaskQualityRequest {
    task: NovelTaskQualityTask { id: "one".into(), target_words: 1, scope: "stories/escape.md".into(), depends_on: vec![], acceptance_checks: vec![] },
    assistant_text: "TASK_DONE: one".into(), task_pool: vec![],
  }).is_err());
}

#[cfg(unix)]
#[test]
fn linked_index_is_rejected_before_changing_concept_or_history() {
  use std::os::unix::fs::symlink;
  let p = Project::new();
  fs::create_dir_all(p.root.join("concept")).unwrap();
  fs::create_dir_all(p.root.join(".novel/.cache")).unwrap();
  fs::write(p.root.join("concept/setting.md"), "原设定").unwrap();
  symlink(p.outside.join("secret.md"), p.root.join(".novel/.cache/concept_index.json")).unwrap();
  assert!(write_text_scoped(&p.state, "concept/setting.md", "新设定", Some("原设定"), Some(p.workspace())).is_err());
  assert_eq!(fs::read_to_string(p.root.join("concept/setting.md")).unwrap(), "原设定");
  assert_eq!(fs::read_to_string(p.outside.join("secret.md")).unwrap(), "其他作品的内容");
  assert!(!p.root.join(".novel/.history").exists());
}

#[test]
fn invalid_media_inputs_do_not_create_assets() {
  let p = Project::new();
  for bytes in [Vec::new(), b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(), vec![0; local_assets::IMPORT_LIMIT + 1]] {
    assert!(local_assets::prepare(&bytes, "test".into(), "input.png".into(), AssetRole::Reference).is_err());
  }
  let mut oversized_dimensions = std::io::Cursor::new(Vec::new());
  image::DynamicImage::new_rgb8(12001, 1).write_to(&mut oversized_dimensions, image::ImageFormat::Png).unwrap();
  assert!(local_assets::prepare(oversized_dimensions.get_ref(), "test".into(), "input.png".into(), AssetRole::Reference).is_err());
  let png = local_assets::fixture_png();
  assert!(local_assets::prepare(&png[..png.len() / 2], "test".into(), "input.png".into(), AssetRole::Reference).is_err());
  assert!(local_assets::prepare(&png, "test".into(), "input.png".into(), AssetRole::Reference).is_ok());
  assert!(!p.root.join("creative").exists());
}
