/**
 * @fileoverview Render folded Antigravity rounds as Markdown, standalone HTML,
 * or static screenshot HTML for `image.mjs`.
 *
 * Adapted from `dsh-conversation-export/lib/render.js` with Antigravity enhancements:
 * - Supports `file://` links emitted by Antigravity agents so `[file.js](file:///...)`
 *   renders cleanly in HTML and PNG instead of raw markdown brackets.
 * - Supports zero-token `heuristicThinkingSummary` fallback when `thinking === 'summary'`
 *   and no external LLM summary model is selected.
 * - Uses native `<details>` + `<summary>` disclosures in HTML so collapsed activity and
 *   tool sections remain accessible and searchable via browser Find-in-Page.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import { heuristicThinkingSummary, heuristicToolSummary } from './summarize.mjs';

export const THEMES = ['paper', 'sepia', 'ink', 'night', 'google', 'antigravity'];
export const DARK_THEMES = new Set(['night', 'antigravity']);
export const DETAIL_LEVELS = ['detailed', 'summary', 'none'];
const THEME_CSS_PATH = fileURLToPath(new URL('../assets/themes.css', import.meta.url));
function getThemeCss() {
  return fs.readFileSync(THEME_CSS_PATH, 'utf8');
}

const LABELS = {
  en: {
    user: 'User',
    assistant: 'Assistant',
    exported: 'Exported',
    session: 'Session',
    messages: (n) => `${n} message${n === 1 ? '' : 's'}`,
    model: 'Model',
    thought: 'Thought for',
    worked: 'Worked for',
    briefly: 'briefly',
    steps: (n) => `${n} step${n === 1 ? '' : 's'}`,
    images: (n) => `[${n} image${n === 1 ? '' : 's'} attached]`,
    files: (names) => `[Attached: ${names.join(', ')}]`,
    args: 'Arguments',
    result: 'Result',
    noResult: '(no result)',
    noReply: '(no reply)',
    clipped: (n) => `… ${n} more characters omitted`,
    notes: {
      interrupted: 'The reply was interrupted.',
      aborted: 'The turn was stopped.',
      error: 'The turn ended with an error',
      'max-tokens': 'The reply hit the output limit.',
    },
    reasoning: 'Thinking',
  },
  zh: {
    user: '用户',
    assistant: '助手',
    exported: '导出时间',
    session: '会话',
    messages: (n) => `${n} 条消息`,
    model: '模型',
    thought: '已思考',
    worked: '已处理',
    briefly: '片刻',
    steps: (n) => `${n} 步`,
    images: (n) => `[附图 ${n} 张]`,
    files: (names) => `[附件：${names.join('、')}]`,
    args: '参数',
    result: '结果',
    noResult: '（无输出）',
    noReply: '（无回复）',
    clipped: (n) => `…… 已省略 ${n} 个字符`,
    notes: {
      interrupted: '回复被中断。',
      aborted: '本轮已停止。',
      error: '本轮因错误结束',
      'max-tokens': '回复达到输出上限。',
    },
    reasoning: '思考',
  },
};

function labelsOf(lang) {
  return LABELS[lang] ?? LABELS.en;
}

export function detailLevel(value) {
  if (value === 'hidden') return 'none';
  return DETAIL_LEVELS.includes(value) ? value : 'none';
}

export function formatDuration(ms, lang) {
  const L = labelsOf(lang);
  const seconds = Math.round(Math.max(0, ms || 0) / 1000);
  if (seconds < 1) return L.briefly;
  if (lang === 'zh') {
    if (seconds < 60) return `${seconds} 秒`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(ms, timeZone, lang) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  try {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-CA', {
      ...options,
      timeZone,
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-CA', options).format(ms);
  }
}

function clip(text, max, lang) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n${labelsOf(lang).clipped(value.length - max)}`;
}

function prettyArgs(tool) {
  if (tool.args && !('raw' in tool.args)) {
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {}
  }
  return tool.argsText;
}

function partsOf(round) {
  return round.parts ?? { user: true, assistant: true };
}

function countMessages(rounds) {
  let n = 0;
  for (const round of rounds) {
    const parts = partsOf(round);
    if (parts.user && round.prompt !== undefined) n += 1;
    if (parts.assistant && round.blocks.length > 0) n += 1;
  }
  return n;
}

/**
 * Resolve one activity group into renderable entries under the chosen options.
 */
function visibleEntries(group, options) {
  const entries = [];
  let hasTools = false;
  let hasThinking = false;
  const summaries = options.summaries ?? new Map();

  for (const item of group.items) {
    if (item.kind === 'reasoning') {
      if (options.thinking === 'none') continue;
      if (options.thinking === 'detailed') {
        entries.push({ kind: 'reasoning', text: item.text });
        hasThinking = true;
        continue;
      }
      const summary = summaries.get(item.key) ?? heuristicThinkingSummary(item.text, options.lang);
      if (!summary || (!summary.title && !summary.text)) continue;
      entries.push({ kind: 'reasoning-summary', title: summary.title, text: summary.text });
      hasThinking = true;
    } else if (item.kind === 'tool') {
      if (options.tools === 'none') continue;
      hasTools = true;
      if (options.tools === 'detailed') {
        entries.push({
          kind: 'tool-detailed',
          tool: item,
          line: heuristicToolSummary(item, options.lang),
        });
      } else {
        const summary = summaries.get(item.key);
        entries.push({
          kind: 'tool-line',
          line: summary?.title || heuristicToolSummary(item, options.lang),
          failed: item.isError,
        });
      }
    } else if (item.kind === 'narration') {
      entries.push({ kind: 'narration', text: item.text });
    } else if (item.kind === 'note') {
      entries.push({ kind: 'note', note: item.note, detail: item.detail });
    }
  }

  if (!hasTools && !hasThinking) {
    return {
      entries: entries.filter((entry) => entry.kind === 'note'),
      hasTools,
      hasThinking,
    };
  }
  return { entries, hasTools, hasThinking };
}

function headerOf(group, visible, lang) {
  const L = labelsOf(lang);
  const duration = formatDuration((group.endTime ?? 0) - (group.startTime ?? 0), lang);
  const verb = visible.hasTools ? L.worked : L.thought;
  const steps = visible.entries.filter(
    (entry) => entry.kind !== 'narration' && entry.kind !== 'note'
  ).length;
  return { title: `${verb} ${duration}`, steps: L.steps(steps) };
}

function noteText(entry, lang) {
  const L = labelsOf(lang);
  const base = L.notes[entry.note] ?? entry.note;
  return entry.detail ? `${base}: ${entry.detail.slice(0, 300)}` : base;
}

function metaParts(doc, options) {
  const L = labelsOf(options.lang);
  const parts = [
    `${L.exported}: ${formatTime(doc.exportedAt, options.timeZone, options.lang)}`,
    `${L.session}: ${doc.sessionId}`,
    L.messages(countMessages(doc.rounds)),
  ];
  if (Array.isArray(doc.models) && doc.models.length > 0) {
    parts.push(`${L.model}: ${doc.models.join(', ')}`);
  }
  return parts;
}

/* ------------------------------ Markdown ------------------------------ */

function fence(text, info = '') {
  const runs = String(text).match(/`{3,}/g) ?? [];
  const length = Math.max(3, ...runs.map((run) => run.length + 1));
  const marks = '`'.repeat(length);
  return `${marks}${info}\n${text}\n${marks}`;
}

function quote(text) {
  return String(text)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function inlineSafe(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function promptMarkdown(prompt, L) {
  const parts = [];
  if (prompt.text.trim() !== '') parts.push(prompt.text.trim());
  if (prompt.images > 0) parts.push(`*${L.images(prompt.images)}*`);
  if (prompt.files.length > 0) parts.push(`*${L.files(prompt.files)}*`);
  return parts.join('\n\n');
}

function activityMarkdown(group, options) {
  const visible = visibleEntries(group, options);
  if (visible.entries.length === 0) return '';
  if (!visible.hasTools && !visible.hasThinking) {
    return visible.entries.map((entry) => `*${noteText(entry, options.lang)}*`).join('\n\n');
  }
  const L = labelsOf(options.lang);
  const head = headerOf(group, visible, options.lang);
  const lines = [`**${head.title}** · ${head.steps}`, ''];
  const maxChars = options.maxDetailChars ?? 4000;

  for (const entry of visible.entries) {
    if (entry.kind === 'tool-line') {
      lines.push(`- ${inlineSafe(entry.line)}`);
    } else if (entry.kind === 'reasoning-summary') {
      lines.push(`- *${inlineSafe(entry.text ? `${entry.title} ${entry.text}` : entry.title)}*`);
    } else if (entry.kind === 'reasoning') {
      lines.push('', `*${L.reasoning}*`, '', entry.text, '');
    } else if (entry.kind === 'narration') {
      lines.push('', entry.text, '');
    } else if (entry.kind === 'note') {
      lines.push('', `*${noteText(entry, options.lang)}*`, '');
    } else if (entry.kind === 'tool-detailed') {
      const tool = entry.tool;
      lines.push(
        '',
        `- **${inlineSafe(entry.line)}** \`${tool.name}\``,
        '',
        fence(clip(prettyArgs(tool), maxChars, options.lang), 'json'),
        '',
        fence(
          clip(
            tool.result === undefined || tool.result === '' ? L.noResult : tool.result,
            maxChars,
            options.lang
          ),
          'text'
        ),
        ''
      );
    }
  }
  return quote(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

function assistantMarkdown(round, options) {
  const body = [];
  for (const block of round.blocks) {
    if (block.kind === 'reply') body.push(block.text.trim());
    else if (block.kind === 'activity') {
      const text = activityMarkdown(block, options);
      if (text !== '') body.push(text);
    } else if (block.kind === 'note') {
      body.push(`*${noteText(block, options.lang)}*`);
    }
  }
  return body.length > 0 ? body.join('\n\n') : `*${labelsOf(options.lang).noReply}*`;
}

function heading(label, time, options) {
  const when = formatTime(time, options.timeZone, options.lang);
  return when === '' ? `## ${label}` : `## ${label} · ${when}`;
}

function renderMarkdown(doc, options) {
  const L = labelsOf(options.lang);
  const out = [`# ${doc.title}`, '', `> ${metaParts(doc, options).join(' · ')}`, ''];
  for (const round of doc.rounds) {
    const parts = partsOf(round);
    if (parts.user && round.prompt !== undefined) {
      out.push(
        '---',
        '',
        heading(L.user, round.startTime, options),
        '',
        promptMarkdown(round.prompt, L),
        ''
      );
    }
    if (parts.assistant && round.blocks.length > 0) {
      out.push(
        '---',
        '',
        heading(L.assistant, round.assistantTime, options),
        '',
        assistantMarkdown(round, options),
        ''
      );
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ----------------------------- HTML / image ----------------------------- */

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function makeMarkdownIt(breaks) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks,
    highlight(code, language) {
      try {
        if (language && hljs.getLanguage(language)) {
          return `<pre><code class="hljs language-${escapeHtml(language)}">${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
        }
      } catch {}
      return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
    },
  });

  // Allow Antigravity's `file://`, `sidecar://`, `customization://`, `conversation://` links
  // to render cleanly instead of leaving unparsed `[label](file:///...)` brackets.
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url) => {
    const str = String(url || '').trim().toLowerCase();
    if (
      str.startsWith('file://') ||
      str.startsWith('sidecar://') ||
      str.startsWith('customization://') ||
      str.startsWith('conversation://')
    ) {
      return true;
    }
    return defaultValidate(url);
  };

  // Strip `<plugin-card>` custom tags cleanly in rendered markdown if present
  md.use(taskLists, { enabled: false, label: true });
  md.use(footnote);
  return md;
}

const SHARED_CSS = `
.doc-meta { color: var(--muted); font-size: 0.8em; margin: 0 0 1.6em; }
.msg { padding: 1.1em 0; border-top: 1px solid var(--border); }
.msg:first-of-type { border-top: 0; padding-top: 0.2em; }
.msg.user + .msg.assistant { border-top: 0; padding-top: 0.2em; }
.msg-label { color: var(--muted); font-size: 0.74em; font-weight: 650; letter-spacing: 0.02em; margin: 0 0 0.5em; }
.msg.user { display: flex; flex-direction: column; align-items: flex-end; }
.msg.user .msg-label { text-align: right; }
.user-bubble { max-width: 85%; padding: 0.6em 1em; border-radius: 1.1em; background: var(--surface); }
.user-bubble > :first-child { margin-top: 0; } .user-bubble > :last-child { margin-bottom: 0; }
.attach { color: var(--muted); font-size: 0.86em; font-style: italic; }
.reply > :first-child { margin-top: 0; }
.activity { margin: 0.2em 0 1em; }
.activity-head { color: var(--muted); font-size: 0.88em; display: inline-flex; gap: 0.4em; align-items: center; }
.activity-head .steps { opacity: .75; }
details.activity > summary { cursor: pointer; list-style: none; user-select: none; }
details.activity > summary::-webkit-details-marker { display: none; }
details.activity > summary::after { content: '›'; display: inline-block; transition: transform .15s; font-size: 1.15em; }
details.activity[open] > summary::after { transform: rotate(90deg); }
.timeline { margin: 0.6em 0 0 0.25em; padding: 0.1em 0 0.1em 1em; border-left: 2px solid var(--border); font-size: 0.9em; color: var(--muted); }
.timeline > * { margin: 0.5em 0; }
.timeline .tool-line { color: var(--text); }
.timeline .tool-line.failed { color: #b42318; }
html[data-theme="night"] .timeline .tool-line.failed,
html[data-theme="antigravity"] .timeline .tool-line.failed { color: #f87171; }
.timeline .reasoning-summary { color: var(--muted); font-style: italic; }
.timeline .reasoning-full { color: var(--muted); }
.timeline .reasoning-full > :first-child { margin-top: 0; }
.timeline .narration { color: var(--text); }
.timeline .note { font-style: italic; }
.timeline .tool-head { color: var(--text); }
.timeline code.name { font-size: 0.8em; margin-left: 0.3em; }
.timeline .io-label { font-size: 0.78em; font-weight: 600; margin: 0.6em 0 0.1em; }
.timeline pre { margin: 0.25em 0; box-shadow: none; }
.reply-note { color: var(--muted); font-style: italic; }
`;

const HTML_CSS = `
body { --body-size: 16px; }
.page { width: 100%; max-width: none; margin: 0; padding: 40px clamp(16px, 4vw, 56px) 64px; }
.user-bubble { max-width: 90%; min-inline-size: 0; }
.document-title { font-size: 1.6em; margin-bottom: 8px; padding-bottom: 14px; }
details.tool > summary { cursor: pointer; }
pre { overflow: auto; } pre code { font-size: 0.85em; } code { font-size: 0.88em; }
.timeline pre code { font-size: 0.82em; }
@media print { details.activity > summary::after { display: none; } }
`;

const IMAGE_CSS = `
.page { padding: 2.25em 2em 2.35em; }
.document-title { font-size: 1.5em; margin: 0 0 0.35em; padding-bottom: 0.5em; }
.doc-meta { font-size: 0.66em; }
.msg-label { font-size: 0.62em; }
.activity-head { font-size: 0.8em; }
.timeline { font-size: 0.86em; }
.timeline pre code { font-size: 0.78em; }
.page-footer { font-size: 0.6em; }
`;

const PRINT_SCRIPT = `<script>addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true})});</script>`;

function activityHtml(group, options, md, mode) {
  const visible = visibleEntries(group, options);
  if (visible.entries.length === 0) return '';
  if (!visible.hasTools && !visible.hasThinking) {
    return visible.entries
      .map((entry) => `<p class="reply-note">${escapeHtml(noteText(entry, options.lang))}</p>`)
      .join('');
  }
  const L = labelsOf(options.lang);
  const head = headerOf(group, visible, options.lang);
  const maxChars = options.maxDetailChars ?? 4000;
  const parts = [];

  for (const entry of visible.entries) {
    if (entry.kind === 'tool-line') {
      parts.push(
        `<div class="tool-line${entry.failed ? ' failed' : ''}">${escapeHtml(entry.line)}</div>`
      );
    } else if (entry.kind === 'reasoning-summary') {
      parts.push(
        `<div class="reasoning-summary">${escapeHtml(entry.text ? `${entry.title} ${entry.text}` : entry.title)}</div>`
      );
    } else if (entry.kind === 'reasoning') {
      parts.push(`<div class="reasoning-full">${md.render(entry.text)}</div>`);
    } else if (entry.kind === 'narration') {
      parts.push(`<div class="narration">${md.render(entry.text)}</div>`);
    } else if (entry.kind === 'note') {
      parts.push(`<div class="note">${escapeHtml(noteText(entry, options.lang))}</div>`);
    } else if (entry.kind === 'tool-detailed') {
      const tool = entry.tool;
      const result = tool.result === undefined || tool.result === '' ? L.noResult : tool.result;
      const io =
        `<div class="io-label">${L.args}</div><pre><code class="hljs language-json">${escapeHtml(clip(prettyArgs(tool), maxChars, options.lang))}</code></pre>` +
        `<div class="io-label">${L.result}</div><pre><code class="hljs">${escapeHtml(clip(result, maxChars, options.lang))}</code></pre>`;
      const label = `${escapeHtml(entry.line)}<code class="name">${escapeHtml(tool.name)}</code>`;
      parts.push(
        mode === 'image'
          ? `<div class="tool"><div class="tool-head">${label}</div>${io}</div>`
          : `<details class="tool"><summary class="tool-head">${label}</summary>${io}</details>`
      );
    }
  }

  const headHtml = `<span>${escapeHtml(head.title)}</span><span class="steps">· ${escapeHtml(head.steps)}</span>`;
  const timeline = `<div class="timeline">${parts.join('')}</div>`;
  return mode === 'image'
    ? `<div class="activity"><div class="activity-head">${headHtml}</div>${timeline}</div>`
    : `<details class="activity"><summary class="activity-head">${headHtml}</summary>${timeline}</details>`;
}

function messagesHtml(doc, options, mode) {
  const L = labelsOf(options.lang);
  const userMd = makeMarkdownIt(true);
  const md = makeMarkdownIt(false);
  const out = [];

  for (const round of doc.rounds) {
    const parts = partsOf(round);
    if (parts.user && round.prompt !== undefined) {
      const attachments = [];
      if (round.prompt.images > 0) attachments.push(L.images(round.prompt.images));
      if (round.prompt.files.length > 0) attachments.push(L.files(round.prompt.files));
      const when = formatTime(round.startTime, options.timeZone, options.lang);
      out.push(
        `<section class="msg user"><div class="msg-label">${escapeHtml(L.user)}${when ? ` · ${escapeHtml(when)}` : ''}</div>` +
          `<div class="user-bubble markdown-body">${round.prompt.text.trim() === '' ? '' : userMd.render(round.prompt.text)}` +
          `${attachments.map((text) => `<p class="attach">${escapeHtml(text)}</p>`).join('')}</div></section>`
      );
    }
    if (parts.assistant && round.blocks.length > 0) {
      const body = [];
      for (const block of round.blocks) {
        if (block.kind === 'reply') {
          body.push(`<div class="reply markdown-body">${md.render(block.text)}</div>`);
        } else if (block.kind === 'activity') {
          body.push(activityHtml(block, options, md, mode));
        } else if (block.kind === 'note') {
          body.push(`<p class="reply-note">${escapeHtml(noteText(block, options.lang))}</p>`);
        }
      }
      const content =
        body.filter(Boolean).join('') || `<p class="reply-note">${escapeHtml(L.noReply)}</p>`;
      const when = formatTime(round.assistantTime, options.timeZone, options.lang);
      out.push(
        `<section class="msg assistant"><div class="msg-label">${escapeHtml(L.assistant)}${when ? ` · ${escapeHtml(when)}` : ''}</div>${content}</section>`
      );
    }
  }
  return out.join('\n');
}

function htmlShell(doc, options, { css, body, bodyStyle = '', script = '' }) {
  const theme = THEMES.includes(options.theme) ? options.theme : 'paper';
  const colorScheme = DARK_THEMES.has(theme) ? 'dark' : 'light';
  return `<!doctype html>
<html lang="${options.lang === 'zh' ? 'zh-CN' : 'en'}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${colorScheme}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="antigravity-conversation-export">
<title>${escapeHtml(doc.title)}</title>
<style>${getThemeCss()}\n${SHARED_CSS}\n${css}</style>
</head>
<body${bodyStyle ? ` style="${bodyStyle}"` : ''}>
${body}
${script}
</body>
</html>
`;
}

function renderHtml(doc, options) {
  const meta = metaParts(doc, options).map(escapeHtml).join(' · ');
  return htmlShell(doc, options, {
    css: HTML_CSS,
    script: PRINT_SCRIPT,
    body: `<main class="page">
<h1 class="document-title">${escapeHtml(doc.title)}</h1>
<p class="doc-meta">${meta}</p>
${messagesHtml(doc, options, 'html')}
</main>`,
  });
}

export function renderImageHtml(doc, options) {
  const meta = metaParts(doc, options).map(escapeHtml).join(' · ');
  return htmlShell(doc, options, {
    css: IMAGE_CSS,
    bodyStyle: `--body-size:${Number(options.fontSize) || 24}px`,
    body: `<main class="page"><div id="content-flow">
<div class="document-title">${escapeHtml(doc.title)}</div>
<p class="doc-meta">${meta}</p>
${messagesHtml(doc, options, 'image')}
</div><footer class="page-footer" id="page-footer"><span id="page-num-label"></span></footer></main>`,
  });
}

export function renderDocument(doc, options) {
  return options.format === 'html' ? renderHtml(doc, options) : renderMarkdown(doc, options);
}
