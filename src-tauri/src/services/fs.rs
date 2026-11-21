//! 文件系统域：工作区文件树、文件操作与正文辅助分析的请求/结果类型。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static TEXT_WRITE_LOCK: Mutex<()> = Mutex::new(());
pub(crate) const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

#[cfg(test)]
#[path = "fs_boundary_tests.rs"]
mod boundary_tests;

/// Resolve a validated relative path without following links or reparse points.
/// This is a filesystem safety check, not an OS sandbox for hostile local processes.
fn checked_workspace_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
  let root = fs::canonicalize(root).map_err(|e| format!("invalid workspace: {e}"))?;
  let mut current = root.clone();
  for part in relative.components() {
    current.push(part);
    match fs::symlink_metadata(&current) {
      Err(e) if e.kind() == io::ErrorKind::NotFound => break,
      Err(e) => return Err(format!("检查作品路径失败：{e}")),
      Ok(meta) => {
        let linked = meta.file_type().is_symlink();
        #[cfg(windows)]
        let linked = linked || {
          use std::os::windows::fs::MetadataExt;
          meta.file_attributes() & 0x400 != 0
        };
        if linked || (!meta.is_file() && !meta.is_dir()) {
          return Err("只允许作品内的普通文件和目录，不能通过链接访问。".into());
        }
        let resolved = fs::canonicalize(&current).map_err(|e| format!("解析作品路径失败：{e}"))?;
        if !resolved.starts_with(&root) { return Err("路径越出当前作品目录，操作已拒绝。".into()); }
      }
    }
  }
  Ok(root.join(relative))
}

/// Keep generic file actions away from stores managed by dedicated services.
fn protect_managed_path(relative: &Path) -> Result<(), String> {
  let parts: Vec<_> = relative.components().map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
  if parts.first().is_some_and(|part| part == ".git")
    || (parts.first().is_some_and(|part| part == ".novel")
      && (parts.len() == 1 || matches!(parts.get(1).map(String::as_str), Some(".history" | "snapshots" | "work.json")))) {
    return Err("此路径由版本、快照或工程管理服务维护，不能通过普通文件操作修改。".into());
  }
  Ok(())
}

fn read_text_bounded(path: &Path) -> io::Result<String> {
  let file = fs::File::open(path)?;
  let meta = file.metadata()?;
  if !meta.is_file() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "只能读取普通文本文件。")); }
  if meta.len() > MAX_TEXT_BYTES as u64 {
    return Err(io::Error::new(io::ErrorKind::InvalidData, "普通文本文件超过 16 MiB 上限。"));
  }
  let mut content = String::new();
  file.take(MAX_TEXT_BYTES as u64 + 1).read_to_string(&mut content)?;
  if content.len() > MAX_TEXT_BYTES {
    return Err(io::Error::new(io::ErrorKind::InvalidData, "普通文本文件超过 16 MiB 上限。"));
  }
  Ok(content)
}

pub(crate) fn read_text_internal(root: &Path, relative_path: &str) -> Result<String, String> {
  let rel = validate_relative_path(relative_path)?;
  let target = checked_workspace_path(root, &rel)?;
  read_text_bounded(&target).map_err(|e| format!("read failed: {e}"))
}

#[derive(Serialize, Clone)]
pub struct FsEntry {
  pub name: String,
  pub path: String,
  pub kind: String,
  pub children: Vec<FsEntry>,
}

#[derive(Deserialize)]
pub struct NovelTaskQualityTask {
  pub id: String,
  pub target_words: u32,
  pub scope: String,
  #[serde(default)]
  pub depends_on: Vec<String>,
  #[serde(default)]
  pub acceptance_checks: Vec<String>,
}

#[derive(Deserialize)]
pub struct NovelTaskQualityRequest {
  pub task: NovelTaskQualityTask,
  pub assistant_text: String,
  #[serde(default)]
  pub task_pool: Vec<NovelTaskQualityTask>,
}

#[derive(Serialize)]
pub struct NovelTaskQualityResult {
  pub ok: bool,
  pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct ComposerDirectiveParseResult {
  pub requested_mode: Option<String>,
  pub auto_action: Option<String>,
  pub content: String,
  pub matched: bool,
}

#[derive(Deserialize)]
pub struct ResolveInlineReferencesRequest {
  pub input: String,
  pub selection_text: Option<String>,
  pub active_file_path: Option<String>,
  pub active_file_content: Option<String>,
}

#[derive(Serialize)]
pub struct ResolveInlineReferencesResult {
  pub resolved_input: String,
  pub blocks_added: usize,
}

// ---- 以下由 commands.rs 等价搬移（概念索引与大纲校验）----

pub(crate) fn update_concept_index(root: &Path, rel_path: &str, content: &str) -> Result<(), String> {
  #[derive(Serialize, Deserialize, Default)]
  struct ConceptIndex {
    revision: u64,
    updated_at: String,
    files: std::collections::BTreeMap<String, ConceptFileInfo>,
  }

  #[derive(Serialize, Deserialize, Default)]
  struct ConceptFileInfo {
    hash: String,
    revision: u64,
    updated_at: String,
  }

  let index_path = checked_workspace_path(root, Path::new(".novel/.cache/concept_index.json"))?;
  let mut index: ConceptIndex = if index_path.exists() {
    let raw = read_text_bounded(&index_path).map_err(|e| format!("read concept index failed: {e}"))?;
    serde_json::from_str(&raw).unwrap_or_default()
  } else {
    ConceptIndex::default()
  };

  let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
    .to_string();

  let changed = index.files.get(rel_path).map(|f| f.hash.as_str() != hash).unwrap_or(true);
  if changed {
    index.revision = index.revision.saturating_add(1);
    index.updated_at = now.clone();
    index.files.insert(
      rel_path.to_string(),
      ConceptFileInfo {
        hash,
        revision: index.revision,
        updated_at: now,
      },
    );
  }

  super::workspace::managed_dir(root, &[".novel", ".cache"], true)?;
  let raw = serde_json::to_string_pretty(&index).map_err(|e| format!("serialize concept index failed: {e}"))?;
  fs::write(index_path, raw).map_err(|e| format!("write concept index failed: {e}"))
}

pub(crate) fn validate_outline(existing_json: &str, new_json: &str) -> Result<(), String> {
  #[derive(Deserialize, Default)]
  struct Outline {
    #[serde(default)]
    events: Vec<Event>,
  }

  #[derive(Deserialize, Default)]
  struct Event {
    #[serde(default)]
    id: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    characters: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    description: String,
  }

  let existing: Outline = if existing_json.trim().is_empty() {
    Outline::default()
  } else {
    serde_json::from_str(existing_json).unwrap_or_default()
  };
  let incoming: Outline = serde_json::from_str(new_json).map_err(|e| format!("outline json invalid: {e}"))?;

  let mut combined = Vec::new();
  combined.extend(existing.events.into_iter());
  combined.extend(incoming.events.into_iter());

  let mut id_set = std::collections::BTreeMap::<String, usize>::new();
  let mut conflicts: Vec<String> = Vec::new();

  for (idx, ev) in combined.iter().enumerate() {
    if !ev.id.trim().is_empty() {
      if let Some(prev) = id_set.insert(ev.id.clone(), idx) {
        conflicts.push(format!("事件 id 重复：{}（第{}条 与 第{}条）", ev.id, prev + 1, idx + 1));
      }
    }
  }

  let mut per_character: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>> =
    std::collections::BTreeMap::new();

  for ev in combined {
    if ev.time.trim().is_empty() {
      continue;
    }
    if ev.characters.is_empty() {
      continue;
    }
    for ch in ev.characters {
      let by_time = per_character.entry(ch.clone()).or_default();
      if let Some(prev_loc) = by_time.get(&ev.time) {
        if !ev.location.trim().is_empty() && prev_loc != &ev.location {
          conflicts.push(format!("时间线冲突：{} 在 {} 同时出现在 {} 与 {}", ch, ev.time, prev_loc, ev.location));
        }
      } else if !ev.location.trim().is_empty() {
        by_time.insert(ev.time.clone(), ev.location.clone());
      }
    }
  }

  if conflicts.is_empty() {
    Ok(())
  } else {
    Err(conflicts.join("\n"))
  }
}
use super::bookshelf::{project_kind, ProjectKind};
use super::workspace::{
  create_history_snapshot_internal, get_workspace_root, should_track_history_path,
  scoped_workspace, validate_relative_path,
};
use crate::state::AppState;
use std::collections::HashSet;
use regex::Regex;

// ---- 由 commands.rs 等价搬移（正文辅助分析）----
fn normalize_no_whitespace(input: &str) -> String {
  input.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn normalize_rel_path_for_read(path: &str) -> Result<PathBuf, String> {
  validate_relative_path(path)
}

fn parse_writer_mode_alias(token: &str) -> Option<&'static str> {
  let lower = token.trim().to_lowercase();
  match lower.as_str() {
    "normal" | "普通" => Some("normal"),
    "plan" | "大纲" => Some("plan"),
    "spec" | "细纲" => Some("spec"),
    _ => None,
  }
}

pub fn parse_composer_directive(input: String) -> ComposerDirectiveParseResult {
  let trimmed = input.trim();
  if !trimmed.starts_with('/') {
    return ComposerDirectiveParseResult {
      requested_mode: None,
      auto_action: None,
      content: trimmed.to_string(),
      matched: false,
    };
  }

  let mut chars = trimmed.chars();
  let _slash = chars.next();
  let after_slash = chars.as_str();
  let mut parts = after_slash.splitn(2, char::is_whitespace);
  let command = parts.next().unwrap_or("").trim();
  let rest = parts.next().unwrap_or("").trim();

  if command.eq_ignore_ascii_case("auto") {
    let arg = rest
      .split_whitespace()
      .next()
      .unwrap_or("")
      .trim()
      .to_lowercase();
    let auto_action = match arg.as_str() {
      "on" => Some("on".to_string()),
      "off" => Some("off".to_string()),
      _ => Some("toggle".to_string()),
    };
    return ComposerDirectiveParseResult {
      requested_mode: None,
      auto_action,
      content: String::new(),
      matched: true,
    };
  }

  if let Some(mode) = parse_writer_mode_alias(command) {
    return ComposerDirectiveParseResult {
      requested_mode: Some(mode.to_string()),
      auto_action: None,
      content: rest.to_string(),
      matched: true,
    };
  }

  ComposerDirectiveParseResult {
    requested_mode: None,
    auto_action: None,
    content: trimmed.to_string(),
    matched: false,
  }
}

pub fn resolve_inline_references(
  state: &AppState,
  payload: ResolveInlineReferencesRequest,
) -> Result<ResolveInlineReferencesResult, String> {
  let source = payload.input.trim().to_string();
  if !source.contains('#') {
    return Ok(ResolveInlineReferencesResult {
      resolved_input: source,
      blocks_added: 0,
    });
  }

  let selection_regex = Regex::new(r"#(?:选区|selection)\b").map_err(|e| format!("selection regex invalid: {e}"))?;
  let current_file_regex =
    Regex::new(r"#(?:当前文件|current_file|current)\b").map_err(|e| format!("current file regex invalid: {e}"))?;
  let file_prefix_regex = Regex::new(r"#(?:文件|file):([^\s#]+)").map_err(|e| format!("file prefix regex invalid: {e}"))?;
  let file_path_regex =
    Regex::new(r"#([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,16})").map_err(|e| format!("file path regex invalid: {e}"))?;

  let mut blocks: Vec<String> = Vec::new();
  let mut file_refs: Vec<String> = Vec::new();
  let mut seen_file_refs: HashSet<String> = HashSet::new();
  let mut cleaned = source.clone();

  let mut push_block = |title: String, body: String| {
    let normalized = body.trim().to_string();
    let final_body = if normalized.is_empty() { "(empty)".to_string() } else { normalized };
    blocks.push(format!("[{title}]\n{final_body}"));
  };

  if selection_regex.is_match(source.as_str()) {
    let selected = payload.selection_text.unwrap_or_default().trim().to_string();
    let body = if selected.is_empty() {
      "(no selection detected; select text in editor first)".to_string()
    } else {
      selected
    };
    push_block("selection".to_string(), body);
    cleaned = selection_regex.replace_all(cleaned.as_str(), "").to_string();
  }

  if current_file_regex.is_match(source.as_str()) {
    if let Some(path) = payload.active_file_path.as_ref() {
      let content = payload.active_file_content.unwrap_or_default();
      push_block(format!("current file {path}"), content);
    } else {
      push_block("current file".to_string(), "(no active file)".to_string());
    }
    cleaned = current_file_regex.replace_all(cleaned.as_str(), "").to_string();
  }

  for captures in file_prefix_regex.captures_iter(source.as_str()) {
    let Some(value) = captures.get(1) else {
      continue;
    };
    let reference = value.as_str().trim().replace('\\', "/");
    if reference.is_empty() {
      continue;
    }
    let key = reference.to_lowercase();
    if seen_file_refs.insert(key) {
      file_refs.push(reference);
    }
  }

  for captures in file_path_regex.captures_iter(source.as_str()) {
    let Some(value) = captures.get(1) else {
      continue;
    };
    let reference = value.as_str().trim().replace('\\', "/");
    if reference.is_empty() {
      continue;
    }
    let key = reference.to_lowercase();
    if seen_file_refs.insert(key) {
      file_refs.push(reference);
    }
  }

  cleaned = file_prefix_regex.replace_all(cleaned.as_str(), "").to_string();
  cleaned = file_path_regex.replace_all(cleaned.as_str(), "").to_string();
  cleaned = cleaned.trim().to_string();

  let root = get_workspace_root(state).ok();
  for reference in file_refs {
    let normalized_ref = reference.as_str();
    if normalized_ref.is_empty() {
      continue;
    }
    if root.is_none() {
      push_block(
        format!("file {normalized_ref}"),
        "(project files are unavailable in current environment)".to_string(),
      );
      continue;
    }
    let relative = match validate_relative_path(normalized_ref) {
      Ok(value) => value,
      Err(err) => {
        push_block(format!("file {normalized_ref}"), format!("read failed: {err}"));
        continue;
      }
    };
    let Some(root_path) = root.as_ref() else {
      continue;
    };
    let result = checked_workspace_path(root_path, &relative)
      .and_then(|path| read_text_bounded(&path).map_err(|e| e.to_string()));
    match result {
      Ok(content) => push_block(format!("file {normalized_ref}"), content),
      Err(err) => push_block(format!("file {normalized_ref}"), format!("read failed: {err}")),
    }
  }

  if blocks.is_empty() {
    return Ok(ResolveInlineReferencesResult {
      resolved_input: source,
      blocks_added: 0,
    });
  }

  let resolved_input = if cleaned.is_empty() {
    format!(
      "Please continue writing based on the following references.\n\n{}",
      blocks.join("\n\n")
    )
  } else {
    format!("{cleaned}\n\n[References]\n{}", blocks.join("\n\n"))
  };

  Ok(ResolveInlineReferencesResult {
    resolved_input,
    blocks_added: blocks.len(),
  })
}

pub fn validate_novel_task_quality(
  state: &AppState,
  payload: NovelTaskQualityRequest,
) -> Result<NovelTaskQualityResult, String> {
  let root = get_workspace_root(state)?;
  let task = payload.task;
  let text = payload.assistant_text.trim();
  if text.is_empty() {
    return Ok(NovelTaskQualityResult {
      ok: false,
      reason: Some("AI returned empty content".to_string()),
    });
  }
  if !text.contains(&format!("TASK_DONE: {}", task.id)) {
    return Ok(NovelTaskQualityResult {
      ok: false,
      reason: Some(format!("Missing completion tag TASK_DONE: {}", task.id)),
    });
  }

  let scope_rel = normalize_rel_path_for_read(task.scope.as_str())?;
  let scope_path = checked_workspace_path(&root, &scope_rel)?;
  let content = read_text_bounded(&scope_path)
    .map_err(|_| format!("target file is missing or unreadable: {}", task.scope))?;
  let compact = normalize_no_whitespace(content.as_str());
  let min_length = std::cmp::max(600usize, ((task.target_words as f32) * 0.42_f32) as usize);
  if compact.len() < min_length {
    return Ok(NovelTaskQualityResult {
      ok: false,
      reason: Some(format!("file content is too short ({}/{})", compact.len(), min_length)),
    });
  }

  let lowered = content.to_lowercase();
  let placeholder_tokens = ["todo", "lorem", "xxx", "[待写]", "待补全", "待完善", "待续"];
  if placeholder_tokens.iter().any(|token| lowered.contains(token)) {
    return Ok(NovelTaskQualityResult {
      ok: false,
      reason: Some("chapter contains placeholder text".to_string()),
    });
  }

  if !content.trim().is_empty()
    && task.acceptance_checks.iter().any(|check| check.contains("钩子"))
  {
    let tail: String = content.chars().rev().take(80).collect::<String>().chars().rev().collect();
    let has_hook_end = tail.chars().any(|ch| ['?', '!', '.', '？', '！', '。', '…'].contains(&ch));
    if !has_hook_end {
      return Ok(NovelTaskQualityResult {
        ok: false,
        reason: Some("chapter ending lacks a valid hook/closure sentence".to_string()),
      });
    }
  }

  if let Some(dep_id) = task.depends_on.first() {
    if let Some(dep_task) = payload.task_pool.iter().find(|item| item.id == *dep_id) {
      if dep_task.scope != task.scope {
        if let Ok(dep_rel) = normalize_rel_path_for_read(dep_task.scope.as_str()) {
          if let Ok(dep_content) = checked_workspace_path(&root, &dep_rel)
            .and_then(|path| read_text_bounded(&path).map_err(|e| e.to_string())) {
            let current_head: String = normalize_no_whitespace(content.as_str()).chars().take(140).collect();
            let dep_head: String = normalize_no_whitespace(dep_content.as_str()).chars().take(140).collect();
            if current_head.len() > 80 && dep_head.len() > 80 && current_head == dep_head {
              return Ok(NovelTaskQualityResult {
                ok: false,
                reason: Some("chapter opening is highly duplicated from dependency task".to_string()),
              });
            }
          }
        }
      }
    }
  }

  Ok(NovelTaskQualityResult {
    ok: true,
    reason: None,
  })
}

// ---- 由 commands.rs 等价搬移（文件操作）----
pub fn list_workspace_tree(state: &AppState, max_depth: usize) -> Result<FsEntry, String> {
  list_workspace_tree_scoped(state, max_depth, None)
}

pub(crate) fn list_workspace_tree_scoped(state: &AppState, max_depth: usize, workspace: Option<&str>) -> Result<FsEntry, String> {
  let root = scoped_workspace(state, workspace)?;
  build_tree(&root, &root, max_depth)
}

pub fn read_text(state: &AppState, relative_path: &str) -> Result<String, String> {
  read_text_scoped(state, relative_path, None)
}

pub(crate) fn read_text_scoped(state: &AppState, relative_path: &str, workspace: Option<&str>) -> Result<String, String> {
  let root = scoped_workspace(state, workspace)?;
  let rel = validate_relative_path(relative_path)?;
  super::screenplay::check_manuscript_path(&root, &rel)?;
  read_text_internal(&root, relative_path)
}

/// 导出整本：按章序合并 stories/ 下全部 .md 为单文档（元数据 title 优先，缺元数据用文件名）。
/// 返回 (文件名, 内容)。frontmatter 剥除，`# 标题` 行去重（避免与合并标题重复）。
pub fn export_work(state: &AppState, format: &str) -> Result<(String, String), String> {
  let root = get_workspace_root(state)?;
  let work_name = root
    .file_name()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| "work".to_string());
  if project_kind(&root) == ProjectKind::Screenplay {
    let content = super::screenplay::export(&root, &work_name, format)?;
    return Ok((format!("{}-剧本.{format}", sanitize_filename(&work_name)), content));
  }

  // 章节元数据（可选）
  let meta_path = checked_workspace_path(&root, Path::new(".novel/.settings/chapters.json"))?;
  let raw_meta = match read_text_bounded(&meta_path) {
    Ok(raw) => raw,
    Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
    Err(e) => return Err(format!("read chapter metadata failed: {e}")),
  };
  let meta: serde_json::Value = serde_json::from_str(&raw_meta).unwrap_or(serde_json::Value::Null);

  // 收集 stories/*.md，按文件名排序兜底
  let mut files: Vec<String> = Vec::new();
  let stories = checked_workspace_path(&root, Path::new("stories"))?;
  if stories.is_dir() {
    let mut entries: Vec<_> = fs::read_dir(&stories)
      .map_err(|e| format!("read stories failed: {e}"))?
      .filter_map(|e| e.ok())
      .map(|e| e.file_name().to_string_lossy().to_string())
      .filter(|n| n.to_lowercase().ends_with(".md") || n.to_lowercase().ends_with(".markdown"))
      .collect();
    entries.sort();
    for n in entries {
      files.push(format!("stories/{n}"));
    }
  }
  if files.is_empty() {
    return Err("stories/ 下没有可导出的章节".to_string());
  }

  // 元数据里按 filePath 查 title/order
  let meta_arr = meta.get("chapters").and_then(|v| v.as_array()).cloned().unwrap_or_default();
  let find_meta = |path: &str| -> Option<(String, i64)> {
    meta_arr
      .iter()
      .find(|c| c.get("filePath").and_then(|v| v.as_str()) == Some(path))
      .map(|c| {
        (
          c.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
          c.get("order").and_then(|v| v.as_i64()).unwrap_or(0),
        )
      })
  };

  let mut indexed: Vec<(i64, String, String)> = Vec::new(); // (order, path, content)
  for path in &files {
    let target = checked_workspace_path(&root, Path::new(path))?;
    let content = read_text_bounded(&target).map_err(|e| format!("read {path} failed: {e}"))?;
    let order = find_meta(path).map(|(_, o)| o).unwrap_or(i64::MAX);
    indexed.push((order, path.clone(), content));
  }
  indexed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

  let ext = if format == "txt" { "txt" } else { "md" };
  let mut out = String::new();
  if ext == "txt" {
    out.push_str(&work_name);
    out.push_str("\n\n");
  }
  let total = indexed.len();
  for (idx, (_, path, raw)) in indexed.iter().enumerate() {
    let title = find_meta(path).map(|(t, _)| t).unwrap_or_default();
    let body = strip_frontmatter_and_heading(raw);
    if ext == "md" {
      let heading = if title.is_empty() {
        path.split('/').next_back().unwrap_or(path).to_string()
      } else {
        title
      };
      out.push_str(&format!("# {}\n\n", heading));
    } else {
      let heading = if title.is_empty() {
        format!("第 {} 章", idx + 1)
      } else {
        title.clone()
      };
      out.push_str(&format!("{}\n\n", heading));
    }
    out.push_str(body.trim());
    out.push_str("\n\n");
    let _ = total;
  }

  Ok((format!("{}.{}", sanitize_filename(&work_name), ext), out))
}

/// 剥 YAML frontmatter 与首个 `# 标题` 行（合并时统一重排标题）
fn strip_frontmatter_and_heading(text: &str) -> String {
  let mut rest = text;
  if rest.trim_start().starts_with("---") {
    if let Some(end) = rest[3..].find("\n---") {
      rest = rest[3 + end + 4..].trim_start_matches('\n');
    }
  }
  let mut out: Vec<&str> = Vec::new();
  let mut heading_skipped = false;
  for line in rest.lines() {
    if !heading_skipped && line.trim_start().starts_with("# ") {
      heading_skipped = true;
      continue;
    }
    out.push(line);
  }
  out.join("\n")
}

fn sanitize_filename(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|c| {
      if c.is_alphanumeric() || c == ' ' || c == '_' || c == '-' {
        c
      } else {
        '_'
      }
    })
    .collect();
  cleaned.trim().to_string()
}

#[cfg(test)]
mod export_tests {
  use super::{sanitize_filename, strip_frontmatter_and_heading, write_text_internal_with_baseline};

  #[test]
  fn strips_frontmatter_and_first_heading() {
    let a = strip_frontmatter_and_heading("---\ntitle: x\n---\n# 第一章\n\n正文");
    assert_eq!(a.trim_start(), "正文");
    let b = strip_frontmatter_and_heading("# 已有标题\n\n内容");
    assert_eq!(b.trim_start(), "内容");
    let c = strip_frontmatter_and_heading("无标题正文\n第二行");
    assert_eq!(c, "无标题正文\n第二行");
  }

  #[test]
  fn sanitizes_filename() {
    assert_eq!(sanitize_filename("我的 小说/v1?"), "我的 小说_v1_");
    assert_eq!(sanitize_filename("clean-name_2"), "clean-name_2");
  }

  #[test]
  fn guarded_write_preserves_external_version_when_editor_baseline_is_stale() {
    let root = std::env::temp_dir().join(format!("iris-write-guard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("stories")).unwrap();
    let path = root.join("stories/chapter-0001.md");
    std::fs::write(&path, "external edit").unwrap();
    let result = write_text_internal_with_baseline(
      &root, "stories/chapter-0001.md", "stale edit", false, "auto-save", Some("old version"),
    );
    assert!(result.unwrap_err().contains("changed on disk"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit");
    write_text_internal_with_baseline(
      &root, "stories/chapter-0001.md", "saved edit", false, "auto-save", Some("external edit"),
    ).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "saved edit");
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn failed_history_and_readonly_save_keep_original_manuscript() {
    let root = std::env::temp_dir().join(format!("iris-failed-save-{}", uuid::Uuid::new_v4()));
    let history = root.join(".novel/.history");
    std::fs::create_dir_all(&history).unwrap();
    std::fs::create_dir_all(root.join("scenes")).unwrap();
    std::fs::write(root.join(".novel/work.json"), r#"{"kind":"screenplay"}"#).unwrap();
    let path = root.join("scenes/opening.md");
    std::fs::write(&path, "original").unwrap();
    let index = history.join("revisions.json");
    std::fs::write(&index, "damaged index").unwrap();
    let save = || write_text_internal_with_baseline(&root, "scenes/opening.md", "new", false, "auto-save", Some("original"));
    assert!(save().unwrap_err().contains("历史快照"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(std::fs::read_to_string(&index).unwrap(), "damaged index");
    std::fs::write(&index, r#"{"entries":[]}"#).unwrap();
    let original_permissions = std::fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&path, readonly).unwrap();
    assert!(save().unwrap_err().contains("未覆盖"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    std::fs::set_permissions(&path, original_permissions).unwrap();
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn generic_text_writes_cannot_replace_the_managed_storyboard_manifest() {
    let root = std::env::temp_dir().join(format!("iris-managed-storyboard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("creative")).unwrap();
    std::fs::create_dir_all(root.join(".novel")).unwrap();
    std::fs::write(root.join(".novel/work.json"), r#"{"kind":"screenplay"}"#).unwrap();
    let path = root.join("creative/storyboard.json");
    let original = r#"{"version":1,"shots":[],"assets":[]}"#;
    std::fs::write(&path, original).unwrap();
    let error = write_text_internal_with_baseline(&root, "creative/storyboard.json", "{}", false, "auto-save", Some(original)).unwrap_err();
    assert!(error.contains("分镜与素材工具管理"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    std::fs::remove_dir_all(root).unwrap();
  }
}

pub fn write_text(
  state: &AppState,
  relative_path: &str,
  content: &str,
) -> Result<(), String> {
  write_text_with_baseline(state, relative_path, content, None)
}

/// 编辑器传入读取时的基线；磁盘有新修改时拒绝静默覆盖。
pub fn write_text_with_baseline(
  state: &AppState,
  relative_path: &str,
  content: &str,
  expected_current: Option<&str>,
) -> Result<(), String> {
  write_text_scoped(state, relative_path, content, expected_current, None)
}

pub(crate) fn write_text_scoped(
  state: &AppState,
  relative_path: &str,
  content: &str,
  expected_current: Option<&str>,
  workspace: Option<&str>,
) -> Result<(), String> {
  let root = scoped_workspace(state, workspace)?;
  write_text_internal_with_baseline(&root, relative_path, content, false, "auto-save", expected_current)
}

pub(crate) fn write_text_internal(
  root: &Path,
  relative_path: &str,
  content: &str,
  create_parent_dirs: bool,
  history_reason: &str,
) -> Result<(), String> {
  write_text_internal_with_baseline(root, relative_path, content, create_parent_dirs, history_reason, None)
}

pub(crate) fn write_text_internal_with_baseline(
  root: &Path,
  relative_path: &str,
  content: &str,
  create_parent_dirs: bool,
  history_reason: &str,
  expected_current: Option<&str>,
) -> Result<(), String> {
  let _write_guard = TEXT_WRITE_LOCK.lock().map_err(|_| "file write lock is poisoned".to_string())?;
  if content.len() > MAX_TEXT_BYTES { return Err("普通文本写入超过 16 MiB 上限；原文件未更改。".into()); }
  let rel = validate_relative_path(relative_path)?;
  protect_managed_path(&rel)?;
  super::storyboard::protect_storage(root, &rel)?;
  let screenplay_scene = super::screenplay::check_manuscript_path(root, &rel)?;
  let rel_norm = rel.to_string_lossy().replace('\\', "/");
  let target = checked_workspace_path(root, &rel)?;
  let atomic = screenplay_scene || expected_current.is_some() || history_reason == "restore-backup";

  if rel_norm.starts_with("concept/") && rel_norm.to_lowercase().ends_with(".md") {
    checked_workspace_path(root, Path::new(".novel/.cache/concept_index.json"))?;
  }

  let check_current = |expected: &str| -> Result<(), String> {
    checked_workspace_path(root, &rel)?;
    let current = read_text_bounded(&target).map_err(|e| {
      if e.kind() == std::io::ErrorKind::NotFound {
        "file changed on disk; file was removed before saving".to_string()
      } else { format!("read current file failed: {e}") }
    })?;
    if current != expected {
      return Err("file changed on disk; reload before saving or explicitly overwrite".to_string());
    }
    Ok(())
  };
  if let Some(expected) = expected_current {
    check_current(expected)?;
  }

  if rel_norm == ".novel/.cache/outline.json" {
    let existing = if target.exists() {
      read_text_bounded(&target).map_err(|e| format!("read outline failed: {e}"))?
    } else {
      String::new()
    };
    validate_outline(&existing, content)?;
  }

  if let Some(parent) = target.parent() {
    if create_parent_dirs {
      fs::create_dir_all(parent).map_err(|e| format!("create parent dir failed: {e}"))?;
    } else if !parent.exists() {
      return Err("parent directory does not exist; create it first".to_string());
    }
  }

  let mut previous = None;
  if should_track_history_path(&rel_norm) {
    match expected_current.map_or_else(|| read_text_bounded(&target), |text| Ok(text.to_owned())) {
      Ok(text) => {
        if text != content {
          let snapshot = create_history_snapshot_internal(root, &rel_norm, &text, history_reason);
          if atomic {
            snapshot.map_err(|e| format!("无法保存历史快照；原文件未更改：{e}"))?;
          }
        }
        previous = Some(text);
      }
      Err(e) if atomic && e.kind() != std::io::ErrorKind::NotFound => {
        return Err(format!("无法读取旧文件以建立快照；原文件未更改：{e}"));
      }
      Err(_) => {},
    }
  }
  if atomic {
    super::workspace::replace_file(&target, content.as_bytes(), || {
      checked_workspace_path(root, &rel)?;
      if let Some(expected) = expected_current.or(previous.as_deref()) { check_current(expected)?; }
      Ok(())
    })?;
  } else {
    checked_workspace_path(root, &rel)?;
    fs::write(&target, content).map_err(|e| format!("write failed: {e}"))?;
  }

  if rel_norm.starts_with("concept/") && rel_norm.to_lowercase().ends_with(".md") {
    update_concept_index(root, &rel_norm, content)?;
  }

  Ok(())
}

pub fn create_file(state: &AppState, relative_path: &str) -> Result<(), String> {
  create_file_scoped(state, relative_path, None)
}

pub(crate) fn create_file_scoped(state: &AppState, relative_path: &str, workspace: Option<&str>) -> Result<(), String> {
  let root = scoped_workspace(state, workspace)?;
  let rel = validate_relative_path(&relative_path)?;
  protect_managed_path(&rel)?;
  super::storyboard::protect_storage(&root, &rel)?;
  super::screenplay::check_manuscript_path(&root, &rel)?;
  let target = checked_workspace_path(&root, &rel)?;
  if let Some(parent) = target.parent() {
    if !parent.exists() {
      return Err("parent directory does not exist; create it first".to_string());
    }
  }
  fs::OpenOptions::new().write(true).create_new(true).open(target)
    .map(|_| ()).map_err(|e| format!("create file failed: {e}"))
}

pub fn create_dir(state: &AppState, relative_path: &str) -> Result<(), String> {
  create_dir_scoped(state, relative_path, None)
}

pub(crate) fn create_dir_scoped(state: &AppState, relative_path: &str, workspace: Option<&str>) -> Result<(), String> {
  if relative_path.trim().is_empty() {
    return Err("empty path is not allowed".to_string());
  }
  let root = scoped_workspace(state, workspace)?;
  let rel = validate_relative_path(&relative_path)?;
  protect_managed_path(&rel)?;
  super::storyboard::protect_storage(&root, &rel)?;
  if super::screenplay::in_scene_directory(&rel) && rel.components().count() > 1 && project_kind(&root) == ProjectKind::Screenplay {
    return Err("场次目录不支持子目录。".into());
  }
  let target = checked_workspace_path(&root, &rel)?;
  fs::create_dir_all(target).map_err(|e| format!("create dir failed: {e}"))
}

pub fn delete_entry(state: &AppState, relative_path: &str) -> Result<(), String> {
  delete_entry_scoped(state, relative_path, None)
}

pub(crate) fn delete_entry_scoped(state: &AppState, relative_path: &str, workspace: Option<&str>) -> Result<(), String> {
  if relative_path.trim().is_empty() {
    return Err("empty path is not allowed".to_string());
  }
  let root = scoped_workspace(state, workspace)?;
  let rel = validate_relative_path(&relative_path)?;
  if rel.as_os_str().is_empty() { return Err("不能删除作品根目录。".into()); }
  protect_managed_path(&rel)?;
  super::storyboard::protect_storage(&root, &rel)?;
  if super::screenplay::in_scene_directory(&rel) && project_kind(&root) == ProjectKind::Screenplay {
    return Err("应用不直接删除场次。关闭作品并备份后，可将多余场次移出 scenes/。".into());
  }
  let target = checked_workspace_path(&root, &rel)?;
  let md = fs::metadata(&target).map_err(|e| format!("stat failed: {e}"))?;
  if md.is_dir() {
    fs::remove_dir_all(target).map_err(|e| format!("delete dir failed: {e}"))
  } else {
    fs::remove_file(target).map_err(|e| format!("delete file failed: {e}"))
  }
}

pub fn rename_entry(state: &AppState, from_relative_path: &str, to_relative_path: &str) -> Result<(), String> {
  rename_entry_scoped(state, from_relative_path, to_relative_path, None)
}

pub(crate) fn rename_entry_scoped(state: &AppState, from_relative_path: &str, to_relative_path: &str, workspace: Option<&str>) -> Result<(), String> {
  if from_relative_path.trim().is_empty() || to_relative_path.trim().is_empty() {
    return Err("empty path is not allowed".to_string());
  }
  let root = scoped_workspace(state, workspace)?;
  let from_rel = validate_relative_path(&from_relative_path)?;
  let to_rel = validate_relative_path(&to_relative_path)?;
  protect_managed_path(&from_rel)?;
  protect_managed_path(&to_rel)?;
  super::storyboard::protect_storage(&root, &from_rel)?;
  super::storyboard::protect_storage(&root, &to_rel)?;
  if from_rel.as_os_str().is_empty() || to_rel.as_os_str().is_empty() { return Err("不能重命名作品根目录。".into()); }
  if (super::screenplay::in_scene_directory(&from_rel) || super::screenplay::in_scene_directory(&to_rel)) && project_kind(&root) == ProjectKind::Screenplay {
    return Err("请编辑场次的首行标题；原文件名用于关联场次与素材。".into());
  }
  let from = checked_workspace_path(&root, &from_rel)?;
  let to = checked_workspace_path(&root, &to_rel)?;
  if let Ok(meta) = fs::symlink_metadata(&to) {
    // A case-only rename on a case-insensitive file system may refer to the source itself.
    if meta.file_type().is_symlink() || fs::canonicalize(&from).ok() != fs::canonicalize(&to).ok() {
      return Err("目标路径已存在，未覆盖。".into());
    }
  }
  if let Some(parent) = to.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {e}"))?;
  }
  fs::rename(from, to).map_err(|e| format!("rename failed: {e}"))
}

// ---- 由 commands.rs 等价搬移（工作区文件树）----
fn build_tree(root: &Path, path: &Path, max_depth: usize) -> Result<FsEntry, String> {
  let meta = fs::metadata(path).map_err(|e| format!("metadata failed: {e}"))?;
  let name = if path == root {
    root
      .file_name()
      .map(|s| s.to_string_lossy().to_string())
      .unwrap_or_else(|| root.to_string_lossy().to_string())
  } else {
    path
      .file_name()
      .map(|s| s.to_string_lossy().to_string())
      .unwrap_or_else(|| path.to_string_lossy().to_string())
  };
  let rel_path = path
    .strip_prefix(root)
    .unwrap_or(path)
    .to_string_lossy()
    .to_string()
    .replace('\\', "/");

  if meta.is_dir() {
    if max_depth == 0 {
      return Ok(FsEntry {
        name,
        path: rel_path,
        kind: "dir".to_string(),
        children: vec![],
      });
    }

    let mut children: Vec<FsEntry> = vec![];
    for entry in fs::read_dir(path).map_err(|e| format!("read dir failed: {e}"))? {
      let entry = entry.map_err(|e| format!("read dir entry failed: {e}"))?;
      if !entry.file_type().is_ok_and(|kind| kind.is_file() || kind.is_dir()) { continue; }
      let child_path = entry.path();
      if checked_workspace_path(root, child_path.strip_prefix(root).map_err(|e| e.to_string())?).is_err() { continue; }
      let child = build_tree(root, &child_path, max_depth - 1)?;
      children.push(child);
    }

    children.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
      ("dir", "file") => std::cmp::Ordering::Less,
      ("file", "dir") => std::cmp::Ordering::Greater,
      _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(FsEntry {
      name,
      path: rel_path,
      kind: "dir".to_string(),
      children,
    })
  } else {
    Ok(FsEntry {
      name,
      path: rel_path,
      kind: "file".to_string(),
      children: vec![],
    })
  }
}
