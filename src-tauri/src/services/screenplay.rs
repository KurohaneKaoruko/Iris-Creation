//! One Markdown file per scene. Ordering is stored separately so reordering never renames a scene.
use super::bookshelf::{project_kind, work_meta_path, ProjectKind};
use super::workspace::{managed_dir, replace_file, write_file_if_absent, write_new_file};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const ORDER_FILE: &str = "scene-order.json";
const FIRST_SCENE: &str = "scene-0001-opening.md";
const MAX_MANUSCRIPT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ORDER_BYTES: usize = 1024 * 1024;
static SCENE_MUTATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub(crate) struct Scene {
  pub path: String,
  pub title: String,
  pub setting: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Interior {
  Interior,
  Exterior,
  Both,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SceneDraft {
  title: Option<String>,
  interior: Option<Interior>,
  location: Option<String>,
  time: Option<String>,
  body: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SceneOrder {
  version: u8,
  paths: Vec<String>,
}

pub(crate) fn init(root: &Path) -> Result<(), String> {
  for name in ["scenes", "concept", "outline"] {
    fs::create_dir(root.join(name)).map_err(|e| format!("创建剧本目录失败：{e}"))?;
  }
  write_file_if_absent(&work_meta_path(root), "{\n  \"kind\": \"screenplay\",\n  \"description\": null\n}\n")?;
  write_file_if_absent(&root.join("outline/outline.md"), "# 分场大纲\n\n## 故事核心\n\n- 一句话梗概：\n- 主要冲突：\n\n## 场次规划\n\n- 开场：\n- 发展：\n- 高潮：\n- 收束：\n")?;
  write_file_if_absent(&root.join("concept/characters.md"), "# 人物表\n\n## 主角\n\n- 欲望与阻碍：\n- 说话习惯：\n- 与其他人物的关系：\n")?;
  write_file_if_absent(&root.join("scenes").join(FIRST_SCENE), "# 开场\n\n**内景 · 待定 · 日**\n\n")
}

pub(crate) fn is_scene_file(path: &Path) -> bool {
  path.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
    !name.starts_with('.') && !name.contains(['\\', ':']) &&
      path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
  })
}

fn require_screenplay(root: &Path) -> Result<(), String> {
  if project_kind(root) == ProjectKind::Screenplay { Ok(()) }
  else { Err("当前作品不是剧本。".into()) }
}

fn scene_directory(root: &Path) -> Result<PathBuf, String> {
  managed_dir(root, &["scenes"], false)?.ok_or_else(|| "未找到作品的 scenes/ 场次目录。".into())
}

pub(crate) fn in_scene_directory(relative: &Path) -> bool {
  relative.components().next().and_then(|part| part.as_os_str().to_str())
    .is_some_and(|part| part.eq_ignore_ascii_case("scenes"))
}

/// For screenplay scene reads/saves, avoid following links or letting the flat scene store become nested.
/// The existing editor uses the same text RPCs for both kinds of project.
pub(crate) fn check_manuscript_path(root: &Path, relative: &Path) -> Result<bool, String> {
  if !in_scene_directory(relative) || project_kind(root) != ProjectKind::Screenplay { return Ok(false); }
  let relative = relative.strip_prefix("scenes").map_err(|_| "请使用 scenes/ 场次路径。")?;
  if relative.components().count() != 1 || !is_scene_file(relative) { return Err("场次须为 scenes/ 的直属 Markdown 文件。".into()); }
  let path = scene_directory(root)?.join(relative);
  match fs::symlink_metadata(path) {
    Ok(meta) if !meta.is_file() => Err("场次必须是普通文件，不能是链接。".into()),
    Ok(_) => Ok(true),
    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
    Err(e) => Err(format!("检查场次文件失败：{e}")),
  }
}

fn order_path(root: &Path, create: bool) -> Result<Option<PathBuf>, String> {
  Ok(managed_dir(root, &[".novel", ".settings"], create)?.map(|path| path.join(ORDER_FILE)))
}

fn scene_number(path: &str) -> Option<u32> {
  let tail = path.strip_prefix("scenes/scene-")?;
  tail.split(['-', '.']).next()?.parse().ok()
}

fn disk_paths(root: &Path) -> Result<Vec<String>, String> {
  let mut paths = Vec::new();
  for entry in fs::read_dir(scene_directory(root)?).map_err(|e| format!("读取场次列表失败：{e}"))? {
    let entry = entry.map_err(|e| format!("读取场次列表失败：{e}"))?;
    if !entry.file_type().map_err(|e| format!("检查场次文件失败：{e}"))?.is_file() || !is_scene_file(&entry.path()) { continue; }
    paths.push(format!("scenes/{}", entry.file_name().to_string_lossy()));
  }
  paths.sort_by(|a, b| scene_number(a).unwrap_or(u32::MAX).cmp(&scene_number(b).unwrap_or(u32::MAX)).then(a.cmp(b)));
  Ok(paths)
}

fn load_order(root: &Path) -> Result<Vec<String>, String> {
  let Some(path) = order_path(root, false)? else { return Ok(Vec::new()); };
  let meta = match fs::symlink_metadata(&path) {
    Ok(meta) => meta,
    Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("读取场次顺序失败：{e}")),
  };
  if !meta.is_file() || meta.len() > MAX_ORDER_BYTES as u64 {
    return Err("场次顺序文件不是普通文件或超过大小限制，未覆盖。".into());
  }
  let file = fs::File::open(path).map_err(|e| format!("读取场次顺序失败：{e}"))?;
  let order: SceneOrder = serde_json::from_reader(file.take(MAX_ORDER_BYTES as u64 + 1))
    .map_err(|_| "场次顺序文件无法读取，未覆盖。")?;
  if order.version != 1 { return Err("不支持此场次顺序文件版本，未覆盖。".into()); }
  Ok(order.paths)
}

fn ordered_paths(root: &Path) -> Result<Vec<String>, String> {
  let files = disk_paths(root)?;
  let mut remaining: std::collections::HashSet<_> = files.iter().map(String::as_str).collect();
  let mut paths = load_order(root)?;
  // Match only actual scene paths, so deleted files/duplicates in metadata never appear.
  paths.retain(|path| remaining.remove(path.as_str()));
  paths.extend(files.iter().filter(|path| remaining.contains(path.as_str())).cloned());
  Ok(paths)
}

fn scene_text(text: &str) -> (Option<&str>, &str) {
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let text = text.trim_start_matches(['\r', '\n', ' ', '\t']);
  let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
  if let Some(title) = first.strip_prefix("# ").or_else(|| first.strip_prefix("#\t")).map(str::trim).filter(|title| !title.is_empty()) {
    (Some(title), rest)
  } else {
    (None, text)
  }
}

fn scene_info(path: String, text: &str) -> Scene {
  let title: String = scene_text(text).0.unwrap_or_else(|| {
    Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("未命名场次")
  }).chars().take(120).collect();
  let setting = text.lines().take(12).find_map(|line| {
    let value = line.trim().strip_prefix("**")?.strip_suffix("**")?;
    if ["内景 · ", "外景 · ", "内/外景 · "].iter().any(|prefix| value.starts_with(prefix)) {
      Some(value.chars().take(160).collect())
    } else { None }
  });
  Scene { path, title, setting }
}

pub(crate) fn list(root: &Path) -> Result<Vec<Scene>, String> {
  require_screenplay(root)?;
  ordered_paths(root)?.into_iter().map(|path| {
    let mut prefix = Vec::new();
    // A bounded header read keeps the board/quick-open cheap even for long manuscripts.
    fs::File::open(root.join(&path)).and_then(|file| file.take(4096).read_to_end(&mut prefix))
      .map_err(|e| format!("无法读取 {path}：{e}"))?;
    Ok(scene_info(path, &String::from_utf8_lossy(&prefix)))
  }).collect()
}

pub(crate) fn read_reference(root: &Path, input: &str) -> Result<String, String> {
  let rel = super::workspace::validate_relative_path(input)?;
  let parts: Vec<_> = rel.components().map(|part| part.as_os_str().to_string_lossy()).collect();
  if parts.len() < 2 || parts.iter().any(|part| part.starts_with('.') || part.contains(['\\', ':'])) ||
    !matches!(parts[0].as_ref(), "scenes" | "concept" | "outline") ||
    !rel.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt")) {
    return Err("只能读取作品的分场、设定和大纲文本。".into());
  }
  let path = root.join(&rel);
  let real = fs::canonicalize(&path).map_err(|e| format!("读取剧本资料失败：{e}"))?;
  if real != path || !real.is_file() { return Err("资料须为作品中的普通文件。".into()); }
  let mut bytes = Vec::new();
  fs::File::open(real).and_then(|file| file.take(48 * 1024 + 1).read_to_end(&mut bytes))
    .map_err(|e| format!("读取剧本资料失败：{e}"))?;
  let truncated = bytes.len() > 48 * 1024;
  bytes.truncate(48 * 1024);
  let mut text = String::from_utf8_lossy(&bytes).into_owned();
  if truncated { text.push_str("\n\n[资料过长：仅提供文件前 48 KiB]"); }
  Ok(text)
}

fn line_field(field: Option<String>, label: &str, width: usize) -> Result<String, String> {
  let value = field.as_deref().unwrap_or("").trim();
  if value.chars().count() > width || value.chars().any(char::is_control) {
    return Err(format!("{label}须为单行，最多 {width} 字。"));
  }
  Ok(value.to_owned())
}

pub(crate) fn create(root: &Path, draft: SceneDraft) -> Result<Scene, String> {
  require_screenplay(root)?;
  let title = line_field(draft.title, "标题", 100)?;
  let location = line_field(draft.location, "地点", 80)?;
  let time = line_field(draft.time, "时间", 32)?;
  let body = draft.body.unwrap_or_default();
  if body.len() > 256 * 1024 { return Err("单次新建场次的正文不能超过 256 KiB。".into()); }
  let _lock = SCENE_MUTATION.lock().map_err(|_| "场次写入锁不可用。")?;
  let number = disk_paths(root)?.iter().filter_map(|path| scene_number(path)).max().unwrap_or(0)
    .checked_add(1).ok_or("场次编号过大。")?;
  let title = if title.is_empty() { format!("场次 {number}") } else { title };
  let mut text = format!("# {title}\n\n");
  if let Some(interior) = draft.interior {
    let place = if location.is_empty() { "待定" } else { &location };
    let time = if time.is_empty() { "待定" } else { &time };
    let interior = match interior { Interior::Interior => "内景", Interior::Exterior => "外景", Interior::Both => "内/外景" };
    text.push_str(&format!("**{interior} · {place} · {time}**\n\n"));
  }
  if !body.trim().is_empty() { text.push_str(body.trim_end()); text.push('\n'); }
  let path = format!("scenes/scene-{number:04}-{}.md", Uuid::new_v4().simple());
  let target = root.join(&path);
  write_new_file(&target, text.as_bytes()).map_err(|e| format!("新建场次失败：{e}"))?;
  Ok(scene_info(path, &text))
}

pub(crate) fn reorder(root: &Path, expected: &[String], paths: Vec<String>) -> Result<(), String> {
  require_screenplay(root)?;
  let _lock = SCENE_MUTATION.lock().map_err(|_| "场次写入锁不可用。")?;
  let current = ordered_paths(root)?;
  if current != expected { return Err("场次列表已变化，请刷新后再调整顺序。".into()); }
  let mut old: Vec<_> = current.iter().collect();
  let mut new: Vec<_> = paths.iter().collect();
  old.sort_unstable();
  new.sort_unstable();
  if old != new { return Err("新的场次顺序必须恰好包含当前所有场次。".into()); }
  let raw = serde_json::to_vec_pretty(&SceneOrder { version: 1, paths }).map_err(|e| e.to_string())?;
  if raw.len() > MAX_ORDER_BYTES { return Err("场次顺序文件超过大小限制。".into()); }
  let path = order_path(root, true)?.ok_or("场次设置目录不可用。")?;
  replace_file(&path, &raw, || {
    if ordered_paths(root)? != current { return Err("场次列表已变化，请刷新后再调整顺序。".into()); }
    Ok(())
  })
}

pub(crate) fn export(root: &Path, name: &str, format: &str) -> Result<String, String> {
  if !matches!(format, "md" | "txt") { return Err("剧本仅支持 Markdown 和 TXT 导出。".into()); }
  let paths = ordered_paths(root)?;
  if paths.is_empty() { return Err("还没有可导出的场次。".into()); }
  let md = format == "md";
  let mut out = if md { format!("# {name}\n") } else { format!("{name}\n") };
  for (index, path) in paths.into_iter().enumerate() {
    let mut raw = String::new();
    fs::File::open(root.join(&path)).and_then(|file| file.take(MAX_MANUSCRIPT_BYTES as u64 + 1).read_to_string(&mut raw))
      .map_err(|e| format!("无法导出 {path}：{e}"))?;
    if out.len().saturating_add(raw.len()) > MAX_MANUSCRIPT_BYTES {
      return Err("剧本超出单次导出的 16 MiB 上限；原文件未变更。".into());
    }
    let info = scene_info(path, &raw);
    out.push_str(&format!("\n{}第 {} 场 · {}\n\n", if md { "## " } else { "" }, index + 1, info.title));
    let body = scene_text(&raw).1.trim_matches(['\r', '\n']);
    if md {
      out.push_str(body);
    } else {
      for line in body.lines() {
        // Keep literal Markdown elsewhere, removing only the scene-heading / speaker prefix syntax.
        if let Some((prefix, rest)) = line.strip_prefix("**").and_then(|text| text.split_once("**")) {
          if prefix.ends_with(['：', ':']) || (rest.is_empty() && prefix.contains(" · ")) {
            out.push_str(prefix);
            out.push_str(rest);
          } else { out.push_str(line); }
        } else { out.push_str(line); }
        out.push('\n');
      }
    }
    if !out.ends_with('\n') { out.push('\n'); }
    if out.len() > MAX_MANUSCRIPT_BYTES { return Err("剧本超出单次导出的 16 MiB 上限；原文件未变更。".into()); }
  }
  Ok(out)
}

pub(crate) fn save_export(root: &Path, format: &str) -> Result<String, String> {
  require_screenplay(root)?;
  let name = root.file_name().and_then(|name| name.to_str()).unwrap_or("未命名作品");
  let text = export(root, name, format)?;
  managed_dir(root, &["exports"], true)?;
  let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
  let id = Uuid::new_v4().simple().to_string();
  let path = format!("exports/screenplay-{stamp}-{}.{format}", &id[..8]);
  write_new_file(&root.join(&path), text.as_bytes()).map_err(|e| format!("保存剧本导出失败：{e}"))?;
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  struct Project(PathBuf);

  impl Project {
    fn new() -> Self {
      let path = std::env::temp_dir().join(format!("iris-screenplay-{}", Uuid::new_v4()));
      fs::create_dir(&path).unwrap();
      let project = Self(path.canonicalize().unwrap());
      init(&project.0).unwrap();
      project
    }
  }

  impl Drop for Project {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
  }

  #[test]
  fn creation_and_reorder_keep_stable_files_and_export_the_same_order() {
    let project = Project::new();
    let root = &project.0;
    assert!(!root.join("stories").exists());
    let scene = create(root, serde_json::from_value(json!({
      "title": "雨后的码头", "interior": "exterior", "location": "码头", "time": "黄昏", "body": "**林雀：** 把灯留下。\n\n她挥手。"
    })).unwrap()).unwrap();
    assert_eq!(scene.setting.as_deref(), Some("外景 · 码头 · 黄昏"));
    let paths: Vec<_> = list(root).unwrap().into_iter().map(|s| s.path).collect();
    let reverse = paths.iter().rev().cloned().collect();
    reorder(root, &paths, reverse).unwrap();
    assert!(reorder(root, &paths, paths.clone()).is_err());
    assert_eq!(list(root).unwrap()[0].path, scene.path);
    assert!(root.join(&paths[0]).is_file());
    assert!(root.join(&paths[1]).is_file());
    let md = export(root, "夜航", "md").unwrap();
    assert!(md.contains("## 第 1 场 · 雨后的码头\n\n**外景 · 码头 · 黄昏**\n\n**林雀：** 把灯留下。"));
    assert!(md.contains("## 第 2 场 · 开场"));
    assert!(!md.contains("# 雨后的码头"));
    assert!(export(root, "夜航", "txt").unwrap().contains("林雀： 把灯留下。\n\n她挥手。"));
    let third = create(root, serde_json::from_value(json!({})).unwrap()).unwrap();
    assert_eq!(list(root).unwrap()[2].path, third.path);
    let expected: Vec<_> = list(root).unwrap().into_iter().map(|s| s.path).collect();
    let mut next = expected.clone();
    next.rotate_right(1);
    reorder(root, &expected, next.clone()).unwrap();
    assert_eq!(ordered_paths(root).unwrap(), next);
  }

  #[test]
  fn invalid_order_cannot_replace_existing_order_or_inject_paths() {
    let project = Project::new();
    let paths: Vec<_> = list(&project.0).unwrap().into_iter().map(|s| s.path).collect();
    assert!(reorder(&project.0, &paths, vec!["../not-a-scene.md".into()]).is_err());
    let file = order_path(&project.0, true).unwrap().unwrap();
    fs::write(&file, "broken").unwrap();
    assert!(reorder(&project.0, &paths, paths.clone()).is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), "broken");
  }

  #[test]
  fn exports_are_new_files_and_crlf_dialogue_survives() {
    let project = Project::new();
    let scene = project.0.join("scenes").join(FIRST_SCENE);
    let content = "\u{feff}\r\n# 雨夜\r\n\r\n**外景 · 天台 · 夜**\r\n\r\n**苏青：** 等等。\r\n**苏青：** 再等一会儿。\r\n\r\n灯光慢慢熄灭。\r\n";
    fs::write(&scene, content).unwrap();
    assert_eq!(list(&project.0).unwrap()[0].title, "雨夜");
    let first = save_export(&project.0, "txt").unwrap();
    let second = save_export(&project.0, "txt").unwrap();
    assert_ne!(first, second);
    let result = fs::read_to_string(project.0.join(first)).unwrap();
    assert!(result.contains("第 1 场 · 雨夜\n\n外景 · 天台 · 夜\n\n苏青： 等等。\n苏青： 再等一会儿。\n\n灯光慢慢熄灭。"));
    assert_eq!(fs::read_to_string(scene).unwrap(), content);
  }

  #[cfg(unix)]
  #[test]
  fn scene_list_and_export_skip_linked_files() {
    let project = Project::new();
    let other = Project::new();
    std::os::unix::fs::symlink(other.0.join("scenes").join(FIRST_SCENE), project.0.join("scenes/linked.md")).unwrap();
    assert_eq!(list(&project.0).unwrap().len(), 1);
    assert!(!export(&project.0, "剧本", "md").unwrap().contains("第 2 场"));
  }
}
