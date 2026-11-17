#!/usr/bin/env node
/**
 * @fileoverview Terminal ANSI colored dashboard & quick-inspect tool (`agy-stats`)
 * for Antigravity CLI (`agy`) and Antigravity.app.
 *
 * Can be invoked directly inside `agy` via `!agy-stats` (zero token cost, instant output)
 * or in a split pane via `agy-stats --watch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFullSessionReport } from '../lib/stats-core.mjs';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  white: '\x1b[37m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  purple: '\x1b[38;5;141m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
};

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  return Number(n).toLocaleString('en-US');
}

function fmtShort(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  const num = Number(n);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function padEndVis(str, width) {
  const plain = String(str).replace(/\x1b\[[0-9;]*m/g, '');
  let visLen = 0;
  for (const ch of plain) {
    visLen += ch.charCodeAt(0) > 255 ? 2 : 1;
  }
  const pad = Math.max(0, width - visLen);
  return str + ' '.repeat(pad);
}

function padStartVis(str, width) {
  const plain = String(str).replace(/\x1b\[[0-9;]*m/g, '');
  let visLen = 0;
  for (const ch of plain) {
    visLen += ch.charCodeAt(0) > 255 ? 2 : 1;
  }
  const pad = Math.max(0, width - visLen);
  return ' '.repeat(pad) + str;
}

function progressBar(pct, width = 22) {
  const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  // Aligned with Antigravity auto-compaction (~95%-100% of maxContextTokens)
  const color = clamped >= 92 ? C.red : clamped >= 80 ? C.orange : C.green;
  return `${color}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset}`;
}

function resolveDefaultSessionId() {
  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID;
  }
  const stateFile = join(homedir(), '.antigravity', 'status-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const ageSec = Date.now() / 1000 - Number(state.timestamp || 0);
      if (state.session_id && ageSec < 3600) {
        return state.session_id;
      }
    } catch {}
  }
  return undefined;
}

function renderAnsiDashboard(report, showAllSubs = false) {
  const { activeSession, costHierarchy } = report;
  const cw = activeSession.contextWindow;
  const lt = activeSession.latestTurn;
  const tot = costHierarchy.total;
  const main = costHierarchy.mainSession;
  const sub = costHierarchy.subagents;
  const q = activeSession.currentQuota;

  const lines = [];
  const rule = `${C.dim}${'─'.repeat(88)}${C.reset}`;

  lines.push(rule);
  lines.push(
    `${C.bold}${C.cyan}📊 Antigravity Model Details & Token Usage${C.reset}  ` +
      `${C.dim}会话:${C.reset} ${C.white}${activeSession.conversationId.slice(0, 8)}…${C.reset} (${activeSession.title || '未命名'})  ` +
      `${C.dim}数据源:${C.reset} ${C.purple}${activeSession.dataSource.toUpperCase()}${C.reset}`
  );
  lines.push(rule);

  // 1. Model Identity & Quota
  const quotaStr =
    q && q.remainingPercent !== null
      ? `${q.remainingPercent < 20 ? C.red : q.remainingPercent < 50 ? C.orange : C.green}${q.remainingPercent}%${C.reset}`
      : `${C.dim}N/A${C.reset}`;
  const avgTtftStr = tot.avgTtftSeconds !== null && tot.avgTtftSeconds !== undefined ? `${tot.avgTtftSeconds}s` : '-';
  const avgTpsStr = tot.avgE2eTps !== null && tot.avgE2eTps !== undefined ? `${tot.avgE2eTps} t/s` : '-';
  lines.push(
    `🤖 ${C.bold}返回模型 ID:${C.reset} ${C.yellow}${C.bold}${cw.responseModel}${C.reset}  ` +
      `${C.dim}显示名:${C.reset} ${cw.modelDisplayName}  ` +
      `${C.dim}枚举:${C.reset} ${cw.modelEnum}  ` +
      `${C.dim}配额剩余:${C.reset} ${quotaStr}`
  );
  lines.push(
    `⚡ ${C.bold}会话整体性能:${C.reset} ${C.dim}平均 TTFT:${C.reset} ${C.cyan}${avgTtftStr}${C.reset}  ` +
      `${C.dim}平均 E2E TPS:${C.reset} ${C.green}${avgTpsStr}${C.reset}`
  );

  // 2. Context Window Watermark
  lines.push(
    `📐 ${C.bold}实际上下文:${C.reset}  ${progressBar(cw.actualPercent)}  ` +
      `${C.bold}${fmtNum(cw.actualTokensUsed)}${C.reset} / ${fmtNum(cw.maxContextTokens)} (${C.bold}${cw.actualPercent}%${C.reset}) · 剩余 ${fmtShort(cw.remainingTokens)}`
  );
  lines.push(
    `   ${C.dim}内部估算值:${C.reset}  ${progressBar(cw.estimatedPercent)}  ` +
      `${C.dim}${fmtNum(cw.estimatedTokensUsed)} / ${fmtNum(cw.maxContextTokens)} (${cw.estimatedPercent}%) · 单次最大输出 ${fmtShort(cw.maxOutputTokens)}${C.reset}`
  );

  if (cw.breakdownGroups && cw.breakdownGroups.length > 0) {
    const bdParts = cw.breakdownGroups.map(
      (g) => `${C.cyan}${g.name}${C.reset}: ${fmtShort(g.numTokens)} (${g.ratioPercent}%)`
    );
    lines.push(`   ${C.dim}上下文构成:${C.reset}  ${bdParts.join('  │  ')}`);
  }
  lines.push(rule);

  // 3. Three-Tier Cost Hierarchy Table
  lines.push(`${C.bold}Σ 开销层级对比（本条消息 vs 主会话 vs Subagents vs 全局总计）${C.reset}`);
  const header =
    padEndVis(`${C.dim}统计维度${C.reset}`, 21) +
    padStartVis(`${C.dim}调用${C.reset}`, 6) +
    padStartVis(`${C.dim}新增 Input${C.reset}`, 11) +
    padStartVis(`${C.dim}缓存 Cached${C.reset}`, 12) +
    padStartVis(`${C.dim}命中率${C.reset}`, 8) +
    padStartVis(`${C.dim}输出 (🧠/💬)${C.reset}`, 23) +
    padStartVis(`${C.dim}总计 Token${C.reset}`, 11) +
    padStartVis(`${C.dim}平均TTFT${C.reset}`, 9) +
    padStartVis(`${C.dim}E2E TPS${C.reset}`, 10);
  lines.push(header);

  const fmtTtft = (s) => (s !== null && s !== undefined ? `${s}s` : '-');
  const fmtTps = (t) => (t !== null && t !== undefined ? `${t} t/s` : '-');

  const fmtRow = (label, color, item) =>
    padEndVis(`${color}${label}${C.reset}`, 21) +
    padStartVis(fmtNum(item.callCount), 6) +
    padStartVis(fmtShort(item.inputTokens), 11) +
    padStartVis(`${C.green}${fmtShort(item.cacheReadTokens)}${C.reset}`, 12) +
    padStartVis(`${item.cacheHitRate}%`, 8) +
    padStartVis(
      `${fmtShort(item.outputTokens)} (${fmtShort(item.thinkingTokens)}/${fmtShort(item.responseTokens)})`,
      23
    ) +
    padStartVis(`${C.bold}${fmtShort(item.totalTokens)}${C.reset}`, 11) +
    padStartVis(`${C.cyan}${fmtTtft(item.avgTtftSeconds)}${C.reset}`, 9) +
    padStartVis(`${C.green}${fmtTps(item.avgE2eTps)}${C.reset}`, 10);

  if (lt) {
    lines.push(fmtRow(`💬 本条消息 (#${lt.turnIndex})`, C.cyan, lt));
  }
  lines.push(fmtRow(`🏠 主会话 (Main)`, C.white, main));
  lines.push(fmtRow(`🌿 Subagents (×${sub.count})`, C.purple, sub));
  lines.push(fmtRow(`🔥 全局总开销 (Total)`, C.yellow + C.bold, tot));

  if (tot.byModel && tot.byModel.length > 0) {
    lines.push('');
    lines.push(`${C.bold}🤖 按返回模型 ID 统计（含平均 TTFT 与 E2E TPS）:${C.reset}`);
    for (const m of tot.byModel) {
      lines.push(
        `  • ${C.yellow}${padEndVis(m.responseModel, 22)}${C.reset} ` +
          `调用:${padStartVis(String(m.callCount), 4)}  ` +
          `In:${padStartVis(fmtShort(m.inputTokens), 7)}  ` +
          `Cache:${padStartVis(fmtShort(m.cacheReadTokens), 7)}(${padStartVis(m.cacheHitRate + '%', 5)})  ` +
          `Out:${padStartVis(fmtShort(m.outputTokens), 7)}  ` +
          `Σ:${C.bold}${padStartVis(fmtShort(m.totalTokens), 7)}${C.reset}  ` +
          `TTFT:${C.cyan}${padStartVis(fmtTtft(m.avgTtftSeconds), 7)}${C.reset}  ` +
          `E2E:${C.green}${padStartVis(fmtTps(m.avgE2eTps), 9)}${C.reset}`
      );
    }
  }

  if (sub.items && sub.items.length > 0) {
    lines.push('');
    const sortedSubs = [...sub.items].sort(
      (a, b) => (b.summary.totalTokens || 0) - (a.summary.totalTokens || 0)
    );
    const limit = showAllSubs ? sortedSubs.length : 10;
    const shown = sortedSubs.slice(0, limit);
    lines.push(
      `${C.bold}${C.purple}🌿 派生 Subagent 会话明细 (${
        shown.length < sortedSubs.length
          ? `Top ${shown.length} / 共 ${sortedSubs.length} 个，加 --all 查看全部`
          : `共 ${sortedSubs.length} 个`
      }):${C.reset}`
    );
    for (const s of shown) {
      lines.push(
        `  • ${C.cyan}${s.conversationId.slice(0, 8)}…${C.reset} ` +
          `${padEndVis(s.title.slice(0, 26), 27)} ` +
          `${C.yellow}${padEndVis(s.responseModel, 23)}${C.reset} ` +
          `调用:${padStartVis(String(s.summary.callCount), 4)}  ` +
          `In:${padStartVis(fmtShort(s.summary.inputTokens), 7)}  ` +
          `Cache:${padStartVis(fmtShort(s.summary.cacheReadTokens), 8)}  ` +
          `Out:${padStartVis(fmtShort(s.summary.outputTokens), 7)}  ` +
          `Σ:${C.bold}${padStartVis(fmtShort(s.summary.totalTokens), 8)}${C.reset}`
      );
    }
  }

  lines.push(rule);
  // 4. Recent 6 Calls
  const recent = activeSession.calls.slice(-6);
  lines.push(`${C.bold}📋 最近 ${recent.length} 次模型调用 (共 ${activeSession.calls.length} 次):${C.reset}`);
  for (const c of recent) {
    const stepStr = c.firstStep === c.lastStep ? `${c.firstStep}` : `${c.firstStep}-${c.lastStep}`;
    const ttftStr = c.ttftSeconds !== null && c.ttftSeconds !== undefined ? `${c.ttftSeconds}s` : '-';
    const tpsVal = c.e2eTokensPerSecond !== undefined ? c.e2eTokensPerSecond : c.tokensPerSecond;
    const tpsStr = tpsVal !== null && tpsVal !== undefined ? `${tpsVal} t/s` : '-';
    lines.push(
      `  #${padEndVis(String(c.callIndex), 3)} ` +
        `${C.dim}T${c.turnIndex}(${padEndVis(stepStr, 7)})${C.reset} ` +
        `${C.yellow}${padEndVis(c.responseModel, 20)}${C.reset} ` +
        `📥${padStartVis(fmtShort(c.inputTokens), 6)} ` +
        `⚡${C.green}${padStartVis(fmtShort(c.cacheReadTokens), 6)}${C.reset}(${padStartVis(c.cacheHitRate + '%', 5)}) ` +
        `📤${padStartVis(fmtShort(c.outputTokens), 6)} ` +
        `⏱${padStartVis(ttftStr, 6)} ` +
        `🚀${padStartVis(tpsStr, 9)}`
    );
  }
  lines.push(rule);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes('--watch') || args.includes('-w');
  const showAllSubs = args.includes('--all') || args.includes('-a');
  const positional = args.filter((a) => !a.startsWith('-'));

  const runOnce = async () => {
    const targetId = positional[0] || resolveDefaultSessionId();
    const report = await getFullSessionReport(targetId);
    if (watchMode) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    console.log(renderAnsiDashboard(report, showAllSubs));
    if (watchMode) {
      console.log(`${C.dim}正在实时监听会话状态 (每 2 秒自动刷新，按 Ctrl+C 退出)...${C.reset}`);
    }
  };

  await runOnce();
  if (watchMode) {
    setInterval(() => {
      runOnce().catch(() => {});
    }, 2000);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
