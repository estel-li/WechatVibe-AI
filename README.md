<div align="center">

<img src="docs/assets/readme/wechatvibe-logo.png" alt="WechatVibe" width="128">

# WechatVibe Tauri 2

微信聊天情感分析客户端 · 由 [estel-li](https://github.com/estel-li) 维护<br>
意图识别 · 情绪感知 · 人物画像 · 群聊画像 · 好感度 · MBTI 聊天推测

[![Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](#运行要求)
[![Tauri 2](https://img.shields.io/badge/desktop-Tauri%202-24C8D8)](https://tauri.app/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[功能介绍](#功能介绍) · [下载安装](#下载安装) · [首次使用](#首次使用) · [常见问题](#常见问题) · [开发与构建](#开发与构建) · [数据与隐私](#数据与隐私) · [免责声明](#免责声明) · [来源与致谢](#来源与致谢) · [交流与反馈](#交流与反馈)

</div>

**这是基于 [tswawa/WechatVibe](https://github.com/tswawa/WechatVibe) 上游项目移植的 Tauri 2 版本，由 [estel-li](https://github.com/estel-li) 独立维护。** 保留上游的聊天分析功能与页面结构，将 Electron 桌面宿主替换为 Rust + Tauri 2 + Windows WebView2。保留上游 Apache-2.0 许可、来源说明及第三方声明。

WechatVibe 只读读取本机已登录的 Windows 微信，分析消息情绪与沟通意图，并整理人物画像、群聊画像、好感度和 MBTI 聊天推测。

- **本地分析**：使用 [Laya](https://github.com/NandhaKishorM/laya) 的 [多语言 ONNX 模型](https://huggingface.co/mizchi/laya-multilingual-onnx)，在本机推理。
- **API 分析**：支持 Anthropic、OpenAI Responses、Chat Completions、Gemini 和 Ollama 兼容接口。
- **微信读取**：沿用 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) 与 `native-reader` 的只读读取层。
- **桌面架构**：Tauri 2 管理窗口、系统操作与进程通信，Node/Python 承载原有分析服务；运行包不附带 Electron 或 Chromium 分发包。
- **本版本优化**：消息节点复用、时间格式化、后台退出清理、剪贴板处理，以及设置弹窗的布局和键盘操作。详见 [review 与性能记录](docs/review-and-performance.md) 和 [迁移记录](MIGRATION.md)。

![API 模式下的消息情绪与意图识别](docs/assets/readme/chat-demo.png)

<sub>功能演示图沿用上游截图，聊天与分析结果均为虚构数据。以下功能与使用说明参考上游完整 README，并针对本版本的运行、构建和维护方式调整。</sub>

## 功能介绍

### 消息情绪与意图

在聊天页点击「意图识别」，消息下方会显示情绪和意图两个短标签，例如「开心」「期待」「委屈」，或「分享」「邀约」「求安慰」「婉拒」。

- **结合上下文**：参考近期聊天和已保存的人物画像来判断，不只看单句；纯标点消息也能分析。
- **本地与 API 一致**：两种模式显示方式相同。API 模式的每个标签不超过四个字，使用支持流式返回的接口时会边分析边显示。
- **人物情绪与群聊氛围**：单聊顶部显示聊天对象当前的情绪状态，群聊顶部显示整体氛围。
- **随时开关**：关闭标签后再打开，会恢复已有结果。

### 人物画像

从聊天工具栏或左侧导航进入「人物画像」，在同一页面查看好感度、MBTI 倾向、互动风格和画像摘要。

![人物画像：好感度、MBTI 倾向、互动风格和摘要](docs/assets/readme/profile-demo.png)

- **好感度**：单聊显示好感度数值和等级，随新消息持续更新。
- **MBTI 聊天推测**：按 E/I、S/N、T/F、J/P 四个维度显示倾向。该人物已分析的有效文本满 100 条后解锁，依据不足的维度显示为未确定。
- **互动风格**：六维雷达图，包括表达活力、幽默表达、情绪平和、话题主动、关怀支持和亲近表达。
- **常聊内容**：根据实际分析过的文本展示高频词。
- **统一计分**：API 模式按上下文容量整批判断聊天，好感度、MBTI、雷达和摘要使用与本地 Laya 相同的累计和打分规则。
- **保存与续算**：再次进入时先显示上次的结果，新消息在原有基础上继续分析，切换聊天或重启软件都不会重新分析全部历史；分析中可查看进度和速率。

### 群聊画像

在群聊中进入画像页面，可以在「群整体」和具体成员之间切换。

![群聊整体画像与成员选择](docs/assets/readme/group-profile-demo.png)

- **群整体**：参与人数、消息数量、分析进度、六维互动风格、常见词和群聊摘要。
- **成员画像**：搜索或翻页选择成员，查看该成员的互动风格、摘要和 MBTI 聊天推测。
- **分别保存**：群整体和每个成员各自积累结果，切换时显示对应对象的画像。

### 聊天记录与账号

软件只读读取本机已登录的微信，支持单聊、群聊、联系人和群头像。图片消息显示为 `[图片]`。

- **按需添加会话**：首次进入只读取会话目录，不加载全部聊天。点击左侧搜索框旁的「＋」，或在「设置 → 信息列表」添加要查看的会话；移出列表不会删除缓存或画像。
- **历史记录**：分页查看更早的消息，可按关键词或日期查找，并定位到上下文。
- **聊天记录路径**：自动找不到微信数据时，可在「设置 → 通用设置 → 聊天记录路径」选择 `xwechat_files` 或账号目录，也可以恢复自动发现。选择目录后仍需微信登录并通过账号校验。
- **多账号**：每个微信账号使用独立的数据库，再次登录时复用原有记录。
- **清除账号**：在账号管理中清除某个账号在 WechatVibe 里的聊天副本、分析和画像，不影响微信本身的聊天记录。清除当前账号后软件会退出。

<details>
<summary>截图：选择要查看的会话</summary>

![选择要加入聊天列表的会话](docs/assets/readme/conversations-demo.png)

</details>

### 模型与设置

- **模型来源**：默认使用本地 Laya，也可以接入 API。填写 Base URL、API Key 和上下文大小后，可获取模型列表、测试连接并启用。
- **上下文容量**：API 画像按模型的上下文容量自动分批，装得下就一次处理。完整的画像判断至少需要 12288 tokens 上下文，不足时会提示。
- **分来源保存**：本地和各个 API 模型的结果分开保存，可在设置中分别查看和清除缓存。
- **运行设置**：浅色/深色主题、界面缩放，以及 CPU/GPU 切换；GPU 不可用时可回退到 CPU。

<details>
<summary>截图：模型设置与缓存管理</summary>

![本地 Laya 下载与运行设备选择](docs/assets/readme/local-model-demo.png)

![API 服务地址、协议、模型与上下文设置](docs/assets/readme/api-settings-demo.png)

![按本地和 API 模型来源分别管理分析缓存](docs/assets/readme/cache-demo.png)

</details>

## 下载安装

本仓库目前发布源码，尚未上传二进制 Release。可以按 [开发与构建](#开发与构建) 从源码运行或构建。正式运行包发布后将在 [本版本 Releases](https://github.com/estel-li/WechatVibe-tauri2/releases) 提供。

本版本运行包的使用方式：

1. 下载 Tauri 2 标准包 `WechatVibe-tauri2-版本号-windows-x64.zip` 或 Windows 安装包。标准包不含 Laya 模型。
2. ZIP 解压后保留整个 `tauri2-portable` 目录，双击 `WechatVibe.exe`。安装包按向导安装后启动。
3. 本地分析需要在「设置 → 本地部署」下载模型，或选择已有、通过校验的模型目录；仅使用 API 时可跳过。

Tauri 版和上游 Electron 版的目录布局、桌面程序及更新包不同，升级应使用同一架构的完整运行包。

### 运行要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| 桌面运行时 | Microsoft Edge WebView2 Runtime；安装器提供缺失时的安装引导 |
| 微信 | Windows 微信 4.x，保持账号已登录；不支持 3.x。上游记录的实测版本为 4.1.15.13，本次迁移未重新测试真实账号 |
| Node/Python | 便携运行包内置所需运行时；源码开发需自行安装 |
| 存储 | 便携目录需可写，账号、缓存、模型和 WebView 数据保存在 `client/.local/` |

下面的 Laya 配置参考来自上游，本次移植未重新系统测试低配设备。

<details>
<summary>本地 Laya 配置参考（只用 API 可以跳过）</summary>

模型约 3.22 亿参数，纯 CPU 即可运行，不需要独立显卡。下表为建议配置，低配设备尚未系统测试。

| 项目 | 建议配置 |
| --- | --- |
| CPU | 4 核及以上 x64 处理器；CPU 推理默认使用 4 线程 |
| 内存 | 8 GB 起步；同时运行微信和其他应用，建议 16 GB 及以上 |
| GPU（可选） | 支持 WebGPU 的显卡和较新的驱动，不兼容时使用 CPU；最低显存要求暂未确定 |
| 磁盘 | 至少预留 4 GB，用于应用、模型下载和安装；聊天缓存和更新备份另算 |
| 模型体积 | 模型包约 599 MB，解压后约 681 MB；文件体积不等于运行时的内存占用 |

首次加载和分析历史消息的速度取决于处理器、内存和聊天量。API 模式不需要下载 Laya，也不需要本地显卡，速度和上下文容量取决于所选的模型服务。

</details>

## 首次使用

1. **登录微信**：使用 Windows 微信 4.x 登录要分析的账号。
2. **启动软件**：双击 `WechatVibe.exe`。账号状态可在「设置 → 管理账号」查看，不用等聊天加载完就能使用界面。
3. **选择模型**：在「设置 → 通用设置」选择模型来源。本地模式下载或选择 Laya 模型；API 模式填写服务地址、API Key 和模型，确认上下文大小，测试连接后保存并启用。
4. **添加会话**：点击左侧搜索框旁的「＋」，或在「设置 → 信息列表」选择联系人或群聊。
5. **查看分析**：打开聊天，点击「意图识别」查看消息标签；进入「人物画像」查看画像，群聊还可以选择具体成员。

## 软件更新

应用保留「设置 → 关于 → 当前版本」的检查、下载、校验、安装与回退流程。**当前检查地址仍为上游 `tswawa/WechatVibe` Releases；本仓库尚未提供签名更新发布。** Tauri 更新器仅接受对应产品标识、签名及文件布局的 Tauri 2 资产，不会把上游 Electron 包作为本版本更新安装。

手动升级时，完全退出应用后使用同架构完整运行包，并保留该安装的 `client/.local` 和 `client/.models`。首次迁移和后续维护说明分别见 [MIGRATION.md](MIGRATION.md) 与 [review 记录](docs/review-and-performance.md)。[CHANGELOG.md](CHANGELOG.md) 保留上游功能版本历史，不代表本仓库已经发布对应版本的二进制文件。

## 常见问题

<details>
<summary>一直显示「当前微信账号未就绪」</summary>

- 确认登录 Windows 微信 4.x；旧版 3.x 不受支持。
- 数据在自定义位置时，在「设置 → 通用设置 → 聊天记录路径」选择 `xwechat_files` 或账号目录。
- 选择目录后仍需微信登录并通过账号校验。
- 若仍未就绪，运行启动诊断工具，再到 [本版本 Issues](https://github.com/estel-li/WechatVibe-tauri2/issues) 反馈。

</details>

<details>
<summary>启动时提示「本地服务未就绪」或无法打开</summary>

在 `WechatVibe.exe` 同目录运行随包提供的 `WechatVibe-diagnose.bat`。它会检查文件、运行环境和启动错误并生成报告，不启动应用或模型，不读取聊天数据库和 API Key，也不会自动上传。详见 [启动诊断说明](docs/startup-diagnostics.md)。

便携版需保留完整 `client/`，并安装 WebView2 Runtime。标准包没有模型权重时，进入设置下载或选择模型，或配置 API 模式。

</details>

<details>
<summary>升级后人物画像还是旧的</summary>

已有 API 画像会先保留显示。在画像页点击「更新画像」后才按新规则重新分析，重建期间会注明正在显示旧画像。

</details>

<details>
<summary>模型下载失败、GPU 不可用或 API 分析失败</summary>

模型文件必须通过长度和 SHA-256 校验；可重试下载或选择已通过校验的外部目录。GPU 不兼容时切换 CPU。API 模式检查服务地址、协议、Key、模型名称及上下文大小，在设置中测试连接后保存并启用；完整画像判断至少需要 12288 tokens 上下文。

</details>

## 开发与构建

### Windows 开发

需要 Windows 10/11 x64、Microsoft Edge WebView2 Runtime、Visual Studio C++ Build Tools 与 Windows SDK、当前稳定版 Rust 工具链、Node 24.11.1 及以上的 24.x 版本、标准 Python 3.14 x64。

安装 Rust、Visual Studio Build Tools 的 C++ 桌面开发组件与 Windows SDK 后，在 PowerShell 执行：

```powershell
git clone https://github.com/estel-li/WechatVibe-tauri2.git
cd WechatVibe-tauri2
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-deps -r python-requirements.lock.txt
npm ci
npm start
```

`--no-deps` 使用项目已锁定的读取依赖集合。上游声明的可选 GUI、OCR 和媒体依赖不在该集合内，详见 `THIRD_PARTY_NOTICES.md`。项目脚本自动选择 `.venv`；也可以使用 `WECHATVIBE_PYTHON` 指定 Python，`WECHATVIBE_NODE` 指定业务运行的 Node。`npm start` 启动 Tauri 开发宿主，后端和分析 worker 由桌面宿主管理。

开发数据写入本目录 `.local/`。缺少本地模型时，可在原有设置界面下载并安装，或先执行：

```powershell
npm run setup:models
```

模型下载使用原来的 revision、文件长度及 SHA-256 校验。API 模式使用原有设置页；启用后，分析所需的聊天片段发送至所配置的服务地址。

### 构建便携版

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

### 安装包、测试与发行

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
### 业务结构与词库

`analysis/` 来自上游 `electron/` 的纯 TypeScript 分析模块，继续由 Node + `tsx` 执行。Python 读取和存储位于 `bridge/`、`native-reader/`；`chatui/` 保留页面；`src-tauri/` 是 Rust 桌面宿主。后端职责见 [后端架构说明](docs/backend-architecture.md)。

词库源文件为 `scripts/analysis-catalog-source.json`、`scripts/intent-display-source.json` 和 `scripts/social-intent-source.json`。修改时保留既有 ID，再执行 `npm run catalog:generate`。可通过 `npm run catalog:export` 导出显示词库。

源码测试与 UI 验证使用合成数据。真实微信读取取决于本机微信版本和账号登录情况；模型推理需另外运行 `npm run test:model`，在线服务需配置后自行验证。

## 数据与隐私

- **本地模式（默认）**：使用本地 Laya 在本机推理，本地服务只监听回环地址。
- **API 模式（需手动开启）**：消息分析会把当前这批聊天文本和简短的画像参考发送给你配置的模型服务；人物画像会按上下文容量发送所选会话的历史文本，由模型判断后，再由程序计算好感度、MBTI、互动风格和摘要。
- **保存方式**：聊天副本按微信账号保存，分析结果和画像再按模型来源分开。

使用时请注意：

- 只读取自己有权访问的账号和聊天，不用于获取他人的私人记录。
- 清除账号只删除 WechatVibe 保存的数据，不删除微信原始聊天。
- 软件只分析和展示，不自动发送微信消息，也不提供聊天记录导出功能。
- 不要把聊天数据库、解密密钥、账号缓存或带私人内容的日志上传到仓库、Issue 或交流群。
- 反馈问题前先检查截图和日志，移除不想公开的姓名、账号和对话。

## 免责声明

WechatVibe 面向技术学习、研究及个人聊天复盘。使用前请确认数据来源和使用方式符合适用法律、微信服务协议及相关第三方服务条款。

- **功能与使用边界**：本项目不提供微信聊天记录导出功能，本地缓存用于应用内查看与分析。项目不提倡通过导出、传播、交易或再利用聊天记录侵犯用户隐私、数据权益或微信相关合法权益，也不为此类用途提供支持。
- **数据授权**：仅处理本人合法持有、有权访问和分析的聊天记录。能在设备上看到记录，不代表可以任意公开、传播或用于其他目的；涉及他人信息时，应尊重其隐私和合法权益。不得用于盗取账号、未经授权的监控、跟踪、骚扰或其他违法侵权活动。
- **分析边界**：意图、情绪、好感度和 MBTI 均为模型推测，可能遗漏语境或产生错误。结果不等于对方真实想法，不构成心理诊断、人格定性或官方测评，不应作为作出重大个人决定的唯一依据。
- **第三方服务**：启用 API 后，所选聊天片段和画像摘要会按功能需要发送至你配置的服务商。请自行了解其计费、数据保存与隐私政策；项目无法替第三方承诺数据安全、服务稳定性或分析准确率。
- **运行风险**：微信版本、操作系统、权限和第三方组件变化可能影响读取与运行。请保留重要数据备份；项目不保证持续兼容、数据绝不丢失，也不承诺“零风险”或“不会封号”。
- **许可与担保**：本项目依据 [Apache-2.0](LICENSE) 许可证“按现状”提供。除适用法律要求或另有书面约定外，维护者及贡献者不提供任何明示或默示担保，包括适销性、特定用途适用性及不侵权担保；不承诺分析结果准确、运行持续稳定或适合任何特定使用场景。
- **使用者责任**：使用者应自行判断本项目是否适合其用途，并负责取得账号、聊天数据及第三方服务所需的授权。由使用者自行决定的数据处理方式、服务配置、结果使用，以及自行或委托第三方实施的修改、部署与运营，由相应使用者、开发者或运营者承担其行为及承诺所对应的责任。
- **责任限制**：在适用法律允许的最大范围内，且除另有书面约定外，维护者及贡献者不对因使用或无法使用本项目而产生的直接、间接、附带、特殊或后果性损失承担责任，包括数据丢失、账号受限、业务中断及其他损失。担保与责任限制的具体范围以 [Apache-2.0](LICENSE) 许可证第 7 至第 9 条为准。

WechatVibe 为独立项目，与腾讯、微信没有官方隶属、合作或背书关系。相关名称、商标及第三方组件的权利归各自权利人所有。

## 许可

项目采用 [Apache-2.0](LICENSE)。Laya、模型与第三方依赖的来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

演示头像使用 Lisa Wischofsky 的 [Adventurer](https://www.dicebear.com/styles/adventurer/) 插画，经 DiceBear 组合并调整配色，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；该素材许可独立于项目代码许可。

## 来源与致谢

- **上游项目**：[tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)。本版本基于其 Electron 项目移植，保留业务功能、源码中的作者和来源声明、许可证及演示素材署名。
- **README 参考**：上游 [README（提交 `99f42f0`）](https://github.com/tswawa/WechatVibe/blob/99f42f07f63e6b2fbceab9fb7020cdb4d98850c3/README.md)，参考日期 2026-10-07。功能说明和使用边界沿用上游内容，安装路径、开发与构建步骤按 Tauri 2 版适配。该提交是文档参考版本，不表示本地移植源码与该提交完全一致。
- **微信读取**：[fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)。
- **分析模型与适配**：[Laya](https://github.com/NandhaKishorM/laya)、[mizchi/laya-mlx](https://github.com/mizchi/laya-mlx)、[mizchi/laya-multilingual-onnx](https://huggingface.co/mizchi/laya-multilingual-onnx)。
- **上游贡献者**：感谢上游作者与所有贡献者，具体贡献见 [上游致谢](https://github.com/tswawa/WechatVibe#致谢)。

本项目是独立维护的衍生版本，不代表上游作者运营或支持，不以原作者名义开展合作或作出承诺。第三方使用、修改或分发须保留相应来源和许可，并对自行修改、分发及运营负责。

## 交流与反馈

- 本版本维护者：[estel-li](https://github.com/estel-li)
- 本版本源码：[estel-li/WechatVibe-tauri2](https://github.com/estel-li/WechatVibe-tauri2)
- 本版本问题反馈：[GitHub Issues](https://github.com/estel-li/WechatVibe-tauri2/issues)
- 上游源码与原版说明：[tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)

反馈时请说明 Windows、微信、应用版本、模型模式和复现步骤。截图及日志请先去除私聊内容、个人身份、账号、API Key、数据库密钥等私人信息。
