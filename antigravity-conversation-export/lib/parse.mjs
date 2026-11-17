/**
 * @fileoverview Fold Antigravity conversation trajectory steps into human-led rounds.
 *
 * Mirrors DSH's `dsh-conversation-export/lib/parse.js` data model:
 * - Each round starts at an explicit human `USER_INPUT` (`source === 'USER_EXPLICIT'`)
 *   and collects everything the assistant did until the next human message.
 * - Inside a round, assistant output is grouped into alternating blocks:
 *   - `activity`: thinking (`reasoning`), tool calls (`tool`), and narration text written
 *     alongside tool calls (`narration`) — rendered as "已处理 12 秒 · 5 步".
 *   - `reply`: visible assistant response text from steps without tool calls.
 * - System-injected blocks (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`,
 *   `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY`, `CHECKPOINT`, `EPHEMERAL_MESSAGE`)
 *   are stripped and never exported as human turns.
 */

/** Collapse whitespace and clip to `max` characters with an ellipsis. */
export function preview(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Plain-text preview of Markdown for one-line list rows. */
export function plainPreview(text, max) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '');
  return preview(plain, max);
}

function parseIsoMs(iso) {
  if (typeof iso === 'number' && Number.isFinite(iso)) return iso;
  if (typeof iso !== 'string' || !iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const argsText = JSON.stringify(raw);
    return { args: raw, argsText };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, argsText: raw };
      }
      return { args: { value: parsed }, argsText: raw };
    } catch {
      return { args: { raw }, argsText: raw };
    }
  }
  return { args: {}, argsText: '' };
}

/**
 * Extract clean user text and optional model selection hint from `USER_INPUT.content`.
 * @param {string} raw
 * @returns {{ text: string, modelHint?: string }}
 */
export function extractUserPrompt(raw) {
  const source = String(raw ?? '');
  let modelHint;
  const settingMatch = source.match(
    /<USER_SETTINGS_CHANGE>[\s\S]*?Model Selection`\s+from\s+.*?\s+to\s+([^.\n<]+)[\s\S]*?<\/USER_SETTINGS_CHANGE>/i
  );
  if (settingMatch?.[1]) {
    const candidate = settingMatch[1].trim();
    if (candidate && candidate.toLowerCase() !== 'none') {
      modelHint = candidate;
    }
  }

  // Strip known system-injected XML blocks first
  const withoutSystemTags = source
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_REMINDER>[\s\S]*?<\/SYSTEM_REMINDER>/gi, '')
    .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '');

  const reqMatch = withoutSystemTags.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    const before = withoutSystemTags.slice(0, reqMatch.index).trim();
    const inside = reqMatch[1].trim();
    const parts = [before, inside].filter(Boolean);
    return { text: parts.join('\n\n'), modelHint };
  }

  return { text: withoutSystemTags.trim(), modelHint };
}

/**
 * Strip `Created At` / `Completed At` execution header from Antigravity tool step output.
 * @param {string} rawContent
 * @param {string} [errorText]
 * @param {string} [status]
 * @param {number} [fallbackTime]
 */
export function parseToolStepOutput(rawContent, errorText, status, fallbackTime) {
  let text = String(rawContent ?? '');
  let completedMs = fallbackTime;

  const createdMatch = text.match(/^Created At:\s*([^\n]+)\n/);
  if (createdMatch) {
    text = text.slice(createdMatch[0].length);
  }
  const completedMatch = text.match(/^Completed At:\s*([^\n]+)\n/);
  if (completedMatch) {
    const parsedEnd = parseIsoMs(completedMatch[1].trim());
    if (parsedEnd !== undefined) completedMs = parsedEnd;
    text = text.slice(completedMatch[0].length);
  }

  text = text.trim();
  if (!text && errorText) {
    text = String(errorText).trim();
  }

  const isError =
    status === 'ERROR' ||
    status === 'CORTEX_STEP_STATUS_ERROR' ||
    Boolean(errorText) ||
    /^Encountered error in tool execution:/m.test(text) ||
    /^Command exited with code [1-9]\d*/m.test(text);

  return { text, isError, completedMs };
}

/**
 * Convert a raw `GetCascadeTrajectory` RPC step into normalized transcript JSONL format.
 * @param {any} rpcStep
 * @param {number} index
 */
export function normalizeRpcStep(rpcStep, index) {
  if (!rpcStep || typeof rpcStep !== 'object') return null;
  const rawType = String(rpcStep.type || '').replace(/^CORTEX_STEP_TYPE_/, '');
  const rawStatus = String(rpcStep.status || '').replace(/^CORTEX_STEP_STATUS_/, '');
  const meta = rpcStep.metadata || {};
  const rawSource = String(meta.source || '').replace(/^CORTEX_STEP_SOURCE_/, '');
  const createdAt = meta.createdAt || meta.viewableAt || '';
  const completedAt = meta.completedAt || meta.finishedGeneratingAt || createdAt;

  if (rawType === 'USER_INPUT') {
    const ui = rpcStep.userInput || {};
    const itemTexts = Array.isArray(ui.items)
      ? ui.items.map((it) => it?.text || '').filter(Boolean).join('\n\n')
      : '';
    const text = ui.userResponse || itemTexts || '';
    const media = Array.isArray(ui.media) ? ui.media : [];
    return {
      step_index: index,
      source: rawSource || 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: rawStatus || 'DONE',
      created_at: createdAt,
      content: text,
      media,
    };
  }

  if (rawType === 'PLANNER_RESPONSE') {
    const pr = rpcStep.plannerResponse || {};
    const toolCalls = Array.isArray(pr.toolCalls)
      ? pr.toolCalls.map((tc) => {
          const { args } = normalizeArgs(tc.argumentsJson ?? tc.args);
          return {
            id: tc.id,
            name: tc.name || tc.originalName || 'tool',
            args,
          };
        })
      : undefined;
    return {
      step_index: index,
      source: rawSource || 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: rawStatus || 'DONE',
      created_at: createdAt,
      completed_at: completedAt,
      thinking: pr.thinking || undefined,
      content: pr.modifiedResponse || pr.response || undefined,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      model_enum: meta.generatorModel || meta.modelUsage?.model || undefined,
    };
  }

  if (rawType === 'ERROR_MESSAGE') {
    const msg =
      rpcStep.errorMessage?.error?.message ||
      rpcStep.errorMessage?.message ||
      JSON.stringify(rpcStep.errorMessage || {});
    return {
      step_index: index,
      source: rawSource || 'SYSTEM',
      type: 'ERROR_MESSAGE',
      status: rawStatus || 'ERROR',
      created_at: createdAt,
      error: msg,
      content: msg,
    };
  }

  // Generic / specific tool result steps in RPC
  let content = '';
  if (rpcStep.runCommand) {
    const rc = rpcStep.runCommand;
    const code = rc.exitCode ?? 0;
    const out = rc.combinedOutput?.full || rc.stdout || rc.output || '';
    content = `Command exited with code ${code}.\n\n${out}`.trim();
  } else if (rpcStep.viewFile) {
    const vf = rpcStep.viewFile;
    content = vf.content || `Viewed ${vf.absolutePathUri || vf.path || 'file'}`;
  } else if (rpcStep.codeAction) {
    content = rpcStep.codeAction.summary || rpcStep.codeAction.description || 'Applied code action';
  } else if (rpcStep.listDirectory) {
    content = JSON.stringify(rpcStep.listDirectory.entries || rpcStep.listDirectory);
  } else {
    const payloadKey = Object.keys(rpcStep).find(
      (k) => !['type', 'status', 'metadata'].includes(k)
    );
    if (payloadKey && rpcStep[payloadKey]) {
      const val = rpcStep[payloadKey];
      content = typeof val === 'string' ? val : val.output || val.content || JSON.stringify(val);
    }
  }

  return {
    step_index: index,
    source: rawSource || 'MODEL',
    type: rawType || 'GENERIC',
    status: rawStatus || 'DONE',
    created_at: createdAt,
    completed_at: completedAt,
    content,
  };
}

const SYSTEM_STEP_TYPES = new Set([
  'SYSTEM_MESSAGE',
  'CONVERSATION_HISTORY',
  'CHECKPOINT',
  'EPHEMERAL_MESSAGE',
]);

/**
 * Fold normalized Antigravity transcript steps into DSH-compatible rounds.
 * @param {readonly any[]} steps
 * @returns {{ rounds: any[], detectedModels: string[] }}
 */
export function foldSteps(steps) {
  const rounds = [];
  const detectedModels = [];
  const addModel = (m) => {
    if (m && typeof m === 'string' && !detectedModels.includes(m)) {
      detectedModels.push(m);
    }
  };

  let current;
  let pendingTools = [];

  const openRound = (prompt) => {
    current = {
      index: rounds.length,
      startTime: prompt?.time,
      prompt,
      raw: [],
      endTime: prompt?.time,
    };
    pendingTools = [];
    rounds.push(current);
  };

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    if (!step || typeof step !== 'object') continue;

    const seq = Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : idx;
    const stepTime = parseIsoMs(step.created_at);
    const stepEndTime = parseIsoMs(step.completed_at) ?? stepTime;
    const type = String(step.type || '');
    const source = String(step.source || '');

    // Ignore system-injected context / compactions / async wakeups
    if (source === 'SYSTEM' && SYSTEM_STEP_TYPES.has(type)) {
      continue;
    }
    if (SYSTEM_STEP_TYPES.has(type)) {
      continue;
    }

    if (type === 'USER_INPUT') {
      if (source && source !== 'USER_EXPLICIT' && source !== 'USER') continue;
      const { text, modelHint } = extractUserPrompt(step.content);
      if (modelHint) addModel(modelHint);

      const media = Array.isArray(step.media) ? step.media : [];
      let images = 0;
      const files = [];
      for (const m of media) {
        const mime = String(m?.mime_type || m?.mimeType || '');
        const uri = String(m?.uri || m?.name || '');
        const name = uri.split(/[\\/]/).filter(Boolean).at(-1) || 'attachment';
        if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
          images += 1;
        } else {
          files.push(name);
        }
      }

      if (!text && images === 0 && files.length === 0) continue;

      openRound({
        seq,
        time: stepTime,
        text,
        images,
        files,
      });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      if (step.model_enum) addModel(step.model_enum);
      if (current === undefined) openRound(undefined);

      const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
      const content = typeof step.content === 'string' ? step.content.trim() : '';
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const hasToolCall = toolCalls.length > 0;

      if (thinking !== '') {
        current.raw.push({
          kind: 'reasoning',
          text: thinking,
          time: stepTime,
          endTime: stepEndTime,
          seq,
        });
      }

      if (content !== '') {
        current.raw.push({
          kind: hasToolCall ? 'narration' : 'reply',
          text: content,
          time: stepEndTime ?? stepTime,
          seq,
        });
      }

      if (!hasToolCall) {
        pendingTools = [];
      } else {
        for (let tIdx = 0; tIdx < toolCalls.length; tIdx++) {
          const tc = toolCalls[tIdx];
          if (!tc || typeof tc !== 'object') continue;
          const { args, argsText } = normalizeArgs(tc.args ?? tc.arguments);
          const toolItem = {
            kind: 'tool',
            id: tc.id ? String(tc.id) : `s${seq}_t${tIdx}`,
            name: String(tc.name ?? 'tool'),
            args,
            argsText,
            result: undefined,
            isError: false,
            time: stepTime,
            endTime: stepEndTime,
            seq,
          };
          current.raw.push(toolItem);
          pendingTools.push(toolItem);
        }
      }

      if (step.status === 'CANCELED' || step.status === 'ABORTED') {
        current.raw.push({ kind: 'note', note: 'aborted', time: stepEndTime, seq });
      }
      if (stepEndTime !== undefined && (current.endTime === undefined || stepEndTime > current.endTime)) {
        current.endTime = stepEndTime;
      }
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      if (current === undefined) continue;
      const errDetail = String(step.error || step.content || '').trim();
      if (pendingTools.length > 0) {
        const failedTool = pendingTools.shift();
        failedTool.result = errDetail;
        failedTool.isError = true;
        if (stepEndTime !== undefined) failedTool.endTime = stepEndTime;
      } else if (errDetail) {
        current.raw.push({
          kind: 'note',
          note: 'error',
          detail: preview(errDetail, 240),
          time: stepTime,
          seq,
        });
      }
      if (stepEndTime !== undefined && (current.endTime === undefined || stepEndTime > current.endTime)) {
        current.endTime = stepEndTime;
      }
      continue;
    }

    // All remaining MODEL:* steps are tool execution results matching pendingTools in FIFO order
    if (current !== undefined && pendingTools.length > 0) {
      const targetTool = pendingTools.shift();
      const parsed = parseToolStepOutput(step.content, step.error, step.status, stepEndTime);
      targetTool.result = parsed.text;
      targetTool.isError = parsed.isError;
      if (parsed.completedMs !== undefined) {
        targetTool.endTime = parsed.completedMs;
        if (current.endTime === undefined || parsed.completedMs > current.endTime) {
          current.endTime = parsed.completedMs;
        }
      }
    }
  }

  for (const round of rounds) {
    finalizeRound(round);
  }

  return { rounds, detectedModels };
}

/** Group raw items into alternating `activity` and `reply` blocks. */
function finalizeRound(round) {
  const blocks = [];
  let activity;
  let boundary = round.startTime;

  round.raw.forEach((item, i) => {
    item.key = `r${round.index}i${i}`;
  });

  for (const item of round.raw) {
    if (item.kind === 'reply') {
      if (activity !== undefined) {
        if (item.time !== undefined) activity.endTime = Math.max(activity.endTime ?? 0, item.time);
        blocks.push(activity);
        activity = undefined;
      }
      const last = blocks.at(-1);
      if (last?.kind === 'reply') {
        last.text += `\n\n${item.text}`;
      } else {
        blocks.push({ kind: 'reply', text: item.text, time: item.time });
      }
      if (item.time !== undefined) boundary = item.time;
      continue;
    }

    if (item.kind === 'note' && activity === undefined) {
      blocks.push({ kind: 'note', note: item.note, detail: item.detail });
      continue;
    }

    if (activity === undefined) {
      const start = boundary ?? item.time ?? 0;
      activity = {
        kind: 'activity',
        items: [],
        startTime: start,
        endTime: item.endTime ?? item.time ?? start,
      };
    }
    activity.items.push(item);
    const candidateEnd = item.endTime ?? item.time;
    if (candidateEnd !== undefined && (activity.endTime === undefined || candidateEnd > activity.endTime)) {
      activity.endTime = candidateEnd;
    }
  }

  if (activity !== undefined) blocks.push(activity);
  round.blocks = blocks;
  delete round.raw;

  let tools = 0;
  let reasoning = 0;
  for (const block of blocks) {
    if (block.kind !== 'activity') continue;
    for (const item of block.items) {
      if (item.kind === 'tool') tools += 1;
      else if (item.kind === 'reasoning') reasoning += 1;
    }
  }

  const replies = blocks.filter((block) => block.kind === 'reply');
  round.stats = {
    tools,
    reasoning,
    activityGroups: blocks.filter((block) => block.kind === 'activity').length,
  };
  round.answerPreview = replies.length > 0 ? replies.at(-1).text : '';
  const firstNote = blocks.find((block) => block.kind === 'note');
  round.notePreview = firstNote === undefined ? '' : firstNote.note;
  const firstAssistant = blocks[0];
  round.assistantTime =
    firstAssistant === undefined
      ? undefined
      : firstAssistant.kind === 'activity'
        ? firstAssistant.items[0]?.time
        : firstAssistant.time;
  round.hasAssistant = blocks.length > 0;
}

/** Lightweight per-round summary for the UI selection list. */
export function outlineOf(round) {
  return {
    index: round.index,
    time: round.startTime ?? null,
    prompt: round.prompt === undefined ? '' : plainPreview(round.prompt.text, 120),
    images: round.prompt?.images ?? 0,
    files: round.prompt?.files ?? [],
    answer: plainPreview(round.answerPreview, 160),
    note: round.notePreview,
    hasPrompt: round.prompt !== undefined,
    hasAssistant: round.hasAssistant,
    tools: round.stats.tools,
    reasoning: round.stats.reasoning,
    activityGroups: round.stats.activityGroups,
  };
}
