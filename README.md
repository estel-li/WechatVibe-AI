# WechatVibe Tauri 2

维护者：老李。关于页、键盘交互与前端刷新性能已更新；代码 review 结果和测试证据见 [review 与性能记录](docs/review-and-performance.md)。保留上游来源及第三方许可声明。

WechatVibe 的 Tauri 2 桌面版本。原版 `WechatVibe-electron` 保留在同级目录；本目录使用 Rust + Windows WebView2 承载原有 `chatui` 页面，通过 Node 与 Python 子进程运行原来的微信只读读取和分析服务。聊天、情绪与意图标签、人物画像、模型设置、账号管理、本地缓存和应用更新的页面与业务分析代码沿用原版。

`analysis/` 是原 `electron/` 下的纯 TypeScript 分析代码迁移后的目录。它继续通过 Node + `tsx` 执行，包括 Laya ONNX 本地模型以及 OpenAI、Anthropic、Gemini、Ollama 等 API 连接器。Python 读取层继续使用 `wechatauto-replica` 和现有 `native-reader`。桌面宿主、窗口、文件选择、系统操作和跨进程通信迁移为 Tauri 2；运行包不携带 Electron 或 Chromium 分发包。

## Windows 开发

需要 Windows 10/11 x64、Microsoft Edge WebView2 Runtime、Visual Studio C++ Build Tools 与 Windows SDK、当前稳定版 Rust 工具链、Node 24.11.1 及以上的 24.x 版本、标准 Python 3.14 x64。

在本目录的 PowerShell 执行：

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-deps -r python-requirements.lock.txt
npm install
npm start
```

`--no-deps` 使用项目已锁定的读取依赖集合。上游声明的可选 GUI、OCR 和媒体依赖不在该集合内，详见 `THIRD_PARTY_NOTICES.md`。项目脚本自动选择 `.venv`；也可以使用 `WECHATVIBE_PYTHON` 指定 Python，`WECHATVIBE_NODE` 指定业务运行的 Node。`npm start` 启动 Tauri 开发宿主，后端和分析 worker 由桌面宿主管理。

开发数据写入本目录 `.local/`。缺少本地模型时，可在原有设置界面下载并安装，或先执行：

```powershell
npm run setup:models
```

模型下载使用原来的 revision、文件长度及 SHA-256 校验。API 模式使用原有设置页；启用后，分析所需的聊天片段发送至所配置的服务地址。

## 构建便携版

```powershell
npm run build:portable
```

脚本先收集锁定 Windows Rust 依赖的许可证，然后在 `.local/tauri-builds/build-*/client` 创建全新 stage，按发行包 RECORD 与 Node 依赖闭包复制 Python、Node、ONNX Runtime，再按清单复制业务代码与页面。它校验文件长度和 SHA-256，将 stage 映射到 `src-tauri/resources/client`，执行与 `npx tauri build --no-bundle` 相同的本地 Tauri CLI，最后创建：

```text
dist/WechatVibe-tauri2/
  WechatVibe.exe
  WechatVibe-diagnose.bat
  client/
    runtime/python/
    runtime/node/
    node_modules/
    scripts/
    bridge/
    analysis/
    chatui/
```

用户双击 `WechatVibe.exe`；无需额外安装 Node 或 Python。便携目录必须可写，数据、账号配置、缓存、日志与 WebView2 用户数据放在该安装的 `client/.local/`。设置页下载的模型位于 `client/.local/models/laya`；构建预先附带的模型位于 `client/.models/laya`。复制不同安装目录会获得不同实例身份与本地端口。标准包不附带 Laya 权重，保留原有首次下载流程；需要包含已有的、通过校验的模型时：

```powershell
npm run build:portable -- --with-model
# 或指定已校验的外部模型目录：
npm run build:portable -- --models-dir D:\Models\laya
```

`--python-exe`、`--node-exe` 与 `--node-license` 可以指定构建输入。Node 的完整许可证必须与所选版本一致：默认从 Node 目录或 `licenses/node-LICENSE-版本.txt` 查找，也可用 `WECHATVIBE_NODE_LICENSE` 指定。构建不读取 `.local`、聊天数据库、账号配置、API Key 或开发环境中的任意未列入清单文件。

构建阶段和验证报告保留在 `.local/tauri-builds/`；最终文件清单写到 `dist/WechatVibe-tauri2-build-verification.json`。已有输出若包含 `.local` 用户数据，构建拒绝替换，可改用 `--output-dir dist/另一个目录`。以前的构建资源和可替换输出保存在当前 build 的 `previous-*` 目录。

## 安装包、测试与发行

```powershell
npm run build:installer
npm test
```

安装包使用当前用户 NSIS 安装模式，资源仍为 `client/`，由 Tauri 的 Windows 安装器处理 WebView2 Runtime。Rust 直接构建可用 `npm run build`；分发前应使用准备完整 runtime 的 `build:portable` 或 `build:installer`。

`npm test` 包括 TypeScript 检查、原有 Node/Python 业务回归、Tauri 适配与 Rust 测试。`npm run test:model` 需要已安装模型，并验证真实本地推理。实际微信账号的读取依赖本机微信及登录状态，离线测试不等同于真实账号验证。

发行更新 ZIP 使用单独的 Tauri 产品标识与根目录，避免接收 Electron 架构更新包：

```powershell
.\.venv\Scripts\python.exe scripts/build-windows-release.py --input dist/WechatVibe-tauri2 --version 1.2.4 --output-dir dist/releases
```

输出 `WechatVibe-tauri2-1.2.4-windows-x64.zip`，内部根目录为 `tauri2-portable/`。`--with-model` 生成单独的 `-windows-x64-full.zip`。签名与发布继续通过 `scripts/build-update-manifest.cjs` 管理；私钥不进入源码、stage 或安装包。

迁移边界与验证记录见 [MIGRATION.md](MIGRATION.md)，启动诊断见 [docs/startup-diagnostics.md](docs/startup-diagnostics.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
