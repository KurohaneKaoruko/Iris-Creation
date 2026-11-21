//! 工作区域：工作区切换、初始化、路径校验与文件历史（快照索引）。
//!
//! 由 `crate::commands` 的 Tauri 命令薄壳调用；路径与状态参数不依赖
//! `tauri::State`，便于本地服务端复用。

use crate::state::AppState;
use super::bookshelf::{count_content_chars, project_kind, save_last_workspace, work_meta_path, ProjectKind};
use super::settings::ProjectWritingSettings;
use chrono::Utc;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Serialize)]
pub struct WorkspaceInfo {
  pub root: String,
  pub kind: ProjectKind,
}

#[derive(Serialize, Clone)]
pub struct HistoryEntry {
  pub id: String,
  pub file_path: String,
  pub created_at: i64,
  pub reason: String,
  pub word_count: usize,
  pub char_count: usize,
  pub summary: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub content_hash: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct HistoryEntryRecord {
  pub(crate) id: String,
  pub(crate) file_path: String,
  pub(crate) snapshot_rel_path: String,
  pub(crate) created_at: i64,
  pub(crate) reason: String,
  pub(crate) word_count: usize,
  pub(crate) char_count: usize,
  pub(crate) summary: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub(crate) content_hash: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct HistoryStore {
  #[serde(default)]
  pub(crate) entries: Vec<HistoryEntryRecord>,
}

pub(crate) const HISTORY_MAX_ENTRIES: usize = 800;
static HISTORY_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[path = "workspace_history_tests.rs"]
mod history_tests;

pub(crate) fn get_workspace_root(state: &AppState) -> Result<PathBuf, String> {
  state
    .workspace_root
    .lock()
    .map_err(|_| "workspace lock poisoned")?
    .clone()
    .ok_or_else(|| "workspace not set".to_string())
}

/// Capture a single root for scoped editor operations; never resolve it again after checking.
pub(crate) fn scoped_workspace(state: &AppState, expected: Option<&str>) -> Result<PathBuf, String> {
  let root = get_workspace_root(state)?;
  if let Some(expected) = expected {
    if expected.is_empty() || canonicalize_path(Path::new(expected)).as_ref() != Ok(&root) {
      return Err("当前作品已切换，请回到书架重新打开原作品。".into());
    }
  }
  Ok(root)
}

pub(crate) fn canonicalize_path(path: &Path) -> Result<PathBuf, String> {
  fs::canonicalize(path).map_err(|e| format!("invalid path: {e}"))
}

pub(crate) fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
  if relative_path.chars().any(char::is_control) {
    return Err("invalid relative path: control characters are not allowed".to_string());
  }
  let p = PathBuf::from(relative_path.replace('\\', "/"));
  if p.is_absolute() {
    return Err("absolute path is not allowed".to_string());
  }
  let mut normalized = PathBuf::new();
  for c in p.components() {
    match c {
      // Reject portable aliases before managed-directory checks, including names
      // that some filesystems normalize to a protected name.
      Component::Normal(part) if !part.to_string_lossy().contains(':')
        && !part.to_string_lossy().ends_with(['.', ' ']) => normalized.push(part),
      Component::CurDir => {},
      _ => return Err("invalid relative path".to_string()),
    }
  }
  Ok(normalized)
}

pub fn set_workspace(state: &AppState, path: &str) -> Result<WorkspaceInfo, String> {
  let root = canonicalize_path(Path::new(path))?;
  if !root.is_dir() { return Err("作品路径必须是目录。".into()); }
  *state.workspace_root.lock().map_err(|_| "workspace lock poisoned")? = Some(root.clone());
  if let Ok(mut w) = state.fs_watcher.lock() {
    *w = None;
  }
  if let Err(e) = start_fs_watcher(state, root.clone()) {
    eprintln!("fs_watcher_start_error: {e}");
    crate::event_sink::global::emit("fs_watch_error", serde_json::json!({ "message": e }));
  }
  if let Err(e) = save_last_workspace(&root) {
    eprintln!("save_last_workspace_failed: {e}");
  }
  Ok(WorkspaceInfo {
    root: root.to_string_lossy().to_string(),
    kind: project_kind(&root),
  })
}

fn start_fs_watcher(state: &AppState, root: PathBuf) -> Result<(), String> {
  let root_for_strip = root.clone();
  let mut watcher =
    notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| match res {
      Ok(event) => {
        let kind = match event.kind {
          EventKind::Create(_) => "create",
          EventKind::Modify(_) => "modify",
          EventKind::Remove(_) => "remove",
          EventKind::Access(_) => return,
          EventKind::Other => "other",
          EventKind::Any => "any",
        };
        for p in event.paths {
          let rel = p
            .strip_prefix(&root_for_strip)
            .unwrap_or(&p)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");
          if p.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(".iris-write-") && name.ends_with(".tmp")) {
            continue;
          }
          crate::event_sink::global::emit("fs_changed", serde_json::json!({ "kind": kind, "path": rel }));
        }
      }
      Err(e) => {
        crate::event_sink::global::emit("fs_watch_error", serde_json::json!({ "message": e.to_string() }));
      }
    })
    .map_err(|e| format!("create watcher failed: {e}"))?;
  watcher
    .watch(&root, RecursiveMode::Recursive)
    .map_err(|e| format!("watch failed: {e}"))?;
  *state.fs_watcher.lock().map_err(|_| "watcher lock poisoned")? = Some(watcher);
  Ok(())
}

pub(crate) fn write_file_if_absent(path: &Path, content: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;
  }
  match write_new_file(path, content.as_bytes()) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
    Err(e) => Err(format!("write file failed: {e}")),
  }
}

pub(crate) fn write_new_file(path: &Path, contents: &[u8]) -> io::Result<()> {
  let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
  let result = file.write_all(contents).and_then(|_| file.sync_all());
  drop(file);
  if result.is_err() { let _ = fs::remove_file(path); }
  result
}

/// Do not truncate the destination if creating, syncing or replacing the temporary file fails.
pub(crate) fn replace_file(path: &Path, contents: &[u8], before_replace: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
  let permissions = match fs::symlink_metadata(path) {
    Ok(meta) if meta.is_file() && !meta.permissions().readonly() => {
      // Respect the permission on the existing file, not just on the parent directory.
      fs::OpenOptions::new().write(true).open(path).map_err(|e| format!("目标文件不可写，未覆盖原文件：{e}"))?;
      Some(meta.permissions())
    }
    Ok(_) => return Err("目标不是可写的普通文件，未覆盖原文件。".into()),
    Err(e) if e.kind() == io::ErrorKind::NotFound => None,
    Err(e) => return Err(format!("检查目标文件失败：{e}")),
  };
  let temp = path.with_file_name(format!(".iris-write-{}.tmp", Uuid::new_v4()));
  write_new_file(&temp, contents).map_err(|e| format!("保存临时文件失败，未覆盖原文件：{e}"))?;
  let result = (|| {
    if let Some(permissions) = permissions {
      fs::set_permissions(&temp, permissions).map_err(|e| format!("保存权限失败，未覆盖原文件：{e}"))?;
    }
    before_replace()?;
    fs::rename(&temp, path).map_err(|e| format!("替换文件失败，未覆盖原文件：{e}"))
  })();
  if result.is_err() { let _ = fs::remove_file(&temp); }
  result
}

/// Walk app-owned directories without following symlinks or junctions in a copied project.
pub(crate) fn managed_dir(root: &Path, parts: &[&str], create: bool) -> Result<Option<PathBuf>, String> {
  let mut path = canonicalize_path(root)?;
  for part in parts {
    path.push(part);
    match fs::symlink_metadata(&path) {
      Err(e) if e.kind() == io::ErrorKind::NotFound && !create => return Ok(None),
      Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::create_dir(&path) {
        Ok(()) => {},
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(format!("创建作品目录失败：{e}")),
      },
      Err(e) => return Err(format!("读取作品目录失败：{e}")),
      Ok(_) => {},
    }
    if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) || fs::canonicalize(&path).as_ref().ok() != Some(&path) {
      return Err(format!("{part} 必须是作品里的普通目录，不能是链接。"));
    }
  }
  Ok(Some(path))
}

pub(crate) fn init_novel_workspace(root: &Path) -> Result<(), String> {
  let novel_dir = root.join(".novel");

  let dirs = [
    novel_dir.join(".settings"),
    novel_dir.join(".cache"),
    novel_dir.join(".history"),
    novel_dir.join(".history").join("snapshots"),
    novel_dir.join("plans"),
    novel_dir.join("tasks"),
    novel_dir.join("state"),
    root.join("stories"),
    root.join("concept"),
    root.join("outline"),
  ];

  for d in dirs {
    fs::create_dir_all(d).map_err(|e| format!("create dir failed: {e}"))?;
  }

  let concept_index = novel_dir.join(".cache").join("concept_index.json");
  if !concept_index.exists() {
    let raw = serde_json::json!({
      "revision": 0,
      "updated_at": "",
      "files": {}
    })
    .to_string();
    fs::write(concept_index, raw).map_err(|e| format!("write concept index failed: {e}"))?;
  }

  let outline_path = novel_dir.join(".cache").join("outline.json");
  if !outline_path.exists() {
    let raw = serde_json::json!({ "events": [] }).to_string();
    fs::write(outline_path, raw).map_err(|e| format!("write outline failed: {e}"))?;
  }

  let project_settings = novel_dir.join(".settings").join("project.json");
  if !project_settings.exists() {
    let raw = serde_json::to_string_pretty(&ProjectWritingSettings::default())
      .map_err(|e| format!("serialize default project settings failed: {e}"))?;
    fs::write(project_settings, raw).map_err(|e| format!("write project settings failed: {e}"))?;
  }

  let characters_path = novel_dir.join(".cache").join("characters.json");
  if !characters_path.exists() {
    let raw = serde_json::json!({ "characters": [] }).to_string();
    fs::write(characters_path, raw).map_err(|e| format!("write characters failed: {e}"))?;
  }

  let relations_path = novel_dir.join(".cache").join("relations.json");
  if !relations_path.exists() {
    let raw = serde_json::json!({ "relations": [] }).to_string();
    fs::write(relations_path, raw).map_err(|e| format!("write relations failed: {e}"))?;
  }

  let session_state = novel_dir.join("state").join("session-state.json");
  if !session_state.exists() {
    let raw = serde_json::json!({ "sessions": {} }).to_string();
    fs::write(session_state, raw).map_err(|e| format!("write session state failed: {e}"))?;
  }

  let continuity_index = novel_dir.join("state").join("continuity-index.md");
  if !continuity_index.exists() {
    let raw = "# Continuity Index\n\nTrack characters, timeline, and callbacks here.\n";
    fs::write(continuity_index, raw).map_err(|e| format!("write continuity index failed: {e}"))?;
  }

  let character_state_index = novel_dir.join("state").join("character-state-index.md");
  if !character_state_index.exists() {
    let raw = "# Character State Index\n\nTrack recent character state shifts here.\n";
    fs::write(character_state_index, raw).map_err(|e| format!("write character state index failed: {e}"))?;
  }

  let foreshadow_index = novel_dir.join("state").join("foreshadow-index.md");
  if !foreshadow_index.exists() {
    let raw = "# Foreshadow Index\n\nTrack active clues, hooks, and unresolved signals here.\n";
    fs::write(foreshadow_index, raw).map_err(|e| format!("write foreshadow index failed: {e}"))?;
  }

  let history_store = novel_dir.join(".history").join("revisions.json");
  write_file_if_absent(&history_store, "{\n  \"entries\": []\n}")?;

  let work_meta = work_meta_path(root);
  if !work_meta.exists() {
    write_file_if_absent(&work_meta, "{\n  \"description\": null\n}")?;
  }

  let outline_md = root.join("outline").join("outline.md");
  write_file_if_absent(
    &outline_md,
    "# Story Outline\n\n## Act 1\n- Setup\n\n## Act 2\n- Conflict escalates\n\n## Act 3\n- Resolution\n",
  )?;

  let characters_md = root.join("concept").join("characters.md");
  write_file_if_absent(
    &characters_md,
    "# Character Sheet\n\n## Protagonist\n- Goal:\n- Flaw:\n- Arc:\n",
  )?;

  let relations_md = root.join("concept").join("relations.md");
  write_file_if_absent(
    &relations_md,
    "# Character Relations\n\n- Protagonist -> Mentor : Trust and conflict\n",
  )?;

  let first_chapter = root.join("stories").join("chapter-0001-opening.md");
  write_file_if_absent(
    &first_chapter,
    "# Chapter 1: Opening\n\nWrite your first scene here.\n",
  )?;

  Ok(())
}

pub fn init_novel(state: &AppState) -> Result<(), String> {
  let root = get_workspace_root(state)?;
  if project_kind(&root) == ProjectKind::Screenplay {
    return Err("这是剧本作品，不能初始化为小说。".into());
  }
  init_novel_workspace(&root)
}

fn history_index_path(root: &Path) -> PathBuf {
  root.join(".novel/.history/revisions.json")
}

fn load_history_store(root: &Path) -> Result<HistoryStore, String> {
  if managed_dir(root, &[".novel", ".history"], false)?.is_none() { return Ok(HistoryStore::default()); }
  let path = history_index_path(root);
  match fs::symlink_metadata(&path) {
    Ok(meta) if meta.is_file() => {},
    Ok(_) => return Err("历史索引不是普通文件，未覆盖。".into()),
    Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(HistoryStore::default()),
    Err(e) => return Err(format!("read history index failed: {e}")),
  }
  let raw = super::fs::read_text_internal(root, ".novel/.history/revisions.json")
    .map_err(|e| format!("read history index failed: {e}"))?;
  serde_json::from_str::<HistoryStore>(&raw).map_err(|e| format!("parse history index failed: {e}"))
}

fn save_history_store(root: &Path, store: &HistoryStore) -> Result<(), String> {
  let raw = serde_json::to_vec_pretty(store).map_err(|e| format!("serialize history index failed: {e}"))?;
  replace_file(&history_index_path(root), &raw, || Ok(()))
}

fn snapshot_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
  let rel = validate_relative_path(relative_path)?;
  let name = rel.strip_prefix(".novel/.history/snapshots").map_err(|_| "invalid snapshot path")?;
  if name.components().count() != 1 || name.file_name().is_none() { return Err("invalid snapshot path".into()); }
  Ok(root.join(rel))
}

fn summarize_snapshot(text: &str) -> String {
  let line = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
  if line.is_empty() {
    "(empty)".to_string()
  } else if line.chars().count() > 80 {
    let short = line.chars().take(80).collect::<String>();
    format!("{short}...")
  } else {
    line.to_string()
  }
}

fn history_entry_from_record(record: &HistoryEntryRecord) -> HistoryEntry {
  HistoryEntry {
    id: record.id.clone(),
    file_path: record.file_path.clone(),
    created_at: record.created_at,
    reason: record.reason.clone(),
    word_count: record.word_count,
    char_count: record.char_count,
    summary: record.summary.clone(),
    content_hash: record.content_hash.clone(),
  }
}

pub(crate) fn should_track_history_path(relative_path: &str) -> bool {
  let norm = relative_path.replace('\\', "/").to_lowercase();
  if norm.starts_with(".novel/.history/")
    || norm.starts_with(".novel/.cache/")
    || norm.starts_with(".novel/state/")
    || norm.starts_with(".git/")
  {
    return false;
  }
  norm.starts_with("stories/")
    || norm.starts_with("scenes/")
    || norm.starts_with("outline/")
    || norm.starts_with("concept/")
    || norm.ends_with(".md")
    || norm.ends_with(".txt")
}

pub(crate) fn create_history_snapshot_internal(
  root: &Path,
  file_path: &str,
  snapshot_content: &str,
  reason: &str,
) -> Result<HistoryEntryRecord, String> {
  let normalized_file_path = validate_relative_path(file_path)?.to_string_lossy().replace('\\', "/");
  if normalized_file_path.is_empty() { return Err("快照来源不能是作品根目录。".into()); }
  if snapshot_content.len() > super::fs::MAX_TEXT_BYTES { return Err("历史快照超过 16 MiB 上限。".into()); }
  let _guard = HISTORY_WRITE_LOCK.lock().map_err(|_| "history write lock is poisoned")?;
  let mut store = load_history_store(root)?;
  managed_dir(root, &[".novel", ".history", "snapshots"], true)?;

  let ext = Path::new(&normalized_file_path)
    .extension()
    .and_then(|v| v.to_str())
    .unwrap_or("txt");
  let id = format!("hist-{}-{}", Utc::now().timestamp_millis(), Uuid::new_v4().simple());
  let snapshot_rel_path = format!(".novel/.history/snapshots/{id}.{ext}");
  let snapshot_abs_path = snapshot_path(root, &snapshot_rel_path)?;
  write_new_file(&snapshot_abs_path, snapshot_content.as_bytes()).map_err(|e| format!("write history snapshot failed: {e}"))?;

  let record = HistoryEntryRecord {
    id: id.clone(),
    file_path: normalized_file_path,
    snapshot_rel_path,
    created_at: Utc::now().timestamp_millis(),
    reason: reason.to_string(),
    word_count: count_content_chars(snapshot_content),
    char_count: snapshot_content.chars().count(),
    summary: summarize_snapshot(snapshot_content),
    content_hash: Some(blake3::hash(snapshot_content.as_bytes()).to_hex().to_string()),
  };
  store.entries.insert(0, record.clone());

  let dropped = store.entries.split_off(store.entries.len().min(HISTORY_MAX_ENTRIES));
  if let Err(error) = save_history_store(root, &store) {
    let _ = fs::remove_file(snapshot_abs_path);
    return Err(error);
  }
  for old in dropped {
    if let Ok(path) = snapshot_path(root, &old.snapshot_rel_path) {
      let _ = fs::remove_file(path);
    }
  }
  Ok(record)
}

fn find_history_entry_record(store: &HistoryStore, id: &str) -> Option<HistoryEntryRecord> {
  store.entries.iter().find(|entry| entry.id == id).cloned()
}

pub fn list_history_entries(root: &Path, max: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
  list_file_history(root, max, None)
}

pub(crate) fn list_file_history(root: &Path, max: Option<usize>, file: Option<&str>) -> Result<Vec<HistoryEntry>, String> {
  let store = load_history_store(root)?;
  let file = file.map(validate_relative_path).transpose()?.map(|path| path.to_string_lossy().replace('\\', "/"));
  let limit = max.unwrap_or(120).clamp(1, 500);
  Ok(
    store
      .entries
      .iter()
      .filter(|entry| file.as_ref().is_none_or(|path| entry.file_path == *path))
      .take(limit)
      .map(history_entry_from_record)
      .collect(),
  )
}

pub fn create_history_snapshot(
  root: &Path,
  relative_path: &str,
  reason: Option<String>,
) -> Result<HistoryEntry, String> {
  let rel = validate_relative_path(relative_path)?;
  super::screenplay::check_manuscript_path(root, &rel)?;
  let rel_norm = rel.to_string_lossy().replace('\\', "/");
  let content = super::fs::read_text_internal(root, &rel_norm)
    .map_err(|e| format!("read snapshot source failed: {e}"))?;
  let reason_text = reason
    .as_deref()
    .map(str::trim)
    .filter(|v| !v.is_empty())
    .unwrap_or("manual");
  let entry = create_history_snapshot_internal(root, &rel_norm, &content, reason_text)?;
  Ok(history_entry_from_record(&entry))
}

pub fn read_history_snapshot(root: &Path, id: &str) -> Result<String, String> {
  let store = load_history_store(root)?;
  let record = find_history_entry_record(&store, id.trim())
    .ok_or_else(|| "history entry not found".to_string())?;
  read_history_record(root, &record)
}

fn read_history_record(root: &Path, record: &HistoryEntryRecord) -> Result<String, String> {
  if managed_dir(root, &[".novel", ".history", "snapshots"], false)?.is_none() { return Err("快照目录不存在。".into()); }
  let path = snapshot_path(root, &record.snapshot_rel_path)?;
  if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) { return Err("快照不存在或不是普通文件。".into()); }
  let content = super::fs::read_text_internal(root, &record.snapshot_rel_path)
    .map_err(|e| format!("read snapshot failed: {e}"))?;
  if record.content_hash.as_ref().is_some_and(|hash| *hash != blake3::hash(content.as_bytes()).to_hex().as_str()) {
    return Err("历史快照校验失败，可能已被外部修改；未恢复或覆盖原稿。".into());
  }
  Ok(content)
}

pub fn restore_history_snapshot(root: &Path, id: &str) -> Result<String, String> {
  restore_history_snapshot_if_current(root, id, None)
}

pub(crate) fn restore_history_snapshot_if_current(root: &Path, id: &str, expected: Option<&str>) -> Result<String, String> {
  let store = load_history_store(root)?;
  let record = find_history_entry_record(&store, id.trim())
    .ok_or_else(|| "history entry not found".to_string())?;
  let snapshot = read_history_record(root, &record)?;
  super::fs::write_text_internal_with_baseline(root, &record.file_path, &snapshot, expected.is_none(), "restore-backup", expected)?;
  Ok(record.file_path)
}
