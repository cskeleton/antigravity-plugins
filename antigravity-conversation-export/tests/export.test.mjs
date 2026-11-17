import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractUserPrompt, foldSteps, outlineOf } from '../lib/parse.mjs';
import {
  detectLanguage,
  heuristicThinkingSummary,
  heuristicToolSummary,
} from '../lib/summarize.mjs';
import { renderDocument, renderImageHtml, THEMES } from '../lib/render.mjs';
import { findChromium, renderPng } from '../lib/image.mjs';
import { selectRounds, writeUnique } from '../lib/exporter.mjs';

const SAMPLE_STEPS = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-11-11T04:00:00Z',
    content: `<USER_REQUEST>
请检查 server.mjs 的性能瓶颈并给出修复建议。
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-11-11T12:00:00+08:00.
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting \`Model Selection\` from None to Gemini 4 Carbon (Medium).
</USER_SETTINGS_CHANGE>`,
    media: [{ mime_type: 'image/png', uri: 'file:///tmp/screenshot.png' }],
  },
  {
    step_index: 1,
    source: 'SYSTEM',
    type: 'CONVERSATION_HISTORY',
    status: 'DONE',
    created_at: '2026-11-11T04:00:01Z',
    content: '# Conversation History ...',
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-11T04:00:02Z',
    thinking:
      '**排查服务端性能瓶颈**\n\n我需要先读取 `server.mjs` 第 1 到 100 行，并运行基准命令确认响应耗时。',
    tool_calls: [
      {
        name: 'read_file',
        args: { Path: '/Users/gc/app/server.mjs', StartLine: 1, EndLine: 100 },
      },
      {
        name: 'run_command',
        args: { CommandLine: 'node bench.js', toolSummary: 'Run latency benchmark' },
      },
    ],
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'VIEW_FILE',
    status: 'DONE',
    created_at: '2026-11-11T04:00:04Z',
    content:
      'Created At: 2026-11-11T04:00:03Z\nCompleted At: 2026-11-11T04:00:05Z\n1: import http from "node:http";',
  },
  {
    step_index: 4,
    source: 'MODEL',
    type: 'RUN_COMMAND',
    status: 'DONE',
    created_at: '2026-11-11T04:00:06Z',
    content:
      'Created At: 2026-11-11T04:00:05Z\nCompleted At: 2026-11-11T04:00:10Z\nCommand exited with code 0.\n\np99: 420ms',
  },
  {
    step_index: 5,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: '2026-11-11T04:00:11Z',
    content: '<SYSTEM_MESSAGE>Background notice</SYSTEM_MESSAGE>',
  },
  {
    step_index: 6,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-11T04:00:14Z',
    thinking: '**整理优化结论**\n\n基准结果显示同步阻塞读取导致了延迟，建议改用内存缓存。',
    content:
      '已定位问题：[`server.mjs`](file:///Users/gc/app/server.mjs#L1-L20) 在每次请求中执行了同步文件读取，建议缓存静态模板。',
  },
];

test('extractUserPrompt strips system XML tags and preserves artifact comments + model hint', () => {
  const res = extractUserPrompt(SAMPLE_STEPS[0].content);
  assert.equal(res.text, '请检查 server.mjs 的性能瓶颈并给出修复建议。');
  assert.equal(res.modelHint, 'Gemini 4 Carbon (Medium)');

  const approval = extractUserPrompt(
    'Comments on artifact URI: file:///tmp/plan.md\n\nThe user has approved this document.\n\n<USER_REQUEST>\n继续执行\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>'
  );
  assert.match(approval.text, /The user has approved this document/);
  assert.match(approval.text, /继续执行/);
  assert.doesNotMatch(approval.text, /ADDITIONAL_METADATA/);
});

test('foldSteps pairs parallel tool calls in FIFO order and skips system steps', () => {
  const { rounds, detectedModels } = foldSteps(SAMPLE_STEPS);
  assert.equal(rounds.length, 1);
  assert.deepEqual(detectedModels, ['Gemini 4 Carbon (Medium)']);

  const r0 = rounds[0];
  assert.equal(r0.prompt.images, 1);
  assert.equal(r0.stats.tools, 2);
  assert.equal(r0.stats.reasoning, 2);
  assert.equal(r0.blocks.length, 2);
  assert.equal(r0.blocks[0].kind, 'activity');
  assert.equal(r0.blocks[1].kind, 'reply');

  const tools = r0.blocks[0].items.filter((i) => i.kind === 'tool');
  assert.equal(tools[0].name, 'read_file');
  assert.match(tools[0].result, /import http/);
  assert.doesNotMatch(tools[0].result, /Created At:/);
  assert.equal(tools[1].name, 'run_command');
  assert.match(tools[1].result, /p99: 420ms/);

  const outline = outlineOf(r0);
  assert.equal(outline.tools, 2);
  assert.equal(outline.reasoning, 2);
  assert.match(outline.answer, /server\.mjs/);
});

test('heuristic summaries produce concise localized lines for both tools and thinking', () => {
  const { rounds } = foldSteps(SAMPLE_STEPS);
  const lang = detectLanguage(rounds);
  assert.equal(lang, 'zh');

  const items = rounds[0].blocks[0].items;
  const readTool = items.find((i) => i.name === 'read_file');
  const cmdTool = items.find((i) => i.name === 'run_command');
  const thinkItem = items.find((i) => i.kind === 'reasoning');

  assert.match(heuristicToolSummary(readTool, 'zh'), /读取 server\.mjs（第 1–100 行）/);
  assert.match(heuristicToolSummary(cmdTool, 'zh'), /Run latency benchmark/);

  const thinkSum = heuristicThinkingSummary(thinkItem.text, 'zh');
  assert.match(thinkSum.title, /排查服务端性能瓶颈/);
  assert.match(thinkSum.title, /server\.mjs/);
});

test('renderDocument supports Markdown and HTML with file:// links and summary/detailed modes', () => {
  const { rounds, detectedModels } = foldSteps(SAMPLE_STEPS);
  const selected = selectRounds(rounds, { parts: [{ index: 0, user: true, assistant: true }] });
  const doc = {
    title: '性能优化会话',
    sessionId: 'test-session-01',
    exportedAt: Date.UTC(2026, 10, 11, 4, 30, 0),
    models: detectedModels,
    rounds: selected,
  };

  const md = renderDocument(doc, {
    format: 'markdown',
    tools: 'summary',
    thinking: 'summary',
    theme: 'paper',
    lang: 'zh',
    timeZone: 'Asia/Shanghai',
  });
  assert.match(md, /# 性能优化会话/);
  assert.match(md, /> \*\*已处理 14 秒\*\* · 4 步/);
  assert.match(md, /读取 server\.mjs/);
  assert.match(md, /\*排查服务端性能瓶颈/);

  const html = renderDocument(doc, {
    format: 'html',
    tools: 'detailed',
    thinking: 'summary',
    theme: 'night',
    lang: 'zh',
    timeZone: 'Asia/Shanghai',
  });
  assert.match(html, /data-theme="night"/);
  assert.match(html, /<details class="activity">/);
  assert.match(
    html,
    /\.page \{ width: 100%; max-width: none; margin: 0; padding: 40px clamp\(16px, 4vw, 56px\) 64px; \}/
  );
  assert.doesNotMatch(html, /max-width:\s*860px/);
  // Ensure Antigravity file:// links are rendered as proper <a> tags, not unparsed markdown
  assert.match(html, /<a href="file:\/\/\/Users\/gc\/app\/server\.mjs#L1-L20">/);

  // Verify new Google & Antigravity signature themes and color-scheme metadata
  assert.deepEqual(THEMES, ['paper', 'sepia', 'ink', 'night', 'google', 'antigravity']);
  const googleHtml = renderDocument(doc, {
    format: 'html',
    tools: 'summary',
    thinking: 'summary',
    theme: 'google',
    lang: 'zh',
  });
  assert.match(googleHtml, /data-theme="google"/);
  assert.match(googleHtml, /<meta name="color-scheme" content="light">/);
  assert.match(googleHtml, /Google Sans Flex/);

  const agyHtml = renderDocument(doc, {
    format: 'html',
    tools: 'summary',
    thinking: 'summary',
    theme: 'antigravity',
    lang: 'zh',
  });
  assert.match(agyHtml, /data-theme="antigravity"/);
  assert.match(agyHtml, /<meta name="color-scheme" content="dark">/);
  assert.match(agyHtml, /Google Sans Code/);
});

test('writeUnique never overwrites existing files', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-export-uniq-'));
  try {
    const first = await writeUnique(tmp, [{ name: 'demo.md', data: Buffer.from('v1') }]);
    const second = await writeUnique(tmp, [{ name: 'demo.md', data: Buffer.from('v2') }]);
    assert.equal(path.basename(first[0]), 'demo.md');
    assert.equal(path.basename(second[0]), 'demo (2).md');
    assert.equal(await fs.promises.readFile(first[0], 'utf8'), 'v1');
    assert.equal(await fs.promises.readFile(second[0], 'utf8'), 'v2');
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test('renderPng generates retina PNG image when Chromium is available', async (t) => {
  const ch = await findChromium();
  if (!ch.available) {
    t.skip(`Chromium unavailable: ${ch.reason}`);
    return;
  }
  const { rounds, detectedModels } = foldSteps(SAMPLE_STEPS);
  const doc = {
    title: 'PNG 导出验证',
    sessionId: 'test-png-01',
    exportedAt: Date.now(),
    models: detectedModels,
    rounds,
  };
  for (const theme of ['google', 'antigravity']) {
    const imgHtml = renderImageHtml(doc, {
      format: 'image',
      tools: 'summary',
      thinking: 'summary',
      theme,
      lang: 'zh',
      fontSize: 24,
    });
    const res = await renderPng(imgHtml, {
      width: 640,
      scale: 2,
      maxHeight: 7500,
      theme,
    });
    try {
      assert.equal(res.files.length, 1);
      const stat = await fs.promises.stat(res.files[0]);
      assert.ok(stat.size > 1000, `PNG file for ${theme} should be non-empty`);
      const header = await fs.promises.readFile(res.files[0]);
      assert.equal(header[0], 0x89);
      assert.equal(header[1], 0x50); // 'P'
      assert.equal(header[2], 0x4e); // 'N'
      assert.equal(header[3], 0x47); // 'G'
    } finally {
      await fs.promises.rm(res.tempDir, { recursive: true, force: true });
    }
  }
});
