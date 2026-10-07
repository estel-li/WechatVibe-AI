# AI 对话助手（1.1.0 开发版）

此功能在“意图识别”“人物画像”右侧增加“AI 总结”和“帮我回复”，也可从“设置 → 通用设置 → AI 对话助手”预先配置。当前为本地开发构建，GitHub 已发布的 1.0.0 安装版和绿色版尚不包含此功能。

## 使用

在“模型与提示词”选择 DeepSeek 官方预设或自定义接口，输入 API 地址和自己的 Key，获取模型或手动输入模型 ID，测试连接后保存。助手模型与原有意图、画像模型各自配置。兼容 Chat Completions、Responses、Anthropic、Gemini 和 Ollama 接口。

“AI 总结”支持当前会话的全部历史或指定起止时间；包含尚未滚动加载的消息。长对话自动分批并合并，显示读取和生成进度。时间范围包含起止时刻，消息附带本机时区的可读日期。图片、语音等使用已有类型描述。

“帮我回复”默认参考最近 80 条记录，也可使用全部或指定时间范围。普通朋友、亲密朋友、同事、亲戚、长辈有各自的基础提示词；支持编辑保存和自定义关系。可补充本次要求，不满意时重新生成。结果可复制或插入原有草稿框，发送由用户自行完成。

点击取消、关闭助手或切换会话会停止旧任务并清除过期输出。更改账号、清除账号或退出应用也会结束所属任务。API Key 通过 Windows DPAPI 加密保存，不回传明文、不进入浏览器 localStorage。生成结果只保留在进程内存中。

## 实现

`chatui/ai-assistant.js` 和样式提供独立弹窗，通过 `/api/assistant/` 访问服务。`bridge/ai_assistant.py` 直接分页读取微信数据源，以稳定的历史上界完成范围快照；客户端不能提交聊天内容替代真实读取。服务启动独立 Node 分析进程，取消不会影响原有意图、画像任务。

`analysis/ai-assistant.ts` 按实际上下文预算分块，超长单条消息无损拆分，多批结果逐层合并。所有选中记录都会参与处理，返回消息数量、分块数量和覆盖信息。提示词将聊天记录与旧草稿明确作为数据，要求避免捏造事实和额外承诺。内部整理过程不作为最终回复流出。

## 验证与复现

2026-10-07 完整 `npm test` 通过：476 项 Node 测试、488 项 Python 测试、8 个脚本测试套件及 4 项 Rust 测试。其中助手覆盖超长 Unicode 消息、全历史覆盖、时间边界、所有关系、自定义和重新生成、配置隔离、敏感信息错误处理，以及取消竞争。

真实 DeepSeek 官方接口使用临时凭证和合成对话验证了模型获取、连接测试、全量总结、时间范围总结、同事回复及自定义关系重新生成，均完成。测试凭证只在隔离临时目录中加密保存，测试结束清理；未读取真实微信聊天，凭证未预置到源码或包内。

打包后的 Tauri/WebView2 使用包内 Python、Node、UI 和服务，接入本地合成模型服务进行验证，18 项原生检查通过。验证包括完整 1305 条历史（含最早的未加载消息）、精确时间范围 10 条、五种关系、自定义要求、重新生成、原生剪贴板、插入草稿、取消与实际切换会话、获取模型、测试连接、提示词保存、焦点及小窗口缩放。合成截图和结构化报告见 [验证文件](verification/assistant-1.1.0/verification.json)。

本地构建位于 `dist/WechatVibe-tauri2-ai-assistant/`，保留完整目录后启动 `WechatVibe.exe`。该包为 1.1.0，包含运行时，不复制账号数据或模型权重。

```powershell
# 完整回归
npm test

# 使用包内运行时和服务重跑原生验证；只使用合成记录与本地模型接口
python scripts/verify-ai-assistant.py --exe dist/WechatVibe-tauri2-ai-assistant/WechatVibe.exe
```

原生验证需要 Windows、WebView2、项目 Playwright 依赖和已构建的可运行目录。输出写入 `.local/assistant-verification/`，测试关闭自己启动的进程并恢复原剪贴板文本。

![全量总结](verification/assistant-1.1.0/08-assistant-all-summary.png)

![时间范围总结](verification/assistant-1.1.0/09-assistant-time-summary.png)

![自定义关系回复](verification/assistant-1.1.0/10-assistant-custom-reply.png)

![小窗口模型设置](verification/assistant-1.1.0/11-assistant-small-settings.png)
