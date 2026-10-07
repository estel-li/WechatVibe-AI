# 知意 AI 对话助手（1.3.0）

知意 AI / WechatVibe AI 在当前聊天的输入框上方提供“AI 总结”和“帮我回复”。两项功能共用“设置 → 通用设置”中保存的 API 模型。助手弹窗只有两个功能页，模型配置集中在通用设置。

## 统一配置模型

通用设置选择“API 接入”，再选择 DeepSeek、MiniMax、智谱 Zhipu、Kimi、硅基流动或自定义 API。输入该服务的 Key，获取模型列表或手动填入模型 ID，测试后“保存并启用”。接口支持 Chat Completions、Responses、Anthropic、Gemini 和 Ollama。切换服务预设会填写地址并清空未保存的 Key 和模型 ID。

新配置上下文默认 **1,000,000（1M）tokens**。已有的明确容量保留；服务返回较小容量或用户调整容量时按该值处理。应用为提示词与输出留出空间，较长历史分段处理后合并。

| 服务 | 预设 Base URL | 官方说明 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | [API 文档](https://api-docs.deepseek.com/) |
| MiniMax | `https://api.minimax.cn/v1` | [OpenAI SDK](https://platform.minimax.cn/docs/api-reference/text-openai-api) |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | [OpenAI 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) |
| Kimi | `https://api.moonshot.cn/v1` | [快速开始](https://platform.kimi.com/docs/get-api-key) |
| 硅基流动 | `https://api.siliconflow.cn/v1` | [快速开始](https://docs.siliconflow.cn/docs/userguide/quickstart) |

意图识别、人物画像、总结和回复使用同一套保存的 API 地址、Key、模型与容量。分析模式切回本地 Laya 后，总结和回复仍使用已保存的 API。旧版仅有助手配置时，将其加密配置迁移到统一存储，不自动开启 API 分析；已有通用配置时保留通用配置，旧助手文件留作备份。

## 提示词与生成

从 1.3.0 起，回复可额外选择简洁直接、温暖真诚、正式清晰、轻松幽默或礼貌有边界的语气。选择只应用于本次生成，保留关系提示词；你输入的本次表达要求优先。总结与回复分别保留当前会话内的结果，切标签后可恢复；更换会话、账号、模型或关闭助手仍按原有取消规则清理。

完成结果显示生成时的模型、范围、实际消息覆盖、来源片段与调用次数；服务商返回 token 用量时才显示，没有返回时明确标为未报告。点击“导出 Markdown”或“导出 TXT”，桌面端使用原生保存对话框，浏览器预览下载文件。保存采用 UTF-8，支持中文文件名，文件只包含当前结果与任务信息；导出和切换结果不会再次调用模型。取消保存可直接返回，失败时仍可复制结果。

“对话总结”提供 7 条预设：全面总结、决定与分歧、时间线回顾、情绪与沟通、待办与行动、群聊要点、简明速览。下拉选择后直接展示提示词，可编辑并点击“保存总结提示词”；每条预设分别保留修改。可额外填写本次要求。

“帮我回复”提供 6 条预设：普通朋友、亲密朋友、同事、亲戚、长辈、通用回复/自定义关系。分别提供自然友好、情绪承接、专业清晰、亲切有礼、尊重耐心和自定义语气的完整提示词。可编辑并点击“保存回复提示词”，或补充本次想表达的内容。两个页面分别保存，保存提示词不修改模型配置或密钥。

总结可读取全部历史或指定时间范围，包含界面尚未加载的记录；回复默认读取最近 80 条，也可选择全部或指定时间。两页都有最近 1 天、最近一周、最近一月的快捷按钮；前两项按 24、168 小时回推，一月按本地日历回推并处理月底和闰年，精确到秒。

较长对话使用完整片段分批整理。内部笔记截断时会用完整原片段和更多输出空间重试一次；失败不会使用残缺笔记。最终响应必须完整结束，进度记录所选消息的覆盖情况。

结果可重新生成、复制或放入原有草稿框，由用户检查后使用，应用不会发送微信消息。关闭助手、切换会话或账号、更改 API 模型或清除 Key 会取消旧任务并清除过期结果。API Key 使用 Windows DPAPI 加密，不回传明文或写入浏览器存储；生成结果只保留在进程内存中。

## 验证与复现

完整回归和两个发行包的原生检查见 [1.2.1 发行验证](https://github.com/estel-li/WechatVibe-AI/blob/v1.2.1/docs/verification/release-1.2.1.json)。本轮使用本机合成模型服务和虚构记录，未读取真实微信聊天或调用外部付费 API。验证覆盖统一配置、旧配置迁移、提示词分别保存、完整 1305 条历史、截断恢复、时间边界、回复预设、重新生成、剪贴板、草稿、小窗口、取消和模型切换。

```powershell
npm test
python scripts/verify-ai-assistant.py --exe dist/WechatVibe-AI-1.2.1-release/WechatVibe.exe
```

原生验证需要 Windows、WebView2、项目 Playwright 依赖及完整可运行目录。输出位于 `.local/`，测试恢复原剪贴板并关闭自身启动的进程。下载与升级见 [1.2.1 发布页](https://github.com/estel-li/WechatVibe-AI/releases/tag/v1.2.1)。
