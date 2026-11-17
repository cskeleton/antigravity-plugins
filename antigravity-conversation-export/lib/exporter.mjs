/**
 * @fileoverview Unified Conversation Export orchestration service for Antigravity.
 * Shared by the Sidecar web server (`sidecars/exporter/server.mjs`) and CLI (`scripts/agy-export.mjs`).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { outlineOf } from './parse.mjs';
import { listRecentConversations, loadConversation } from './session-loader.mjs';
import { detectLanguage, loadSummaryModels, summarizeWithModel } from './summarize.mjs';
import { detailLevel, renderDocument, renderImageHtml, THEMES } from './render.mjs';
import { autoFontSize, findChromium, renderPng } from './image.mjs';

export const IMAGE_PRESETS = [
  { id: 'phone', width: 640 },
  { id: 'tablet', width: 960 },
  { id: 'desktop', width: 1200 },
];
export const IMAGE_WIDTH = { min: 320, max: 2400, default: 640 };
export const FONT_SIZE = { min: 12, max: 48 };
const FORMATS = new Set(['markdown', 'html', 'image']);

export function expandHome(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function defaultDirectory(configuredDir) {
  const expanded = expandHome(configuredDir);
  if (expanded && isDirectory(expanded)) return expanded;
  const downloads = path.join(os.homedir(), 'Downloads');
  return isDirectory(downloads) ? downloads : os.homedir();
}

export function fileManagerKind() {
  if (process.platform === 'darwin') return 'finder';
  if (process.platform === 'win32') return 'explorer';
  return 'directory';
}

export function stemOf(title) {
  const stem =
    String(title || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'conversation';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${stem}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function intIn(value, range) {
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= range.min && num <= range.max ? num : undefined;
}

/** Select rounds & user/assistant parts based on `parts` or `rounds` filter. */
export function selectRounds(rounds, body = {}) {
  if (Array.isArray(body.parts)) {
    const byIndex = new Map();
    for (const part of body.parts) {
      if (!part || typeof part !== 'object' || !Number.isSafeInteger(part.index)) continue;
      byIndex.set(part.index, {
        user: part.user === true,
        assistant: part.assistant === true,
      });
    }
    return rounds
      .filter((round) => byIndex.has(round.index))
      .map((round) => ({ ...round, parts: byIndex.get(round.index) }))
      .filter(
        (round) =>
          (round.parts.user && round.prompt !== undefined) ||
          (round.parts.assistant && round.blocks.length > 0)
      );
  }

  if (Array.isArray(body.rounds)) {
    const wanted = new Set(body.rounds.filter((idx) => Number.isSafeInteger(idx)));
    const userOn = body.only !== 'assistant';
    const assistantOn = body.only !== 'user';
    return rounds
      .filter((round) => wanted.has(round.index))
      .map((round) => ({ ...round, parts: { user: userOn, assistant: assistantOn } }))
      .filter(
        (round) =>
          (round.parts.user && round.prompt !== undefined) ||
          (round.parts.assistant && round.blocks.length > 0)
      );
  }

  const userOn = body.only !== 'assistant';
  const assistantOn = body.only !== 'user';
  return rounds
    .map((round) => ({ ...round, parts: { user: userOn, assistant: assistantOn } }))
    .filter(
      (round) =>
        (round.parts.user && round.prompt !== undefined) ||
        (round.parts.assistant && round.blocks.length > 0)
    );
}

/** Write files to `directory` without overwriting existing files (`name.md`, `name (2).md`, ...). */
export async function writeUnique(directory, entries) {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const suffix = attempt === 1 ? '' : ` (${attempt})`;
    const targets = entries.map((entry) =>
      path.join(directory, entry.name.replace(/(\.[^.]+)$/, `${suffix}$1`))
    );
    if (targets.some((target) => fs.existsSync(target))) continue;
    const written = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        await fs.promises.writeFile(targets[i], entries[i].data, { flag: 'wx' });
        written.push(targets[i]);
      }
      return written;
    } catch (error) {
      for (const file of written) {
        await fs.promises.rm(file, { force: true });
      }
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('无法找到可用的未占用文件名 (Could not find a free file name)');
}

/** Get conversation outline + runtime capabilities for the Export UI. */
export async function getConversationOutline(conversationId, config = {}) {
  const session = await loadConversation(conversationId);
  const externalModels = loadSummaryModels().map((m) => ({
    provider: m.provider,
    model: m.model,
    label: m.label,
  }));
  const chromium = await findChromium(config.chromiumPath);

  return {
    sessionId: session.conversationId,
    title: session.title,
    surface: session.surface,
    isSubagent: session.isSubagent,
    subagentCount: session.subagentCount,
    models: session.models,
    rounds: session.rounds.map(outlineOf),
    summary: {
      // Thinking & tool summaries ALWAYS work in Antigravity via zero-token local extractive rules,
      // plus optional external LLM models when configured!
      available: true,
      hasExternalModels: externalModels.length > 0,
      models: externalModels,
      defaultModel: externalModels[0]
        ? { provider: externalModels[0].provider, model: externalModels[0].model }
        : null,
    },
    image: {
      available: chromium.available,
      reason: chromium.reason ?? null,
      presets: IMAGE_PRESETS,
      width: IMAGE_WIDTH,
      fontSize: FONT_SIZE,
      scale: config.imageScale ?? 2,
    },
    save: {
      available: true,
      defaultDirectory: defaultDirectory(config.saveDirectory),
      picker: process.platform === 'darwin' || process.platform === 'win32',
      fileManager: fileManagerKind(),
    },
  };
}

/** Render and either save to disk or return base64 payloads for browser download. */
export async function exportConversation(body, config = {}, signal) {
  const sessionId = String(body.sessionId || body.conversationId || '').trim();
  if (!sessionId) throw new Error('缺少会话 ID (Missing sessionId)');

  const format = body.format || 'markdown';
  if (!FORMATS.has(format)) {
    throw new Error('导出格式必须为 markdown、html 或 image');
  }

  const tools = detailLevel(body.tools);
  const thinking = detailLevel(body.thinking);
  const theme = THEMES.includes(body.theme) ? body.theme : 'paper';
  const timeZone =
    typeof body.timeZone === 'string' && body.timeZone.length < 64
      ? body.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const delivery = body.delivery === 'download' ? 'download' : 'save';
  const imageScale = config.imageScale ?? 2;
  const imageMaxHeight = Math.min(config.imageMaxHeight ?? 7500, Math.floor(16000 / imageScale));
  const maxDetailChars = config.maxDetailChars ?? 4000;

  let directory;
  if (delivery === 'save') {
    directory = expandHome(body.directory) ?? defaultDirectory(config.saveDirectory);
    if (!path.isAbsolute(directory) || !isDirectory(directory)) {
      throw new Error(`目标文件夹不存在：${directory}`);
    }
  }

  let width;
  let fontSize;
  if (format === 'image') {
    width =
      body.image?.width === undefined
        ? IMAGE_WIDTH.default
        : intIn(body.image.width, IMAGE_WIDTH);
    if (width === undefined) {
      throw new Error(`图片宽度必须在 ${IMAGE_WIDTH.min}–${IMAGE_WIDTH.max} px 之间`);
    }
    fontSize =
      body.image?.fontSize === undefined || body.image?.fontSize === null
        ? autoFontSize(width)
        : intIn(body.image.fontSize, FONT_SIZE);
    if (fontSize === undefined) {
      throw new Error(`字号必须在 ${FONT_SIZE.min}–${FONT_SIZE.max} px 之间`);
    }
  }

  const session = await loadConversation(sessionId);
  const selected = selectRounds(session.rounds, body);
  if (selected.length === 0) {
    throw new Error('请至少选择一条要导出的消息');
  }

  let chosenModelCfg;
  if (body.model && typeof body.model === 'object' && body.model.provider && body.model.model) {
    const available = loadSummaryModels();
    chosenModelCfg = available.find(
      (m) => m.provider === body.model.provider && m.model === body.model.model
    );
  }

  const lang = body.lang === 'zh' || body.lang === 'en' ? body.lang : detectLanguage(selected);
  let summaries = new Map();
  let failures = 0;

  if (chosenModelCfg && (tools === 'summary' || thinking === 'summary')) {
    const result = await summarizeWithModel({
      modelCfg: chosenModelCfg,
      language: lang,
      rounds: selected.filter((r) => r.parts.assistant),
      tools: tools === 'summary',
      reasoning: thinking === 'summary',
      concurrency: config.summaryConcurrency ?? 4,
      timeoutMs: config.summaryTimeoutMs ?? 90_000,
      signal,
    });
    summaries = result.summaries;
    failures = result.failures;
  }

  const doc = {
    title: session.title,
    sessionId: session.conversationId,
    exportedAt: Date.now(),
    models: session.models,
    rounds: selected,
  };
  const renderOpts = {
    format,
    tools,
    thinking,
    theme,
    lang,
    timeZone,
    summaries,
    maxDetailChars,
    fontSize,
  };
  const stem = stemOf(session.title);

  let entries;
  let compressed = null;
  if (format === 'image') {
    const pngRes = await renderPng(renderImageHtml(doc, renderOpts), {
      width,
      theme,
      scale: imageScale,
      maxHeight: imageMaxHeight,
      chromiumPath: config.chromiumPath,
      pythonPath: config.pythonPath,
      signal,
    });
    try {
      entries = await Promise.all(
        pngRes.files.map(async (file, i) => ({
          name:
            pngRes.files.length === 1
              ? `${stem}.png`
              : `${stem}-${String(i + 1).padStart(2, '0')}.png`,
          mime: 'image/png',
          data: await fs.promises.readFile(file),
        }))
      );
    } finally {
      await fs.promises.rm(pngRes.tempDir, { recursive: true, force: true });
    }
    compressed = pngRes.compressed;
  } else {
    const text = renderDocument(doc, renderOpts);
    entries = [
      {
        name: `${stem}.${format === 'html' ? 'html' : 'md'}`,
        mime: format === 'html' ? 'text/html' : 'text/markdown',
        data: Buffer.from(text, 'utf8'),
      },
    ];
  }

  const meta = {
    format,
    summaryFailures: failures,
    compressed,
    width: width ?? null,
    fontSize: fontSize ?? null,
  };

  if (delivery === 'save') {
    const written = await writeUnique(directory, entries);
    return {
      delivery,
      directory,
      files: written.map((file) => ({ name: path.basename(file), path: file })),
      ...meta,
    };
  }

  return {
    delivery,
    files: entries.map((entry) => ({
      name: entry.name,
      mime: entry.mime,
      base64: entry.data.toString('base64'),
    })),
    ...meta,
  };
}

/** Open or reveal an exported file in macOS Finder / Windows Explorer / Linux file manager. */
export function openSystemPath(target, action = 'open') {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = action === 'reveal' ? ['-R', target] : [target];
  } else if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = action === 'reveal' ? [`/select,${target}`] : [target];
  } else {
    command = 'xdg-open';
    args = [action === 'reveal' ? path.dirname(target) : target];
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000 }, (error) => {
      if (error && !(process.platform === 'win32' && error.code === 1)) reject(error);
      else resolve({ opened: true });
    });
  });
}

/** Open native OS directory chooser dialog (macOS AppleScript / Windows PowerShell). */
export function pickNativeFolder(initialDir, signal) {
  if (process.platform === 'darwin') {
    const safeDefault = initialDir && isDirectory(initialDir) ? initialDir : defaultDirectory();
    const escaped = safeDefault.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `POSIX path of (choose folder with prompt "选择对话导出保存文件夹" default location (POSIX file "${escaped}"))`;
    return new Promise((resolve) => {
      const child = execFile('osascript', ['-e', script], { timeout: 120_000 }, (err, stdout) => {
        if (err) {
          resolve({ path: null });
          return;
        }
        const chosen = String(stdout || '').trim().replace(/\/+$/, '') || '/';
        resolve({ path: chosen });
      });
      signal?.addEventListener('abort', () => child.kill(), { once: true });
    });
  }

  if (process.platform === 'win32') {
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq "OK") { Write-Output $f.SelectedPath }';
    return new Promise((resolve) => {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', ps],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) return resolve({ path: null });
          const chosen = String(stdout || '').trim();
          resolve({ path: chosen || null });
        }
      );
      signal?.addEventListener('abort', () => child.kill(), { once: true });
    });
  }

  return Promise.resolve({ unsupported: true, path: null });
}

export { listRecentConversations };
