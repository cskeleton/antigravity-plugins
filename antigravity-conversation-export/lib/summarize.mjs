/**
 * @fileoverview Dual-mode one-line summaries for tool calls and thinking blocks:
 *
 * 1. Zero-token local heuristic / extractive summaries (`heuristicToolSummary` &
 *    `heuristicThinkingSummary`): Always available offline with 0 latency and 0 quota usage.
 *    Tailored specifically for Antigravity's toolset (`read_file`, `view_file`, `write_file`,
 *    `edit_file`, `run_command`, `grep_search`, `list_dir`, `search_web`, `invoke_subagent`,
 *    `swarm`, `call_mcp_tool`, etc.) and Gemini/Claude structured thinking blocks.
 * 2. Optional external LLM API summaries (`summarizeWithModel`): Reads optional provider config
 *    from `~/.gemini/config/conversation-export.json` or standard API env vars (`OPENAI_API_KEY`,
 *    `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) for LLM-generated summaries, falling back cleanly
 *    to local rules on failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preview } from './parse.mjs';

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g;

/** Detect export language (`'zh'` or `'en'`) from human prompts (and assistant replies if needed). */
export function detectLanguage(rounds) {
  let cjk = 0;
  let total = 0;
  for (const round of rounds) {
    const text = round.prompt?.text || round.answerPreview || '';
    total += text.length;
    cjk += (text.match(CJK) ?? []).length;
  }
  return total > 0 && cjk / total > 0.06 ? 'zh' : 'en';
}

function first(args, ...keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function base(filePath) {
  if (!filePath) return '';
  const clean = String(filePath).replace(/^file:\/\//, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? clean;
}

function lineSpan(args, lang) {
  const s = args?.StartLine ?? args?.start_line ?? args?.offset;
  const e = args?.EndLine ?? args?.end_line;
  if (Number.isInteger(s) && Number.isInteger(e)) {
    return lang === 'zh' ? `（第 ${s}–${e} 行）` : ` (lines ${s}–${e})`;
  }
  if (Number.isInteger(s)) {
    return lang === 'zh' ? `（自第 ${s} 行起）` : ` (from line ${s})`;
  }
  return '';
}

const PHRASES = {
  en: {
    bash: (desc, cmd) =>
      desc && cmd
        ? `${desc} (\`${preview(cmd, 44)}\`)`
        : desc
          ? desc
          : `Ran \`${preview(cmd, 60)}\``,
    read: (p, span) => (p ? `Read ${base(p)}${span}` : 'Read file'),
    write: (p) => (p ? `Wrote ${base(p)}` : 'Created file'),
    edit: (p) => (p ? `Edited ${base(p)}` : 'Edited file'),
    listDir: (p) => (p ? `Listed directory ${base(p)}` : 'Listed directory'),
    grep: (q, p) =>
      q
        ? `Searched${p ? ` ${base(p)}` : ' files'} for “${preview(q, 45)}”`
        : 'Searched file contents',
    find: (q) => (q ? `Found files matching “${preview(q, 45)}”` : 'Searched file names'),
    webSearch: (q) => (q ? `Searched the web for “${preview(q, 55)}”` : 'Searched the web'),
    webFetch: (u) => (u ? `Read URL ${preview(u, 65)}` : 'Read web page'),
    subagent: (role, prompt) =>
      role
        ? `Delegated to ${role}${prompt ? `: ${preview(prompt, 45)}` : ''}`
        : `Launched subagent: ${preview(prompt, 55)}`,
    sendMsg: (to) => `Messaged agent ${preview(to, 24)}`,
    swarm: (action, name) => `Swarm ${action}${name ? ` (${name})` : ''}`,
    mcp: (srv, tool) => `Called MCP ${srv ? `${srv}/` : ''}${tool}`,
    ask: (q) => (q ? `Asked user: “${preview(q, 50)}”` : 'Asked the user a question'),
    schedule: (p) => `Scheduled task${p ? `: ${preview(p, 45)}` : ''}`,
    manageTask: (act) => `Managed background task (${act || 'status'})`,
    imageGen: (p) => `Generated image${p ? `: ${preview(p, 45)}` : ''}`,
    marketplace: (q) => `Searched Marketplace${q ? ` for “${preview(q, 45)}”` : ''}`,
    generic: (n) => `Used ${n}`,
    failed: (s) => `${s} (failed)`,
  },
  zh: {
    bash: (desc, cmd) =>
      desc && cmd
        ? `${desc}（\`${preview(cmd, 42)}\`）`
        : desc
          ? `执行命令：${desc}`
          : `运行命令 \`${preview(cmd, 56)}\``,
    read: (p, span) => (p ? `读取 ${base(p)}${span}` : '读取文件'),
    write: (p) => (p ? `写入 ${base(p)}` : '创建文件'),
    edit: (p) => (p ? `修改 ${base(p)}` : '编辑文件'),
    listDir: (p) => (p ? `列出目录 ${base(p)}` : '列出目录内容'),
    grep: (q, p) =>
      q
        ? `在${p ? ` ${base(p)}` : '文件'}中搜索“${preview(q, 38)}”`
        : '搜索文件内容',
    find: (q) => (q ? `查找匹配“${preview(q, 38)}”的文件` : '按名称查找文件'),
    webSearch: (q) => (q ? `联网搜索“${preview(q, 42)}”` : '联网搜索'),
    webFetch: (u) => (u ? `读取网页 ${preview(u, 58)}` : '读取网页内容'),
    subagent: (role, prompt) =>
      role
        ? `委派子代理（${role}）${prompt ? `：${preview(prompt, 36)}` : ''}`
        : `启动子代理：${preview(prompt, 42)}`,
    sendMsg: (to) => `向子代理 ${preview(to, 18)} 发送消息`,
    swarm: (action, name) => `管理协作集群（${action}${name ? `: ${name}` : ''}）`,
    mcp: (srv, tool) => `调用 MCP 工具 ${srv ? `${srv}/` : ''}${tool}`,
    ask: (q) => (q ? `向用户提问：“${preview(q, 40)}”` : '向用户提问'),
    schedule: (p) => `设置定时任务${p ? `：${preview(p, 38)}` : ''}`,
    manageTask: (act) => `管理后台任务（${act || 'status'}）`,
    imageGen: (p) => `生成图片${p ? `：${preview(p, 38)}` : ''}`,
    marketplace: (q) => `检索插件市场${q ? `“${preview(q, 38)}”` : ''}`,
    generic: (n) => `调用 ${n}`,
    failed: (s) => `${s}（失败）`,
  },
};

/**
 * Deterministic one-line description of an Antigravity tool call.
 * @param {any} tool
 * @param {'en'|'zh'} lang
 */
export function heuristicToolSummary(tool, lang) {
  const p = PHRASES[lang] ?? PHRASES.en;
  const a = tool.args ?? {};
  const name = String(tool.name ?? 'tool');
  let text;

  if (name === 'run_command' || name === 'bash' || name === 'pwsh') {
    const desc = first(a, 'toolSummary', 'toolAction', 'description');
    const cmd = first(a, 'CommandLine', 'command') ?? '';
    text = p.bash(desc, cmd);
  } else if (name === 'read_file' || name === 'view_file' || name === 'read' || name === 'read_image') {
    const target = first(a, 'Path', 'AbsolutePath', 'file_path', 'path') ?? '';
    text = p.read(target, lineSpan(a, lang));
  } else if (name === 'write_file' || name === 'write' || name === 'write_to_file') {
    const target = first(a, 'Path', 'TargetFile', 'AbsolutePath', 'file_path', 'path') ?? '';
    text = p.write(target);
  } else if (
    name === 'edit_file' ||
    name === 'edit' ||
    name === 'replace_file_content' ||
    name === 'multi_replace_file_content'
  ) {
    const target = first(a, 'Path', 'TargetFile', 'AbsolutePath', 'file_path', 'path') ?? '';
    text = p.edit(target);
  } else if (name === 'list_dir' || name === 'list_directory') {
    text = p.listDir(first(a, 'DirectoryPath', 'Path', 'path') ?? '');
  } else if (name === 'grep_search' || name === 'grep') {
    text = p.grep(
      first(a, 'Query', 'Pattern', 'pattern', 'query') ?? '',
      first(a, 'SearchPath', 'DirectoryPath', 'path')
    );
  } else if (name === 'find_by_name' || name === 'glob' || name === 'find') {
    text = p.find(first(a, 'Pattern', 'pattern', 'Query', 'query') ?? '');
  } else if (name === 'search_web' || name === 'web_search') {
    text = p.webSearch(first(a, 'query', 'Query') ?? '');
  } else if (name === 'read_url_content' || name === 'web_fetch') {
    text = p.webFetch(first(a, 'Url', 'url') ?? '');
  } else if (name === 'invoke_subagent' || name === 'subagent' || name === 'browser_subagent') {
    text = p.subagent(
      first(a, 'Role', 'TypeName', 'TaskName'),
      first(a, 'Prompt', 'Task', 'description', 'prompt') ?? ''
    );
  } else if (name === 'send_message') {
    text = p.sendMsg(first(a, 'Recipient', 'recipient') ?? '');
  } else if (name === 'swarm') {
    text = p.swarm(first(a, 'action') ?? 'status', first(a, 'name', 'title'));
  } else if (name === 'call_mcp_tool') {
    text = p.mcp(first(a, 'ServerName'), first(a, 'ToolName') ?? 'tool');
  } else if (name.startsWith('mcp_')) {
    const rest = name.slice(4);
    text = p.mcp('', rest);
  } else if (name === 'ask_question' || name === 'ask_user_question') {
    const q = Array.isArray(a.questions) ? a.questions[0]?.question : first(a, 'question');
    text = p.ask(q);
  } else if (name === 'schedule') {
    text = p.schedule(first(a, 'Prompt', 'CronExpression'));
  } else if (name === 'manage_task' || name === 'command_status') {
    text = p.manageTask(first(a, 'Action', 'TaskId', 'CommandId'));
  } else if (name === 'generate_image') {
    text = p.imageGen(first(a, 'Prompt', 'ImageName'));
  } else if (name === 'search_marketplace') {
    const q = Array.isArray(a.queries) ? a.queries.join(' / ') : first(a, 'query');
    text = p.marketplace(q);
  } else {
    const hint = first(
      a,
      'toolSummary',
      'toolAction',
      'description',
      'Path',
      'AbsolutePath',
      'query',
      'Query',
      'name',
      'Name'
    );
    text = hint ? `${p.generic(name)}：${preview(hint, 45)}` : p.generic(name);
  }

  return tool.isError ? p.failed(text) : text;
}

/**
 * Zero-token local extractive one-sentence summary for a thinking block.
 * Extracts Markdown `**Heading**` + first meaningful sentence so "Thinking: Summary"
 * works instantaneously without requiring an external LLM call.
 * @param {string} rawThinking
 * @param {'en'|'zh'} lang
 * @returns {{ title: string, text: string }}
 */
export function heuristicThinkingSummary(rawThinking, lang) {
  const raw = String(rawThinking ?? '').trim();
  if (!raw) return { title: '', text: '' };

  // Check if thinking starts with a Gemini-style `**Heading**` line
  let heading = '';
  let body = raw;
  const headingMatch = raw.match(/^\*\*([^\n*]{2,80})\*\*\s*\n+([\s\S]*)$/);
  if (headingMatch) {
    heading = headingMatch[1].trim();
    body = headingMatch[2].trim();
  }

  // Clean markdown code blocks, bullets, and formatting from body
  const cleaned = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Split first sentence
  const sentenceMatch = cleaned.match(/^(.{6,140}?[。！？.!?])(?:\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[1].trim() : preview(cleaned, lang === 'zh' ? 68 : 120);

  if (heading && firstSentence) {
    const maxLen = lang === 'zh' ? 76 : 135;
    const combined = `${heading} — ${firstSentence}`;
    return { title: preview(combined, maxLen), text: '' };
  }
  if (heading) {
    return { title: preview(heading, lang === 'zh' ? 60 : 110), text: '' };
  }
  return { title: preview(firstSentence, lang === 'zh' ? 72 : 130), text: '' };
}

/* ---------------- Optional External LLM Model Summarizer ---------------- */

const CONFIG_PATH = join(homedir(), '.gemini', 'config', 'conversation-export.json');

/**
 * Load optional external summary LLM configurations from `~/.gemini/config/conversation-export.json`
 * or standard API environment variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`).
 */
export function loadSummaryModels() {
  const models = [];
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (Array.isArray(cfg?.models)) {
        for (const m of cfg.models) {
          if (m && m.provider && m.model && m.apiKey) {
            models.push({
              provider: String(m.provider),
              model: String(m.model),
              label: String(m.label || `${m.provider} · ${m.model}`),
              baseUrl: m.baseUrl ? String(m.baseUrl) : undefined,
              apiKey: String(m.apiKey),
            });
          }
        }
      }
    } catch {
      // Ignore invalid config file
    }
  }

  if (process.env.GEMINI_API_KEY) {
    models.push({
      provider: 'gemini',
      model: process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash',
      label: `Gemini API · ${process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash'}`,
      apiKey: process.env.GEMINI_API_KEY,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    models.push({
      provider: 'openai',
      model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
      label: `OpenAI · ${process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini'}`,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    models.push({
      provider: 'anthropic',
      model: process.env.ANTHROPIC_SUMMARY_MODEL || 'claude-3-5-haiku-latest',
      label: `Anthropic · ${process.env.ANTHROPIC_SUMMARY_MODEL || 'claude-3-5-haiku-latest'}`,
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  return models;
}

const SYSTEM_PROMPT = `You write the collapsed "activity" lines of an AI-assistant chat transcript, in the style ChatGPT uses under "Thought for 12s".
You receive JSON entries of kind "tool" (a tool call and a clipped result) or "reasoning" (the assistant's private thinking).
Return ONLY a JSON object mapping each entry id to its summary, with no prose and no code fences:
{"<id>": {"title": "...", "text": "..."}}
Rules:
- Write in LANGUAGE. Use plain prose; never include raw commands, code, JSON, or long paths.
- tool: "title" is one short past-tense sentence saying what the step did and, when the result shows it, what it found (at most 16 words, or 30 CJK characters). Mark failures. Leave "text" empty.
- reasoning: "title" is one short first-person sentence ("I'm checking…", "我在确认…") saying what the assistant was working out or decided (at most 24 words, or 40 CJK characters). Omit secrets and filler. Leave "text" empty.
- Every input id must appear exactly once.`;

function clipText(text, max) {
  const value = String(text ?? '');
  return value.length > max
    ? `${value.slice(0, max)} …[${value.length - max} more chars]`
    : value;
}

function entriesOf(group, wantTools, wantReasoning) {
  const entries = [];
  for (const item of group.items) {
    if (item.kind === 'tool' && wantTools) {
      entries.push({
        id: item.key,
        kind: 'tool',
        name: item.name,
        arguments: clipText(item.argsText, 700),
        result: clipText(item.result ?? '(no result)', 500),
        failed: item.isError || undefined,
      });
    } else if (item.kind === 'reasoning' && wantReasoning) {
      entries.push({
        id: item.key,
        kind: 'reasoning',
        text: clipText(item.text, 2400),
      });
    }
  }
  return entries;
}

function chunkEntries(entries, maxChars = 14000) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const entry of entries) {
    const len = JSON.stringify(entry).length;
    if (cur.length > 0 && size + len > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(entry);
    size += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export function parseSummaryJson(text) {
  const stripped = String(text).replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(stripped.slice(start, end + 1));
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function callExternalModel(modelCfg, systemPrompt, userPrompt, signal) {
  if (modelCfg.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelCfg.model)}:generateContent?key=${encodeURIComponent(modelCfg.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  }

  if (modelCfg.provider === 'anthropic') {
    const baseUrl = (modelCfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': modelCfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelCfg.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
    const data = await res.json();
    return data?.content?.map((c) => c.text || '').join('') || '';
  }

  // OpenAI-compatible endpoint
  const baseUrl = (modelCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modelCfg.apiKey}`,
    },
    body: JSON.stringify({
      model: modelCfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function summarizeWithModel({
  modelCfg,
  language,
  rounds,
  tools,
  reasoning,
  concurrency = 4,
  timeoutMs = 90_000,
  signal,
}) {
  const sys = SYSTEM_PROMPT.replace('LANGUAGE', language === 'zh' ? 'Simplified Chinese' : 'English');
  const tasks = [];

  for (const round of rounds) {
    const context = round.prompt === undefined ? '' : preview(round.prompt.text, 400);
    for (const block of round.blocks) {
      if (block.kind !== 'activity') continue;
      const entries = entriesOf(block, tools, reasoning);
      for (const part of chunkEntries(entries, 14000)) {
        tasks.push(async () => {
          const signals = [AbortSignal.timeout(timeoutMs)];
          if (signal) signals.push(signal);
          const callSignal = AbortSignal.any(signals);
          const prompt = `The user's request in this round: ${JSON.stringify(context)}\n\nEntries:\n${JSON.stringify(part)}`;
          try {
            const output = await callExternalModel(modelCfg, sys, prompt, callSignal);
            return { part, parsed: parseSummaryJson(output) };
          } catch (error) {
            signal?.throwIfAborted?.();
            return { part, parsed: undefined, error };
          }
        });
      }
    }
  }

  const results = await runPool(tasks, concurrency);
  const summaries = new Map();
  let failures = 0;
  for (const { part, parsed } of results) {
    if (!parsed) {
      failures += 1;
      continue;
    }
    for (const entry of part) {
      const value = parsed[entry.id];
      if (!value || typeof value !== 'object') continue;
      const title = typeof value.title === 'string' ? value.title.trim() : '';
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (title || text) summaries.set(entry.id, { title, text });
    }
  }

  return { summaries, failures, calls: tasks.length };
}
