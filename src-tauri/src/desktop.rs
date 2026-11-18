//! 桌面启动辅助：只从安装资源目录加载前端，迁移旧配置到可写的用户目录。

use std::path::{Path, PathBuf};

/// 同时识别历史安装目录与旧应用标识；不移动工程、不扫描无关应用目录。
pub fn legacy_data_dirs(data_dir: &Path, exe_dir: Option<&Path>) -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Some(path) = exe_dir { dirs.push(path.to_path_buf()); }
  if let Some(parent) = data_dir.parent() {
    dirs.push(parent.join("com.iris-creation.app"));
    dirs.push(parent.join("com.iriscreation.app"));
  }
  dirs.retain(|path| path != data_dir);
  dirs.dedup();
  dirs
}

/// 安装包资源与启动工作目录无关；显式覆盖无效时直接报错，不加载其他旧版本。
pub fn frontend_dir(resources: &Path, override_dir: Option<PathBuf>) -> Result<PathBuf, String> {
  let dir = override_dir.unwrap_or_else(|| resources.join("frontend"));
  if !dir.join("index.html").is_file() {
    return Err(format!(
      "未找到应用前端资源：{}。请重新安装完整安装包，不要单独运行裸 exe。",
      dir.display()
    ));
  }
  dir
    .canonicalize()
    .map_err(|e| format!("无法读取前端资源目录：{e}"))
}

/// Development proxy configuration is fixed at 8765; packaged launch may use nearby ports.
pub fn server_port_candidates(is_dev: bool, preferred: Option<u16>) -> Vec<u16> {
  if is_dev {
    vec![8765]
  } else {
    let mut ports = Vec::with_capacity(31);
    if let Some(port @ 8765..=8795) = preferred {
      ports.push(port);
    }
    ports.extend((8765..=8795).filter(|port| Some(*port) != preferred));
    ports
  }
}

pub fn preferred_server_port(data_dir: &Path) -> Option<u16> {
  let port = std::fs::read_to_string(data_dir.join("config/server-port.txt")).ok()?;
  let port = port.trim().parse::<u16>().ok()?;
  (8765..=8795).contains(&port).then_some(port)
}

pub fn remember_server_port(data_dir: &Path, port: u16) -> Result<(), String> {
  if !(8765..=8795).contains(&port) {
    return Err("server port is outside the stable desktop port range".to_string());
  }
  let path = data_dir.join("config/server-port.txt");
  let parent = path
    .parent()
    .ok_or_else(|| "invalid server port path".to_string())?;
  std::fs::create_dir_all(parent).map_err(|e| format!("create server config failed: {e}"))?;
  let temp = parent.join("server-port.txt.tmp");
  std::fs::write(&temp, format!("{port}\n"))
    .map_err(|e| format!("write server port failed: {e}"))?;
  if path.exists() {
    std::fs::remove_file(&path).map_err(|e| format!("replace server port failed: {e}"))?;
  }
  std::fs::rename(&temp, &path).map_err(|e| {
    let _ = std::fs::remove_file(&temp);
    format!("save server port failed: {e}")
  })
}

/// 仅补齐缺失配置，绝不覆盖新目录中的用户文件，也不移动/删除旧工程或密钥。
pub fn migrate_legacy_data(legacy: &Path, destination: &Path) -> Result<usize, String> {
  let files = [
    "config/settings.json",
    "data/agents.json",
    "data/chat_history.json",
    "state/last_workspace.json",
    "state/external_projects.json",
    "secrets/secrets.json",
  ];
  let mut copied = 0;
  for relative in files {
    let source = legacy.join(relative);
    let target = destination.join(relative);
    if !source.is_file() || target.exists() {
      continue;
    }
    if let Some(parent) = target.parent() {
      std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    }
    // create_new 杜绝另一个实例刚写入时被迁移覆盖。
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    match options.open(&target) {
      Ok(mut output) => {
        let result = (|| {
          let mut input = std::fs::File::open(&source)?;
          std::io::copy(&mut input, &mut output)?;
          Ok::<_, std::io::Error>(())
        })();
        if let Err(e) = result {
          drop(output);
          let _ = std::fs::remove_file(&target);
          return Err(format!("迁移 {relative} 失败：{e}"));
        }
        copied += 1;
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
      Err(e) => return Err(format!("迁移 {relative} 失败：{e}")),
    }
  }
  Ok(copied)
}

#[cfg(test)]
mod tests {
  use super::*;
  fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("iris-desktop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn resolves_packaged_frontend_without_cwd() {
    let root = temp();
    std::fs::create_dir_all(root.join("frontend")).unwrap();
    std::fs::write(root.join("frontend/index.html"), "<html>Iris</html>").unwrap();
    assert_eq!(
      frontend_dir(&root, None).unwrap(),
      root.join("frontend").canonicalize().unwrap()
    );
    assert!(frontend_dir(&root, Some(root.join("missing")))
      .unwrap_err()
      .contains("未找到"));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn missing_packaged_assets_are_actionable() {
    let root = temp();
    assert!(frontend_dir(&root, None)
      .unwrap_err()
      .contains("完整安装包"));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn development_keeps_the_vite_proxy_port_stable() {
    assert_eq!(server_port_candidates(true, Some(8769)), vec![8765]);
    let release = server_port_candidates(false, None);
    assert_eq!(release.first(), Some(&8765));
    assert_eq!(release.last(), Some(&8795));
    assert_eq!(
      server_port_candidates(false, Some(8777)).first(),
      Some(&8777)
    );
  }

  #[test]
  fn remembered_port_is_validated_and_persisted() {
    let root = temp();
    assert_eq!(preferred_server_port(&root), None);
    remember_server_port(&root, 8777).unwrap();
    assert_eq!(preferred_server_port(&root), Some(8777));
    remember_server_port(&root, 8778).unwrap();
    assert_eq!(preferred_server_port(&root), Some(8778));
    assert!(remember_server_port(&root, 80).is_err());
    std::fs::write(root.join("config/server-port.txt"), "99999").unwrap();
    assert_eq!(preferred_server_port(&root), None);
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn legacy_roots_include_both_previous_identifiers() {
    let dirs = legacy_data_dirs(Path::new("data/com.iriscreation.desktop"), Some(Path::new("install")));
    assert_eq!(dirs, vec![PathBuf::from("install"), PathBuf::from("data/com.iris-creation.app"), PathBuf::from("data/com.iriscreation.app")]);
  }

  #[test]
  fn migration_preserves_existing_data_and_leaves_projects_alone() {
    let root = temp();
    let legacy = root.join("legacy");
    let dest = root.join("user");
    std::fs::create_dir_all(legacy.join("config")).unwrap();
    std::fs::create_dir_all(legacy.join("state")).unwrap();
    std::fs::create_dir_all(legacy.join("projects/我的作品")).unwrap();
    std::fs::create_dir_all(dest.join("config")).unwrap();
    std::fs::write(legacy.join("config/settings.json"), "old").unwrap();
    std::fs::write(dest.join("config/settings.json"), "new").unwrap();
    std::fs::write(legacy.join("state/last_workspace.json"), "last").unwrap();
    assert_eq!(migrate_legacy_data(&legacy, &dest).unwrap(), 1);
    assert_eq!(migrate_legacy_data(&legacy, &dest).unwrap(), 0);
    assert_eq!(
      std::fs::read_to_string(dest.join("config/settings.json")).unwrap(),
      "new"
    );
    assert!(legacy.join("projects/我的作品").exists());
    assert!(!dest.join("projects").exists());
    std::fs::remove_dir_all(root).unwrap();
  }
}
