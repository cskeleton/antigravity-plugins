/**
 * @fileoverview Sidecar backend server for Antigravity Model Details & Token Usage.
 * Runs inside Antigravity's sidecar host via `sidecar_sdk`, or standalone for local testing.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fetchModelQuotas,
  getFullSessionReport,
  listRecentSessions,
} from '../../lib/stats-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = join(__dirname, 'ui', 'index.html');

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

async function main() {
  const { SidecarApp } = await loadSidecarSdk();
  const app = new SidecarApp();

  // Serve Dashboard SPA
  app.page('/', () => readFileSync(UI_HTML_PATH, 'utf-8'));

  // API: List recent root conversations (with nested subagent info)
  const handleSessions = async (data) => {
    const limit = Number(data?.limit || 40);
    const sessions = await listRecentSessions(limit);
    return {
      defaultConversationId: app.config.conversationId || sessions[0]?.conversationId || '',
      sessions,
    };
  };
  app.api('/api/sessions', handleSessions, 'POST');
  app.api('/api/sessions', handleSessions, 'GET');

  // API: Full multi-level session report (latest turn, context window, total/main/subagent hierarchy, calls)
  const handleReport = async (data) => {
    const targetId =
      data?.conversationId || app.config.conversationId || undefined;
    return await getFullSessionReport(targetId);
  };
  app.api('/api/report', handleReport, 'POST');
  app.api('/api/report', handleReport, 'GET');

  // API: Model quotas
  const handleQuotas = async () => {
    return await fetchModelQuotas();
  };
  app.api('/api/quotas', handleQuotas, 'POST');
  app.api('/api/quotas', handleQuotas, 'GET');

  await app.run();
}

main().catch((err) => {
  console.error('[model-details-sidecar] Fatal error:', err);
  process.exit(1);
});
