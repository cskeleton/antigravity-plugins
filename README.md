# Antigravity Plugins

English | [中文](README.zh.md)

Independent plugins for **Antigravity.app (Desktop)** and **`agy` (TUI CLI)**, maintained in one source repository. Each plugin keeps its own manifest (`plugin.json`), Sidecar UI, CLI entrypoints, skills, and installer.

## Plugins

| Plugin | Purpose | Guide |
| --- | --- | --- |
| **Model Details & Token Usage** | Live model IDs, Input/Cached/Output/Thinking token breakdown, dual-metric context window gauge, quota monitor, and 3-tier Main + Subagent cost tracking | [antigravity-model-details](antigravity-model-details/README.md) |
| **Conversation Export** | Export conversations as Markdown, standalone HTML, or paginated 2x retina PNG images with 6 themes, 3 detail levels (`detailed`/`summary`/`none`), and per-turn selection | [antigravity-conversation-export](antigravity-conversation-export/README.md) |

## Quick Installation

Clone this repository to a **permanent directory** on your machine (the installer registers paths in `~/.gemini/config/plugins.json` and creates links pointing to this directory):

```bash
git clone https://github.com/cskeleton/antigravity-plugins.git
cd antigravity-plugins
```

### Install Both Plugins

```bash
# 1. Install Model Details & Token Usage
(cd antigravity-model-details && chmod +x scripts/install.sh && ./scripts/install.sh)

# 2. Install Conversation Export
(cd antigravity-conversation-export && pnpm install && chmod +x scripts/install.sh && ./scripts/install.sh)
```

You can also install only the plugin you need by running the corresponding `scripts/install.sh` inside its subdirectory.

### What the Installers Configure

- **Plugin Registration**: Registers both plugin subdirectories under `~/.gemini/config/plugins.json` (using `include_only`).
- **Desktop Sidecars (`Antigravity.app`)**: Configured with `"restart_policy": "always"` so Sidecar panels launch and exit automatically with the app. Open them from the Auxiliary Pane or via `/model-details` and `/conversation-export`.
- **CLI Tools (`agy` & Terminal)**:
  - `~/.local/bin/agy-stats` (supports `!agy-stats` in `agy` and `agy-stats --watch`)
  - `~/.local/bin/agy-export` (supports `!agy-export` in `agy` and scripted terminal exports)
  - `~/.antigravity/status.py` (symlinked for the `agy` two-line status bar; see [Model Details README](antigravity-model-details/README.md) to enable it in `~/.gemini/antigravity-cli/settings.json`)

> Ensure `~/.local/bin` is in your `PATH` if you invoke `agy-stats` or `agy-export` directly from a shell.

## Prerequisites

- **Node.js**: Recommended `Node >= 22.5` (with built-in `node:sqlite`). On macOS, `scripts/run-node.sh` automatically checks Homebrew/PATH `node` and falls back to Antigravity.app's bundled Electron Node runtime if needed.
- **pnpm** (for `antigravity-conversation-export` dependencies): `pnpm install` installs `markdown-it`, `highlight.js`, and `playwright-core`.
- **Python 3**: Required for `agy` `statusLine` (`agy-statusline.py`) and optional lossless PNG size optimization (`Pillow` + `numpy` in `antigravity-conversation-export`).
- **Chromium / Chrome** (for PNG export in `antigravity-conversation-export`): Uses local Chrome/Chromium or Playwright Chromium.

## Repository Layout

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

## Verification & Tests

```bash
# Model Details CLI smoke check
./antigravity-model-details/scripts/run-node.sh ./antigravity-model-details/scripts/stats-cli.mjs --help

# Conversation Export unit & render tests
(cd antigravity-conversation-export && pnpm test)
```

## License

[MIT](LICENSE)
