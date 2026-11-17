/**
 * @fileoverview Multi-source session catalog and trajectory loader for Antigravity
 * (both Antigravity.app Desktop and `agy` TUI CLI).
 *
 * Read-only data sources (never mutates conversation state):
 * 1. `conversation_summaries.db` (App + CLI SQLite index) + `annotations/<id>.pbtxt`
 * 2. Live Language Server Connect RPC (`GetAllCascadeTrajectories`, `GetCascadeTrajectory`, `GetUserStatus`)
 * 3. `brain/<id>/.system_generated/logs/transcript_full.jsonl` & `transcript.jsonl`
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { foldSteps, normalizeRpcStep, preview } from './parse.mjs';

const HOME = homedir();
const AGY_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR
  ? join(HOME, '.gemini', process.env.ANTIGRAVITY_APP_DATA_DIR)
  : join(HOME, '.gemini', 'antigravity');
const AGY_CLI_DIR = join(HOME, '.gemini', 'antigravity-cli');

const KNOWN_MODEL_LABELS = {
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon (Medium)',
  MODEL_PLACEHOLDER_M419: 'Gemini 4 Argon (Low)',
  MODEL_PLACEHOLDER_M420: 'Gemini 4 Carbon (High)',
  MODEL_PLACEHOLDER_M421: 'Gemini 4 Carbon (Medium)',
  MODEL_PLACEHOLDER_M422: 'Gemini 4 Carbon (Low)',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
  MODEL_PLACEHOLDER_M322: 'Gemini 3.8 Flash (Tiered)',
  MODEL_PLACEHOLDER_M132: 'Gemini 3.5 Flash (High)',
  MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5 (Low)',
  MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5 (Medium)',
  MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5 (High)',
  MODEL_PLACEHOLDER_M403: 'Claude Sonnet 5.5 (Low)',
  MODEL_PLACEHOLDER_M404: 'Claude Sonnet 5.5 (Medium)',
  MODEL_PLACEHOLDER_M405: 'Claude Sonnet 5.5 (High)',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)',
};

let modelLabelLoadedAt = 0;

/** Discover active Language Server HTTP address + CSRF token if running. */
export function discoverLanguageServer() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      address: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  for (const root of [AGY_DIR, AGY_CLI_DIR]) {
    const daemonDir = join(root, 'daemon');
    if (!existsSync(daemonDir)) continue;
    try {
      const files = readdirSync(daemonDir)
        .filter((f) => f.startsWith('hub_') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files) {
        const raw = JSON.parse(readFileSync(join(daemonDir, f), 'utf-8'));
        if (raw.httpPort && raw.csrfToken) {
          return {
            address: `127.0.0.1:${raw.httpPort}`,
            csrfToken: raw.csrfToken,
          };
        }
      }
    } catch {
      // Ignore daemon discovery errors
    }
  }
  return null;
}

/** Call a read-only method on `exa.language_server_pb.LanguageServerService`. */
export async function lsrpc(method, body = {}, timeoutMs = 3000) {
  const ls = discoverLanguageServer();
  if (!ls) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `http://${ls.address}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': ls.csrfToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureModelLabels() {
  if (Date.now() - modelLabelLoadedAt < 60_000) return;
  modelLabelLoadedAt = Date.now();
  const resp = await lsrpc('GetUserStatus', {}, 2000);
  const configs = resp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  for (const c of configs) {
    const modelEnum = c.modelOrAlias?.model || '';
    if (modelEnum && c.label) KNOWN_MODEL_LABELS[modelEnum] = c.label;
    if (c.modelId && c.label) KNOWN_MODEL_LABELS[c.modelId] = c.label;
  }
}

export function formatModelName(raw) {
  if (!raw) return '';
  return KNOWN_MODEL_LABELS[raw] || raw;
}

/** Decode octal/escaped UTF-8 title from `annotations/<id>.pbtxt`. */
function readAnnotationTitle(conversationId) {
  for (const root of [AGY_DIR, AGY_CLI_DIR]) {
    const p = join(root, 'annotations', `${conversationId}.pbtxt`);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf-8');
      const m = text.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      const raw = m[1];
      const bytes = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '\\' && i + 3 < raw.length && /^[0-7]{3}$/.test(raw.slice(i + 1, i + 4))) {
          bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
          i += 3;
        } else if (raw[i] === '\\' && i + 1 < raw.length) {
          i += 1;
          bytes.push(raw.charCodeAt(i));
        } else {
          for (const b of Buffer.from(raw[i], 'utf-8')) bytes.push(b);
        }
      }
      const decoded = Buffer.from(bytes).toString('utf-8').trim();
      if (decoded) return decoded;
    } catch {
      // Ignore malformed pbtxt
    }
  }
  return '';
}

/** Build full conversation catalog from SQLite summaries + live RPC + brain directories. */
export async function getConversationCatalog() {
  const map = new Map();

  for (const [surface, root] of [
    ['cli', AGY_CLI_DIR],
    ['app', AGY_DIR],
  ]) {
    const sumDbPath = join(root, 'conversation_summaries.db');
    if (!existsSync(sumDbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(sumDbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris,
                  status, source, agent_name, parent_conversation_id, nesting_depth, app_data_dir
           FROM conversation_summaries
           ORDER BY last_modified_time DESC`
        )
        .all();
      for (const r of rows) {
        const appDir = String(r.app_data_dir || '');
        const resolvedSurface = appDir.includes('cli') ? 'cli' : surface;
        map.set(r.conversation_id, {
          conversationId: r.conversation_id,
          title: r.title || readAnnotationTitle(r.conversation_id) || '',
          stepCount: Number(r.step_count || 0),
          lastModifiedTime: r.last_modified_time || '',
          workspaceUris: r.workspace_uris ? r.workspace_uris.split(',').filter(Boolean) : [],
          status: r.status || '',
          surface: resolvedSurface,
          agentName: r.agent_name || '',
          subagentRole: '',
          parentConversationId: r.parent_conversation_id || '',
          nestingDepth: Number(r.nesting_depth || 0),
          childIds: [],
        });
      }
    } catch {
      // Ignore SQLite errors
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  // Enrich with live Language Server trajectories
  const rpcAll = await lsrpc('GetAllCascadeTrajectories', {}, 2500);
  const summaries = rpcAll?.trajectorySummaries || {};
  for (const [cid, item] of Object.entries(summaries)) {
    const meta = item.trajectoryMetadata || {};
    const existing = map.get(cid) || {
      conversationId: cid,
      title: '',
      stepCount: 0,
      lastModifiedTime: '',
      workspaceUris: [],
      status: '',
      surface: 'app',
      agentName: '',
      subagentRole: '',
      parentConversationId: '',
      nestingDepth: 0,
      childIds: [],
    };
    existing.title =
      item.summary ||
      existing.title ||
      readAnnotationTitle(cid) ||
      meta.subagentSpec?.role ||
      '';
    existing.stepCount = Math.max(existing.stepCount, Number(item.stepCount || 0));
    existing.lastModifiedTime = item.lastModifiedTime || existing.lastModifiedTime;
    existing.workspaceUris = meta.workspaceUris || existing.workspaceUris;
    existing.status = item.status || existing.status;
    existing.agentName = meta.subagentSpec?.typeName || existing.agentName;
    existing.subagentRole = meta.subagentSpec?.role || existing.subagentRole;
    existing.parentConversationId = meta.parentConversationId || existing.parentConversationId;
    if (meta.nestingDepth !== undefined) existing.nestingDepth = Number(meta.nestingDepth);
    map.set(cid, existing);
  }

  // Fallback scan of brain directories for any unindexed conversations
  for (const [surface, root] of [
    ['app', AGY_DIR],
    ['cli', AGY_CLI_DIR],
  ]) {
    const brainDir = join(root, 'brain');
    if (!existsSync(brainDir)) continue;
    try {
      for (const cid of readdirSync(brainDir)) {
        if (!/^[0-9a-f-]{20,}$/i.test(cid) || map.has(cid)) continue;
        const logDir = join(brainDir, cid, '.system_generated', 'logs');
        const fullLog = join(logDir, 'transcript_full.jsonl');
        const compactLog = join(logDir, 'transcript.jsonl');
        const target = existsSync(fullLog) ? fullLog : existsSync(compactLog) ? compactLog : null;
        if (!target) continue;
        const st = statSync(target);
        map.set(cid, {
          conversationId: cid,
          title: readAnnotationTitle(cid) || '',
          stepCount: 0,
          lastModifiedTime: st.mtime.toISOString(),
          workspaceUris: [],
          status: '',
          surface,
          agentName: '',
          subagentRole: '',
          parentConversationId: '',
          nestingDepth: 0,
          childIds: [],
        });
      }
    } catch {}
  }

  for (const entry of map.values()) {
    if (entry.parentConversationId && map.has(entry.parentConversationId)) {
      const parent = map.get(entry.parentConversationId);
      if (!parent.childIds.includes(entry.conversationId)) {
        parent.childIds.push(entry.conversationId);
      }
    }
  }

  return map;
}

/**
 * List recent sessions for UI dropdown and CLI `--list`.
 * @param {{ limit?: number, includeSubagents?: boolean }} [opts]
 */
export async function listRecentConversations({ limit = 80, includeSubagents = false } = {}) {
  const catalog = await getConversationCatalog();
  const list = [...catalog.values()]
    .filter((item) => {
      if (item.stepCount === 0 && !findTranscriptFiles(item.conversationId).any) return false;
      if (!includeSubagents && (item.parentConversationId || item.nestingDepth > 0)) return false;
      return true;
    })
    .sort((a, b) => String(b.lastModifiedTime).localeCompare(String(a.lastModifiedTime)))
    .slice(0, limit);

  return list.map((item) => ({
    conversationId: item.conversationId,
    title: item.title || item.subagentRole || item.conversationId.slice(0, 8),
    stepCount: item.stepCount,
    lastModifiedTime: item.lastModifiedTime,
    surface: item.surface,
    isSubagent: Boolean(item.parentConversationId || item.nestingDepth > 0),
    subagentRole: item.subagentRole || item.agentName || '',
    parentConversationId: item.parentConversationId || '',
    subagentCount: item.childIds.length,
    workspaceUris: item.workspaceUris,
  }));
}

function findTranscriptFiles(conversationId) {
  for (const root of [AGY_DIR, AGY_CLI_DIR]) {
    const logDir = join(root, 'brain', conversationId, '.system_generated', 'logs');
    const full = join(logDir, 'transcript_full.jsonl');
    const compact = join(logDir, 'transcript.jsonl');
    if (existsSync(full) || existsSync(compact)) {
      return {
        full: existsSync(full) ? full : null,
        compact: existsSync(compact) ? compact : null,
        any: existsSync(full) ? full : compact,
      };
    }
  }
  return { full: null, compact: null, any: null };
}

function readJsonlSteps(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const steps = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      steps.push(JSON.parse(trimmed));
    } catch {
      // Skip incomplete trailing line if actively being written
    }
  }
  return steps;
}

/**
 * Load and fold a conversation by ID across `transcript_full.jsonl`, `GetCascadeTrajectory` RPC,
 * and `transcript.jsonl`.
 * @param {string} conversationId
 */
export async function loadConversation(conversationId) {
  await ensureModelLabels();
  const catalog = await getConversationCatalog();
  const meta = catalog.get(conversationId);

  const files = findTranscriptFiles(conversationId);
  let steps = [];

  if (files.full) {
    steps = readJsonlSteps(files.full);
  } else if (files.compact) {
    steps = readJsonlSteps(files.compact);
  }

  // Check live RPC if local transcript is missing OR to capture brand-new live steps & generator models
  let rpcModels = [];
  const rpcResp = await lsrpc('GetCascadeTrajectory', { cascadeId: conversationId }, 3500);
  const rpcTraj = rpcResp?.trajectory;
  if (rpcTraj) {
    const genMeta = Array.isArray(rpcTraj.generatorMetadata) ? rpcTraj.generatorMetadata : [];
    for (const gm of genMeta) {
      const m =
        gm?.chatModel?.usage?.responseModel ||
        gm?.chatModel?.usage?.model ||
        gm?.chatModel?.model;
      if (m) rpcModels.push(formatModelName(m));
    }
    const rpcSteps = Array.isArray(rpcTraj.steps) ? rpcTraj.steps : [];
    if (steps.length === 0 && rpcSteps.length > 0) {
      steps = rpcSteps.map((s, idx) => normalizeRpcStep(s, idx)).filter(Boolean);
    } else if (rpcSteps.length > steps.length) {
      // Append any completed tail steps not yet flushed to transcript_full.jsonl
      const maxExistingIdx = steps.reduce(
        (max, s) => Math.max(max, Number.isFinite(Number(s.step_index)) ? Number(s.step_index) : -1),
        -1
      );
      for (let idx = maxExistingIdx + 1; idx < rpcSteps.length; idx++) {
        const s = rpcSteps[idx];
        if (s?.status && !String(s.status).endsWith('DONE') && !String(s.status).endsWith('ERROR')) {
          continue;
        }
        const norm = normalizeRpcStep(s, idx);
        if (norm) steps.push(norm);
      }
    }
  }

  if (steps.length === 0 && !meta) {
    const err = new Error(`未找到会话 (Conversation not found): ${conversationId}`);
    err.status = 404;
    throw err;
  }

  const folded = foldSteps(steps);
  const models = [];
  for (const m of [...rpcModels, ...folded.detectedModels.map(formatModelName)]) {
    if (m && !models.includes(m)) models.push(m);
  }

  const firstPrompt = folded.rounds.find((r) => r.prompt?.text)?.prompt.text;
  const rawTitle =
    meta?.title ||
    readAnnotationTitle(conversationId) ||
    meta?.subagentRole ||
    (firstPrompt ? preview(firstPrompt, 60) : '') ||
    conversationId;

  return {
    conversationId,
    title: rawTitle.trim() || conversationId,
    surface: meta?.surface || 'app',
    isSubagent: Boolean(meta?.parentConversationId || (meta?.nestingDepth ?? 0) > 0),
    subagentCount: meta?.childIds?.length ?? 0,
    models,
    rounds: folded.rounds,
  };
}
