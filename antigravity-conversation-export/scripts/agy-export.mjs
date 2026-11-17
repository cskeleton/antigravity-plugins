#!/usr/bin/env node
/**
 * @fileoverview CLI tool (`agy-export`) for Antigravity Conversation Export.
 * Supports exporting from `agy` TUI (`!agy-export`), terminal scripts, and `/conversation-export` skill.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  exportConversation,
  getConversationOutline,
  listRecentConversations,
  openSystemPath,
} from '../lib/exporter.mjs';

const CONFIG_PATH = join(homedir(), '.gemini', 'config', 'conversation-export.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function printHelp() {
  console.log(`Usage: agy-export [conversation-id] [options]

Export an Antigravity (Desktop App or agy TUI) conversation as Markdown, HTML, or PNG images.
When [conversation-id] is omitted, uses $ANTIGRAVITY_CONVERSATION_ID or the latest active root conversation.

Options:
  -l, --list                  List recent conversations and exit
      --subagents             Include subagent sessions in --list
      --outline               Print per-round outline of the conversation and exit
  -f, --format <fmt>          Output format: markdown | html | image (default: markdown)
      --theme <theme>         Theme for html/image: paper | sepia | ink | night | google | antigravity (default: paper)
      --tools <level>         Tool call detail: detailed | summary | none (default: none)
      --thinking <level>      Thinking detail: detailed | summary | none (default: none)
  -w, --width <px>            Image width in CSS px, 320–2400 (default: 640 -> 1280px @2x)
      --font-size <px>        Image body font size, 12–48 (default: auto 24->16 by width)
  -r, --rounds <1,2,3>        1-based round numbers to include (default: all)
      --only <role>           Filter role: user | assistant
  -o, --dir <folder>          Destination folder (default: ~/Downloads)
      --lang <zh|en>          Force output language (default: auto-detected from prompts)
      --open                  Open the exported file (or first image) after saving
      --reveal                Reveal the exported file in Finder / Explorer
      --json                  Print machine-readable JSON output
  -h, --help                  Show this help message
`);
}

function parseCliArgs(argv) {
  const opts = {
    conversationId: '',
    list: false,
    subagents: false,
    outline: false,
    format: 'markdown',
    theme: 'paper',
    tools: 'none',
    thinking: 'none',
    width: undefined,
    fontSize: undefined,
    rounds: undefined,
    only: undefined,
    directory: undefined,
    lang: undefined,
    open: false,
    reveal: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-l' || a === '--list') opts.list = true;
    else if (a === '--subagents') opts.subagents = true;
    else if (a === '--outline') opts.outline = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--reveal') opts.reveal = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-f' || a === '--format') opts.format = argv[++i];
    else if (a === '--theme') opts.theme = argv[++i];
    else if (a === '--tools') opts.tools = argv[++i];
    else if (a === '--thinking') opts.thinking = argv[++i];
    else if (a === '-w' || a === '--width') opts.width = Number(argv[++i]);
    else if (a === '--font-size') opts.fontSize = Number(argv[++i]);
    else if (a === '-r' || a === '--rounds') {
      opts.rounds = String(argv[++i] || '')
        .split(',')
        .map((s) => Number(s.trim()) - 1)
        .filter((n) => Number.isSafeInteger(n) && n >= 0);
    } else if (a === '--only') opts.only = argv[++i];
    else if (a === '-o' || a === '--dir') opts.directory = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (!a.startsWith('-') && !opts.conversationId) {
      opts.conversationId = a;
    }
  }
  return opts;
}

async function resolveTargetId(explicitId) {
  if (explicitId) return explicitId;
  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID;
  }
  const sessions = await listRecentConversations({ limit: 5, includeSubagents: false });
  if (sessions.length === 0) {
    throw new Error('未找到任何可导出的会话 (No conversations found)');
  }
  return sessions[0].conversationId;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const config = loadConfig();

  if (opts.list) {
    const sessions = await listRecentConversations({
      limit: 40,
      includeSubagents: opts.subagents,
    });
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('暂无会话记录。');
      return;
    }
    console.log('最近会话列表 (Recent Conversations):');
    for (const s of sessions) {
      const tag = s.isSubagent ? '[Sub]' : s.surface === 'cli' ? '[CLI]' : '[App]';
      const time = s.lastModifiedTime ? s.lastModifiedTime.slice(0, 16).replace('T', ' ') : '';
      console.log(`  ${s.conversationId}  ${tag.padEnd(5)}  ${time}  ${s.title}`);
    }
    return;
  }

  const sessionId = await resolveTargetId(opts.conversationId);

  if (opts.outline) {
    const outline = await getConversationOutline(sessionId, config);
    if (opts.json) {
      console.log(JSON.stringify(outline, null, 2));
      return;
    }
    console.log(`会话标题: ${outline.title}`);
    console.log(`会话 ID : ${outline.sessionId}`);
    console.log(`使用模型: ${outline.models.join(', ') || '(未知)'}`);
    console.log(`对话轮数: ${outline.rounds.length} 轮\n`);
    for (const r of outline.rounds) {
      console.log(
        `  [第 ${r.index + 1} 轮] 工具:${r.tools} 思考:${r.reasoning}\n    👤 ${r.prompt || '(无)'}\n    🤖 ${r.answer || '(无文字回复)'}`
      );
    }
    return;
  }

  const result = await exportConversation(
    {
      sessionId,
      format: opts.format,
      theme: opts.theme,
      tools: opts.tools,
      thinking: opts.thinking,
      image:
        opts.format === 'image'
          ? { width: opts.width ?? 640, fontSize: opts.fontSize ?? null }
          : undefined,
      rounds: opts.rounds,
      only: opts.only,
      delivery: 'save',
      directory: opts.directory,
      lang: opts.lang,
    },
    config
  );

  if (opts.open && result.files[0]) {
    await openSystemPath(result.files[0].path, 'open');
  } else if (opts.reveal && result.files[0]) {
    await openSystemPath(result.files[0].path, 'reveal');
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.files.length === 1) {
    console.log(`✅ 导出成功: ${result.files[0].path}`);
  } else {
    console.log(`✅ 已导出 ${result.files.length} 张图片至: ${result.directory}`);
    for (const f of result.files) {
      console.log(`   - ${f.path}`);
    }
  }
}

main().catch((err) => {
  console.error(`❌ 导出失败: ${err.message || err}`);
  process.exit(1);
});
