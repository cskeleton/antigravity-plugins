/**
 * @fileoverview Retina PNG export via headless Chromium (`playwright-core`):
 * - Renders static page at 2x deviceScaleFactor.
 * - Splits tall conversations (> `maxHeight` CSS px) cleanly at block boundaries
 *   with `1 / N` page footers so every image stays under iOS's 16,384px limit.
 * - Shrinks PNG size by ~70% via `compress_png.py` (neutral themes: paper/ink)
 *   or `quantize_png.py` (tinted/accented themes: sepia/night/google/antigravity) when Python + Pillow + numpy exist.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPRESSOR = fileURLToPath(new URL('../assets/compress_png.py', import.meta.url));
const QUANTIZER = fileURLToPath(new URL('../assets/quantize_png.py', import.meta.url));
const NEUTRAL_THEMES = new Set(['paper', 'ink']);

let playwright;
async function loadChromium() {
  playwright ??= await import('playwright-core');
  return playwright.chromium;
}

function playwrightCacheDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const home = os.homedir();
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') {
    dirs.push(
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright')
    );
  } else dirs.push(path.join(home, '.cache', 'ms-playwright'));
  return dirs;
}

function cachedChromiums() {
  const found = [];
  for (const dir of playwrightCacheDirs()) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name);
      if (!match) continue;
      const root = path.join(dir, name);
      const candidates =
        match[1] === 'chromium_headless_shell'
          ? [
              'chrome-headless-shell-mac-arm64/chrome-headless-shell',
              'chrome-headless-shell-mac-x64/chrome-headless-shell',
              'chrome-headless-shell-linux64/chrome-headless-shell',
              'chrome-headless-shell-win64/chrome-headless-shell.exe',
            ]
          : [
              'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
              'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
              'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
              'chrome-linux64/chrome',
              'chrome-linux/chrome',
              'chrome-win64/chrome.exe',
              'chrome-win/chrome.exe',
            ];
      for (const relative of candidates) {
        const file = path.join(root, relative);
        if (fs.existsSync(file)) {
          found.push({
            file,
            revision: Number(match[2]),
            shell: match[1] === 'chromium_headless_shell',
          });
        }
      }
    }
  }
  return found
    .sort((a, b) => b.revision - a.revision || Number(b.shell) - Number(a.shell))
    .map((entry) => entry.file);
}

function systemBrowsers() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

let resolvedLaunch;

export async function findChromium(configured) {
  const chromium = await loadChromium().catch(() => undefined);
  if (chromium === undefined) {
    return { available: false, reason: 'playwright-core 未安装' };
  }
  if (configured && fs.existsSync(configured)) {
    return { available: true, executablePath: configured };
  }
  let own;
  try {
    own = chromium.executablePath();
  } catch {}
  if (own && fs.existsSync(own)) {
    return { available: true, executablePath: undefined };
  }
  const fallback = [...cachedChromiums(), ...systemBrowsers()].find((file) => fs.existsSync(file));
  if (fallback) return { available: true, executablePath: fallback };
  return {
    available: false,
    reason: '未找到可用的 Chromium 或 Chrome 浏览器（可运行 npx playwright install chromium 安装）',
  };
}

async function launchBrowser(configured) {
  const chromium = await loadChromium();
  const args = ['--disable-lcd-text'];
  if (resolvedLaunch !== undefined) {
    return chromium.launch({ headless: true, args, executablePath: resolvedLaunch });
  }
  const first = await findChromium(configured);
  if (!first.available) throw new Error(first.reason);
  const tries = [first.executablePath, ...cachedChromiums(), ...systemBrowsers()].filter(
    (file, i, all) => all.indexOf(file) === i
  );
  let lastError;
  for (const executablePath of tries) {
    if (executablePath !== undefined && !fs.existsSync(executablePath)) continue;
    try {
      const browser = await chromium.launch({ headless: true, args, executablePath });
      resolvedLaunch = executablePath;
      return browser;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Chromium 启动失败');
}

function runExec(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error) => resolve(error === null));
  });
}

let pythonForCompression;

function pythonCandidates(configured) {
  const list = [];
  if (configured) list.push(configured);
  list.push(
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
    'python'
  );
  return list.filter((file, i, all) => all.indexOf(file) === i);
}

async function compressPngFiles(files, configured, theme) {
  const script = NEUTRAL_THEMES.has(theme) ? COMPRESSOR : QUANTIZER;
  if (pythonForCompression === null) return false;
  const candidates = pythonForCompression ? [pythonForCompression] : pythonCandidates(configured);
  for (const python of candidates) {
    if (path.isAbsolute(python) && !fs.existsSync(python)) continue;
    if (!(await runExec(python, ['-c', 'import numpy, PIL'], 15000))) continue;
    pythonForCompression = python;
    for (const file of files) {
      await runExec(python, [script, file, file], 120000);
    }
    return true;
  }
  pythonForCompression = null;
  return false;
}

/** Auto font size: 24px at 640px width, easing smoothly to 16px at 1200px+. */
export function autoFontSize(width) {
  const value = 24 - ((width - 640) * 8) / 560;
  return Math.round(Math.min(24, Math.max(16, value)));
}

export async function renderPng(html, options) {
  const { width, scale = 2, maxHeight = 7500, signal } = options;
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agy-conversation-export-')
  );
  const htmlPath = path.join(tempDir, 'document.html');
  await fs.promises.writeFile(htmlPath, html, 'utf8');
  const browser = await launchBrowser(options.chromiumPath);
  const abort = () => browser.close().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const context = await browser.newContext({
      viewport: { width, height: 100 },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });

    const layout = await page.evaluate(() => {
      const flow = document.getElementById('content-flow');
      const flowTop = flow.getBoundingClientRect().top;
      const flowHeight = Math.ceil(flow.getBoundingClientRect().height);
      const totalDocHeight = Math.ceil(document.documentElement.scrollHeight);
      const selector =
        '#content-flow > *, .msg > *, .markdown-body > *, .timeline > *, .activity > *';
      const splits = [];
      for (const el of document.querySelectorAll(selector)) {
        if (
          /^H[1-6]$/.test(el.tagName) ||
          el.classList.contains('msg-label') ||
          el.classList.contains('activity-head')
        ) {
          continue;
        }
        const next = el.nextElementSibling;
        const rect = el.getBoundingClientRect();
        const endY = Math.ceil(rect.bottom - flowTop);
        const nextStartY = next
          ? Math.max(endY, Math.floor(next.getBoundingClientRect().top - flowTop))
          : endY;
        if (endY > 0 && endY < flowHeight) splits.push({ endY, nextStartY });
      }
      splits.sort((a, b) => a.endY - b.endY);
      return { flowHeight, totalDocHeight, splits };
    });

    const stem = path.join(tempDir, 'page');
    const files = [];

    if (layout.totalDocHeight <= maxHeight) {
      const file = `${stem}.png`;
      await page.screenshot({ path: file, fullPage: true, type: 'png' });
      files.push(file);
    } else {
      const hardBudget = maxHeight - 160;
      const numPagesTarget = Math.ceil(layout.flowHeight / (hardBudget * 0.94));
      const slices = [];
      let y = 0;
      while (y < layout.flowHeight) {
        const remaining = layout.flowHeight - y;
        if (remaining <= hardBudget) {
          slices.push({ start: y, end: layout.flowHeight });
          break;
        }
        const pagesLeft = Math.max(2, numPagesTarget - slices.length);
        const idealTarget = y + Math.ceil(remaining / pagesLeft);
        const hardTarget = Math.min(y + hardBudget, layout.flowHeight);
        const valid = layout.splits.filter(
          (s) => s.endY > y + Math.min(600, hardBudget / 3) && s.endY <= hardTarget
        );
        let chosen = { endY: hardTarget, nextStartY: hardTarget };
        if (valid.length > 0) {
          const feasible = valid.filter(
            (s) => layout.flowHeight - s.nextStartY <= (pagesLeft - 1) * hardBudget
          );
          const pool = feasible.length > 0 ? feasible : valid;
          chosen = pool.reduce(
            (best, cur) =>
              Math.abs(cur.endY - idealTarget) < Math.abs(best.endY - idealTarget) ? cur : best,
            pool[0]
          );
        }
        slices.push({ start: y, end: chosen.endY });
        y = chosen.nextStartY;
      }

      for (let i = 0; i < slices.length; i++) {
        signal?.throwIfAborted?.();
        const slice = slices[i];
        const pageCssHeight = await page.evaluate(
          ({ start, sliceHeight, label }) => {
            const sheet = document.querySelector('.page');
            const flow = document.getElementById('content-flow');
            let box = document.getElementById('slice-viewport');
            if (!box) {
              box = document.createElement('div');
              box.id = 'slice-viewport';
              box.style.overflow = 'hidden';
              box.style.width = '100%';
              flow.parentNode.insertBefore(box, flow);
              box.appendChild(flow);
            }
            box.style.height = `${sliceHeight}px`;
            flow.style.transform = `translateY(-${start}px)`;
            document.getElementById('page-footer').style.display = 'block';
            document.getElementById('page-num-label').textContent = label;
            return Math.ceil(sheet.getBoundingClientRect().height);
          },
          {
            start: slice.start,
            sliceHeight: slice.end - slice.start,
            label: `${i + 1} / ${slices.length}`,
          }
        );
        await page.setViewportSize({ width, height: pageCssHeight });
        const file = `${stem}-${String(i + 1).padStart(2, '0')}.png`;
        await page.screenshot({ path: file, type: 'png' });
        files.push(file);
      }
    }

    await context.close();
    const compressed = await compressPngFiles(files, options.pythonPath, options.theme ?? 'paper');
    return { files, cssHeight: layout.totalDocHeight, pages: files.length, compressed, tempDir };
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}
