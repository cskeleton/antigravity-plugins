---
name: model-details
description: 统计并展示当前会话（或指定会话）的模型详细信息，包括服务端返回的模型 ID、当前消息与累计详细 Token 用量（Input、Cached、Output、Thinking）、当前会话上下文窗口（实际值与估算值），以及总开销、主会话开销、Subagent 开销三级汇总，并提供打开右侧实时监控面板的快捷入口。
---

# Model Details & Token Usage (`model-details`)

当用户询问当前会话使用了什么模型、消耗了多少 Token、缓存命中率如何、当前上下文窗口还剩多少、或者主会话与 Subagent 分别花了多少开销时，请按以下步骤执行：

## 1. 运行统计脚本获取精确数据

运行本插件内置的统计 CLI 脚本（优先传入当前会话 ID，若不传则自动定位最新活跃根会话）：

```bash
/Users/gc/Dev/MyProject/antigravity-model-details/scripts/run-node.sh \
  /Users/gc/Dev/MyProject/antigravity-model-details/scripts/stats-cli.mjs \
  "<current-conversation-id>"
```

- 如需仅输出 3 行紧凑摘要（当前消息 Token + 上下文窗口 + 三级累计开销），可附加 `--compact` 参数。
- 如需获取原始 JSON 数据进行自定义分析，可附加 `--json` 参数。

## 2. 向用户呈现结果并提供面板胶囊链接

1. 将脚本输出的统计结果（包含 **紧凑概览**、**当前模型与上下文窗口水位**、**总开销 / 主会话开销 / Subagent 开销三级汇总** 及 **最近调用明细**）清晰地展示给用户。
2. 当本插件的 UI 面板（Sidecar）处于已启用状态时，在回复末尾附上可一键打开右侧监控面板的胶囊链接：

```markdown
[Model Details](sidecar://antigravity-model-details/dashboard/)
```
