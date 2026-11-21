//! HTTP RPC 分发：把 `/api/rpc/{command}` 映射到与服务层（Tauri 命令同源）的调用。
//!
//! 命令名与 Tauri 命令一致；参数为 JSON 对象（camelCase/snake_case 均按命令约定）。
//! 返回值包进 `{"ok": ...}` 或 `{"err": "..."}`（见 server::rpc）。

use crate::server::ServerContext;
use crate::state::AppState;
use serde_json::{Value, json};
use std::sync::Arc;

fn arg_str(args: &Value, keys: &[&str]) -> Result<String, String> {
  for k in keys {
    if let Some(v) = args.get(*k).and_then(|v| v.as_str()) {
      return Ok(v.to_string());
    }
  }
  Err(format!("missing argument: {}", keys[0]))
}

fn arg_opt_str(args: &Value, keys: &[&str]) -> Option<String> {
  for k in keys {
    if let Some(v) = args.get(*k).and_then(|v| v.as_str()) {
      return Some(v.to_string());
    }
  }
  None
}

fn arg_usize(args: &Value, keys: &[&str]) -> Result<usize, String> {
  for k in keys {
    if let Some(v) = args.get(*k).and_then(|v| v.as_u64()) {
      return Ok(v as usize);
    }
  }
  Err(format!("missing argument: {}", keys[0]))
}

fn arg_opt_usize(args: &Value, keys: &[&str]) -> Option<usize> {
  for k in keys {
    if let Some(v) = args.get(*k).and_then(|v| v.as_u64()) {
      return Some(v as usize);
    }
  }
  None
}

fn arg_t<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
  let v = args
    .get(key)
    .ok_or_else(|| format!("missing argument: {key}"))?;
  serde_json::from_value(v.clone()).map_err(|e| format!("invalid argument {key}: {e}"))
}

fn state_of(ctx: &ServerContext) -> &AppState {
  ctx.app_state.as_ref()
}

/// 取第一个 key（用于替代版）。
fn first_key(args: &Value, keys: &[&str]) -> String {
  for k in keys {
    if args.get(*k).is_some() {
      return k.to_string();
    }
  }
  keys[0].to_string()
}

pub async fn dispatch(ctx: &ServerContext, command: &str, args: Value) -> Result<Value, String> {
  let state = state_of(ctx);
  let workspace = arg_opt_str(&args, &["workspaceRoot", "workspace_root"]);
  match command {
    "ping" => Ok(json!("pong")),

    // ---- workspace / bookshelf ----
    "set_workspace" => {
      let path = arg_str(&args, &["path"])?;
      let info = crate::services::workspace::set_workspace(state, &path)?;
      serde_json::to_value(info).map_err(|e| e.to_string())
    }
    "get_last_workspace" => {
      let v = crate::services::bookshelf::get_last_workspace()?;
      Ok(json!(v))
    }
    "get_project_picker_state" => {
      let v = crate::services::bookshelf::get_project_picker_state()?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "get_bookshelf_state" => {
      let v = crate::services::bookshelf::get_project_picker_state()?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "create_novel_project" | "create_novel_work" => {
      let name = arg_str(&args, &["name"])?;
      let desc = arg_opt_str(&args, &["description"]);
      let v = crate::services::bookshelf::create_novel_project(&name, desc)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "create_project" => {
      let name = arg_str(&args, &["name"])?;
      let description = arg_opt_str(&args, &["description"]);
      let kind = arg_t(&args, "kind")?;
      let project = crate::services::bookshelf::create_project(&name, description, kind)?;
      serde_json::to_value(project).map_err(|e| e.to_string())
    }
    "update_work_description" => {
      let path = arg_str(&args, &["path"])?;
      let desc = arg_opt_str(&args, &["description"]);
      crate::services::bookshelf::update_work_description(&path, desc)?;
      Ok(json!(null))
    }
    "remember_external_project" => {
      let path = arg_str(&args, &["path"])?;
      crate::services::bookshelf::remember_external_project(&path)?;
      Ok(json!(null))
    }
    "remember_imported_work" => {
      let path = arg_str(&args, &["path"])?;
      crate::services::bookshelf::remember_external_project(&path)?;
      Ok(json!(null))
    }
    "forget_external_project" => {
      let path = arg_str(&args, &["path"])?;
      crate::services::bookshelf::forget_external_project(&path)?;
      Ok(json!(null))
    }
    "forget_imported_work" => {
      let path = arg_str(&args, &["path"])?;
      crate::services::bookshelf::forget_external_project(&path)?;
      Ok(json!(null))
    }
    "set_launch_mode" => {
      let mode = arg_str(&args, &["mode"])?;
      crate::services::bookshelf::set_launch_mode(&mode)?;
      Ok(json!(null))
    }
    "init_novel" => {
      crate::services::workspace::init_novel(state)?;
      Ok(json!(null))
    }

    // ---- screenplay storyboard / local media assets ----
    "load_storyboard" | "save_storyboard_shot" | "remove_storyboard_shot" | "reorder_storyboard_shots"
      | "detach_storyboard_asset" | "import_storyboard_image"
      | "save_storyboard_export" | "read_creative_image" => {
      use base64::Engine;
      use crate::services::{local_assets, storyboard, workspace::scoped_workspace};
      let expected = workspace.as_deref().ok_or("missing argument: workspaceRoot")?;
      let root = scoped_workspace(state, Some(expected))?;
      // Image decoding and synced writes must not block the async HTTP executor.
      let command = command.to_owned();
      return tokio::task::spawn_blocking(move || match command.as_str() {
        "load_storyboard" => serde_json::to_value(storyboard::load(&root)?).map_err(|e| e.to_string()),
        "save_storyboard_shot" => {
          let revision = arg_opt_str(&args, &["revision"]);
          let draft = arg_t(&args, "shot")?;
          serde_json::to_value(storyboard::save_shot(&root, revision.as_deref(), draft)?).map_err(|e| e.to_string())
        }
        "remove_storyboard_shot" => {
          let revision = arg_opt_str(&args, &["revision"]);
          let id: uuid::Uuid = arg_t(&args, "shotId")?;
          serde_json::to_value(storyboard::remove_shot(&root, revision.as_deref(), id)?).map_err(|e| e.to_string())
        }
        "reorder_storyboard_shots" => {
          let revision = arg_opt_str(&args, &["revision"]);
          let expected_ids: Vec<uuid::Uuid> = arg_t(&args, "expectedIds")?;
          let ids: Vec<uuid::Uuid> = arg_t(&args, "ids")?;
          serde_json::to_value(storyboard::reorder(&root, revision.as_deref(), expected_ids, ids)?).map_err(|e| e.to_string())
        }
        "detach_storyboard_asset" => {
          let revision = arg_opt_str(&args, &["revision"]);
          let id: uuid::Uuid = arg_t(&args, "id")?;
          serde_json::to_value(storyboard::detach_asset(&root, revision.as_deref(), id)?).map_err(|e| e.to_string())
        }
        "import_storyboard_image" => {
          let revision = arg_opt_str(&args, &["revision"]);
          let shot_id: Option<uuid::Uuid> = arg_t(&args, "shotId")?;
          let name = arg_str(&args, &["name"])?;
          let original_name = arg_str(&args, &["originalName"])?;
          let role = arg_t(&args, "role")?;
          let encoded = arg_str(&args, &["base64"])?;
          const MAX_ENCODED: usize = (local_assets::IMPORT_LIMIT + 2) / 3 * 4;
          if encoded.len() > MAX_ENCODED { return Err("导入图片不能超过 10 MB。".into()); }
          let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "图片编码无效。")?;
          serde_json::to_value(storyboard::import_image(&root, revision.as_deref(), shot_id, role, name, original_name, &bytes)?).map_err(|e| e.to_string())
        }
        "save_storyboard_export" => {
          let revision = arg_opt_str(&args, &["revision"]);
          storyboard::export(&root, revision.as_deref()).map(|path| json!(path))
        }
        _ => {
          let id: uuid::Uuid = arg_t(&args, "id")?;
          let encoded = storyboard::preview_asset(&root, id)?;
          // Only a checked, re-encoded PNG thumbnail is returned to the browser.
          serde_json::to_value(encoded).map_err(|e| e.to_string())
        }
      }).await.map_err(|_| "本地分镜操作异常退出，原稿未更改。".to_string())?;
    }

    // ---- screenplay: mutations and reads are bound to the project that opened the UI ----
    "list_screenplay_scenes" | "create_screenplay_scene" | "reorder_screenplay_scenes" | "save_screenplay_export" => {
      use crate::services::{screenplay, workspace::scoped_workspace};
      let expected = workspace.as_deref().ok_or("missing argument: workspaceRoot")?;
      let root = scoped_workspace(state, Some(expected))?;
      match command {
        "list_screenplay_scenes" => serde_json::to_value(screenplay::list(&root)?).map_err(|e| e.to_string()),
        "create_screenplay_scene" => serde_json::to_value(screenplay::create(&root, arg_t(&args, "draft")?)?).map_err(|e| e.to_string()),
        "reorder_screenplay_scenes" => {
          let expected: Vec<String> = arg_t(&args, "expectedPaths")?;
          screenplay::reorder(&root, &expected, arg_t(&args, "paths")?)?;
          Ok(json!(null))
        }
        _ => screenplay::save_export(&root, &arg_str(&args, &["format"])?).map(|path| json!(path)),
      }
    }

    // ---- 目录浏览（打开目录对话框） ----
    "browse_dir" => {
      let path = arg_opt_str(&args, &["path"]).unwrap_or_default();
      let v = crate::services::dir_browse::list_dir(&path)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "quick_locations" => {
      let v = crate::services::dir_browse::quick_locations();
      serde_json::to_value(v).map_err(|e| e.to_string())
    }

    // ---- fs ----
    "list_workspace_tree" => {
      let depth = arg_usize(&args, &["max_depth", "maxDepth"])?;
      let v = crate::services::fs::list_workspace_tree_scoped(state, depth, workspace.as_deref())?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "read_text" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      crate::services::fs::read_text_scoped(state, &path, workspace.as_deref()).map(|v| json!(v))
    }
    "export_work" => {
      let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("md")
        .to_string();
      let (filename, content) = crate::services::fs::export_work(state, &format)?;
      Ok(json!({ "filename": filename, "content": content }))
    }
    "write_text" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      let content = arg_str(&args, &["content"])?;
      crate::services::fs::write_text_scoped(state, &path, &content, None, workspace.as_deref()).map(|_| json!(null))
    }
    "write_text_if_current" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      let content = arg_str(&args, &["content"])?;
      let expected = arg_str(&args, &["expected_current", "expectedCurrent"])?;
      crate::services::fs::write_text_scoped(state, &path, &content, Some(&expected), workspace.as_deref()).map(|_| json!(null))
    }
    "create_file" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      crate::services::fs::create_file_scoped(state, &path, workspace.as_deref()).map(|_| json!(null))
    }
    "create_dir" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      crate::services::fs::create_dir_scoped(state, &path, workspace.as_deref()).map(|_| json!(null))
    }
    "delete_entry" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      crate::services::fs::delete_entry_scoped(state, &path, workspace.as_deref()).map(|_| json!(null))
    }
    "rename_entry" => {
      let from = arg_str(&args, &["from_relative_path", "fromRelativePath", "from"])?;
      let to = arg_str(&args, &["to_relative_path", "toRelativePath", "to"])?;
      crate::services::fs::rename_entry_scoped(state, &from, &to, workspace.as_deref()).map(|_| json!(null))
    }
    "parse_composer_directive" => {
      let input = arg_str(&args, &["input"])?;
      let v = crate::services::fs::parse_composer_directive(input);
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "resolve_inline_references" => {
      let payload = arg_t::<crate::services::fs::ResolveInlineReferencesRequest>(&args, "payload")?;
      let v = crate::services::fs::resolve_inline_references(state, payload)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "validate_novel_task_quality" => {
      let payload = arg_t::<crate::services::fs::NovelTaskQualityRequest>(&args, "payload")?;
      let v = crate::services::fs::validate_novel_task_quality(state, payload)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }

    // ---- settings ----
    "get_project_writing_settings" => {
      let v = crate::services::settings::get_project_writing_settings(state)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "set_project_writing_settings" => {
      let settings = arg_t::<crate::services::settings::ProjectWritingSettings>(&args, "settings")?;
      let v = crate::services::settings::set_project_writing_settings(state, settings)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "get_app_settings" => {
      let v = crate::services::settings::get_app_settings()?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "set_app_settings" => {
      let settings = arg_t::<crate::app_settings::AppSettings>(&args, "settings")?;
      crate::services::settings::set_app_settings(settings)?;
      Ok(json!(null))
    }
    "get_api_key_status" => {
      let pid = arg_opt_str(&args, &["providerId", "provider_id", "provider"]);
      let v = crate::services::settings::get_api_key_status(pid.clone(), pid)?;
      Ok(json!(v))
    }
    "set_api_key" => {
      let _pid = first_key(&args, &["providerId", "provider_id", "provider"]);
      let _key = first_key(&args, &["apiKey", "api_key"]);
      let provider_id = arg_opt_str(&args, &["providerId", "provider_id", "provider"]);
      let api_key = arg_opt_str(&args, &["apiKey", "api_key"]);
      crate::services::settings::set_api_key(
        arg_opt_str(&args, &["providerId"]),
        provider_id,
        arg_opt_str(&args, &["apiKey"]),
        api_key,
      )?;
      Ok(json!(null))
    }
    "test_provider_connectivity" => {
      let provider = arg_t::<crate::app_settings::ModelProvider>(&args, "provider")?;
      let v = crate::services::settings::test_provider_connectivity(
        provider,
        arg_opt_str(&args, &["apiKey"]),
        arg_opt_str(&args, &["api_key"]),
      ).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "get_agents" | "get_writing_assistants" => {
      let v = crate::services::settings::get_agents()?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "set_agents" | "set_writing_assistants" => {
      let key = first_key(&args, &["agents_list", "agentsList", "agents", "assistants"]);
      let list = arg_t::<Vec<crate::agents::Agent>>(&args, &key)?;
      crate::services::settings::set_agents(list)?;
      Ok(json!(null))
    }
    "export_agents" | "export_writing_assistants" => {
      let v = crate::services::settings::export_agents()?;
      Ok(json!(v))
    }
    "import_agents" | "import_writing_assistants" => {
      let text = arg_str(&args, &["json"])?;
      crate::services::settings::import_agents(text)?;
      Ok(json!(null))
    }

    // ---- history ----
    "list_history_entries" => {
      let max = arg_opt_usize(&args, &["max"]);
      let root = crate::services::workspace::scoped_workspace(state, workspace.as_deref())?;
      let file = arg_opt_str(&args, &["relative_path", "relativePath"]);
      let v = crate::services::workspace::list_file_history(&root, max, file.as_deref())?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "create_history_snapshot" => {
      let path = arg_str(&args, &["relative_path", "relativePath", "path"])?;
      let label = arg_opt_str(&args, &["label", "reason"]);
      let root = crate::services::workspace::get_workspace_root(state)?;
      let v = crate::services::workspace::create_history_snapshot(&root, &path, label)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "read_history_snapshot" => {
      let id = arg_str(&args, &["id"])?;
      let root = crate::services::workspace::scoped_workspace(state, workspace.as_deref())?;
      crate::services::workspace::read_history_snapshot(&root, &id).map(|v| json!(v))
    }
    "restore_history_snapshot" => {
      let id = arg_str(&args, &["id"])?;
      let expected = arg_opt_str(&args, &["expected_current", "expectedCurrent"]);
      let root = crate::services::workspace::scoped_workspace(state, workspace.as_deref())?;
      crate::services::workspace::restore_history_snapshot_if_current(&root, &id, expected.as_deref()).map(|v| json!(v))
    }

    // ---- chat ----
    "save_chat_session" => {
      let session = arg_t::<crate::chat_history::ChatSession>(&args, "session")?;
      crate::services::chat::save_chat_session(session)?;
      Ok(json!(null))
    }
    "list_chat_sessions" => {
      let root = arg_opt_str(&args, &["workspace_root", "workspaceRoot"]);
      let v = crate::services::chat::list_chat_sessions(root)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "get_chat_session" => {
      let id = arg_str(&args, &["id"])?;
      let v = crate::services::chat::get_chat_session(&id)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "delete_chat_session" => {
      let id = arg_str(&args, &["id"])?;
      let v = crate::services::chat::delete_chat_session(&id)?;
      Ok(json!(v))
    }

    // ---- ai stream ----
    "studio_complete_stream" => {
      let stream_id = arg_str(&args, &["streamId", "stream_id"])?;
      let system = arg_opt_str(&args, &["system"]).map(|s| {
        s.trim().to_string()
      });
      let system = system.filter(|s| !s.is_empty());
      let messages = arg_t::<Vec<crate::ai_types::ChatMessage>>(&args, "messages")?;
      let temperature = args
        .get("temperature")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32);
      let provider_id = arg_opt_str(&args, &["providerId", "provider_id"]);
      crate::services::ai_stream::studio_complete_stream_service(
        ctx.event_sink.clone(),
        state,
        stream_id,
        system,
        messages,
        temperature,
        provider_id,
      )?;
      Ok(json!(null))
    }
    "chat_generate_stream" => {
      let stream_id = arg_str(&args, &["streamId", "stream_id"])?;
      let messages = arg_t::<Vec<crate::ai_types::ChatMessage>>(&args, "messages")?;
      let use_markdown = args
        .get("use_markdown")
        .or_else(|| args.get("useMarkdown"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
      let agent_id = arg_opt_str(&args, &["agentId", "agent_id", "assistantId", "assistant_id"]);
      let provider_id = arg_opt_str(&args, &["providerId", "provider_id"]);
      crate::services::ai_stream::chat_generate_stream_service(
        ctx.event_sink.clone(),
        crate::services::workspace::scoped_workspace(state, workspace.as_deref())?,
        stream_id,
        messages,
        use_markdown,
        agent_id,
        provider_id,
      )?;
      Ok(json!(null))
    }
    "chat_cancel_stream" => {
      let stream_id = arg_str(&args, &["streamId", "stream_id"])?;
      crate::services::ai_stream::cancel_stream(&stream_id)?;
      crate::event_sink::EventSink::emit(
        &*ctx.event_sink,
        "ai_stream_done",
        json!({ "streamId": stream_id, "cancelled": true }),
      );
      Ok(json!(null))
    }

    // ---- skills ----
    "get_skills" => {
      use crate::skills::SkillManager;
      let manager = SkillManager::new();
      serde_json::to_value(manager.get_all()).map_err(|e| e.to_string())
    }
    "get_skill_categories" => {
      use crate::skills::SkillManager;
      let manager = SkillManager::new();
      Ok(json!(manager.categories()))
    }
    "get_skills_by_category" => {
      use crate::skills::SkillManager;
      let category = arg_str(&args, &["category"])?;
      let manager = SkillManager::new();
      serde_json::to_value(manager.get_by_category(&category)).map_err(|e| e.to_string())
    }
    "apply_skill" => {
      use crate::skills::SkillManager;
      let skill_id = arg_str(&args, &["skill_id", "skillId"])?;
      let content = arg_str(&args, &["content"])?;
      let manager = SkillManager::new();
      Ok(json!(manager.apply_skill(&skill_id, &content)))
    }

    // ---- external agent cli ----
    "agent_cli_detect" => {
      let v = crate::services::agent_cli::detect_clis().await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "agent_cli_run_task" => {
      let cli_id = arg_str(&args, &["cliId", "cli_id"])?;
      let workspace_root = arg_str(&args, &["workspaceRoot", "workspace_root"])?;
      let prompt = arg_str(&args, &["prompt"])?;
      let write_mode = arg_opt_str(&args, &["writeMode", "write_mode"]);
      let settings = crate::app_settings::load()?;
      let v = crate::services::agent_cli::run_task(
        state,
        crate::services::agent_cli::CliTaskRequest {
          cli_id,
          workspace_root,
          prompt,
          write_mode,
        },
        &settings.agent_cli_write_mode,
      )
      .await?;
      Ok(json!(v))
    }
    "agent_cli_list_tasks" => {
      let v = crate::services::agent_cli::list_tasks();
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "agent_cli_get_task" => {
      let id = arg_str(&args, &["taskId", "task_id"])?;
      let v = crate::services::agent_cli::get_task(&id).ok_or("task not found")?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "agent_cli_cancel_task" => {
      let id = arg_str(&args, &["taskId", "task_id"])?;
      crate::services::agent_cli::cancel_task(&id)?;
      Ok(json!(null))
    }
    "agent_cli_decide_change" => {
      let id = arg_str(&args, &["taskId", "task_id"])?;
      let path = arg_str(&args, &["path"])?;
      let accept = args.get("accept").and_then(|v| v.as_bool()).unwrap_or(false);
      let v = crate::services::agent_cli::decide_change(&id, &path, accept)?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }

    // ---- AI / 风险 / 拆书 ----
    "risk_scan_content" => {
      let file_path = arg_opt_str(&args, &["filePath", "file_path"]);
      let content = arg_str(&args, &["content"])?;
      let v = crate::commands::risk_scan_content_impl(state, file_path, content).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "ai_assistance_generate" => {
      let prompt = arg_str(&args, &["prompt"])?;
      let v = crate::commands::ai_assistance_generate_impl(prompt).await?;
      Ok(json!(v))
    }
    "analyze_book" => {
      let content = arg_str(&args, &["content"])?;
      let title = arg_str(&args, &["title"])?;
      let v = crate::commands::analyze_book(content, title).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "split_book" => {
      let content = arg_str(&args, &["content"])?;
      let title = arg_str(&args, &["title"])?;
      let config = arg_t::<crate::book_split::BookSplitConfig>(&args, "config")?;
      let v = crate::commands::split_book(content, title, config).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "extract_chapters" => {
      let content = arg_str(&args, &["content"])?;
      let v = crate::commands::extract_chapters(content).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "book_analyze" => {
      let content = arg_str(&args, &["content"])?;
      let title = arg_str(&args, &["title"])?;
      let v = crate::commands::book_analyze(content, title).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "book_extract_techniques" => {
      let content = arg_str(&args, &["content"])?;
      let v = crate::commands::book_extract_techniques(content).await?;
      serde_json::to_value(v).map_err(|e| e.to_string())
    }
    "ai_analyze_book_deep" | "ai_split_by_ai" => {
      // 占位实现：需要配置 Provider 后才有真实能力，保持与桌面端一致返回提示文本
      Ok(json!("AI analysis requires a configured provider and key."))
    }

    _ => Err(format!("unknown command: {command}")),
  }
}

/// 允许 dispatch 在测试中构造裸 ServerContext。
pub fn test_context() -> ServerContext {
  let broadcast = crate::event_sink::BroadcastEventSink::new(16);
  ServerContext {
    app_state: Arc::new(AppState::default()),
    event_sink: Arc::new(broadcast.clone()),
    broadcast,
  }
}

#[cfg(test)]
#[path = "rpc_boundary_tests.rs"]
mod boundary_tests;

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn dispatch_ping() {
    let ctx = test_context();
    let v = dispatch(&ctx, "ping", json!({})).await.unwrap();
    assert_eq!(v, json!("pong"));
  }

  #[tokio::test]
  async fn dispatch_unknown_command() {
    let ctx = test_context();
    let err = dispatch(&ctx, "no_such_command", json!({})).await.unwrap_err();
    assert!(err.contains("unknown command"));
  }

  #[tokio::test]
  async fn dispatch_missing_arg() {
    let ctx = test_context();
    let err = dispatch(&ctx, "read_text", json!({})).await.unwrap_err();
    assert!(err.contains("missing argument"));
  }

  #[tokio::test]
  async fn guarded_editor_write_rejects_stale_baseline() {
    let ctx = test_context();
    let root = std::env::temp_dir().join(format!("iris-rpc-write-guard-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("stories")).unwrap();
    let path = root.join("stories/chapter-0001.md");
    std::fs::write(&path, "external edit").unwrap();
    *ctx.app_state.workspace_root.lock().unwrap() = Some(root.clone());
    let stale = dispatch(&ctx, "write_text_if_current", json!({
      "relativePath":"stories/chapter-0001.md", "content":"stale editor write", "expectedCurrent":"old content"
    })).await.unwrap_err();
    assert!(stale.contains("changed on disk"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit");
    dispatch(&ctx, "write_text_if_current", json!({
      "relativePath":"stories/chapter-0001.md", "content":"saved editor write", "expectedCurrent":"external edit"
    })).await.unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "saved editor write");
    let _ = std::fs::remove_dir_all(root);
  }
}
