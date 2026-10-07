# README 软件截图

2026-10-07，README 的七张旧功能截图替换为知意 AI / WechatVibe AI 1.1.0 开发版的 Windows Tauri 2 实际界面，并增加四张 AI 助手截图。

截图由已构建的 `WechatVibe.exe` 与当前页面代码在隔离目录中运行，通过 WebView2 和实际界面操作捕获。联系人、聊天、标签、画像、缓存统计、模型配置状态和 AI 输出由专用合成 fixture 提供，头像使用应用本身的首字显示。虚构故事围绕周六下午两点在书店碰面、读书和散步，所有截图统一为1280×960、深色主题、100%缩放。

| 文件 | 展示内容 |
| --- | --- |
| `chat-demo.png` | 聊天、情绪与意图标签、工具栏和草稿 |
| `profile-demo.png` | 好感度、MBTI聊天推测、互动风格、高频词及摘要 |
| `group-profile-demo.png` | 群聊统计、成员选择、互动风格及群摘要 |
| `conversations-demo.png` | 会话选择与管理 |
| `local-model-demo.png` | 本地Laya、运行设备及并行设置 |
| `api-settings-demo.png` | API协议、地址、模型获取及连接状态 |
| `cache-demo.png` | 按模型来源管理分析缓存 |
| `ai-summary-demo.png` | 全部1305条虚拟消息的总结、约定与待办 |
| `ai-time-summary-demo.png` | 指定时间内8条虚拟消息的总结 |
| `ai-reply-demo.png` | 普通朋友关系、提示词、附加要求与回复草稿 |
| `ai-assistant-settings-demo.png` | 独立DeepSeek配置、1M上下文及总结提示词 |

所有图片位于 `docs/assets/readme/`，结构化记录见 [截图报告](readme-screenshots.json)。捕获脚本检查当前页面与服务均为演示模式、无外网请求、无控制台错误、API Key输入框为空，并在结束后关闭自己创建的应用和恢复剪贴板。Tauri的 `http://ipc.localhost` 请求属于本机私有IPC，单独记录。

回复画面展示现有“帮我回复”的草稿生成、重新生成、复制和放入草稿功能，发送操作由用户决定。

```powershell
python scripts/verify-tauri-ui.py `
  --exe dist/WechatVibe-AI-1.1.0/WechatVibe.exe `
  --capture-readme `
  --output .local/readme-capture
```

演示开关仅用于截图与测试夹具。正常模式的运行与验证继续使用原有路径，生产页面代码和微信数据读取逻辑保持原有行为。
