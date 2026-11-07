/**
 * @fileoverview Core data collection, decoding, and aggregation engine for
 * Antigravity Model Details & Usage Statistics (`antigravity-model-details`).
 *
 * Supports multi-tier read-only data retrieval:
 *   Tier 1: Language Server Connect RPC (`GetCascadeTrajectoryGeneratorMetadata`, `GetAllCascadeTrajectories`, `GetUserStatus`)
 *   Tier 2: Local read-only SQLite (`~/.gemini/antigravity/conversations/<id>.db`, `conversation_summaries.db`)
 *   Tier 3: Local conversation transcript (`~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeGeneratorMetadataBlob } from './proto-lite.mjs';

const HOME = homedir();
const AGY_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR
  ? join(HOME, '.gemini', process.env.ANTIGRAVITY_APP_DATA_DIR)
  : join(HOME, '.gemini', 'antigravity');
const AGY_CLI_DIR = join(HOME, '.gemini', 'antigravity-cli');

/** Known fallback display names for internal model enums / responseModel IDs */
const KNOWN_MODEL_LABELS = {
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon (Medium)',
  MODEL_PLACEHOLDER_M419: 'Gemini 4 Argon (Low)',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
  MODEL_PLACEHOLDER_M322: 'Gemini 3.8 Flash (Tiered)',
  MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5 (Low)',
  MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5 (Medium)',
  MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5 (High)',
  MODEL_PLACEHOLDER_M403: 'Claude Sonnet 5.5 (Low)',
  MODEL_PLACEHOLDER_M404: 'Claude Sonnet 5.5 (Medium)',
  MODEL_PLACEHOLDER_M405: 'Claude Sonnet 5.5 (High)',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)',
};

/**
 * Discovers Language Server address and CSRF token from environment or daemon file.
 * @returns {{ address: string, csrfToken: string } | null}
 */
export function discoverLanguageServer() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      address: process.env.ANTIGRAVITY_LS_ADDRESS,
      csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  const daemonDir = join(AGY_DIR, 'daemon');
  if (existsSync(daemonDir)) {
    try {
      const files = readdirSync(daemonDir).filter((f) => f.startsWith('hub_') && f.endsWith('.json'));
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

/**
 * Calls a method on `exa.language_server_pb.LanguageServerService`.
 * @param {string} method
 * @param {object} body
 * @param {number} [timeoutMs=2500]
 * @returns {Promise<object | null>}
 */
export async function lsrpc(method, body = {}, timeoutMs = 2500) {
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

/**
 * Reads annotation title from `~/.gemini/antigravity(-cli)/annotations/<id>.pbtxt` if present.
 * @param {string} conversationId
 * @returns {string}
 */
function readAnnotationTitle(conversationId) {
  const candidates = [
    join(AGY_DIR, 'annotations', `${conversationId}.pbtxt`),
    join(AGY_CLI_DIR, 'annotations', `${conversationId}.pbtxt`),
  ];
  const p = candidates.find((c) => existsSync(c));
  if (!p) return '';
  try {
    const text = readFileSync(p, 'utf-8');
    const m = text.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    // Decode octal escapes (\346\217\222) or standard escapes in pbtxt
    const raw = m[1];
    const bytes = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\' && i + 3 < raw.length && /^[0-7]{3}$/.test(raw.slice(i + 1, i + 4))) {
        bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
        i += 3;
      } else if (raw[i] === '\\' && i + 1 < raw.length) {
        i++;
        bytes.push(raw.charCodeAt(i));
      } else {
        const codeBytes = Buffer.from(raw[i], 'utf-8');
        for (const b of codeBytes) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Fetches model quota and configuration info from `GetUserStatus`.
 * @returns {Promise<{ models: Array<object>, userTier: string | null }>}
 */
export async function fetchModelQuotas() {
  const resp = await lsrpc('GetUserStatus', {});
  const status = resp?.userStatus;
  const configs = status?.cascadeModelConfigData?.clientModelConfigs || [];
  const models = configs.map((c) => {
    const modelEnum = c.modelOrAlias?.model || '';
    if (modelEnum && c.label) {
      KNOWN_MODEL_LABELS[modelEnum] = c.label;
    }
    const rem = c.quotaInfo?.remainingFraction;
    const resetTime = c.quotaInfo?.resetTime || null;
    return {
      label: c.label || c.modelId || modelEnum,
      modelId: c.modelId || '',
      modelEnum,
      tagTitle: c.tagTitle || null,
      tagDescription: c.tagDescription || null,
      remainingFraction: typeof rem === 'number' ? rem : null,
      remainingPercent: typeof rem === 'number' ? Math.round(rem * 1000) / 10 : null,
      resetTime,
    };
  });
  return {
    models,
    userTier: status?.userTier || null,
  };
}

/**
 * Lists all conversations and builds parent/subagent linkage from RPC + `conversation_summaries.db`.
 * @returns {Promise<Map<string, object>>}
 */
export async function getConversationCatalog() {
  const map = new Map();

  // 1. Read from both App and CLI conversation_summaries.db (contains CLI + App sessions and fast indexed fields)
  const summaryDbPaths = [
    join(AGY_CLI_DIR, 'conversation_summaries.db'),
    join(AGY_DIR, 'conversation_summaries.db'),
  ];
  for (const sumDbPath of summaryDbPaths) {
    if (!existsSync(sumDbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(sumDbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris,
                  status, source, project_id, agent_name, parent_conversation_id,
                  nesting_depth, last_user_input_time, last_user_input_step_index, app_data_dir
           FROM conversation_summaries
           ORDER BY last_modified_time DESC`
        )
        .all();
      for (const r of rows) {
        map.set(r.conversation_id, {
          conversationId: r.conversation_id,
          title: r.title || readAnnotationTitle(r.conversation_id) || '',
          stepCount: Number(r.step_count || 0),
          lastModifiedTime: r.last_modified_time || '',
          workspaceUris: r.workspace_uris ? r.workspace_uris.split(',').filter(Boolean) : [],
          status: r.status || '',
          source: r.source || '',
          projectId: r.project_id || '',
          agentName: r.agent_name || '',
          subagentRole: '',
          subagentModel: '',
          parentConversationId: r.parent_conversation_id || '',
          rootConversationId: '',
          nestingDepth: Number(r.nesting_depth || 0),
          lastUserInputTime: r.last_user_input_time || '',
          lastUserInputStepIndex: Number(r.last_user_input_step_index ?? -1),
          appDataDir: r.app_data_dir || 'antigravity',
          childIds: [],
        });
      }
    } catch {
      // Ignore SQLite summary error
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  // 2. Enrich with live `GetAllCascadeTrajectories` RPC (has subagentSpec role, live stepCount, rootConversationId)
  const rpcAll = await lsrpc('GetAllCascadeTrajectories', {});
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
      source: '',
      projectId: '',
      agentName: '',
      subagentRole: '',
      subagentModel: '',
      parentConversationId: '',
      rootConversationId: '',
      nestingDepth: 0,
      lastUserInputTime: '',
      lastUserInputStepIndex: -1,
      appDataDir: 'antigravity',
      childIds: [],
    };

    const title =
      item.summary ||
      existing.title ||
      readAnnotationTitle(cid) ||
      meta.subagentSpec?.role ||
      '';
    existing.title = title;
    existing.stepCount = Math.max(existing.stepCount, Number(item.stepCount || 0));
    existing.lastModifiedTime = item.lastModifiedTime || existing.lastModifiedTime;
    existing.workspaceUris = meta.workspaceUris || existing.workspaceUris;
    existing.status = item.status || existing.status;
    existing.projectId = meta.projectId || existing.projectId;
    existing.agentName = meta.subagentSpec?.typeName || meta.agentScript?.name || existing.agentName;
    existing.subagentRole = meta.subagentSpec?.role || existing.subagentRole;
    existing.subagentModel = meta.subagentSpec?.model || existing.subagentModel;
    existing.parentConversationId = meta.parentConversationId || existing.parentConversationId;
    existing.rootConversationId = meta.rootConversationId || existing.rootConversationId;
    existing.nestingDepth =
      meta.nestingDepth !== undefined ? Number(meta.nestingDepth) : existing.nestingDepth;
    if (item.lastUserInputStepIndex !== undefined) {
      existing.lastUserInputStepIndex = Number(item.lastUserInputStepIndex);
    }
    if (item.lastUserInputTime) {
      existing.lastUserInputTime = item.lastUserInputTime;
    }
    map.set(cid, existing);
  }

  // 3. Resolve parent -> child tree & rootConversationId for all entries
  for (const entry of map.values()) {
    if (entry.parentConversationId && map.has(entry.parentConversationId)) {
      const parent = map.get(entry.parentConversationId);
      if (!parent.childIds.includes(entry.conversationId)) {
        parent.childIds.push(entry.conversationId);
      }
    }
  }
  for (const entry of map.values()) {
    if (!entry.rootConversationId) {
      let cur = entry;
      const visited = new Set([cur.conversationId]);
      while (cur.parentConversationId && map.has(cur.parentConversationId)) {
        if (visited.has(cur.parentConversationId)) break;
        visited.add(cur.parentConversationId);
        cur = map.get(cur.parentConversationId);
      }
      entry.rootConversationId = cur.conversationId;
    }
  }

  return map;
}

/**
 * Resolves the local SQLite database path for a conversation ID.
 * @param {string} conversationId
 * @returns {string | null}
 */
function findConversationDbPath(conversationId) {
  const candidates = [
    join(AGY_DIR, 'conversations', `${conversationId}.db`),
    join(AGY_CLI_DIR, 'conversations', `${conversationId}.db`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Reads user input step indices (`step_type = 14`) from a conversation's SQLite DB.
 * @param {string} conversationId
 * @returns {number[]}
 */
function readUserStepIndicesFromDb(conversationId) {
  const dbPath = findConversationDbPath(conversationId);
  if (!dbPath) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db
      .prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC')
      .all()
      .map((r) => Number(r.idx));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Reads and decodes `gen_metadata` rows directly from the conversation's SQLite DB.
 * @param {string} conversationId
 * @returns {Array<object>}
 */
function readGeneratorMetadataFromDb(conversationId) {
  const dbPath = findConversationDbPath(conversationId);
  if (!dbPath) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    return rows.map((r) => decodeGeneratorMetadataBlob(r.data));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Tier 3 fallback: reads token counts from `transcript.jsonl`.
 * @param {string} conversationId
 * @returns {{ generatorMetadata: Array<object>, userStepIndices: number[] }}
 */
function readFromTranscriptFallback(conversationId) {
  const transcriptPath = join(
    AGY_DIR,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  if (!existsSync(transcriptPath)) {
    return { generatorMetadata: [], userStepIndices: [] };
  }
  const generatorMetadata = [];
  const userStepIndices = [];
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const step = JSON.parse(line);
      if (step.type === 'USER_INPUT') {
        userStepIndices.push(Number(step.step_index));
      } else if (step.type === 'PLANNER_RESPONSE') {
        generatorMetadata.push({
          stepIndices: [Number(step.step_index)],
          chatModel: {
            responseModel: 'unknown (transcript fallback)',
            modelDisplayName: 'Transcript Fallback',
            usage: {
              inputTokens: String(step.input_tokens || 0),
              cacheReadTokens: String(step.cache_read_tokens || 0),
              outputTokens: String(step.output_tokens || 0),
            },
          },
        });
      }
    }
  } catch {
    // Ignore transcript parse errors
  }
  return { generatorMetadata, userStepIndices };
}

/**
 * Parses a duration string like `"6.623554083s"` into seconds.
 * @param {string | undefined} dur
 * @returns {number | null}
 */
function parseDurationSeconds(dur) {
  if (!dur || typeof dur !== 'string') return null;
  const m = dur.match(/^([0-9.]+)s$/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Collects raw generatorMetadata + userStepIndices for a single conversation using Tier 1 -> Tier 2 -> Tier 3.
 * @param {string} conversationId
 * @returns {Promise<{ generatorMetadata: Array<object>, userStepIndices: number[], dataSource: string }>}
 */
export async function fetchRawTrajectoryStats(conversationId) {
  const userStepIndices = readUserStepIndicesFromDb(conversationId);

  // Tier 1: Language Server RPC
  const rpcData = await lsrpc('GetCascadeTrajectoryGeneratorMetadata', {
    cascadeId: conversationId,
  });
  if (rpcData?.generatorMetadata && rpcData.generatorMetadata.length > 0) {
    return {
      generatorMetadata: rpcData.generatorMetadata,
      userStepIndices,
      dataSource: 'rpc',
    };
  }

  // Tier 2: Read-only SQLite gen_metadata table
  const dbMeta = readGeneratorMetadataFromDb(conversationId);
  if (dbMeta.length > 0) {
    return {
      generatorMetadata: dbMeta,
      userStepIndices,
      dataSource: 'sqlite',
    };
  }

  // Tier 3: transcript.jsonl fallback
  const fb = readFromTranscriptFallback(conversationId);
  return {
    generatorMetadata: fb.generatorMetadata,
    userStepIndices: fb.userStepIndices.length > 0 ? fb.userStepIndices : userStepIndices,
    dataSource: fb.generatorMetadata.length > 0 ? 'transcript' : 'empty',
  };
}

/**
 * Creates an empty usage accumulator object.
 */
function createEmptyAccumulator() {
  return {
    callCount: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    retryCount: 0,
    errorCount: 0,
    totalTtftSeconds: 0,
    totalStreamingSeconds: 0,
  };
}

function addCallToAccumulator(acc, call) {
  acc.callCount += 1;
  acc.inputTokens += call.inputTokens;
  acc.cacheReadTokens += call.cacheReadTokens;
  acc.cacheWriteTokens += call.cacheWriteTokens;
  acc.totalInputTokens += call.totalInputTokens;
  acc.outputTokens += call.outputTokens;
  acc.thinkingTokens += call.thinkingTokens;
  acc.responseTokens += call.responseTokens;
  acc.totalTokens += call.totalTokens;
  acc.retryCount += call.retryCount;
  if (call.hasError) acc.errorCount += 1;
  if (call.ttftSeconds) acc.totalTtftSeconds += call.ttftSeconds;
  if (call.streamingSeconds) acc.totalStreamingSeconds += call.streamingSeconds;
  acc.cacheHitRate =
    acc.totalInputTokens > 0
      ? Math.round((acc.cacheReadTokens / acc.totalInputTokens) * 1000) / 10
      : 0;
}

function mergeAccumulators(target, source) {
  target.callCount += source.callCount;
  target.inputTokens += source.inputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalInputTokens += source.totalInputTokens;
  target.outputTokens += source.outputTokens;
  target.thinkingTokens += source.thinkingTokens;
  target.responseTokens += source.responseTokens;
  target.totalTokens += source.totalTokens;
  target.retryCount += source.retryCount;
  target.errorCount += source.errorCount;
  target.totalTtftSeconds += source.totalTtftSeconds;
  target.totalStreamingSeconds += source.totalStreamingSeconds;
  target.cacheHitRate =
    target.totalInputTokens > 0
      ? Math.round((target.cacheReadTokens / target.totalInputTokens) * 1000) / 10
      : 0;
}

/**
 * Analyzes a single conversation trajectory into structured calls, turns, contextWindow, and summary totals.
 * @param {string} conversationId
 * @param {object} [catalogEntry]
 * @returns {Promise<object>}
 */
export async function analyzeSingleConversation(conversationId, catalogEntry = null) {
  const { generatorMetadata, userStepIndices, dataSource } =
    await fetchRawTrajectoryStats(conversationId);

  // Extract maxOutputTokens from any entry with plannerConfig
  let maxOutputTokens = null;
  for (let i = generatorMetadata.length - 1; i >= 0; i--) {
    const mo = generatorMetadata[i]?.plannerConfig?.maxOutputTokens;
    if (mo) {
      maxOutputTokens = Number(mo);
      break;
    }
  }

  // If userStepIndices wasn't in DB, try extracting from tokenBreakdown of the last entry
  let resolvedUserSteps = [...userStepIndices];
  if (resolvedUserSteps.length === 0) {
    for (let i = generatorMetadata.length - 1; i >= 0; i--) {
      const groups =
        generatorMetadata[i]?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown
          ?.groups;
      if (groups) {
        const found = [];
        for (const g of groups) {
          for (const ch of g.children || []) {
            const m = ch.name?.match(/^(\d+):\s*USER_INPUT$/);
            if (m) found.push(Number(m[1]));
          }
        }
        if (found.length > 0) {
          resolvedUserSteps = found.sort((a, b) => a - b);
          break;
        }
      }
    }
  }

  const calls = [];
  const byModelMap = new Map();
  const summary = createEmptyAccumulator();

  let prevModel = null;
  let prevCheckpoint = null;
  let prevExecId = null;
  let inferredTurnIdx = 0;

  for (let i = 0; i < generatorMetadata.length; i++) {
    const gm = generatorMetadata[i];
    const cm = gm.chatModel;
    if (!cm) continue;

    const stepIndices = Array.isArray(gm.stepIndices) ? gm.stepIndices.map(Number) : [];
    const lastStepIdxAttr =
      cm.customMetadata?.last_step_index !== undefined
        ? Number(cm.customMetadata.last_step_index)
        : null;
    const firstStep =
      stepIndices.length > 0
        ? stepIndices[0]
        : lastStepIdxAttr !== null
          ? lastStepIdxAttr + 1
          : i;
    const lastStep = stepIndices.length > 0 ? stepIndices[stepIndices.length - 1] : firstStep;

    // Determine Turn Index (1-based) and corresponding User Step Index
    let turnIndex = 1;
    let userStepIndex = 0;
    if (resolvedUserSteps.length > 0) {
      for (let u = 0; u < resolvedUserSteps.length; u++) {
        if (resolvedUserSteps[u] <= firstStep) {
          turnIndex = u + 1;
          userStepIndex = resolvedUserSteps[u];
        } else {
          break;
        }
      }
    } else {
      if (gm.executionId && gm.executionId !== prevExecId) {
        inferredTurnIdx += 1;
        prevExecId = gm.executionId;
      }
      turnIndex = Math.max(1, inferredTurnIdx);
    }

    const usage = cm.usage || {};
    const inputTokens = Number(usage.inputTokens || 0);
    const cacheReadTokens = Number(usage.cacheReadTokens || 0);
    const cacheWriteTokens = Number(
      usage.cacheWriteTokens || usage.cacheCreationInputTokens || 0
    );
    const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;

    const outputTokens = Number(usage.outputTokens || 0);
    const thinkingTokens = Number(usage.thinkingOutputTokens || 0);
    const responseTokens =
      usage.responseOutputTokens !== undefined
        ? Number(usage.responseOutputTokens)
        : Math.max(0, outputTokens - thinkingTokens);
    const totalTokens = totalInputTokens + outputTokens;

    const modelEnum =
      cm.model || cm.customMetadata?.model_enum || usage.model || 'UNKNOWN_MODEL';
    const responseModel = cm.responseModel || modelEnum;
    const modelDisplayName =
      cm.modelDisplayName || KNOWN_MODEL_LABELS[modelEnum] || responseModel;
    const apiProvider = (usage.apiProvider || '').replace(/^API_PROVIDER_/, '') || 'UNKNOWN';

    const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata || {};
    const checkpointIndex =
      cm.chatStartMetadata?.checkpointIndex !== undefined
        ? Number(cm.chatStartMetadata.checkpointIndex)
        : -1;
    const estimatedContextTokens = Number(ctxMeta.estimatedTokensUsed || 0);
    const maxContextTokens = Number(ctxMeta.maxContextTokens || 0);
    const actualContextTokens = totalInputTokens;

    const actualContextRatio =
      maxContextTokens > 0
        ? Math.round((actualContextTokens / maxContextTokens) * 1000) / 10
        : null;
    const estimatedContextRatio =
      maxContextTokens > 0
        ? Math.round((estimatedContextTokens / maxContextTokens) * 1000) / 10
        : null;

    const ttftSeconds = parseDurationSeconds(cm.timeToFirstToken);
    const streamingSeconds = parseDurationSeconds(cm.streamingDuration);
    const totalCallSeconds = (ttftSeconds || 0) + (streamingSeconds || 0);
    const tokensPerSecond =
      totalCallSeconds > 0.2 && outputTokens > 0
        ? Math.round((outputTokens / totalCallSeconds) * 10) / 10
        : null;

    const retryInfos = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
    const retryCount = Math.max(0, retryInfos.length - 1);
    const lastRetryError = retryInfos.find((r) => r.error)?.error || null;
    const hasError = Boolean(lastRetryError && totalTokens === 0);

    const modelSwitched = prevModel !== null && prevModel !== responseModel;
    const compressed =
      prevCheckpoint !== null && checkpointIndex !== prevCheckpoint && checkpointIndex >= 0;
    if (responseModel) prevModel = responseModel;
    prevCheckpoint = checkpointIndex;

    const callObj = {
      callIndex: calls.length + 1,
      metadataIndex: i,
      turnIndex,
      userStepIndex,
      stepIndices,
      firstStep,
      lastStep,
      executionId: gm.executionId || '',
      responseModel,
      modelDisplayName,
      modelEnum,
      apiProvider,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalInputTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      totalTokens,
      cacheHitRate:
        totalInputTokens > 0
          ? Math.round((cacheReadTokens / totalInputTokens) * 1000) / 10
          : 0,
      actualContextTokens,
      estimatedContextTokens,
      maxContextTokens,
      actualContextRatio,
      estimatedContextRatio,
      checkpointIndex,
      compressed,
      modelSwitched,
      ttftSeconds: ttftSeconds !== null ? Math.round(ttftSeconds * 100) / 100 : null,
      streamingSeconds:
        streamingSeconds !== null ? Math.round(streamingSeconds * 100) / 100 : null,
      tokensPerSecond,
      retryCount,
      hasError,
      errorMessage: lastRetryError,
      responseId: usage.responseId || '',
      messageId: usage.messageId || '',
      traceId: retryInfos.at(-1)?.traceId || '',
      rawTokenBreakdown: ctxMeta.tokenBreakdown || null,
    };

    calls.push(callObj);
    addCallToAccumulator(summary, callObj);

    const modelKey = responseModel || modelDisplayName;
    if (!byModelMap.has(modelKey)) {
      byModelMap.set(modelKey, {
        responseModel,
        modelDisplayName,
        modelEnum,
        apiProvider,
        ...createEmptyAccumulator(),
      });
    }
    addCallToAccumulator(byModelMap.get(modelKey), callObj);
  }

  // Group calls into Turns (each user message = 1 turn)
  const turnsMap = new Map();
  for (const call of calls) {
    if (!turnsMap.has(call.turnIndex)) {
      turnsMap.set(call.turnIndex, {
        turnIndex: call.turnIndex,
        userStepIndex: call.userStepIndex,
        firstStep: call.firstStep,
        lastStep: call.lastStep,
        models: [],
        responseModel: call.responseModel,
        modelDisplayName: call.modelDisplayName,
        ...createEmptyAccumulator(),
        contextAtEnd: null,
      });
    }
    const turn = turnsMap.get(call.turnIndex);
    turn.lastStep = Math.max(turn.lastStep, call.lastStep);
    if (!turn.models.includes(call.responseModel)) {
      turn.models.push(call.responseModel);
    }
    turn.responseModel = call.responseModel;
    turn.modelDisplayName = call.modelDisplayName;
    addCallToAccumulator(turn, call);
    turn.contextAtEnd = {
      actualContextTokens: call.actualContextTokens,
      estimatedContextTokens: call.estimatedContextTokens,
      maxContextTokens: call.maxContextTokens,
      actualContextRatio: call.actualContextRatio,
      estimatedContextRatio: call.estimatedContextRatio,
    };
  }
  const turns = Array.from(turnsMap.values()).sort((a, b) => a.turnIndex - b.turnIndex);
  const latestTurn = turns.at(-1) || null;

  // Build current Context Window snapshot from the latest valid call
  const lastValidCall =
    [...calls].reverse().find((c) => c.maxContextTokens > 0 || c.totalInputTokens > 0) ||
    calls.at(-1) ||
    null;
  const lastWithBreakdown =
    [...calls].reverse().find((c) => c.rawTokenBreakdown?.groups?.length > 0) || lastValidCall;

  let breakdownGroups = [];
  if (lastWithBreakdown?.rawTokenBreakdown?.groups) {
    const totalBd =
      lastWithBreakdown.rawTokenBreakdown.totalTokens ||
      lastWithBreakdown.rawTokenBreakdown.groups.reduce((s, g) => s + (g.numTokens || 0), 0) ||
      1;
    breakdownGroups = lastWithBreakdown.rawTokenBreakdown.groups.map((g) => {
      const sortedChildren = [...(g.children || [])]
        .sort((a, b) => (b.numTokens || 0) - (a.numTokens || 0))
        .slice(0, 12);
      return {
        name: g.name,
        numTokens: g.numTokens || 0,
        ratioPercent: Math.round(((g.numTokens || 0) / totalBd) * 1000) / 10,
        childCount: (g.children || []).length,
        topChildren: sortedChildren,
      };
    });
  }

  const maxCtx = lastValidCall?.maxContextTokens || 0;
  const actualCtx = lastValidCall?.actualContextTokens || 0;
  const estCtx = lastValidCall?.estimatedContextTokens || 0;
  const actualPct = maxCtx > 0 ? Math.round((actualCtx / maxCtx) * 1000) / 10 : 0;
  const estPct = maxCtx > 0 ? Math.round((estCtx / maxCtx) * 1000) / 10 : 0;
  const maxPct = Math.max(actualPct, estPct);

  const contextWindow = {
    responseModel: lastValidCall?.responseModel || 'N/A',
    modelDisplayName: lastValidCall?.modelDisplayName || 'N/A',
    modelEnum: lastValidCall?.modelEnum || 'N/A',
    apiProvider: lastValidCall?.apiProvider || 'N/A',
    actualTokensUsed: actualCtx,
    estimatedTokensUsed: estCtx,
    maxContextTokens: maxCtx,
    maxOutputTokens: maxOutputTokens || 65536,
    actualPercent: actualPct,
    estimatedPercent: estPct,
    remainingTokens: Math.max(0, maxCtx - actualCtx),
    statusLevel: maxPct >= 85 ? 'critical' : maxPct >= 70 ? 'warning' : 'normal',
    breakdownGroups,
  };

  // Strip rawTokenBreakdown from call items to keep payload compact
  for (const c of calls) {
    delete c.rawTokenBreakdown;
  }

  return {
    conversationId,
    title: catalogEntry?.title || readAnnotationTitle(conversationId) || conversationId.slice(0, 8),
    status: catalogEntry?.status || '',
    stepCount: Math.max(catalogEntry?.stepCount || 0, calls.at(-1)?.lastStep || 0),
    lastModifiedTime: catalogEntry?.lastModifiedTime || '',
    agentName: catalogEntry?.agentName || '',
    subagentRole: catalogEntry?.subagentRole || '',
    nestingDepth: catalogEntry?.nestingDepth || 0,
    parentConversationId: catalogEntry?.parentConversationId || '',
    rootConversationId: catalogEntry?.rootConversationId || conversationId,
    dataSource,
    summary: {
      ...summary,
      byModel: Array.from(byModelMap.values()),
    },
    contextWindow,
    latestTurn,
    turns,
    calls,
  };
}

function toEpochMs(ts) {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Generates the complete multi-level report for a conversation (including its root session and all nested Subagents).
 * @param {string} [targetConversationId] If omitted, automatically selects the most recently active root conversation.
 * @returns {Promise<object>}
 */
export async function getFullSessionReport(targetConversationId) {
  const [catalog, quotaData] = await Promise.all([
    getConversationCatalog(),
    fetchModelQuotas(),
  ]);

  let selectedId = targetConversationId;
  if (!selectedId) {
    // Pick the most recently modified root session (depth === 0) sorted by epoch timestamp
    const roots = Array.from(catalog.values())
      .filter((e) => e.nestingDepth === 0 && !e.parentConversationId)
      .sort((a, b) => toEpochMs(b.lastModifiedTime) - toEpochMs(a.lastModifiedTime));
    selectedId = roots[0]?.conversationId;
    if (!selectedId && catalog.size > 0) {
      selectedId = catalog.keys().next().value;
    }
  }

  if (!selectedId) {
    throw new Error('No conversations found in Antigravity.');
  }

  const targetMeta = catalog.get(selectedId);
  const rootId = targetMeta?.rootConversationId || selectedId;
  const rootMeta = catalog.get(rootId) || targetMeta || { conversationId: rootId };

  // Collect all descendant subagents belonging to `rootId`
  const subagentEntries = [];
  for (const entry of catalog.values()) {
    if (entry.conversationId !== rootId && entry.rootConversationId === rootId) {
      subagentEntries.push(entry);
    }
  }
  subagentEntries.sort(
    (a, b) => toEpochMs(a.lastModifiedTime) - toEpochMs(b.lastModifiedTime)
  );

  // Analyze Main Session + all Subagent sessions in parallel
  const [mainAnalysis, ...subagentAnalyses] = await Promise.all([
    analyzeSingleConversation(rootId, rootMeta),
    ...subagentEntries.map((sub) => analyzeSingleConversation(sub.conversationId, sub)),
  ]);

  // If the user explicitly asked for a specific subagent ID, also provide its analysis as `activeSession`
  const activeAnalysis =
    selectedId === rootId
      ? mainAnalysis
      : subagentAnalyses.find((s) => s.conversationId === selectedId) || mainAnalysis;

  // Compute 3-tier Cost Hierarchy: Grand Total = Main Session + Subagents
  const subagentsTotal = createEmptyAccumulator();
  const subagentsByModelMap = new Map();
  const grandTotal = createEmptyAccumulator();
  const grandByModelMap = new Map();

  const mergeByModel = (map, modelList) => {
    for (const m of modelList) {
      const key = m.responseModel || m.modelDisplayName;
      if (!map.has(key)) {
        map.set(key, {
          responseModel: m.responseModel,
          modelDisplayName: m.modelDisplayName,
          modelEnum: m.modelEnum,
          apiProvider: m.apiProvider,
          ...createEmptyAccumulator(),
        });
      }
      mergeAccumulators(map.get(key), m);
    }
  };

  mergeAccumulators(grandTotal, mainAnalysis.summary);
  mergeByModel(grandByModelMap, mainAnalysis.summary.byModel);

  const subagentItems = subagentAnalyses.map((sub) => {
    mergeAccumulators(subagentsTotal, sub.summary);
    mergeByModel(subagentsByModelMap, sub.summary.byModel);
    mergeAccumulators(grandTotal, sub.summary);
    mergeByModel(grandByModelMap, sub.summary.byModel);

    return {
      conversationId: sub.conversationId,
      title: sub.subagentRole || sub.title || sub.agentName || sub.conversationId.slice(0, 8),
      agentName: sub.agentName || 'subagent',
      subagentRole: sub.subagentRole || '',
      nestingDepth: sub.nestingDepth,
      parentConversationId: sub.parentConversationId,
      status: sub.status,
      stepCount: sub.stepCount,
      lastModifiedTime: sub.lastModifiedTime,
      dataSource: sub.dataSource,
      responseModel: sub.contextWindow.responseModel,
      modelDisplayName: sub.contextWindow.modelDisplayName,
      contextWindow: {
        actualTokensUsed: sub.contextWindow.actualTokensUsed,
        estimatedTokensUsed: sub.contextWindow.estimatedTokensUsed,
        maxContextTokens: sub.contextWindow.maxContextTokens,
        actualPercent: sub.contextWindow.actualPercent,
      },
      summary: sub.summary,
    };
  });

  // Match current active model quota
  const currentModelEnum = activeAnalysis.contextWindow.modelEnum;
  const currentModelId = activeAnalysis.contextWindow.responseModel;
  const matchedQuota =
    quotaData.models.find(
      (q) =>
        (currentModelEnum && q.modelEnum === currentModelEnum) ||
        (currentModelId && q.modelId === currentModelId) ||
        (currentModelId && q.modelId.startsWith(currentModelId))
    ) || null;

  return {
    generatedAt: new Date().toISOString(),
    requestedConversationId: selectedId,
    rootConversationId: rootId,
    isSubagentSelected: selectedId !== rootId,
    activeSession: {
      conversationId: activeAnalysis.conversationId,
      title: activeAnalysis.title,
      status: activeAnalysis.status,
      stepCount: activeAnalysis.stepCount,
      lastModifiedTime: activeAnalysis.lastModifiedTime,
      dataSource: activeAnalysis.dataSource,
      currentQuota: matchedQuota,
      latestTurn: activeAnalysis.latestTurn,
      contextWindow: activeAnalysis.contextWindow,
      turns: activeAnalysis.turns,
      calls: activeAnalysis.calls,
    },
    costHierarchy: {
      total: {
        ...grandTotal,
        sessionCount: 1 + subagentItems.length,
        byModel: Array.from(grandByModelMap.values()),
      },
      mainSession: {
        conversationId: mainAnalysis.conversationId,
        title: mainAnalysis.title,
        ...mainAnalysis.summary,
      },
      subagents: {
        count: subagentItems.length,
        ...subagentsTotal,
        byModel: Array.from(subagentsByModelMap.values()),
        items: subagentItems,
      },
    },
    quotas: quotaData,
  };
}

/**
 * Lists recent root conversations (with subagent counts) for the session switcher UI.
 * @param {number} [limit=40]
 * @returns {Promise<Array<object>>}
 */
export async function listRecentSessions(limit = 40) {
  const catalog = await getConversationCatalog();
  const subagentCounts = new Map();
  const subagentListMap = new Map();

  for (const entry of catalog.values()) {
    if (entry.conversationId !== entry.rootConversationId && entry.rootConversationId) {
      subagentCounts.set(
        entry.rootConversationId,
        (subagentCounts.get(entry.rootConversationId) || 0) + 1
      );
      if (!subagentListMap.has(entry.rootConversationId)) {
        subagentListMap.set(entry.rootConversationId, []);
      }
      subagentListMap.get(entry.rootConversationId).push({
        conversationId: entry.conversationId,
        title: entry.subagentRole || entry.title || entry.agentName || entry.conversationId.slice(0, 8),
        agentName: entry.agentName,
        nestingDepth: entry.nestingDepth,
        stepCount: entry.stepCount,
        status: entry.status,
        lastModifiedTime: entry.lastModifiedTime,
      });
    }
  }

  const roots = [];
  for (const entry of catalog.values()) {
    if (entry.nestingDepth === 0 && !entry.parentConversationId) {
      roots.push({
        conversationId: entry.conversationId,
        title: entry.title || `Session ${entry.conversationId.slice(0, 8)}`,
        stepCount: entry.stepCount,
        status: entry.status,
        source: entry.source,
        lastModifiedTime: entry.lastModifiedTime,
        workspaceUris: entry.workspaceUris,
        subagentCount: subagentCounts.get(entry.conversationId) || 0,
        subagents: subagentListMap.get(entry.conversationId) || [],
      });
    }
  }

  roots.sort((a, b) => toEpochMs(b.lastModifiedTime) - toEpochMs(a.lastModifiedTime));
  return roots.slice(0, limit);
}
