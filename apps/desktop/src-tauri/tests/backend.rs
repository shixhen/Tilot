use serde_json::json;
use std::{path::Path, time::Duration};
use tilot_desktop::backend::{Backend, BackendEvent};
use tokio::{process::Command, sync::mpsc, time::timeout};

/// 等待桥接消息，测试超时直接失败，避免进程异常时无限等待。
async fn receive(events: &mut mpsc::UnboundedReceiver<BackendEvent>) -> BackendEvent {
    timeout(Duration::from_secs(10), events.recv())
        .await
        .unwrap()
        .unwrap()
}

/// 通过真正的 Node 服务验证中文、换行、请求应答及关闭标准输入后的正常退出。
#[tokio::test]
async fn node_server_round_trip_and_graceful_shutdown() {
    let directory = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut command = Command::new("node");
    command
        .arg(root.join("packages/server/src/main.ts"))
        .arg(directory.path());
    let (sender, mut events) = mpsc::unbounded_channel();
    let backend = Backend::spawn(command, move |event| {
        let _ = sender.send(event);
    })
    .unwrap();
    backend
        .send(json!({"id":"create","method":"thread.create","params":{"title":"中文\n任务"}}))
        .await
        .unwrap();
    match receive(&mut events).await {
        BackendEvent::Message { message } => {
            assert_eq!(message["id"], "create");
            assert_eq!(message["success"], true);
            assert_eq!(message["result"]["title"], "中文\n任务");
        }
        _ => panic!("应先收到 RPC 应答"),
    }
    backend
        .send(json!({"id":"list","method":"thread.list","params":{}}))
        .await
        .unwrap();
    match receive(&mut events).await {
        BackendEvent::Message { message } => {
            assert_eq!(message["result"].as_array().unwrap().len(), 1)
        }
        _ => panic!("任务列表请求不应导致服务退出"),
    }
    timeout(Duration::from_secs(10), backend.shutdown())
        .await
        .unwrap();
    assert!(backend.is_exited());
    assert!(matches!(
        receive(&mut events).await,
        BackendEvent::Stopped { error: None }
    ));
    assert!(backend.send(json!({})).await.is_err());
}

/// 子进程忽略输入关闭时，宿主必须结束它，不能让应用退出一直挂起。
#[tokio::test]
async fn unresponsive_process_is_terminated() {
    let mut command = Command::new("node");
    command.arg("-e").arg("setInterval(() => {}, 1000)");
    let (sender, mut events) = mpsc::unbounded_channel();
    let backend = Backend::spawn(command, move |event| {
        let _ = sender.send(event);
    })
    .unwrap();
    timeout(Duration::from_secs(12), backend.shutdown())
        .await
        .unwrap();
    assert!(backend.is_exited());
    assert!(matches!(
        receive(&mut events).await,
        BackendEvent::Stopped { error: Some(_) }
    ));
}
