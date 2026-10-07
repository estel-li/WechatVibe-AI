# Electron → Tauri 2 迁移

原项目保留在 `../WechatVibe-electron/`。新目录以 Tauri 2 的 Rust 宿主、Windows WebView2 和 JSONL Node sidecar 替换 Electron 主进程、preload、IPC 与 Electron Builder。

桌面依赖统一使用 Tauri 2.12.1、Tauri Build 2.7.1 与 Tauri CLI 2.12.1，具体直接和传递版本锁定在 `src-tauri/Cargo.lock` 与 `package-lock.json`。

| 原架构 | Tauri 2 架构 |
| --- | --- |
| Electron BrowserWindow | Tauri WebviewWindow / WebView2 |
| Electron preload 与 IPC | `chatui/desktop-host.js` + Tauri commands/events |
| Electron 主进程 | `src-tauri/` Rust 生命周期与系统能力 |
| 主进程中的 Node 服务 | `scripts/tauri-host.cjs` JSONL 子进程 |
| `electron/` 纯分析 TypeScript | `analysis/`，保持原来的分析实现 |
| Electron Builder / app.asar | Tauri CLI / 原生 EXE + `client/` |
| `resources/client/.local` | 每个安装的 `client/.local` |
| `win-unpacked/` 更新包 | `tauri2-portable/`，独立产品标识 |

`chatui` 的布局、样式、页面逻辑和业务 HTTP API 保留。Python 微信读取、模型选择、账号作用域、结果存储、历史浏览、任务恢复与 TypeScript Laya/API 分析继续使用原有代码；仅调整目录引用和桌面桥接。Node、Python 与 ONNX Runtime 仍是运行依赖，因此完整便携目录需要与 EXE 一起分发。

构建只能从公共文件清单、Python RECORD 和 Node 依赖闭包组装；不会把开发目录、`.local` 用户数据或聊天数据库打进包。构建验证报告记录每个文件的 SHA-256。更新器要求 `wechatvibe-tauri2-runtime` / `desktopFramework: tauri2`，拒绝原架构的更新包。

## 验证方式

`npm test` 覆盖业务与架构回归；`npm run build:portable` 完成实际 Rust release 编译、runtime staging 和最终目录逐文件校验；`npm run test:model` 使用另行下载的模型验证 ONNX 推理。真实微信账号和在线 API 的读取/请求需在具备对应环境与配置的机器上检查。

2026-10-07 首次迁移验收记录：`npm test` 全部通过，包含 443 项 Node 测试、8 组桌面脚本测试、444 项 Python 测试与 3 项 Rust 测试；Rust Clippy 无警告。原有业务 `chatui/app.js` 与 Electron 目录字节一致。

真实 WebView2 的开发版与发行版均验证了桌面接口、会话切换、聊天及画像页面、主题、缩放、草稿复制、版本与更新页面、窗口最大化/还原/最小化、重复启动唤醒、导航与弹出窗口拦截，以及正常退出。开发版另验证了两个父窗口模态目录选择器取消和 Windows 原生调整窗口大小。标题栏拖动使用 Tauri 的原生接口；自动化工具无法独立保持物理鼠标按下，拖动手势尚未完成自动化验证。

源码、自带运行环境、安装包解出的运行环境均通过真实 Node → Python 服务启动、身份匹配、关闭和端口释放检查；未访问真实微信账号数据或调用付费模型。标准运行包不包含模型权重，保留原来的下载和选目录功能。验证证据位于 `docs/verification/`，完整构建清单位于 `dist/WechatVibe-tauri2-build-verification.json`。

测试和构建的具体结果由迁移完成报告及 `.local/tauri-builds/*/build-verification.json` 提供。本文件不将尚未执行的检查计作成功。

后续 UI、性能和维护者信息更新见 [review 与性能记录](docs/review-and-performance.md)。首次迁移时的 app.js 字节一致检查为历史验收证据。
