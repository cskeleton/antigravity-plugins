# Antigravity 插件合集

[English](README.md) | 中文

为 **Antigravity.app（桌面端）** 与 **`agy`（TUI 终端版）** 打造的独立插件集合，统一维护在同一个源码仓库中。每个插件保留各自的清单（`plugin.json`）、Sidecar 面板、CLI 入口、Skill 与安装脚本。

## 插件列表

| 插件 | 功能概述 | 文档 |
| --- | --- | --- |
| **Model Details & Token Usage** | 实时展示底层模型 ID、Input/Cached/Output/Thinking 用量、双口径上下文窗口水位、模型配额以及主会话 + Subagent 三级开销 | [antigravity-model-details](antigravity-model-details/README.zh.md) |
| **Conversation Export** | 将会话导出为 Markdown、独立 HTML 或自适应分页 2x 高清 PNG 长图，支持 6 套主题、3 档过程粒度（详细/摘要/无）与逐轮勾选 | [antigravity-conversation-export](antigravity-conversation-export/README.zh.md) |

## 快速安装

将本仓库克隆到机器上的**固定目录**（安装脚本会将该目录路径写入 `~/.gemini/config/plugins.json` 并创建命令入口与软链接，安装后请勿随意删除目录）：

```bash
git clone https://github.com/cskeleton/antigravity-model-details.git antigravity-plugins
cd antigravity-plugins
```

### 安装全部插件

```bash
# 1. 安装 Model Details & Token Usage
(cd antigravity-model-details && chmod +x scripts/install.sh && ./scripts/install.sh)

# 2. 安装 Conversation Export
(cd antigravity-conversation-export && pnpm install && chmod +x scripts/install.sh && ./scripts/install.sh)
```

如果只需要其中一个插件，只进入对应子目录运行 `./scripts/install.sh` 即可。

### 安装脚本做了什么

- **注册插件**：将对应子目录注册到 `~/.gemini/config/plugins.json`（通过 `include_only` 管理）。
- **桌面端 Sidecar（`Antigravity.app`）**：配置了 `"restart_policy": "always"`，随 App 打开自动启动、关闭自动退出；可在右侧辅助面板打开，或通过 `/model-details`、`/conversation-export` 技能唤起。
- **终端工具（`agy` 与 Shell）**：
  - `~/.local/bin/agy-stats`（支持在 `agy` 中运行 `!agy-stats`，以及在终端运行 `agy-stats --watch`）
  - `~/.local/bin/agy-export`（支持在 `agy` 中运行 `!agy-export`，以及终端命令行批量导出）
  - `~/.antigravity/status.py`（软链接到 `agy-statusline.py`；如需启用 `agy` 底部双行状态栏，请参考 [Model Details 中文文档](antigravity-model-details/README.zh.md) 配置 `~/.gemini/antigravity-cli/settings.json`）

> 若直接在终端调用 `agy-stats` 或 `agy-export`，请确保 `~/.local/bin` 已在 `PATH` 中。

## 运行环境要求

- **Node.js**：推荐 `Node >= 22.5`（含内置 `node:sqlite`）。在 macOS 上，`scripts/run-node.sh` 会依次探测 Homebrew / `PATH` 中的 `node`，未找到时自动回退到 `Antigravity.app` 内置的 Electron Node 运行时。
- **pnpm**：用于安装 `antigravity-conversation-export` 依赖（`markdown-it`、`highlight.js`、`playwright-core`）。
- **Python 3**：用于 `agy` 双行状态栏（`agy-statusline.py`）以及可选的 PNG 无损压缩优化（`Pillow` + `numpy`）。
- **Chrome / Chromium**：`antigravity-conversation-export` 导出 PNG 图片时使用本机 Chrome/Chromium 或 Playwright Chromium。

## 仓库结构

```text
.
├── LICENSE
├── README.md
├── README.zh.md
├── antigravity-model-details/
│   ├── README.md
│   ├── README.zh.md
│   ├── plugin.json
│   ├── lib/
│   ├── scripts/
│   ├── sidecars/dashboard/
│   └── skills/model-details/
└── antigravity-conversation-export/
    ├── README.md
    ├── README.zh.md
    ├── package.json
    ├── plugin.json
    ├── assets/
    ├── lib/
    ├── scripts/
    ├── sidecars/exporter/
    ├── skills/conversation-export/
    └── tests/
```

## 验证与测试

```bash
# Model Details CLI 检查
./antigravity-model-details/scripts/run-node.sh ./antigravity-model-details/scripts/stats-cli.mjs --help

# Conversation Export 单元测试
(cd antigravity-conversation-export && pnpm test)
```

## 开源协议

[MIT](LICENSE)
