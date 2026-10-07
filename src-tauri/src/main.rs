#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
mod instance;

use host::Host;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Desktop {
    host: Arc<Host>,
    url: tauri::Url,
    closing: AtomicBool,
    shutdown_complete: AtomicBool,
    _instance: instance::Instance,
}

const COMMANDS: &[&str] = &[
    "desktop-set-theme",
    "desktop-copy-draft",
    "desktop-exit-app",
    "desktop-get-app-version",
    "desktop-get-model-download-state",
    "desktop-download-laya-model",
    "desktop-choose-model-directory",
    "desktop-choose-data-root",
    "desktop-check-for-updates",
    "desktop-get-update-state",
    "desktop-begin-update",
    "desktop-rollback-update",
    "desktop-report-ui-ready",
    "desktop-open-doc",
    "desktop-window-action",
];
const DOC_URLS: &[&str] = &[
    "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
    "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
    "https://github.com/tswawa",
    "https://github.com/tswawa/WechatVibe",
    "https://github.com/tswawa/WechatVibe/releases",
    "https://github.com/estel-li",
    "https://github.com/estel-li/WechatVibe-tauri2",
    "https://github.com/estel-li/WechatVibe-tauri2/releases",
    "https://github.com/fanyuantaier/wechatauto-replica",
];

fn trusted(window: &WebviewWindow, desktop: &Desktop) -> Result<(), String> {
    if window.label() != "main"
        || window.url().map_err(|e| e.to_string())? != desktop.url
        || desktop.closing.load(Ordering::SeqCst)
    {
        Err("Desktop command is unavailable to this page".into())
    } else {
        Ok(())
    }
}

async fn rpc(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    cmd: &'static str,
) -> Result<Value, String> {
    trusted(&window, &desktop)?;
    let host = Arc::clone(&desktop.host);
    tauri::async_runtime::spawn_blocking(move || host.request(cmd, Value::Null))
        .await
        .map_err(|e| e.to_string())?
}

macro_rules! rpc_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        async fn $name(
            window: WebviewWindow,
            desktop: State<'_, Desktop>,
        ) -> Result<Value, String> {
            rpc(window, desktop, $method).await
        }
    };
}
rpc_command!(desktop_get_model_download_state, "model-download-state");
rpc_command!(desktop_download_laya_model, "model-download");
rpc_command!(desktop_check_for_updates, "check-updates");
rpc_command!(desktop_get_update_state, "update-state");
rpc_command!(desktop_begin_update, "begin-update");
rpc_command!(desktop_rollback_update, "rollback-update");
#[tauri::command]
async fn desktop_report_ui_ready(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
) -> Result<Value, String> {
    trusted(&window, &desktop)?;
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return Ok(json!(false));
    }
    rpc(window, desktop, "report-ui-ready").await
}

#[tauri::command]
fn desktop_set_theme(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    theme: String,
) -> Result<bool, String> {
    trusted(&window, &desktop)?;
    let (theme, color) = match theme.as_str() {
        "light" => (
            tauri::Theme::Light,
            tauri::window::Color(237, 243, 247, 255),
        ),
        "dark" => (tauri::Theme::Dark, tauri::window::Color(27, 27, 27, 255)),
        _ => return Ok(false),
    };
    window.set_theme(Some(theme)).map_err(|e| e.to_string())?;
    window
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_copy_draft(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    value: String,
) -> Result<bool, String> {
    trusted(&window, &desktop)?;
    if value.trim().is_empty() || value.chars().count() > 1_000_000 {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(value).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn desktop_get_app_version(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
) -> Result<String, String> {
    trusted(&window, &desktop)?;
    Ok(window.app_handle().package_info().version.to_string())
}

async fn choose_folder(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    model: bool,
) -> Result<Value, String> {
    trusted(&window, &desktop)?;
    let root = desktop.host.root.clone();
    let dialog = rfd::FileDialog::new()
        .set_parent(&window)
        .set_title(if model {
            "选择 Laya 模型目录"
        } else {
            "选择微信聊天记录目录"
        });
    let result = tauri::async_runtime::spawn_blocking(move || {
        let dialog = if model {
            dialog.set_directory(root.join(".local/models"))
        } else {
            dialog
        };
        dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!(result))
}
#[tauri::command]
async fn desktop_choose_model_directory(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
) -> Result<Value, String> {
    choose_folder(window, desktop, true).await
}
#[tauri::command]
async fn desktop_choose_data_root(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
) -> Result<Value, String> {
    choose_folder(window, desktop, false).await
}

#[tauri::command]
fn desktop_open_doc(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    target: String,
    trusted: bool,
    active: bool,
) -> Result<bool, String> {
    self::trusted(&window, &desktop)?;
    if !trusted || !active || !DOC_URLS.contains(&target.as_str()) {
        return Ok(false);
    }
    open::that_detached(target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn desktop_window_action(
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    action: String,
) -> Result<Value, String> {
    trusted(&window, &desktop)?;
    match action.as_str() {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "start-dragging" => window.start_dragging(),
        "close" => {
            window.app_handle().exit(0);
            Ok(())
        }
        "get-state" => Ok(()),
        _ => return Err("Invalid window action".into()),
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({"maximized":window.is_maximized().unwrap_or(false)}))
}

#[tauri::command]
fn desktop_exit_app(window: WebviewWindow, desktop: State<'_, Desktop>) -> Result<bool, String> {
    trusted(&window, &desktop)?;
    window.app_handle().exit(0);
    Ok(true)
}

fn show_error(title: &str, message: &str) {
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

fn setup(app: &mut tauri::App) -> Result<(), String> {
    let root = host::runtime_root(&app.path().resource_dir().map_err(|e| e.to_string())?)?;
    let Some(instance) = instance::Instance::acquire(&root)? else {
        app.handle().exit(0);
        return Ok(());
    };
    let host = Host::spawn(root.clone(), app.handle().clone())?;
    let startup = (|| {
        let result = host.request("start", Value::Null)?;
        let url = host::validated_url(&result)?;
        let mut permissions: Vec<String> =
            COMMANDS.iter().map(|cmd| format!("allow-{cmd}")).collect();
        permissions.extend([
            "core:event:allow-listen".into(),
            "core:event:allow-unlisten".into(),
        ]);
        app.add_capability(json!({
            "identifier":"owned-loopback", "description":"Desktop access for this installation's validated bridge",
            "local":false, "windows":["main"], "remote":{"urls":[url.as_str()]}, "permissions":permissions,
        }).to_string()).map_err(|e| e.to_string())?;
        let allowed = url.clone();
        let update_validation = std::env::var("WECHATVIBE_UPDATE_VALIDATE").as_deref() == Ok("1");
        let final_ready = !update_validation
            && std::env::var_os("WECHATVIBE_UPDATE_FINAL_READY_FILE").is_some()
            && std::env::var_os("WECHATVIBE_UPDATE_FINAL_READY_NONCE").is_some();
        let profile = root.join(".local/tauri-webview");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
            .title("知意 AI · WechatVibe AI")
            .inner_size(1180.0, 780.0)
            .min_inner_size(720.0, 520.0)
            .resizable(true)
            .decorations(false)
            .shadow(true)
            .background_color(tauri::window::Color(27, 27, 27, 255))
            .data_directory(profile)
            .disable_drag_drop_handler()
            .devtools(false)
            .initialization_script(format!(
                "window.__WECHATVIBE_DESKTOP__ = Object.freeze({});",
                json!({"updateValidationMode":update_validation,"updateFinalReadyMode":final_ready})
            ))
            .on_navigation(move |target| target == &allowed)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|e| e.to_string())?;
        let handle = app.handle().clone();
        let maximized = AtomicBool::new(window.is_maximized().unwrap_or(false));
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                handle.exit(0);
            }
            tauri::WindowEvent::Resized(_) => {
                if let Some(window) = handle.get_webview_window("main") {
                    let next = window.is_maximized().unwrap_or(false);
                    if maximized.swap(next, Ordering::SeqCst) == next {
                        return;
                    }
                    let _ = handle.emit("wechatvibe-window-state", json!({"maximized":next}));
                }
            }
            _ => {}
        });
        instance.watch(app.handle().clone());
        app.manage(Desktop {
            host: Arc::clone(&host),
            url,
            closing: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            _instance: instance,
        });
        Ok(())
    })();
    if startup.is_err() {
        let _ = host.shutdown(true);
    }
    startup
}

fn main() {
    let application = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_set_theme,
            desktop_copy_draft,
            desktop_exit_app,
            desktop_get_app_version,
            desktop_get_model_download_state,
            desktop_download_laya_model,
            desktop_choose_model_directory,
            desktop_choose_data_root,
            desktop_check_for_updates,
            desktop_get_update_state,
            desktop_begin_update,
            desktop_rollback_update,
            desktop_report_ui_ready,
            desktop_open_doc,
            desktop_window_action,
        ])
        .setup(|app| setup(app).map_err(Box::<dyn std::error::Error>::from))
        .build(tauri::generate_context!());
    let app = match application {
        Ok(app) => app,
        Err(error) => {
            show_error("知意 AI 启动失败", &error.to_string());
            return;
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(desktop) = app.try_state::<Desktop>() {
                if !desktop.shutdown_complete.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if desktop.closing.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let host = Arc::clone(&desktop.host);
                    let app = app.clone();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    std::thread::spawn(move || {
                        match host.shutdown(false) {
                            Ok(value)
                                if value.get("stopped").and_then(Value::as_bool) == Some(true)
                                    || value.get("alreadyStopped").and_then(Value::as_bool)
                                        == Some(true) => {}
                            Ok(value)
                                if value.get("handoff").and_then(Value::as_bool) == Some(true) => {}
                            result => show_error(
                                "知意 AI 退出提示",
                                &format!("本地服务未能安全关闭：{result:?}"),
                            ),
                        }
                        if let Some(desktop) = app.try_state::<Desktop>() {
                            desktop.shutdown_complete.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    });
                }
            }
        }
    });
}
