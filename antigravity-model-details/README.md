# Antigravity Model Details & Token Usage (`antigravity-model-details`)

English | [中文](README.zh.md)

A real-time model identity, context window, and token usage monitor plugin for **Antigravity.app (Desktop)** and **`agy` (TUI CLI)**.

---

## Core Features

1. **Compact Live Status Banner (Latest Turn + Context Window)**
   - Tracks call count, new input (`inputTokens`), cache hit (`cacheReadTokens`), cache write (`cacheWriteTokens`), cache hit rate, and output tokens (split into Thinking tokens and Response tokens) for the **latest user turn**.
2. **Model Identity & Quota Monitor**
   - Displays the actual backend model ID returned by the server (`responseModel`, e.g., `gemini-4-hydrogen`, `gemini-4-argon`, `claude-opus-5-5-high`, `gemini-3.8-flash-tiered`), human-readable display name (`modelDisplayName`), internal enum (`model_enum`), API provider (`apiProvider`), and remaining **model quota percentage & reset countdown**.
3. **Dual-Metric Context Window Watermark & Breakdown**
   - **Provider Actual Context**: `input + cacheRead + cacheWrite` from the latest call compared against the model's dynamic max context window (e.g., Gemini `512K` / `256K`, Claude `840K`).
   - **Antigravity Estimated Context**: Shows `estimatedTokensUsed` and percentage (Antigravity typically triggers auto-compaction near `95%–100%` of `maxContextTokens`).
   - **Adaptive Threshold Warnings**: Status bar, terminal dashboard, and Sidecar share consistent thresholds: `80%` amber warning (consider organizing or running `/compact`) and `92%` red critical alert (approaching auto-compaction).
   - **Context Breakdown**: Visualizes token share and top children across `System Prompt`, `Tools`, and `Chat Messages`.
4. **3-Tier Cost Hierarchy (Total = Main Session + Subagents)**
   - Automatically discovers and recursively aggregates all **Subagent** sessions spawned by the root conversation.
   - Displays **Total**, **Main Session**, and **Subagents** summaries, along with a per-model breakdown table and per-subagent drill-down list.
5. **Zero-Dependency 3-Tier Read-Only Fallback**
   - `Language Server RPC` → `Read-only SQLite (node:sqlite)` → `transcript.jsonl`, never blocking or interfering with agent execution.

---

## Installation & Auto-Start

Clone the repository and run the installer inside `antigravity-model-details`:

```bash
git clone https://github.com/cskeleton/antigravity-model-details.git antigravity-plugins
cd antigravity-plugins/antigravity-model-details
chmod +x scripts/install.sh
./scripts/install.sh
```

**No manual background daemon required:**

- **In `Antigravity.app` (Desktop)**: The Sidecar panel is configured with `"restart_policy": "always"`, starting automatically with the app and exiting on close. Open it via the `[Model Details](sidecar://antigravity-model-details/dashboard/)` pill or from the Auxiliary Pane.
- **In `agy` (TUI CLI)**:
  1. **Two-line `statusLine` (starts automatically with `agy`)**: Enable it in `~/.gemini/antigravity-cli/settings.json`:
     ```json
     "statusLine": {
       "type": "command",
       "command": "python3 ~/.antigravity/status.py",
       "enabled": true
     }
     ```
     Live status lines shown under the `agy` input box:
     ```text
     gemini-4-argon (Gemini 4 Argon (High)) │ Idle │ Ctx 37.9K/256.0K (15%)·估16% │ ⬡ 38%·30m │ ~/Projects/my-app
       本条#12(31次): 📥801.4K+⚡4.80M(86%) 📤29.2K(🧠14.4K/💬14.8K) │ Σ 总 369.97M = 主 79.48M + Sub[48] 290.49M
     ```
  2. **`!agy-stats` Quick Inspection (pure CLI script, zero LLM token cost)**:
     - Type `!agy-stats` inside `agy` to print the ANSI-colored report immediately.
     - Run `agy-stats --watch` in a split terminal pane to live-refresh every 2 seconds following the active session.

---

## Directory Structure

```text
antigravity-model-details/
├── plugin.json                     # Plugin manifest
├── README.md                       # English documentation
├── README.zh.md                    # Chinese documentation
├── assets/logo.svg                 # Plugin icon
├── lib/
│   ├── stats-core.mjs              # Core collector, 3-tier aggregator & fallback engine
│   └── proto-lite.mjs              # Zero-dependency Protobuf decoder (for offline SQLite fallback)
├── scripts/
│   ├── install.sh                  # One-step installer for plugin, CLI & TUI statusLine
│   ├── run-node.sh                 # Node.js runtime wrapper
│   ├── stats-cli.mjs               # Markdown / Compact / JSON reporter
│   ├── agy-stats.mjs               # TUI / terminal ANSI dashboard (supports --watch)
│   └── agy-statusline.py           # agy TUI two-line status bar script
├── sidecars/dashboard/
│   ├── sidecar.json                # Auxiliary Pane (AUX_PANE) Sidecar config
│   ├── server.mjs                  # Backend server using sidecar_sdk
│   └── ui/index.html               # Responsive light/dark adaptive dashboard UI
└── skills/model-details/
    └── SKILL.md                    # /model-details skill definition
```
