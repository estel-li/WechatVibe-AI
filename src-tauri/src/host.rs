use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

type Reply = Result<Value, String>;

// Rust's canonicalize uses verbatim Windows paths; Node realpath and the Python
// installation identity use ordinary paths. Use one representation across all
// three runtimes so ownership, model storage and updater readiness agree.
fn service_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{unc}"))
    } else if let Some(disk) = value.strip_prefix("\\\\?\\") {
        PathBuf::from(disk)
    } else {
        path
    }
}

fn packaged_installation(root: &Path, exe: &Path) -> bool {
    if cfg!(debug_assertions)
        || root.file_name().and_then(|name| name.to_str()) != Some("client")
        || exe.file_name().and_then(|name| name.to_str()) != Some("WechatVibe.exe")
    {
        return false;
    }
    let parent = |path: &Path| {
        path.parent()
            .and_then(|p| p.canonicalize().ok())
            .map(service_path)
    };
    let (Some(root_parent), Some(exe_parent)) = (parent(root), parent(exe)) else {
        return false;
    };
    if !root_parent
        .to_string_lossy()
        .eq_ignore_ascii_case(&exe_parent.to_string_lossy())
    {
        return false;
    }
    let metadata = fs::read(root.join("package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    metadata.is_some_and(|value| {
        value["name"] == "wechatvibe-tauri2-runtime" && value["desktopFramework"] == "tauri2"
    })
}

pub struct Host {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    serial: AtomicU64,
    closed: AtomicBool,
    closing: AtomicBool,
    update_handoff: AtomicBool,
    bridge_created: AtomicBool,
    bridge_port: Mutex<Option<u16>>,
    python: PathBuf,
    pub root: PathBuf,
}

pub fn runtime_root(resource_dir: &Path) -> Result<PathBuf, String> {
    let candidates = if let Some(root) = std::env::var_os("WECHATVIBE_CLIENT_ROOT") {
        vec![PathBuf::from(root)]
    } else {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut roots = vec![
            exe.parent().unwrap().join("client"),
            resource_dir.join("client"),
        ];
        if cfg!(debug_assertions) {
            roots.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_path_buf(),
            );
        }
        roots
    };
    for root in candidates {
        if root.join("scripts/tauri-host.cjs").is_file()
            && root.join("scripts/start-real-client.py").is_file()
            && root.join("chatui/index.html").is_file()
        {
            return root
                .canonicalize()
                .map(service_path)
                .map_err(|e| e.to_string());
        }
    }
    Err("运行文件不完整：找不到 client/scripts/tauri-host.cjs，请使用完整运行包。".into())
}

impl Host {
    pub fn spawn(root: PathBuf, app: AppHandle) -> Result<Arc<Self>, String> {
        let node = std::env::var_os("WECHATVIBE_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let bundled = root.join("runtime/node/node.exe");
                if bundled.is_file() {
                    bundled
                } else {
                    PathBuf::from("node")
                }
            });
        let python = std::env::var_os("WECHATVIBE_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let bundled = root.join("runtime/python/python.exe");
                let project = root.join(".venv/Scripts/python.exe");
                if bundled.is_file() {
                    bundled
                } else if project.is_file() {
                    project
                } else {
                    PathBuf::from("python")
                }
            });
        let logs = root.join(".local/real-client-runtime");
        fs::create_dir_all(&logs).map_err(|e| format!("无法写入本地数据目录：{e}"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("tauri-host.log"))
            .map_err(|e| e.to_string())?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let packaged = packaged_installation(&root, &executable);
        let mut command = Command::new(&node);
        command
            .arg(root.join("scripts/tauri-host.cjs"))
            .current_dir(&root)
            .env("WECHATVIBE_CLIENT_ROOT", &root)
            .env("WECHATVIBE_NODE", &node)
            .env("WECHATVIBE_PYTHON", &python)
            .env(
                "WECHATVIBE_APP_VERSION",
                app.package_info().version.to_string(),
            )
            .env(
                "WECHATVIBE_APP_EXE",
                std::env::current_exe().map_err(|e| e.to_string())?,
            )
            .env("WECHATVIBE_PARENT_PID", std::process::id().to_string())
            .env("WECHATVIBE_APP_PACKAGED", if packaged { "1" } else { "0" })
            .env_remove("CHATUI_PORT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr));
        if node.is_absolute() {
            let mut paths = vec![node.parent().unwrap().to_path_buf()];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            command.env(
                "PATH",
                std::env::join_paths(paths).map_err(|e| e.to_string())?,
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 Node 桌面服务：{e}"))?;
        let input = child.stdin.take();
        let output = child.stdout.take().ok_or("Node stdout unavailable")?;
        let host = Arc::new(Self {
            input: Mutex::new(input),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            serial: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            update_handoff: AtomicBool::new(false),
            bridge_created: AtomicBool::new(false),
            bridge_port: Mutex::new(None),
            python,
            root,
        });
        let watcher = Arc::clone(&host);
        let watcher_app = app.clone();
        std::thread::spawn(move || loop {
            let ended = watcher.child.lock().unwrap().try_wait();
            if !matches!(ended, Ok(None)) {
                watcher.mark_closed(&watcher_app);
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        });
        let reader = Arc::clone(&host);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = reader.pending.lock().unwrap().remove(&id) {
                        let reply = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Desktop service error")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(reply);
                    }
                } else if let Some(event) = message.get("event").and_then(Value::as_str) {
                    match event {
                        "wechatvibe-service-restored"
                        | "wechatvibe-update-state"
                        | "wechatvibe-model-download-state"
                        | "wechatvibe-error" => {
                            let _ = app
                                .emit(event, message.get("detail").cloned().unwrap_or(Value::Null));
                        }
                        "quit" => {
                            if message["detail"]["reason"] == "update" {
                                reader.update_handoff.store(true, Ordering::SeqCst);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                }
            }
            reader.mark_closed(&app);
        });
        Ok(host)
    }

    fn mark_closed(&self, app: &AppHandle) {
        // Windows can keep an inherited pipe handle open after the worker has
        // exited. Observe both the process and EOF, and report failure only once.
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.input.lock().unwrap().take();
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err("本地桌面服务已退出，请重新启动应用".into()));
        }
        if !self.closing.load(Ordering::SeqCst) {
            let _ = app.emit(
                "wechatvibe-error",
                json!({"message":"本地桌面服务已退出，请重新启动应用"}),
            );
        }
    }

    pub fn request(&self, cmd: &str, args: Value) -> Reply {
        if self.closed.load(Ordering::SeqCst) {
            return Err("本地桌面服务已退出，请重新启动应用".into());
        }
        let args = if args.is_null() { json!({}) } else { args };
        let id = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let write_result = (|| {
            let mut guard = self.input.lock().unwrap();
            let stream = guard.as_mut().ok_or("Desktop service is closed")?;
            writeln!(stream, "{}", json!({"id":id,"cmd":cmd,"args":args}))
                .map_err(|e| e.to_string())?;
            stream.flush().map_err(|e| e.to_string())
        })();
        let result = match write_result {
            Ok(()) => receiver
                .recv_timeout(Duration::from_secs(95))
                .map_err(|_| "本地服务操作超时".to_string())
                .and_then(|x| x),
            Err(error) => Err(error),
        };
        self.pending.lock().unwrap().remove(&id);
        if cmd == "start" {
            if let Ok(value) = &result {
                if let Ok(url) = validated_url(value) {
                    *self.bridge_port.lock().unwrap() = url.port();
                    self.bridge_created.store(
                        value["created"].as_bool().unwrap_or(false),
                        Ordering::SeqCst,
                    );
                }
            }
        }
        result
    }

    pub fn shutdown(&self, startup_failed: bool) -> Reply {
        self.closing.store(true, Ordering::SeqCst);
        let mut reply = self.request("shutdown", json!({"startupFailed":startup_failed}));
        if reply.is_err()
            && !self.update_handoff.load(Ordering::SeqCst)
            && (!startup_failed || self.bridge_created.load(Ordering::SeqCst))
        {
            if let Some(port) = *self.bridge_port.lock().unwrap() {
                // The Node worker can crash while its Python bridge remains alive.
                // Reuse the launcher's PID/time/token checks rather than killing a
                // process tree or guessing which listening service belongs to us.
                reply = stop_owned_bridge(&self.root, &self.python, port);
            }
        }
        self.input.lock().unwrap().take();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if self
                .child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .is_some()
            {
                return reply;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        reply
    }
}

fn stop_owned_bridge(root: &Path, python: &Path, port: u16) -> Reply {
    let mut command = Command::new(python);
    command
        .arg(root.join("scripts/start-real-client.py"))
        .args(["--stop-owned-bridge", "--json"])
        .current_dir(root)
        .env("WECHATVIBE_CLIENT_ROOT", root)
        .env("WECHATVIBE_PYTHON", python)
        .env("CHATUI_PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法执行本地服务退出清理".to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地服务退出清理超时".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let result: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "本地服务退出结果无效".to_string())?;
    if !output.status.success() || !(result["stopped"] == true || result["alreadyStopped"] == true)
    {
        return Err("本地服务未能安全关闭，请检查运行日志".into());
    }
    Ok(result)
}

pub fn validated_url(result: &Value) -> Result<tauri::Url, String> {
    let raw = result
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Launcher URL missing")?;
    let instance = result
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if result.get("version").and_then(Value::as_str) != Some("real-ui-1")
        || instance.len() != 64
        || !instance
            .bytes()
            .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
    {
        return Err("Invalid launcher identity".into());
    }
    let url = tauri::Url::parse(raw).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid launcher loopback URL".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_crash_cleans_the_owned_bridge_but_preserves_startup_reuse_and_update_handoff() {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let fixture_base = project.join(".local/review-rust-tests");
        fs::create_dir_all(&fixture_base).unwrap();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = fixture_base.join(format!("cleanup-{suffix}"));
        fs::create_dir_all(root.join("scripts")).unwrap();
        let project_python = project.join(".venv/Scripts/python.exe");
        let python = if project_python.is_file() {
            project_python
        } else {
            PathBuf::from("python")
        };
        fs::write(
            root.join("scripts/start-real-client.py"),
            concat!(
                "import os, sys, json\n",
                "from pathlib import Path\n",
                "assert sys.argv[1:] == ['--stop-owned-bridge', '--json']\n",
                "assert os.environ['CHATUI_PORT'] == '42001'\n",
                "assert Path(os.environ['WECHATVIBE_CLIENT_ROOT']).resolve() == Path.cwd()\n",
                "Path('cleanup-called').write_text('synthetic')\n",
                "print(json.dumps({'stopped': True}))\n"
            ),
        )
        .unwrap();
        for (startup_failed, created, handoff, expected_cleanup) in [
            (false, true, false, true),
            (true, false, false, false),
            (true, true, false, true),
            (false, true, true, false),
        ] {
            let mut command = Command::new(&python);
            command.args(["-c", "pass"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let host = Host {
                input: Mutex::new(None),
                child: Mutex::new(command.spawn().unwrap()),
                pending: Mutex::new(HashMap::new()),
                serial: AtomicU64::new(0),
                closed: AtomicBool::new(true),
                closing: AtomicBool::new(false),
                update_handoff: AtomicBool::new(handoff),
                bridge_created: AtomicBool::new(created),
                bridge_port: Mutex::new(Some(42001)),
                python: python.clone(),
                root: root.clone(),
            };
            assert!(host.request("model-download-state", Value::Null).is_err());
            assert!(host.pending.lock().unwrap().is_empty());
            let result = host.shutdown(startup_failed);
            assert_eq!(result.is_ok(), expected_cleanup);
            assert_eq!(root.join("cleanup-called").exists(), expected_cleanup);
            if expected_cleanup {
                fs::remove_file(root.join("cleanup-called")).unwrap();
            }
        }
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(fixture_base.canonicalize().unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn runtime_paths_match_node_and_python_windows_identity() {
        assert_eq!(
            service_path(PathBuf::from(r"\\?\D:\微信\client")),
            PathBuf::from(r"D:\微信\client")
        );
        assert_eq!(
            service_path(PathBuf::from(r"\\?\UNC\server\share\client")),
            PathBuf::from(r"\\server\share\client")
        );
        assert_eq!(
            service_path(PathBuf::from(r"D:\client")),
            PathBuf::from(r"D:\client")
        );
    }
    #[test]
    fn only_owned_loopback_root_is_accepted() {
        let base = json!({"version":"real-ui-1","instanceId":"a".repeat(64),"url":"http://127.0.0.1:28001"});
        assert_eq!(
            validated_url(&base).unwrap().as_str(),
            "http://127.0.0.1:28001/"
        );
        for url in [
            "http://localhost:28001",
            "https://127.0.0.1:28001",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://user@127.0.0.1:28001",
            "http://127.0.0.1:28001/a",
            "http://127.0.0.1:28001/?x=1",
            "http://example.com:28001",
        ] {
            let mut value = base.clone();
            value["url"] = json!(url);
            assert!(validated_url(&value).is_err(), "{url}");
        }
        let mut wrong = base;
        wrong["instanceId"] = json!("A".repeat(64));
        assert!(validated_url(&wrong).is_err());
    }
}
