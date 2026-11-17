/**
 * @fileoverview Sidecar backend server for Antigravity Conversation Export.
 * Runs inside Antigravity's sidecar host via `sidecar_sdk`, with standalone HTTP fallback for testing.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  exportConversation,
  getConversationOutline,
  listRecentConversations,
  openSystemPath,
  pickNativeFolder,
} from '../../lib/exporter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = join(__dirname, 'ui', 'index.html');
const CONFIG_PATH = join(homedir(), '.gemini', 'config', 'conversation-export.json');

function loadUserConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const sdkPath = join(
      homedir(),
      '.gemini',
      'antigravity',
      'lib',
      'node_modules',
      'sidecar_sdk',
      'index.mjs'
    );
    return await import(pathToFileURL(sdkPath).href);
  }
}

function createHandlers(getDefaultConvId) {
  const savedPaths = new Set();
  const trackSaved = (p) => {
    if (!p) return;
    savedPaths.add(p);
    while (savedPaths.size > 500) {
      savedPaths.delete(savedPaths.values().next().value);
    }
  };

  return {
    async sessions(data = {}) {
      const limit = Number(data.limit || 80);
      const includeSubagents =
        data.includeSubagents === true || data.includeSubagents === 'true';
      const sessions = await listRecentConversations({ limit, includeSubagents });
      return {
        defaultConversationId:
          getDefaultConvId() || sessions[0]?.conversationId || '',
        sessions,
      };
    },

    async outline(data = {}) {
      const sessionId = String(
        data.sessionId || data.conversationId || getDefaultConvId() || ''
      ).trim();
      if (!sessionId) {
        throw new Error('未指定会话 ID (No active conversation found)');
      }
      return await getConversationOutline(sessionId, loadUserConfig());
    },

    async render(data = {}) {
      const result = await exportConversation(data, loadUserConfig());
      if (result.delivery === 'save') {
        if (result.directory) trackSaved(result.directory);
        for (const f of result.files || []) {
          trackSaved(f.path);
        }
      }
      return result;
    },

    async open(data = {}) {
      const target = typeof data.path === 'string' ? data.path : '';
      const action = data.action === 'reveal' ? 'reveal' : 'open';
      if (!savedPaths.has(target)) {
        throw new Error('仅允许打开本次导出生成的文件');
      }
      if (!existsSync(target)) {
        throw new Error(`文件已不存在：${target}`);
      }
      return await openSystemPath(target, action);
    },

    async pick(data = {}) {
      const initialDir = typeof data.directory === 'string' ? data.directory : undefined;
      return await pickNativeFolder(initialDir);
    },
  };
}

async function runStandalone(port) {
  const handlers = createHandlers(() => process.env.ANTIGRAVITY_CONVERSATION_ID || '');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(UI_HTML_PATH, 'utf-8'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('window.sidecar = { conversationId: "", fetch: (u, o) => fetch(u, o) };');
      return;
    }
    const routeName = url.pathname.replace(/^\/api\//, '');
    if (Object.hasOwn(handlers, routeName)) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
          const out = await handlers[routeName](payload);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[conversation-export] standalone listening on http://127.0.0.1:${port}`);
  });
}

async function main() {
  if (
    process.env.STANDALONE_PORT &&
    !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
  ) {
    await runStandalone(Number(process.env.STANDALONE_PORT));
    return;
  }

  const { SidecarApp } = await loadSidecarSdk();
  const app = new SidecarApp();
  const handlers = createHandlers(() => app.config.conversationId || '');

  app.page('/', () => readFileSync(UI_HTML_PATH, 'utf-8'));

  app.api('/api/sessions', handlers.sessions, 'POST');
  app.api('/api/sessions', handlers.sessions, 'GET');

  app.api('/api/outline', handlers.outline, 'POST');
  app.api('/api/outline', handlers.outline, 'GET');

  app.api('/api/render', handlers.render, 'POST');
  app.api('/api/open', handlers.open, 'POST');
  app.api('/api/pick', handlers.pick, 'POST');

  await app.run();
}

main().catch((err) => {
  console.error('[conversation-export-sidecar] Fatal error:', err);
  process.exit(1);
});
