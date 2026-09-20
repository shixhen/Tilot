pub mod backend;

use backend::{Backend, BackendEvent};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, State};
use tokio::{process::Command, sync::Mutex};

/// 应用唯一的服务进程及退出标志，多个界面刷新复用同一个连接。
#[derive(Default)]
struct BackendState {
    process: Mutex<Option<Backend>>,
    closing: AtomicBool,
    exit_ready: AtomicBool,
}

/// 选择开发源码或发布资源位置；不接受前端提供的可执行文件路径。
fn server_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut command = Command::new("node");
        command
            .arg(root.join("packages/server/src/main.ts"))
            .current_dir(root);
        Ok(command)
    } else {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(resources.join("node/node.exe"));
        command.arg(resources.join("server/main.js"));
        Ok(command)
    }
}

/// 前端先订阅事件再连接服务；刷新页面不会重复创建进程，已退出的服务不自动重启。
#[tauri::command]
async fn connect_backend(
    app: tauri::AppHandle,
    state: State<'_, BackendState>,
) -> Result<(), String> {
    let mut process = state.process.lock().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("应用正在退出。".into());
    }
    if let Some(backend) = process.as_ref() {
        return if backend.is_exited() {
            Err("本地服务已退出，请重新打开应用。".into())
        } else {
            Ok(())
        };
    }
    let command = server_command(&app)?;
    *process = Some(Backend::spawn(command, move |event: BackendEvent| {
        let _ = app.emit_to("main", "backend-event", event);
    })?);
    Ok(())
}

/// 将前端 JSON 请求交给既有服务，具体方法和参数由 Server 校验。
#[tauri::command]
async fn send_backend(request: Value, state: State<'_, BackendState>) -> Result<(), String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("应用正在退出。".into());
    }
    let backend = state
        .process
        .lock()
        .await
        .clone()
        .ok_or("本地服务尚未连接。")?;
    backend.send(request).await
}

/// 创建桌面窗口与单实例约束，退出前等待 Node 服务完成清理。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![connect_backend, send_backend])
        .build(tauri::generate_context!())
        .expect("无法创建 Tilot 桌面应用")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<BackendState>();
                if state.exit_ready.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if state.closing.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let backend = app.state::<BackendState>().process.lock().await.clone();
                    if let Some(backend) = backend {
                        backend.shutdown().await;
                    }
                    app.state::<BackendState>()
                        .exit_ready
                        .store(true, Ordering::SeqCst);
                    app.exit(0);
                });
            }
        });
}
