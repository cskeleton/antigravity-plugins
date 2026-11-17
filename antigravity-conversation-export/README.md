# Antigravity Conversation Export (`antigravity-conversation-export`)

English | [中文](README.zh.md)

A full-featured conversation exporter for **Antigravity.app (Desktop 2.0)** and **`agy` (TUI CLI)**, inspired by DeepSeek Harness's `dsh-conversation-export` plugin.

Export conversations as **Markdown**, standalone **HTML**, or **2x retina paginated PNG images**. Includes the four classic themes (**Paper**, **Sepia**, **Ink**, **Night**) plus two Antigravity-tailored themes (**Google** Material 3 daylight with four-color top bar, and **Antigravity** DeepMind dark space with aurora top bar), featuring the `"Google Sans Flex"` / `"Google Sans Code"` font stack, collapsible step timelines, and lossless PNG compression.

---

## Core Features

1. **Three Export Formats + Six Themes**
   - **Markdown (`.md`)**: Clean standard Markdown with tool/thinking panels formatted as structured blockquotes.
   - **Standalone HTML (`.html`)**: Zero external runtime dependencies; tool calls and thinking blocks collapse into native `<details>` timelines (auto-expanded during in-page find and printing), with `highlight.js` syntax highlighting.
   - **High-DPI PNG Images (`.png`)**: Headless Chromium 2x retina rendering with presets for Mobile (`640`), Tablet (`960`), Desktop (`1200`), or custom `320–2400 px` widths and adaptive font sizes. Automatically splits long conversations at paragraph boundaries when exceeding `7500 CSS px` (`15000` device px) with `1 / N` page footers (staying below iOS `16384 px` texture limits), and optionally invokes Python (`Pillow` + `numpy`) for lossless grayscale/256-color quantization (~70% smaller).

2. **Three Granularity Levels for Tools & Thinking (`detailed · summary · none`)**
   - **detailed**: Keeps tool arguments, truncated outputs, and full thinking text.
   - **summary**: Summarizes each tool call and thinking block into a concise one-line summary (powered by a built-in **0-Token local rule & extraction engine** by default; optionally supports external LLM API models).
   - **none**: Hides intermediate steps, keeping only user prompts and assistant responses.

3. **Per-Turn Selection & Clean Sanitization**
   - Individual checkboxes for every user prompt and assistant response (with **All / Users Only / Assistants Only / None** quick toggles).
   - Automatically strips internal Antigravity tags and system context such as `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, `CHECKPOINT`, and `SYSTEM_MESSAGE`.
   - Preserves Antigravity-specific `file://`, `sidecar://`, `customization://`, and `conversation://` links cleanly.

4. **Desktop Sidecar + `agy` Terminal CLI + `/conversation-export` Skill**
   - **Desktop Sidecar Panel**: Runs in the background with `Antigravity.app`, supports searching across App / CLI / Subagent sessions, native macOS folder picker (`Browse…`), collision-safe filenames (`name (2).md`), and one-click **Open / Reveal in Finder / Copy Path**.
   - **Terminal CLI (`agy-export`)**: Run `!agy-export` directly inside the `agy` input box (0 tokens, instant export) or script batch exports from any terminal.
   - **Agent Skill (`/conversation-export`)**: Ask the agent in conversation to export with a specific format, theme, and detail level.

---

## Installation

Clone the repository, install dependencies, and run the installer inside `antigravity-conversation-export`:

```bash
git clone https://github.com/cskeleton/antigravity-plugins.git
cd antigravity-plugins/antigravity-conversation-export
pnpm install
chmod +x scripts/install.sh
./scripts/install.sh
```

The installer automatically:
1. Registers `antigravity-conversation-export` in `~/.gemini/config/plugins.json`;
2. Installs the global CLI wrapper `~/.local/bin/agy-export`.

---

## Usage

### 1. Visual Exporter Panel in `Antigravity.app`

- Open **Conversation Export** from the right-hand Auxiliary Pane;
- Or click the pill link in chat: `[Conversation Export](sidecar://antigravity-conversation-export/exporter/)`.

| Option | Values | Default |
| --- | --- | --- |
| Format | Markdown, HTML, Image | Markdown |
| Theme | Paper, Sepia, Ink, Night, Google, Antigravity (HTML & Image) | Paper |
| Image Width | Mobile 640, Tablet 960, Desktop 1200, or `320–2400 px`; font auto or `12–48 px` | `640 px`, auto (`24 px`) |
| Tool Calls | Detailed · Summary · None | None |
| Thinking | Detailed · Summary · None | None |
| Save To | Local folder (default `~/Downloads`), or browser download | Local folder |
| Content | Per-turn checkboxes for user/assistant messages; All / Users / Assistants / None | All |

### 2. Using `agy-export` in `agy` TUI or Terminal

```bash
# Run inside agy input box (0-token instant Markdown export to ~/Downloads)
!agy-export

# List recent conversations (App + CLI)
agy-export --list

# Export the latest/specified conversation as Antigravity dark HTML with tool & thinking summaries, and reveal in Finder
agy-export --format html --theme antigravity --tools summary --thinking summary --reveal

# Render as a 640px mobile-width Google-theme 2x PNG and open immediately
agy-export --format image --theme google --width 640 --open
```

### 3. Optional Configuration (`~/.gemini/config/conversation-export.json`)

Works out of the box without configuration. To customize default save directory, image scale/height, or external LLM summary models, create `~/.gemini/config/conversation-export.json`:

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

## Tests

```bash
pnpm test
```
