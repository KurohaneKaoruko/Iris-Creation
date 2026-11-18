#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 桌面壳：内嵌 iris-creation-server（HTTP RPC + WS + webui 静态资源），
//! 开发态由 Vite 提供前端；发行态从系统资源目录启动本机前端与 HTTP/RPC/WS，
//! 与 iris-creation-server 独立部署形态行为完全一致。

use iris_creation::{commands, desktop};
use tauri::{Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn show_startup_error(window: &tauri::WebviewWindow, message: String) {
  eprintln!("[iris] startup failed: {message}");
  let _ = window.set_title("Iris-Creation · 启动失败");
  let _ = window.show();
  let app = window.app_handle().clone();
  window.dialog().message(format!("{message}\n\n作品文件不会被修改。请关闭应用后重试；资源缺失时请重新安装完整安装包。"))
    .title("Iris-Creation · 启动失败")
    .kind(MessageDialogKind::Error)
    .show(move |_| app.exit(1));
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let window = app
        .get_webview_window("main")
        .ok_or_else(|| std::io::Error::other("main window was not created"))?;
      let is_dev = tauri::is_dev();
      let static_dir = if is_dev {
        None // Vite 托管开发 UI；内嵌服务只提供 RPC/WS。
      } else {
        let resources = match app.path().resource_dir() {
          Ok(path) => path,
          Err(error) => { show_startup_error(&window, format!("无法定位应用资源目录：{error}")); return Ok(()); }
        };
        let override_dir = std::env::var("IRIS_CREATION_STATIC_DIR")
          .ok()
          .map(std::path::PathBuf::from);
        match desktop::frontend_dir(&resources, override_dir) {
          Ok(path) => Some(path),
          Err(error) => { show_startup_error(&window, error); return Ok(()); }
        }
      };

      let data_override = std::env::var("IRIS_CREATION_DATA_DIR")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from);
      let use_default_data = data_override.is_none();
      let data_dir = match data_override.map(Ok).unwrap_or_else(|| app.path().app_data_dir()) {
        Ok(path) => path,
        Err(error) => { show_startup_error(&window, format!("无法定位用户数据目录：{error}")); return Ok(()); }
      };
      if let Err(error) = std::fs::create_dir_all(&data_dir) {
        show_startup_error(&window, format!("无法创建用户数据目录 {}：{error}", data_dir.display()));
        return Ok(());
      }
      iris_creation::app_data::set_storage_root_override(data_dir.clone());
      let server_data_dir = data_dir.clone();
      // 旧版本将配置写在 exe 同目录或旧 bundle identifier 目录；只迁移已知文件，保留原件。
      let exe = std::env::current_exe().ok();
      let legacy_dirs = if use_default_data { desktop::legacy_data_dirs(&data_dir, exe.as_deref().and_then(|path| path.parent())) } else { Vec::new() };
      for legacy_dir in legacy_dirs {
        if legacy_dir != data_dir {
          match desktop::migrate_legacy_data(&legacy_dir, &data_dir) {
            Ok(n) if n > 0 => eprintln!(
              "[iris] migrated {n} legacy app-data files from {}",
              legacy_dir.display()
            ),
            Ok(_) => {}
            Err(e) => eprintln!("[iris] app-data migration warning: {e}"),
          }
        }
      }
      let window_on_error = window.clone();
      tauri::async_runtime::spawn(async move {
        let config = iris_creation::server::ServerConfig {
          host: "127.0.0.1".to_string(),
          port: 8765,
          static_dir,
          data_dir: Some(data_dir),
        };
        let preferred = if is_dev {
          None
        } else {
          desktop::preferred_server_port(&server_data_dir)
        };
        let mut started = None;
        let mut last_error = String::new();
        for port in desktop::server_port_candidates(is_dev, preferred) {
          let mut candidate = config.clone();
          candidate.port = port;
          match iris_creation::server::start(candidate).await {
            Ok(addr) => {
              started = Some(addr);
              break;
            }
            Err(e) => {
              let retry = e.starts_with("bind ");
              last_error = e;
              if !retry { break; }
            }
          }
        }
        if started.is_none() && !is_dev && last_error.starts_with("bind ") {
          let mut candidate = config;
          candidate.port = 0;
          match iris_creation::server::start(candidate).await {
            Ok(addr) => started = Some(addr),
            Err(error) => last_error = error,
          }
        }
        match started {
          Some(addr) => {
            if !is_dev {
              if let Err(e) = desktop::remember_server_port(&server_data_dir, addr.port()) {
                eprintln!("[iris] cannot remember local server port: {e}");
              }
              if let Ok(url) = Url::parse(&format!("http://{addr}/")) {
                if let Err(e) = window.navigate(url) {
                  show_startup_error(&window, format!("无法加载写作界面：{e}"));
                  return;
                }
              }
            }
            if let Err(e) = window.show() {
              eprintln!("[iris] failed to show main window: {e}");
            }
          }
          None => {
            show_startup_error(&window_on_error, format!("本地写作服务启动失败：{last_error}"));
          }
        }
      });
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .manage(iris_creation::state::AppState::default())
    .invoke_handler(tauri::generate_handler![
      commands::ping,
      commands::agent_cli_detect,
      commands::agent_cli_run_task,
      commands::agent_cli_list_tasks,
      commands::agent_cli_get_task,
      commands::agent_cli_cancel_task,
      commands::agent_cli_decide_change,
      commands::set_workspace,
      commands::get_last_workspace,
      commands::get_project_picker_state,
      commands::get_bookshelf_state,
      commands::create_novel_project,
      commands::create_novel_work,
      commands::update_work_description,
      commands::remember_external_project,
      commands::remember_imported_work,
      commands::forget_external_project,
      commands::forget_imported_work,
      commands::set_launch_mode,
      commands::init_novel,
      commands::list_workspace_tree,
      commands::get_project_writing_settings,
      commands::set_project_writing_settings,
      commands::parse_composer_directive,
      commands::resolve_inline_references,
      commands::validate_novel_task_quality,
      commands::read_text,
      commands::export_work,
      commands::write_text,
      commands::write_text_if_current,
      commands::create_file,
      commands::create_dir,
      commands::delete_entry,
      commands::rename_entry,
      commands::get_app_settings,
      commands::set_app_settings,
      commands::get_api_key_status,
      commands::set_api_key,
      commands::test_provider_connectivity,
      commands::get_agents,
      commands::get_writing_assistants,
      commands::set_agents,
      commands::set_writing_assistants,
      commands::export_agents,
      commands::export_writing_assistants,
      commands::import_agents,
      commands::import_writing_assistants,
      commands::save_chat_session,
      commands::list_chat_sessions,
      commands::get_chat_session,
      commands::delete_chat_session,
      commands::list_history_entries,
      commands::create_history_snapshot,
      commands::read_history_snapshot,
      commands::restore_history_snapshot,
      commands::chat_generate_stream,
      commands::chat_cancel_stream,
      commands::ai_assistance_generate,
      commands::risk_scan_content,
      commands::get_skills,
      commands::get_skill_categories,
      commands::get_skills_by_category,
      commands::apply_skill,
      commands::book_analyze,
      commands::book_extract_techniques,
      commands::analyze_book,
      commands::split_book,
      commands::extract_chapters,
      commands::ai_analyze_book_deep,
      commands::ai_split_by_ai
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
