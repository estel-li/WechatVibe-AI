//! Installation-scoped instance ownership; independent portable copies can coexist.
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Manager};

pub fn identity(root: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes())
    )
}

#[cfg(windows)]
pub struct Instance {
    mutex: isize,
    event: isize,
}

#[cfg(windows)]
impl Instance {
    pub fn acquire(root: &Path) -> Result<Option<Self>, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::{CreateEventW, CreateMutexW, SetEvent},
        };
        fn wide(s: String) -> Vec<u16> {
            s.encode_utf16().chain(Some(0)).collect()
        }
        let key = identity(root);
        let mutex_name = wide(format!("Local\\WechatVibe-Tauri2-{key}"));
        let event_name = wide(format!("Local\\WechatVibe-Tauri2-Focus-{key}"));
        unsafe {
            let mutex = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
            if mutex.is_null() {
                return Err("无法创建客户端实例锁".into());
            }
            let existing = GetLastError() == ERROR_ALREADY_EXISTS;
            let event = CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr());
            if event.is_null() {
                CloseHandle(mutex);
                return Err("无法创建客户端唤醒事件".into());
            }
            if existing {
                SetEvent(event);
                CloseHandle(event);
                CloseHandle(mutex);
                return Ok(None);
            }
            Ok(Some(Self {
                mutex: mutex as isize,
                event: event as isize,
            }))
        }
    }
    pub fn watch(&self, app: AppHandle) {
        let event = self.event;
        std::thread::spawn(move || {
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            while unsafe { WaitForSingleObject(event as _, u32::MAX) } == 0 {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    }
}

#[cfg(windows)]
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.event as _);
            windows_sys::Win32::Foundation::CloseHandle(self.mutex as _);
        }
    }
}

#[cfg(not(windows))]
pub struct Instance;
#[cfg(not(windows))]
impl Instance {
    pub fn acquire(_: &Path) -> Result<Option<Self>, String> {
        Err("WechatVibe 当前仅支持 Windows".into())
    }
    pub fn watch(&self, _: AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_have_distinct_instance_locks() {
        assert_ne!(
            identity(Path::new("D:/one/client")),
            identity(Path::new("D:/two/client"))
        );
        assert_eq!(
            identity(Path::new("D:/ONE/client")),
            identity(Path::new("d:/one/client"))
        );
    }
}
