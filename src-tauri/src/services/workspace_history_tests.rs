//! History metadata, retention and reversible restore use real disposable files.
use super::*;
use crate::services::fs::write_text_internal_with_baseline;

struct Project(PathBuf);

impl Project {
  fn new() -> Self {
    let root = std::env::temp_dir().join(format!("iris-history-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("stories")).unwrap();
    Self(root)
  }
}

impl Drop for Project {
  fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[test]
fn metadata_keeps_unicode_counts_timestamp_normalized_path_and_raw_byte_hash() {
  let p = Project::new();
  let content = "甲 乙\r\n😀";
  fs::write(p.0.join("stories/one.markdown"), content).unwrap();
  let before = Utc::now().timestamp_millis();
  let entry = create_history_snapshot(&p.0, ".\\stories\\one.markdown", Some("  checkpoint  ".into())).unwrap();
  assert!(entry.id.starts_with("hist-"));
  assert!(entry.created_at >= before && entry.created_at <= Utc::now().timestamp_millis());
  assert_eq!(entry.file_path, "stories/one.markdown");
  assert_eq!(entry.reason, "checkpoint");
  assert_eq!(entry.word_count, 3);
  assert_eq!(entry.char_count, 6);
  assert_eq!(entry.summary, "甲 乙");
  let serialized = serde_json::to_value(&entry).unwrap();
  assert_eq!(serialized["content_hash"], blake3::hash(content.as_bytes()).to_hex().to_string());
  let store = load_history_store(&p.0).unwrap();
  assert!(store.entries[0].snapshot_rel_path.ends_with(".markdown"));
  assert_eq!(read_history_snapshot(&p.0, &entry.id).unwrap(), content);
  assert_eq!(list_file_history(&p.0, None, Some("./stories//one.markdown")).unwrap().len(), 1);
}

#[test]
fn legacy_records_without_hash_remain_readable_and_restorable() {
  let p = Project::new();
  let record = create_history_snapshot_internal(&p.0, "stories/legacy.md", "旧版\r\n正文", "manual").unwrap();
  let mut raw = serde_json::to_value(load_history_store(&p.0).unwrap()).unwrap();
  raw["entries"][0].as_object_mut().unwrap().remove("content_hash");
  fs::write(history_index_path(&p.0), serde_json::to_vec(&raw).unwrap()).unwrap();
  fs::write(p.0.join("stories/legacy.md"), "当前正文").unwrap();
  assert_eq!(read_history_snapshot(&p.0, &record.id).unwrap(), "旧版\r\n正文");
  let entries = list_history_entries(&p.0, None).unwrap();
  assert!(serde_json::to_value(&entries[0]).unwrap().get("content_hash").is_none());
  assert_eq!(restore_history_snapshot_if_current(&p.0, &record.id, Some("当前正文")).unwrap(), "stories/legacy.md");
  assert_eq!(fs::read_to_string(p.0.join("stories/legacy.md")).unwrap(), "旧版\r\n正文");
}

#[test]
fn restoring_chapters_and_scenes_leaves_a_backup_for_a_second_rollback() {
  for path in ["stories/one.md", "stories/one.markdown", "stories/one.txt", "scenes/stable-opening.md"] {
    let p = Project::new();
    if path.starts_with("scenes/") {
      fs::create_dir_all(p.0.join("scenes")).unwrap();
      fs::create_dir_all(p.0.join(".novel/.settings")).unwrap();
      fs::write(p.0.join(".novel/work.json"), r#"{"kind":"screenplay"}"#).unwrap();
      fs::write(p.0.join(".novel/.settings/scene-order.json"), r#"{"version":1,"paths":["scenes/stable-opening.md"]}"#).unwrap();
    }
    let a = "# 旧标题\r\n\r\n原始正文。\r\n";
    let b = "# 新标题\r\n\r\n当前正文与对白。\r\n";
    fs::write(p.0.join(path), a).unwrap();
    let first = create_history_snapshot(&p.0, path, None).unwrap();
    write_text_internal_with_baseline(&p.0, path, b, false, "auto-save", Some(a)).unwrap();
    assert_eq!(restore_history_snapshot_if_current(&p.0, &first.id, Some(b)).unwrap(), path);
    assert_eq!(fs::read_to_string(p.0.join(path)).unwrap(), a);
    let backup = list_file_history(&p.0, None, Some(path)).unwrap().remove(0);
    assert_eq!(backup.reason, "restore-backup");
    assert_eq!(read_history_snapshot(&p.0, &backup.id).unwrap(), b);
    assert_eq!(restore_history_snapshot_if_current(&p.0, &backup.id, Some(a)).unwrap(), path);
    assert_eq!(fs::read_to_string(p.0.join(path)).unwrap(), b);
    let newest = list_file_history(&p.0, None, Some(path)).unwrap().remove(0);
    assert_eq!(read_history_snapshot(&p.0, &newest.id).unwrap(), a);
    assert_eq!(fs::read_dir(p.0.join(if path.starts_with("scenes/") { "scenes" } else { "stories" })).unwrap().count(), 1);
    if path.starts_with("scenes/") {
      assert_eq!(fs::read_to_string(p.0.join(".novel/.settings/scene-order.json")).unwrap(), r#"{"version":1,"paths":["scenes/stable-opening.md"]}"#);
      let scenes = crate::services::screenplay::list(&p.0).unwrap();
      assert_eq!(scenes[0].path, path);
      assert_eq!(scenes[0].title, "新标题");
    }
  }
}

#[test]
fn stale_restore_does_not_add_history_or_overwrite_external_edits() {
  let p = Project::new();
  let record = create_history_snapshot_internal(&p.0, "stories/one.md", "old", "manual").unwrap();
  fs::write(p.0.join("stories/one.md"), "external").unwrap();
  let index = fs::read(history_index_path(&p.0)).unwrap();
  let files = fs::read_dir(p.0.join(".novel/.history/snapshots")).unwrap().count();
  assert!(restore_history_snapshot_if_current(&p.0, &record.id, Some("stale")).unwrap_err().contains("changed on disk"));
  assert_eq!(fs::read_to_string(p.0.join("stories/one.md")).unwrap(), "external");
  assert_eq!(fs::read(history_index_path(&p.0)).unwrap(), index);
  assert_eq!(fs::read_dir(p.0.join(".novel/.history/snapshots")).unwrap().count(), files);
}

#[test]
fn tampered_snapshot_is_not_previewed_or_restored() {
  let p = Project::new();
  let record = create_history_snapshot_internal(&p.0, "stories/one.md", "old", "manual").unwrap();
  fs::write(p.0.join("stories/one.md"), "current").unwrap();
  fs::write(p.0.join(&record.snapshot_rel_path), "bad").unwrap();
  let index = fs::read(history_index_path(&p.0)).unwrap();
  assert!(read_history_snapshot(&p.0, &record.id).unwrap_err().contains("校验"));
  assert!(restore_history_snapshot_if_current(&p.0, &record.id, Some("current")).is_err());
  assert_eq!(fs::read_to_string(p.0.join("stories/one.md")).unwrap(), "current");
  assert_eq!(fs::read(history_index_path(&p.0)).unwrap(), index);
}

#[test]
fn pruning_retains_newest_800_and_never_deletes_an_external_path() {
  let p = Project::new();
  managed_dir(&p.0, &[".novel", ".history", "snapshots"], true).unwrap();
  let mut entries = Vec::new();
  for n in 0..HISTORY_MAX_ENTRIES {
    let relative = format!(".novel/.history/snapshots/fixture-{n}.md");
    fs::write(p.0.join(&relative), format!("version {n}")).unwrap();
    entries.push(serde_json::json!({"id":format!("fixture-{n}"),"file_path":"stories/one.md","snapshot_rel_path":relative,
      "created_at":1000-n as i64,"reason":"manual","word_count":1,"char_count":1,"summary":"legacy"}));
  }
  let sentinel = p.0.join("sentinel.md");
  fs::write(&sentinel, "must survive").unwrap();
  let mut invalid = entries.last().unwrap().clone();
  invalid["snapshot_rel_path"] = serde_json::json!("sentinel.md");
  entries.push(invalid);
  let store: HistoryStore = serde_json::from_value(serde_json::json!({"entries":entries})).unwrap();
  save_history_store(&p.0, &store).unwrap();
  let newest = create_history_snapshot_internal(&p.0, "stories/one.md", "latest", "manual").unwrap();
  let after = load_history_store(&p.0).unwrap();
  assert_eq!(after.entries.len(), HISTORY_MAX_ENTRIES);
  assert_eq!(after.entries[0].id, newest.id);
  assert_eq!(after.entries[1].id, "fixture-0");
  assert_eq!(after.entries.last().unwrap().id, format!("fixture-{}", HISTORY_MAX_ENTRIES-2));
  assert!(!p.0.join(format!(".novel/.history/snapshots/fixture-{}.md", HISTORY_MAX_ENTRIES-1)).exists());
  assert_eq!(fs::read_to_string(sentinel).unwrap(), "must survive");
  assert_eq!(list_history_entries(&p.0, Some(0)).unwrap().len(), 1);
  assert_eq!(list_history_entries(&p.0, Some(usize::MAX)).unwrap().len(), 500);
}

#[test]
fn failed_index_commit_removes_only_the_uncommitted_new_snapshot() {
  let p = Project::new();
  let original = create_history_snapshot_internal(&p.0, "stories/one.md", "original", "manual").unwrap();
  let path = history_index_path(&p.0);
  let before = fs::read(&path).unwrap();
  let permissions = fs::metadata(&path).unwrap().permissions();
  let mut readonly = permissions.clone();
  readonly.set_readonly(true);
  fs::set_permissions(&path, readonly).unwrap();
  let result = create_history_snapshot_internal(&p.0, "stories/one.md", "new", "manual");
  fs::set_permissions(&path, permissions).unwrap();
  assert!(result.is_err());
  assert_eq!(fs::read(&path).unwrap(), before);
  assert_eq!(read_history_snapshot(&p.0, &original.id).unwrap(), "original");
  assert_eq!(fs::read_dir(p.0.join(".novel/.history/snapshots")).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn manual_snapshots_cannot_follow_a_source_link() {
  use std::os::unix::fs::symlink;
  let p = Project::new();
  let outside = Project::new();
  fs::write(outside.0.join("secret.md"), "outside").unwrap();
  symlink(outside.0.join("secret.md"), p.0.join("stories/link.md")).unwrap();
  assert!(create_history_snapshot(&p.0, "stories/link.md", None).is_err());
  assert!(!p.0.join(".novel/.history").exists());
}

#[test]
fn manual_snapshots_reject_oversized_sources_before_creating_history() {
  let p = Project::new();
  let large = fs::File::create(p.0.join("stories/large.md")).unwrap();
  large.set_len(16 * 1024 * 1024 + 1).unwrap();
  assert!(create_history_snapshot(&p.0, "stories/large.md", None).is_err());
  assert!(!p.0.join(".novel/.history").exists());
}
