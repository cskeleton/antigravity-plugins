# Antigravity Conversation Export (`antigravity-conversation-export`)

[English](README.md) | 中文

参考 DeepSeek Harness 的 `dsh-conversation-export` 插件设计，为 **Antigravity.app（桌面端 2.0）** 与 **`agy`（TUI 终端版）** 打造的全功能会话导出插件。

支持将会话导出为 **Markdown**、独立的 **HTML** 文件或 **2x 高清自适应分页 PNG 长图**，除了完整沿用 `dsh-conversation-export` 的 **纸白（Paper）、暖黄（Sepia）、墨黑（Ink）、夜间（Night）** 四套经典主题外，还专为 Antigravity 定制了 **Google（Material 3 昼白 + 四色顶栏）** 与 **Antigravity（DeepMind 暗夜深空 + 极光顶栏）** 两套品牌主题，均配备 `"Google Sans Flex"` / `"Google Sans Code"` 字体栈、可折叠步骤时间线与智能 PNG 压缩方案。

---

## ✨ 核心特性

1. **三种导出格式 + 六套排版主题**
   - **Markdown (`.md`)**：纯净标准 Markdown，步骤面板渲染为结构化引用块。
   - **独立 HTML (`.html`)**：单文件零外部依赖，工具调用与思考过程折叠为原生 `<details>` 时间线面板（支持浏览器页内搜索自动展开、打印时自动全部展开），代码语法高亮基于 `highlight.js`。
   - **高清长图 (`.png`)**：无头 Chromium 2 倍视网膜清晰度渲染，支持手机 `640`、平板 `960`、桌面 `1200` 及 `320–2400 px` 自定义宽度与自适应字号。超过 `7500 CSS px`（`15000` 设备像素）时自动在段落边界切分多图并标注 `1 / N` 页脚，严格低于 iOS `16384px` 纹理上限；自动调用 Python (`Pillow` + `numpy`) 进行分区灰度/256 色调色板无损瘦身（体积减小约 70%）。

2. **工具调用与思考过程三档粒度（`详细 · 摘要 · 无`）**
   - **详细**：保留工具调用参数、截断输出与完整思考原文。
   - **摘要**：每次工具调用、每段思考各用一句话概括（默认内置 **0 Token 本地规则与智能提炼引擎**，无需配置外部模型即可对工具和思考同时生成摘要；亦支持配置外部 LLM API 模型生成摘要）。
   - **无**：完全隐藏中间过程，仅保留用户提问与助手最终回复。

3. **精细消息筛选与纯净内容清洗**
   - 每条用户消息与每条助手回复均可独立勾选（内置 **全选 / 仅用户 / 仅助手 / 全不选** 快捷栏）。
   - 自动剥离 Antigravity 系统注入的 `<ADDITIONAL_METADATA>`、`<USER_SETTINGS_CHANGE>`、压缩检查点（`CHECKPOINT`）、后台唤醒通知（`SYSTEM_MESSAGE`）等内部上下文。
   - 完美兼容 Antigravity 特有的 `file://`、`sidecar://`、`customization://`、`conversation://` 协议链接渲染。

4. **全场景覆盖（桌面右侧面板 + `agy` 终端 CLI + `/conversation-export` 技能）**
   - **桌面端 Sidecar 面板**：随 `Antigravity.app` 自动后台常驻，支持跨 App / CLI / Subagent 检索会话、macOS 原生文件夹选择器（`选择…`）、防覆盖写入（`名称 (2).md`）及导出后一键 **打开文件 / 在访达中显示 / 复制路径**。
   - **终端 CLI (`agy-export`)**：在 `agy` 输入框内直接运行 `!agy-export`（0 Token 瞬间导出当前会话），或在任意终端批量脚本化导出。
   - **Agent 技能 (`/conversation-export`)**：支持在对话中直接让智能体按指定主题和粒度代为导出。

---

## 🚀 安装

```bash
git clone https://github.com/cskeleton/antigravity-model-details.git antigravity-plugins
cd antigravity-plugins/antigravity-conversation-export
pnpm install
chmod +x scripts/install.sh
./scripts/install.sh
```

安装脚本会自动完成：
1. 在 `~/.gemini/config/plugins.json` 注册 `antigravity-conversation-export` 插件；
2. 安装全局命令行工具 `~/.local/bin/agy-export`。

---

## 📖 使用指南

### 1. 在 `Antigravity.app` 桌面端使用可视化面板

- 在右侧辅助面板（Auxiliary Pane）中点击 **Conversation Export** 图标打开；
- 或在对话中点击胶囊链接：`[Conversation Export](sidecar://antigravity-conversation-export/exporter/)`。

| 选项 | 可选值 | 默认 |
|---|---|---|
| 格式 | Markdown、HTML、图片 | Markdown |
| 主题 | 纸白、暖黄、墨黑、夜间、Google、Antigravity（HTML 和图片） | 纸白 |
| 图片宽度 | 手机 640、平板 960、桌面 1200，或 `320–2400 px`；字号自动或 `12–48 px` | `640 px`，自动（`24 px`） |
| 工具调用 | 详细 · 摘要 · 无 | 无 |
| 思考过程 | 详细 · 摘要 · 无 | 无 |
| 保存到 | 本地文件夹（默认 `~/Downloads`），或浏览器下载 | 本地文件夹 |
| 导出内容 | 每轮用户消息与助手回复独立复选框；支持全选、仅用户、仅助手、全不选 | 全选 |

### 2. 在 `agy` TUI 或终端中使用 `agy-export`

```bash
# 在 agy 输入框内直接执行（0 Token 导出当前会话为 Markdown 到 ~/Downloads）
!agy-export

# 列出最近所有会话（包含桌面端与 CLI 会话）
agy-export --list

# 导出指定（或最新）会话为 Antigravity 暗夜主题 HTML，包含一句话工具与思考摘要，并在访达中显示
agy-export --format html --theme antigravity --tools summary --thinking summary --reveal

# 导出为 640px 手机阅读宽度的 Google 昼白主题高清 PNG 长图并立即预览
agy-export --format image --theme google --width 640 --open
```

### 3. 可选高级配置（`~/.gemini/config/conversation-export.json`）

无需任何配置即可开箱即用。如需自定义默认保存目录、Chromium 路径或接入外部摘要大模型，可创建 `~/.gemini/config/conversation-export.json`：

```json
{
  "saveDirectory": "~/Downloads",
  "imageScale": 2,
  "imageMaxHeight": 7500,
  "maxDetailChars": 4000,
  "models": [
    {
      "provider": "openai",
      "model": "deepseek-chat",
      "label": "DeepSeek · deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-..."
    }
  ]
}
```

---

## 🧪 测试

```bash
pnpm test
```
