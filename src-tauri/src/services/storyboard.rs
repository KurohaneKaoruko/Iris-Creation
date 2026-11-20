//! Scene-linked shot lists and local reference images. No model requests here.
use super::{local_assets::{self, AssetRole, ReferenceAsset}, screenplay, workspace};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path, sync::Mutex};
use uuid::Uuid;

const BOARD_PATH: &str = "creative/storyboard.json";
const BOARD_LIMIT: usize = 1024 * 1024;
const MAX_SHOTS: usize = 2000;
const MAX_ASSETS: usize = 500;
static MUTATION: Mutex<()> = Mutex::new(());

/// Keep generic file actions from bypassing storyboard revisions or deleting source images.
pub(crate) fn protect_storage(root: &Path, relative: &Path) -> Result<(), String> {
  let mut parts = relative.components().filter_map(|part| part.as_os_str().to_str());
  if !parts.next().is_some_and(|part| part.eq_ignore_ascii_case("creative")) {
    return Ok(());
  }
  let managed = parts.next().is_none_or(|part| part.eq_ignore_ascii_case("storyboard.json") || part.eq_ignore_ascii_case("references"));
  if managed && super::bookshelf::project_kind(root) == super::bookshelf::ProjectKind::Screenplay {
    return Err("此目录或文件由分镜与素材工具管理，不能通过普通文件操作改写或删除。".into());
  }
  Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Framing { Wide, Medium, CloseUp, ExtremeCloseUp, OverShoulder, PointOfView, Insert }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CameraMove { Static, Pan, Tilt, Dolly, Track, Handheld, Zoom }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Shot {
  pub id: Uuid,
  pub scene_path: String,
  pub title: String,
  pub action: String,
  pub dialogue: String,
  pub framing: Framing,
  pub camera_move: CameraMove,
  pub duration: u8,
  pub asset_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShotDraft {
  pub id: Option<Uuid>,
  pub scene_path: String,
  pub title: String,
  pub action: String,
  pub dialogue: String,
  pub framing: Framing,
  pub camera_move: CameraMove,
  pub duration: u8,
  pub asset_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Board { version: u8, shots: Vec<Shot>, assets: Vec<ReferenceAsset> }

impl Default for Board {
  fn default() -> Self { Self { version: 1, shots: Vec::new(), assets: Vec::new() } }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetView {
  #[serde(flatten)]
  asset: ReferenceAsset,
  available: bool,
  path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardView {
  pub revision: Option<String>,
  pub shots: Vec<Shot>,
  pub assets: Vec<AssetView>,
  pub unlinked_scene_paths: Vec<String>,
}

fn text(value: &str, label: &str, max: usize, multiline: bool) -> Result<(), String> {
  if value.chars().count() > max || value.chars().any(|ch| ch.is_control() && !(multiline && matches!(ch, '\n' | '\r' | '\t'))) {
    return Err(format!("{label}超过长度或含有不支持的控制字符。"));
  }
  Ok(())
}

fn scene_path(path: &str) -> bool {
  let Some(name) = path.strip_prefix("scenes/") else { return false; };
  !name.starts_with('.') && !name.contains(['/', '\\', ':']) && !name.chars().any(char::is_control)
    && Path::new(name).extension().and_then(|ext| ext.to_str()).is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn validate(board: &Board) -> Result<(), String> {
  if board.version != 1 { return Err("不支持此分镜文件版本，未覆盖。".into()); }
  if board.shots.len() > MAX_SHOTS || board.assets.len() > MAX_ASSETS { return Err("每个作品最多保存 2000 个镜头和 500 项素材。".into()); }
  let mut assets = HashSet::new();
  for asset in &board.assets {
    if !assets.insert(asset.id) { return Err("素材 ID 重复，未覆盖。".into()); }
    text(&asset.name, "素材名称", 100, false)?;
    text(&asset.original_name, "原文件名", 255, false)?;
    text(&asset.notes, "素材说明", 1000, true)?;
    if asset.name.trim().is_empty() || asset.bytes == 0 || asset.bytes > local_assets::IMPORT_LIMIT as u64
      || asset.width == 0 || asset.height == 0 || asset.width > 12000 || asset.height > 12000
      || u64::from(asset.width) * u64::from(asset.height) > 24_000_000 {
      return Err("素材字段无效，未覆盖。".into());
    }
    for hash in [&asset.hash, &asset.preview_hash] {
      if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("素材校验值无效，未覆盖。".into()); }
    }
  }
  let mut ids = HashSet::new();
  for shot in &board.shots {
    if !ids.insert(shot.id) { return Err("镜头 ID 重复，未覆盖。".into()); }
    text(&shot.title, "镜头标题", 120, false)?;
    text(&shot.action, "画面动作", 8000, true)?;
    text(&shot.dialogue, "对白／声音", 8000, true)?;
    if shot.title.trim().is_empty() || !scene_path(&shot.scene_path) || !(1..=60).contains(&shot.duration) {
      return Err("镜头标题、场次或时长无效，未覆盖。".into());
    }
    let unique: HashSet<_> = shot.asset_ids.iter().collect();
    if shot.asset_ids.len() > 8 || unique.len() != shot.asset_ids.len() || shot.asset_ids.iter().any(|id| !assets.contains(id)) {
      return Err("镜头关联的素材不存在、重复或超过 8 项。".into());
    }
  }
  Ok(())
}

fn read(root: &Path) -> Result<(Board, Option<Vec<u8>>), String> {
  if super::bookshelf::project_kind(root) != super::bookshelf::ProjectKind::Screenplay { return Err("分镜仅适用于剧本作品。".into()); }
  if workspace::managed_dir(root, &["creative"], false)?.is_none() { return Ok((Board::default(), None)); }
  let raw = local_assets::read_limited(&root.join(BOARD_PATH), BOARD_LIMIT)?;
  let board = match &raw {
    Some(bytes) => serde_json::from_slice(bytes).map_err(|_| "分镜文件损坏或含有未知字段；未覆盖原文件。")?,
    None => Board::default(),
  };
  validate(&board)?;
  Ok((board, raw))
}

fn revision(raw: Option<&[u8]>) -> Option<String> { raw.map(|raw| blake3::hash(raw).to_hex().to_string()) }

fn view(root: &Path, board: Board, revision: Option<String>) -> Result<BoardView, String> {
  let scenes: HashSet<_> = screenplay::list(root)?.into_iter().map(|scene| scene.path).collect();
  let mut unlinked_scene_paths: Vec<_> = board.shots.iter().filter(|shot| !scenes.contains(&shot.scene_path)).map(|shot| shot.scene_path.clone()).collect();
  unlinked_scene_paths.sort(); unlinked_scene_paths.dedup();
  let assets = board.assets.into_iter().map(|asset| AssetView {
    available: local_assets::available(root, &asset), path: asset.relative_path(), asset,
  }).collect();
  Ok(BoardView { revision, shots: board.shots, assets, unlinked_scene_paths })
}

fn checked(root: &Path, expected: Option<&str>) -> Result<(Board, Option<Vec<u8>>), String> {
  let (board, raw) = read(root)?;
  if revision(raw.as_deref()).as_deref() != expected { return Err("分镜已被其他窗口或程序修改；草稿未覆盖，请先复制草稿再重新读取。".into()); }
  Ok((board, raw))
}

fn commit(root: &Path, previous: Option<&[u8]>, board: Board) -> Result<BoardView, String> {
  validate(&board)?;
  let mut bytes = serde_json::to_vec_pretty(&board).map_err(|e| e.to_string())?;
  bytes.push(b'\n');
  if bytes.len() > BOARD_LIMIT { return Err("分镜超过 1 MiB；请缩短镜头说明，原文件未变化。".into()); }
  let expected = revision(previous);
  workspace::managed_dir(root, &["creative"], true)?;
  if let Some(previous) = previous.filter(|raw| *raw != bytes.as_slice()) {
    let previous = std::str::from_utf8(previous).map_err(|_| "分镜文件编码无效。")?;
    workspace::create_history_snapshot_internal(root, BOARD_PATH, previous, "storyboard-edit")?;
  }
  // Return our saved snapshot, not another writer's potentially newer state.
  let response = view(root, board, revision(Some(&bytes)))?;
  workspace::replace_file(&root.join(BOARD_PATH), &bytes, || {
    workspace::managed_dir(root, &["creative"], false)?.ok_or("分镜目录已移除。")?;
    checked(root, expected.as_deref())?;
    Ok(())
  })?;
  Ok(response)
}

pub(crate) fn load(root: &Path) -> Result<BoardView, String> {
  let (board, raw) = read(root)?;
  view(root, board, revision(raw.as_deref()))
}

pub(crate) fn save_shot(root: &Path, expected: Option<&str>, draft: ShotDraft) -> Result<BoardView, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (mut board, raw) = checked(root, expected)?;
  if !screenplay::list(root)?.iter().any(|scene| scene.path == draft.scene_path) { return Err("所选场次已移除或更名，请重新关联。".into()); }
  let id = draft.id.unwrap_or_else(Uuid::new_v4);
  let shot = Shot { id, scene_path: draft.scene_path, title: draft.title.trim().into(), action: draft.action, dialogue: draft.dialogue,
    framing: draft.framing, camera_move: draft.camera_move, duration: draft.duration, asset_ids: draft.asset_ids };
  if let Some(existing) = board.shots.iter_mut().find(|shot| shot.id == id) { *existing = shot; }
  else {
    if draft.id.is_some() { return Err("原镜头已被移除，不能直接重新创建。".into()); }
    board.shots.push(shot);
  }
  commit(root, raw.as_deref(), board)
}

pub(crate) fn remove_shot(root: &Path, expected: Option<&str>, id: Uuid) -> Result<BoardView, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (mut board, raw) = checked(root, expected)?;
  let before = board.shots.len();
  board.shots.retain(|shot| shot.id != id);
  if board.shots.len() == before { return Err("镜头已不存在。".into()); }
  commit(root, raw.as_deref(), board)
}

pub(crate) fn reorder(root: &Path, expected: Option<&str>, expected_ids: Vec<Uuid>, ids: Vec<Uuid>) -> Result<BoardView, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (mut board, raw) = checked(root, expected)?;
  if board.shots.iter().map(|shot| shot.id).collect::<Vec<_>>() != expected_ids { return Err("镜头列表已变化，请刷新后再调整。".into()); }
  let mut old = expected_ids; let mut new = ids.clone(); old.sort_unstable(); new.sort_unstable();
  if old != new { return Err("新顺序须恰好包含全部镜头，不可重复。".into()); }
  let mut lookup: std::collections::HashMap<_, _> = board.shots.into_iter().map(|shot| (shot.id, shot)).collect();
  board.shots = ids.into_iter().filter_map(|id| lookup.remove(&id)).collect();
  commit(root, raw.as_deref(), board)
}

pub(crate) fn import_image(root: &Path, expected: Option<&str>, shot_id: Option<Uuid>, role: AssetRole, name: String, original_name: String, bytes: &[u8]) -> Result<BoardView, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (mut board, raw) = checked(root, expected)?;
  if board.assets.len() >= MAX_ASSETS { return Err("每个作品最多保存 500 项参考图。".into()); }
  let target = shot_id.map(|id| board.shots.iter_mut().find(|shot| shot.id == id).ok_or("目标镜头不存在。")).transpose()?;
  if target.as_ref().is_some_and(|shot| shot.asset_ids.len() >= 8) { return Err("每个镜头最多关联 8 项素材。".into()); }
  text(&name, "素材名称", 100, false)?; text(&original_name, "原文件名", 255, false)?;
  if name.trim().is_empty() { return Err("素材名称不能为空。".into()); }
  let prepared = local_assets::prepare(bytes, name.trim().into(), original_name, role)?;
  if let Some(shot) = target { shot.asset_ids.push(prepared.asset.id); }
  board.assets.push(prepared.asset.clone());
  validate(&board)?;
  local_assets::store(root, &prepared, bytes)?;
  match commit(root, raw.as_deref(), board) {
    Ok(board) => Ok(board),
    Err(error) => { local_assets::rollback_import(root, &prepared.asset); Err(error) }
  }
}

pub(crate) fn detach_asset(root: &Path, expected: Option<&str>, id: Uuid) -> Result<BoardView, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (mut board, raw) = checked(root, expected)?;
  let before = board.assets.len(); board.assets.retain(|asset| asset.id != id);
  if before == board.assets.len() { return Err("素材已不存在。".into()); }
  for shot in &mut board.shots { shot.asset_ids.retain(|asset| *asset != id); }
  commit(root, raw.as_deref(), board)
}

pub(crate) fn preview_asset(root: &Path, id: Uuid) -> Result<local_assets::ImagePreview, String> {
  let (board, _) = read(root)?;
  let asset = board.assets.iter().find(|asset| asset.id == id).ok_or("素材不存在或已从分镜移除。")?;
  local_assets::preview(root, asset)
}

pub(crate) fn export(root: &Path, expected: Option<&str>) -> Result<String, String> {
  let _guard = MUTATION.lock().map_err(|_| "分镜编辑锁不可用。")?;
  let (board, _) = checked(root, expected)?;
  let scenes = screenplay::list(root)?;
  let mut content = String::from("# 分镜清单\n\n仅包含已保存的镜头与素材关联；不是成片。时长为规划值。\n");
  for (index, shot) in board.shots.iter().enumerate() {
    let scene = scenes.iter().find(|scene| scene.path == shot.scene_path).map(|scene| scene.title.as_str()).unwrap_or("已失联场次");
    content.push_str(&format!("\n## {:03} · {}\n\n场次：{}\n\n源文件：`{}`\n\n景别：{} · 运镜：{} · 时长：{} 秒\n\n{}\n\n{}\n", index + 1, shot.title, scene, shot.scene_path, shot.framing.label(), shot.camera_move.label(), shot.duration, shot.action, shot.dialogue));
    for id in &shot.asset_ids {
      let asset = board.assets.iter().find(|asset| asset.id == *id).ok_or("素材关联失效。")?;
      content.push_str(&format!("\n- {}：`../{}`\n", asset.name, asset.relative_path()));
    }
  }
  workspace::managed_dir(root, &["exports"], true)?;
  let name = format!("exports/storyboard-{}-{}.md", chrono::Local::now().format("%Y%m%d-%H%M%S"), Uuid::new_v4().simple());
  workspace::write_new_file(&root.join(&name), content.as_bytes()).map_err(|e| format!("导出分镜失败：{e}"))?;
  Ok(name)
}

impl Framing { fn label(self) -> &'static str { match self { Self::Wide => "远景", Self::Medium => "中景", Self::CloseUp => "近景", Self::ExtremeCloseUp => "大特写", Self::OverShoulder => "过肩", Self::PointOfView => "主观", Self::Insert => "插入特写" } } }
impl CameraMove { fn label(self) -> &'static str { match self { Self::Static => "固定", Self::Pan => "摇镜", Self::Tilt => "俯仰", Self::Dolly => "推拉", Self::Track => "跟拍", Self::Handheld => "手持", Self::Zoom => "变焦" } } }

#[cfg(test)]
mod tests {
  use super::*;
  use std::{fs, path::PathBuf};

  struct Project(PathBuf);
  impl Project {
    fn new() -> Self {
      let path = std::env::temp_dir().join(format!("iris-storyboard-{}", Uuid::new_v4()));
      fs::create_dir(&path).unwrap();
      let project = Self(path.canonicalize().unwrap());
      screenplay::init(&project.0).unwrap();
      project
    }
    fn scene(&self) -> String { screenplay::list(&self.0).unwrap()[0].path.clone() }
    fn draft(&self, title: &str) -> ShotDraft {
      ShotDraft { id: None, scene_path: self.scene(), title: title.into(), action: "灯光亮起。".into(),
        dialogue: "林雀：把灯留下。".into(), framing: Framing::Wide, camera_move: CameraMove::Static,
        duration: 5, asset_ids: Vec::new() }
    }
  }
  impl Drop for Project { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

  #[test]
  fn stale_writes_and_duplicate_order_cannot_change_disk() {
    let p = Project::new();
    assert!(load(&p.0).unwrap().revision.is_none());
    let first = save_shot(&p.0, None, p.draft("开场")).unwrap();
    let second = save_shot(&p.0, first.revision.as_deref(), p.draft("车站")).unwrap();
    assert!(save_shot(&p.0, first.revision.as_deref(), p.draft("旧草稿")).is_err());
    let ids: Vec<_> = second.shots.iter().map(|shot| shot.id).collect();
    let before = fs::read(p.0.join(BOARD_PATH)).unwrap();
    assert!(reorder(&p.0, second.revision.as_deref(), ids.clone(), vec![ids[0], ids[0]]).is_err());
    assert_eq!(fs::read(p.0.join(BOARD_PATH)).unwrap(), before);
    let sorted = reorder(&p.0, second.revision.as_deref(), ids.clone(), ids.iter().rev().copied().collect()).unwrap();
    assert_eq!(sorted.shots[0].title, "车站");
    assert_eq!(sorted.shots[0].id, ids[1]);
    assert!(workspace::list_history_entries(&p.0, None).unwrap().iter().any(|entry| entry.file_path == BOARD_PATH));
  }

  #[test]
  fn scene_titles_and_external_scene_removal_preserve_shots() {
    let p = Project::new();
    let scene = p.scene();
    let saved = save_shot(&p.0, None, p.draft("稳定标识")).unwrap();
    let id = saved.shots[0].id;
    fs::write(p.0.join(&scene), "# 新标题\n\n原稿。\n").unwrap();
    assert_eq!(load(&p.0).unwrap().shots[0].scene_path, scene);
    fs::remove_file(p.0.join(&scene)).unwrap();
    let loaded = load(&p.0).unwrap();
    assert_eq!(loaded.shots[0].id, id);
    assert_eq!(loaded.unlinked_scene_paths, vec![scene]);
  }

  #[test]
  fn import_link_export_and_detach_leave_original_bytes_untouched() {
    let p = Project::new();
    let scene = p.scene();
    let original_script = fs::read(p.0.join(&scene)).unwrap();
    let saved = save_shot(&p.0, None, p.draft("车站远景")).unwrap();
    let image = local_assets::fixture_png();
    let imported = import_image(&p.0, saved.revision.as_deref(), Some(saved.shots[0].id), AssetRole::Location,
      "站台".into(), "参考.png".into(), &image).unwrap();
    assert_eq!(imported.assets.len(), 1);
    let record = &imported.assets[0].asset;
    assert!(imported.assets[0].available);
    assert_eq!(imported.shots[0].asset_ids, vec![record.id]);
    assert_eq!(fs::read(p.0.join(record.relative_path())).unwrap(), image);
    assert_eq!(preview_asset(&p.0, record.id).unwrap().mime, "image/png");
    let a = export(&p.0, imported.revision.as_deref()).unwrap();
    let b = export(&p.0, imported.revision.as_deref()).unwrap();
    assert_ne!(a, b);
    assert!(fs::read_to_string(p.0.join(a)).unwrap().contains("车站远景"));
    assert_eq!(fs::read(p.0.join(scene)).unwrap(), original_script);
    let removed = remove_shot(&p.0, imported.revision.as_deref(), saved.shots[0].id).unwrap();
    assert_eq!(removed.assets[0].asset.id, record.id);
    let detached = detach_asset(&p.0, removed.revision.as_deref(), record.id).unwrap();
    assert!(detached.assets.is_empty());
    assert!(p.0.join(record.relative_path()).is_file());
  }

  #[test]
  fn invalid_images_and_readonly_manifest_never_leave_new_imports() {
    let p = Project::new();
    let saved = save_shot(&p.0, None, p.draft("原镜头")).unwrap();
    let before = fs::read(p.0.join(BOARD_PATH)).unwrap();
    assert!(import_image(&p.0, saved.revision.as_deref(), None, AssetRole::Reference, "伪图".into(), "x.png".into(), b"\x89PNG\r\n\x1a\nfixture").is_err());
    let path = p.0.join(BOARD_PATH);
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone(); readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = import_image(&p.0, saved.revision.as_deref(), None, AssetRole::Reference, "失败的导入".into(), "x.png".into(), &local_assets::fixture_png());
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(fs::read_dir(p.0.join("creative/references")).unwrap().next().is_none());
    fs::set_permissions(path, permissions).unwrap();
  }

  #[test]
  fn externally_modified_image_is_not_previewed_even_at_the_same_file_size() {
    let p = Project::new();
    let bytes = local_assets::fixture_png();
    let imported = import_image(&p.0, None, None, AssetRole::Character, "人物参考".into(), "x.png".into(), &bytes).unwrap();
    let asset = &imported.assets[0].asset;
    let mut changed = bytes; changed[20] ^= 1;
    fs::write(p.0.join(asset.relative_path()), changed).unwrap();
    assert!(preview_asset(&p.0, asset.id).unwrap_err().contains("外部修改"));
    fs::remove_file(p.0.join(asset.relative_path())).unwrap();
    let missing = load(&p.0).unwrap();
    assert!(!missing.assets[0].available);
    assert_eq!(missing.assets[0].asset.id, asset.id);
  }

  #[test]
  fn corrupt_and_future_boards_are_never_reinitialized() {
    let p = Project::new();
    workspace::managed_dir(&p.0, &["creative"], true).unwrap();
    for content in ["broken", r#"{"version":2,"shots":[],"assets":[]}"#, r#"{"version":1,"shots":[],"assets":[],"future":true}"#] {
      fs::write(p.0.join(BOARD_PATH), content).unwrap();
      assert!(load(&p.0).is_err());
      assert!(save_shot(&p.0, None, p.draft("不能覆盖")).is_err());
      assert_eq!(fs::read_to_string(p.0.join(BOARD_PATH)).unwrap(), content);
    }
  }

  #[test]
  fn ordinary_file_actions_cannot_overwrite_or_delete_managed_storyboard_storage() {
    let p = Project::new();
    let saved = save_shot(&p.0, None, p.draft("保留镜头")).unwrap();
    let before = fs::read(p.0.join(BOARD_PATH)).unwrap();
    let state = crate::state::AppState::default();
    *state.workspace_root.lock().unwrap() = Some(p.0.clone());
    assert!(super::super::fs::write_text_scoped(&state, BOARD_PATH, "{}", None, None).is_err());
    for path in ["creative", BOARD_PATH, "creative/references"] {
      assert!(super::super::fs::delete_entry_scoped(&state, path, None).unwrap_err().contains("分镜与素材工具管理"));
      assert!(super::super::fs::create_dir_scoped(&state, path, None).is_err());
      assert!(super::super::fs::create_file_scoped(&state, path, None).is_err());
      assert!(super::super::fs::rename_entry_scoped(&state, path, "moved", None).is_err());
      assert!(super::super::fs::rename_entry_scoped(&state, "outline", path, None).is_err());
    }
    assert_eq!(fs::read(p.0.join(BOARD_PATH)).unwrap(), before);
    assert_eq!(load(&p.0).unwrap().revision, saved.revision);
  }

  #[cfg(unix)]
  #[test]
  fn linked_reference_directories_are_rejected() {
    let p = Project::new();
    let outside = Project::new();
    fs::create_dir(p.0.join("creative")).unwrap();
    std::os::unix::fs::symlink(&outside.0, p.0.join("creative/references")).unwrap();
    assert!(import_image(&p.0, None, None, AssetRole::Reference, "拒绝链接".into(), "x.png".into(), &local_assets::fixture_png()).is_err());
    assert!(!outside.0.join("creative").exists());
  }
}
