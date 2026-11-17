# Antigravity Model Details & Token Usage (`antigravity-model-details`)

[English](README.md) | 中文

为 **Antigravity.app (Antigravity 2.0 桌面版)** 与 **`agy` (TUI 终端版)** 打造的模型详情与 Token 用量实时监控插件。

---

## ✨ 核心功能

1. **紧凑实时状态横幅（本条消息 + 当前上下文窗口）**
   - 实时统计**当前这条用户消息（Latest Turn）**触发的模型调用次数、新增输入（`inputTokens`）、缓存命中（`cacheReadTokens`）、缓存写入（`cacheWriteTokens`）、缓存命中率，以及总输出（细分为 🧠 Thinking 思考 Token 与 💬 Response 回复 Token）。
2. **模型身份与配额监控**
   - 展示服务端实际返回的底层模型 ID（`responseModel`，如 `gemini-4-hydrogen`、`gemini-4-argon`、`claude-opus-5-5-high`、`gemini-3.8-flash-tiered`）、可读名称（`modelDisplayName`）、内部枚举（`model_enum`）、API 提供商（`apiProvider`），以及当前模型的**剩余配额百分比与重置时间倒计时**。
3. **双口径上下文窗口水位与结构拆解**
   - **服务商实际已用上下文**：最后一次调用的 `input + cacheRead + cacheWrite` 对比当前模型的动态最大窗口（如 Gemini `512K` / `256K`、Claude `840K`）。
   - **Antigravity 内部估算上下文**：显示 `estimatedTokensUsed` 及估算百分比（Antigravity 通常在上下文接近 `maxContextTokens` 的 `95%–100%` 时触发自动压缩）。
   - **自适应水位警戒**：状态栏、终端面板与 Sidecar 统一按 `80%` 橙色预警（建议准备整理或手动 `/compact`）、`92%` 红色临界告警（即将触发自动压缩）。
   - **上下文结构拆解**：可视化展示 `System Prompt`、`Tools`、`Chat Messages` 各分组 Token 占比与 Top 子项。
4. **三级开销看板（总开销 = 主会话 + Subagents）**
   - 自动发现并递归归并当前主会话下派生的所有 **Subagent（子代理）** 会话。
   - 同时展示 **🔥 全局总开销**、**🏠 主会话开销**、**🌿 Subagents 汇总开销**，以及按模型分类汇总表和每个 Subagent 的独立明细。
5. **三级只读数据源自动降级**
   - `Language Server RPC` → `只读 SQLite (node:sqlite)` → `transcript.jsonl`，零外部依赖，绝不阻塞或干扰 Agent 正常执行。

---

## 🚀 安装与自动启动机制

克隆仓库后进入 `antigravity-model-details` 目录运行一键安装脚本：

```bash
git clone https://github.com/cskeleton/antigravity-model-details.git antigravity-plugins
cd antigravity-plugins/antigravity-model-details
chmod +x scripts/install.sh
./scripts/install.sh
```

**无需手动启动任何后台程序：**
- **在 `Antigravity.app`（桌面版）中**：Sidecar 面板配置了 `"restart_policy": "always"`，随 App 打开自动在后台启动，随 App 关闭自动退出。可在对话中点击 `[Model Details](sidecar://antigravity-model-details/dashboard/)` 胶囊或从右侧辅助面板打开。
- **在 `agy`（TUI 终端版）中**：
  1. **底部双行 `statusLine`（随 `agy` 自动伴随启动）**：在 `~/.gemini/antigravity-cli/settings.json` 中启用：
     ```json
     "statusLine": {
       "type": "command",
       "command": "python3 ~/.antigravity/status.py",
       "enabled": true
     }
     ```
     启动 `agy` 时自动在输入框下方实时显示两行监控状态栏：
     ```text
     gemini-4-argon (Gemini 4 Argon (High)) │ Idle │ Ctx 37.9K/256.0K (15%)·估16% │ ⬡ 38%·30m │ ~/Projects/my-app
       本条#12(31次): 📥801.4K+⚡4.80M(86%) 📤29.2K(🧠14.4K/💬14.8K) │ Σ 总 369.97M = 主 79.48M + Sub[48] 290.49M
     ```
  2. **`!agy-stats` 终端速查（纯脚本，即调即用）**：
     - 在 `agy` 输入框内直接输入 `!agy-stats`（不经过大模型、0 Token 开销），立即打印 ANSI 彩色详情面板。
     - 在分屏终端中运行 `agy-stats --watch`，每 2 秒自动刷新跟随当前活跃会话。

---

## 📁 目录结构

```text
antigravity-model-details/
├── plugin.json                     # 插件清单
├── README.md                       # 英文说明文档
├── README.zh.md                    # 中文说明文档
├── assets/logo.svg                 # 插件图标
├── lib/
│   ├── stats-core.mjs              # 核心采集、三级聚合与多源降级引擎
│   └── proto-lite.mjs              # 零依赖 Protobuf 解码器（供离线 SQLite 回退使用）
├── scripts/
│   ├── install.sh                  # 一键注册插件、命令与 TUI statusLine
│   ├── run-node.sh                 # Node 运行时自动寻路包装脚本
│   ├── stats-cli.mjs               # Markdown / Compact / JSON 报表工具
│   ├── agy-stats.mjs               # TUI / 终端 ANSI 彩色详情看板 (支持 --watch)
│   └── agy-statusline.py           # agy TUI 双行实时状态栏脚本
├── sidecars/dashboard/
│   ├── sidecar.json                # 右侧辅助面板 (AUX_PANE) Sidecar 配置
│   ├── server.mjs                  # 基于官方 sidecar_sdk 的后端服务
│   └── ui/index.html               # 响应式深浅色自适应监控面板
└── skills/model-details/
    └── SKILL.md                    # /model-details 快捷技能
```
