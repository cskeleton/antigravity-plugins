---
name: conversation-export
description: 将当前或指定的 Antigravity 会话（支持桌面端 Antigravity.app 与终端 agy CLI）导出为 Markdown、独立 HTML 或自适应分页高清 PNG 长图，支持六套主题（纸白/暖黄/墨黑/夜间/Google/Antigravity）、工具调用与思考过程三档粒度（详细/摘要/无）、逐轮筛选及右侧可视化导出面板。
---

# 对话导出 (`conversation-export`)

当用户希望导出当前会话或历史会话（为 Markdown、HTML 或 PNG 长图），或者想打开可视化对话导出面板自定义勾选消息时，请按以下方式处理：

## 1. 打开右侧可视化导出面板（桌面端交互首选）

如果用户希望在图形界面中自主勾选轮次、预览字号宽度、选择文件夹或通过浏览器下载，请向用户提供右侧辅助面板的一键胶囊链接（前提是插件已启用）：

```markdown
[Conversation Export](sidecar://antigravity-conversation-export/exporter/)
```

## 2. 直接通过命令行快速导出指定格式

如果用户明确说明了想要导出的格式、主题或粒度（例如“把当前会话导出为夜间主题的 HTML，工具调用和思考过程设为摘要”），直接运行内置 CLI 工具（位于当前 `SKILL.md` 向上两级目录的 `<plugin-root>/scripts/` 下，或已安装的 `agy-export`）并传入当前会话 ID：

```bash
<plugin-root>/scripts/run-node.sh \
  <plugin-root>/scripts/agy-export.mjs \
  "<current-conversation-id>" \
  --format html \
  --theme night \
  --tools summary \
  --thinking summary
```

### 常用参数速查

- `--list`（加 `--subagents` 含子代理会话）：列出最近会话 ID 与标题
- `--outline`：查看某会话每一轮的用户提问与助手回复摘要及轮次编号
- `--format <markdown|html|image>`：导出格式（默认 `markdown`）
- `--theme <paper|sepia|ink|night|google|antigravity>`：HTML 与图片主题（纸白 `paper`、暖黄 `sepia`、墨黑 `ink`、夜间 `night`、谷歌昼白 `google`、反重力暗夜 `antigravity`）
- `--tools <detailed|summary|none>`：工具调用粒度（详细、一句话摘要、无）
- `--thinking <detailed|summary|none>`：思考过程粒度（详细、一句话摘要、无）
- `--width <320..2400>` / `--font-size <12..48>`：PNG 图片 CSS 宽度（默认 `640`，2x 渲染为 `1280px`）与字号（默认随宽度自动 `24->16`）
- `--rounds 1,2,3` / `--only <user|assistant>`：只导出指定轮次或指定角色
- `-o <dir>`：保存目录（默认 `~/Downloads`，自动防覆盖重命名为 `名称 (2).ext`）
- `--open` / `--reveal`：导出后自动打开文件或在访达（Finder）中定位

导出完成后，向用户汇报生成文件的完整路径（使用 `[文件名](file:///...)` 可点击链接），并可附上 `[Conversation Export](sidecar://antigravity-conversation-export/exporter/)` 方便用户后续微调重导。
