use serde::Serialize;
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{mpsc, oneshot, watch},
    time::{Instant, sleep_until, timeout},
};

/// Rust 到界面的桥接事件，消息主体保持 Server 协议不变。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BackendEvent {
    Message { message: Value },
    Stopped { error: Option<String> },
}

/// 待写入请求及写入确认；确认只代表传输完成，不代表 RPC 成功。
struct WriteRequest {
    line: String,
    reply: oneshot::Sender<Result<(), String>>,
}

/// 子进程的通信与退出句柄；进程本身由后台任务持有，界面不能指定执行程序。
#[derive(Clone)]
pub struct Backend {
    requests: mpsc::Sender<WriteRequest>,
    stop: watch::Sender<bool>,
    exited: watch::Receiver<bool>,
}

impl Backend {
    /// 启动固定的服务命令，独立读写管道，防止输出与大请求互相堵塞。
    pub fn spawn(
        mut command: Command,
        notify: impl Fn(BackendEvent) + Send + 'static,
    ) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW，服务不弹出控制台。
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动本地服务：{error}"))?;
        let stdin = child.stdin.take().expect("stdin 已配置为管道");
        let mut stdout = BufReader::new(child.stdout.take().expect("stdout 已配置为管道")).lines();
        let mut stderr = BufReader::new(child.stderr.take().expect("stderr 已配置为管道")).lines();
        let (requests, receiver) = mpsc::channel(16);
        let (stop, mut stopping) = watch::channel(false);
        let (finished, exited) = watch::channel(false);
        let writer = tokio::spawn(write_requests(stdin, receiver, stop.clone()));
        let stop_after_read = stop.clone();
        tokio::spawn(async move {
            let mut error = None;
            let mut stderr_open = true;
            let mut closing = false;
            let mut deadline = Instant::now();
            loop {
                tokio::select! {
                    line = stdout.next_line() => match line {
                        Ok(Some(line)) => match serde_json::from_str(&line) {
                            Ok(message) => notify(BackendEvent::Message { message }),
                            Err(_) => { error = Some("服务返回了无效的 JSON 消息。".into()); break; }
                        },
                        Ok(None) => break,
                        Err(_) => { error = Some("读取服务消息失败。".into()); break; }
                    },
                    line = stderr.next_line(), if stderr_open => match line {
                        Ok(Some(line)) => error = Some(line),
                        _ => stderr_open = false,
                    },
                    _ = stopping.changed(), if !closing => {
                        closing = true;
                        deadline = Instant::now() + Duration::from_secs(5);
                    },
                    _ = sleep_until(deadline), if closing => {
                        error = Some("服务未及时退出，已请求强制结束。".into());
                        let _ = child.kill().await;
                        break;
                    }
                }
            }
            stop_after_read.send_replace(true);
            let _ = writer.await;
            match timeout(Duration::from_secs(5), child.wait()).await {
                Ok(Ok(status)) if status.success() => {}
                Ok(Ok(status)) => {
                    if error.is_none() {
                        error = Some(format!("服务异常退出：{status}"));
                    }
                }
                Ok(Err(_)) => error = Some("无法读取服务退出状态。".into()),
                Err(_) => {
                    let _ = child.kill().await;
                    error = Some("服务退出超时。".into());
                }
            }
            notify(BackendEvent::Stopped { error });
            finished.send_replace(true);
        });
        Ok(Self {
            requests,
            stop,
            exited,
        })
    }

    /// 序列化单条请求并等待写入，保留字符串内的换行转义，不记录请求原文。
    pub async fn send(&self, request: Value) -> Result<(), String> {
        if *self.stop.borrow() || self.is_exited() {
            return Err("本地服务已关闭。".into());
        }
        let (reply, received) = oneshot::channel();
        self.requests
            .send(WriteRequest {
                line: format!("{request}\n"),
                reply,
            })
            .await
            .map_err(|_| "服务输入已关闭。")?;
        received.await.map_err(|_| "请求尚未写入，服务已关闭。")?
    }

    /// 查询后台任务是否已收尾，用于阻止向已退出服务继续发送请求。
    pub fn is_exited(&self) -> bool {
        *self.exited.borrow()
    }

    /// 先关闭标准输入，让 Server 取消执行并保存状态，再等待退出或超时终止。
    pub async fn shutdown(&self) {
        self.stop.send_replace(true);
        let mut exited = self.exited.clone();
        let _ = exited.wait_for(|finished| *finished).await;
    }
}

/// 串行写入请求；关闭通知可以中断正在等待的管道写入，并释放标准输入。
async fn write_requests(
    mut stdin: ChildStdin,
    mut requests: mpsc::Receiver<WriteRequest>,
    stop: watch::Sender<bool>,
) {
    let mut stopping = stop.subscribe();
    while !*stopping.borrow() {
        let request = tokio::select! {
            _ = stopping.changed() => break,
            request = requests.recv() => match request { Some(request) => request, None => break },
        };
        let result = tokio::select! {
            _ = stopping.changed() => Err("服务正在关闭。".to_string()),
            result = stdin.write_all(request.line.as_bytes()) => result.map_err(|_| "向服务写入请求失败。".to_string()),
        };
        let failed = result.is_err();
        let _ = request.reply.send(result);
        if failed {
            break;
        }
    }
    stop.send_replace(true);
}
