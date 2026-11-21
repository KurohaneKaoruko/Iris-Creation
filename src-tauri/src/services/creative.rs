//! Scoped storage for project boards and media. Capture the project before any async work.
use super::workspace::{canonicalize_path, get_workspace_root};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::{fs, io, io::Write, path::{Path, PathBuf}, sync::Mutex};
use uuid::Uuid;

const BOARD_LIMIT: usize = 512 * 1024;
static BOARD_WRITE: Mutex<()> = Mutex::new(());

pub(crate) fn project_root(state: &AppState, expected: &str) -> Result<PathBuf, String> {
  let root = get_workspace_root(state)?;
  if expected.is_empty() || canonicalize_path(Path::new(expected)).as_ref() != Ok(&root) {
    return Err("当前作品已切换，请重新打开创作台。".into());
  }
  Ok(root)
}

/// Walk only real directories under a canonical workspace root. Never follow links in managed storage.
pub(crate) fn managed_dir(root: &Path, parts: &[&str], create: bool) -> Result<Option<PathBuf>, String> {
  let mut path = root.to_owned();
  for part in parts {
    path.push(part);
    loop {
      match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() && path.canonicalize().is_ok_and(|real| real == path) => break,
        Ok(_) => return Err("创作台目录必须是作品中的普通目录，不能是文件或链接。".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound && !create => return Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::create_dir(&path) {
          Ok(()) => continue,
          Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
          Err(e) => return Err(format!("创建创作台目录失败：{e}")),
        },
        Err(e) => return Err(format!("读取创作台目录失败：{e}")),
      }
    }
  }
  Ok(Some(path))
}

pub(crate) fn regular_file(path: &Path) -> Result<Option<fs::Metadata>, String> {
  match fs::symlink_metadata(path) {
    Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(Some(meta)),
    Ok(_) => Err("创作台只支持普通文件，不能读取链接。".into()),
    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("读取创作台文件失败：{e}")),
  }
}

pub(crate) fn read_limited(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
  use io::Read;
  let Some(meta) = regular_file(path)? else { return Ok(None); };
  if meta.len() > limit as u64 { return Err("创作台文件超过大小限制。".into()); }
  let mut buf = Vec::new();
  fs::File::open(path).and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut buf))
    .map_err(|e| format!("读取创作台文件失败：{e}"))?;
  if buf.len() > limit { return Err("创作台文件超过大小限制。".into()); }
  Ok(Some(buf))
}

pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
  regular_file(path)?;
  let temp = path.with_file_name(format!(".write-{}.tmp", Uuid::new_v4()));
  let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)
    .map_err(|e| format!("建立创作台临时文件失败：{e}"))?;
  let result = file.write_all(contents).and_then(|_| file.sync_all());
  drop(file);
  let result = result.and_then(|_| fs::rename(&temp, path));
  if let Err(e) = result {
    let _ = fs::remove_file(&temp);
    return Err(format!("保存创作台文件失败：{e}"));
  }
  Ok(())
}

#[derive(Serialize, Debug)]
pub(crate) struct StoredBoard {
  pub revision: Option<String>,
  pub board: Option<Value>,
}

fn read_board(path: &Path) -> Result<StoredBoard, String> {
  let Some(raw) = read_limited(path, BOARD_LIMIT)? else { return Ok(StoredBoard { revision: None, board: None }); };
  let board: Value = serde_json::from_slice(&raw).map_err(|_| "剧本分镜文件已损坏，未覆盖原文件。")?;
  check_board_version(&board)?;
  Ok(StoredBoard { revision: Some(blake3::hash(&raw).to_hex().to_string()), board: Some(board) })
}

fn check_board_version(board: &Value) -> Result<(), String> {
  if board.get("version").and_then(Value::as_u64) != Some(1) {
    return Err("无法识别此剧本分镜文件的版本，未覆盖原文件。".into());
  }
  Ok(())
}

pub(crate) fn load_board(root: &Path) -> Result<StoredBoard, String> {
  match managed_dir(root, &["creative"], false)? {
    Some(dir) => read_board(&dir.join("board.json")),
    None => Ok(StoredBoard { revision: None, board: None }),
  }
}

pub(crate) fn save_board(root: &Path, revision: Option<&str>, board: Value) -> Result<String, String> {
  check_board_version(&board)?;
  let mut raw = serde_json::to_vec_pretty(&board).map_err(|e| e.to_string())?;
  raw.push(b'\n');
  if raw.len() > BOARD_LIMIT { return Err("剧本分镜超过 512 KB。请缩短场次正文，或将长篇拆成不同作品。".into()); }
  let _lock = BOARD_WRITE.lock().map_err(|_| "创作台保存锁不可用。")?;
  let dir = managed_dir(root, &["creative"], true)?.ok_or("创作台目录不可用。")?;
  let path = dir.join("board.json");
  if read_board(&path)?.revision.as_deref() != revision {
    return Err("剧本分镜已被其他窗口或程序修改。请先导出当前草稿，再重新打开作品确认磁盘版本。".into());
  }
  write_atomic(&path, &raw)?;
  Ok(blake3::hash(&raw).to_hex().to_string())
}

#[cfg(test)]
pub(crate) struct TestProject(pub PathBuf);

#[cfg(test)]
impl TestProject {
  pub(crate) fn new() -> Self {
    let path = std::env::temp_dir().join(format!("iris-creative-{}", Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    Self(path.canonicalize().unwrap())
  }
}

#[cfg(test)]
impl Drop for TestProject {
  fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn board_is_scoped_and_conflicts_preserve_the_document() {
    let a = TestProject::new();
    let b = TestProject::new();
    assert!(load_board(&a.0).unwrap().board.is_none());
    let new = json!({ "version": 1, "title": "夜航" });
    let revision = save_board(&a.0, None, new.clone()).unwrap();
    assert!(save_board(&a.0, None, json!({ "version": 1 })).is_err());
    assert_eq!(load_board(&a.0).unwrap().board, Some(new));
    assert!(load_board(&b.0).unwrap().board.is_none());
    assert!(save_board(&a.0, Some(&revision), json!({ "version": 2 })).is_err());
    assert!(save_board(&a.0, Some(&revision), json!({ "version": 1, "title": "改稿" })).is_ok());
    let state = AppState::default();
    *state.workspace_root.lock().unwrap() = Some(a.0.clone());
    assert!(project_root(&state, b.0.to_str().unwrap()).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn managed_directories_cannot_be_redirected_with_symlinks() {
    let project = TestProject::new();
    let other = TestProject::new();
    std::os::unix::fs::symlink(&other.0, project.0.join("creative")).unwrap();
    assert!(save_board(&project.0, None, json!({"version": 1})).is_err());
    assert!(fs::read_dir(&other.0).unwrap().next().is_none());
  }
}
