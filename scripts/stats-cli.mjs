#!/usr/bin/env node
/**
 * @fileoverview CLI entry point for Antigravity Model Details & Usage Statistics.
 *
 * Usage:
 *   node scripts/stats-cli.mjs [conversationId] [--compact | --markdown | --json | --sessions]
 */

import { getFullSessionReport, listRecentSessions } from '../lib/stats-core.mjs';

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

function renderCompactSummary(report) {
  const { activeSession, costHierarchy } = report;
  const lt = activeSession.latestTurn;
  const cw = activeSession.contextWindow;
  const tot = costHierarchy.total;
  const main = costHierarchy.mainSession;
  const sub = costHierarchy.subagents;

  const lines = [];
  if (lt) {
    lines.push(
      `🏷 ${cw.responseModel} (${cw.modelDisplayName}) · 本条消息 #${lt.turnIndex} (${lt.callCount} 次调用) │ ` +
        `📥 新增 ${fmtShort(lt.inputTokens)} + ⚡缓存 ${fmtShort(lt.cacheReadTokens)}` +
        (lt.cacheWriteTokens > 0 ? ` + ✍️写入 ${fmtShort(lt.cacheWriteTokens)}` : '') +
        ` (${lt.cacheHitRate}%) │ ` +
        `📤 输出 ${fmtShort(lt.outputTokens)} (🧠思考 ${fmtShort(lt.thinkingTokens)} / 💬回复 ${fmtShort(lt.responseTokens)})`
    );
  }
  lines.push(
    `📊 上下文窗口: 实际 ${fmtShort(cw.actualTokensUsed)} / ${fmtShort(cw.maxContextTokens)} (${cw.actualPercent}%) · ` +
      `Antigravity 估算 ${fmtShort(cw.estimatedTokensUsed)} (${cw.estimatedPercent}%) · ` +
      `单次最大输出 ${fmtShort(cw.maxOutputTokens)}`
  );
  lines.push(
    `Σ 三级累计开销: 总计 ${fmtShort(tot.totalTokens)} (${tot.callCount} 次调用) = ` +
      `主会话 ${fmtShort(main.totalTokens)} (${main.callCount} 次) + ` +
      `Subagents[${sub.count}] ${fmtShort(sub.totalTokens)} (${sub.callCount} 次)`
  );
  return lines.join('\n');
}

function renderMarkdownReport(report) {
  const { activeSession, costHierarchy } = report;
  const lt = activeSession.latestTurn;
  const cw = activeSession.contextWindow;
  const tot = costHierarchy.total;
  const main = costHierarchy.mainSession;
  const sub = costHierarchy.subagents;
  const q = activeSession.currentQuota;

  const out = [];
  out.push(`## 📊 模型详情与 Token 用量统计报告`);
  out.push(
    `> **当前会话**: \`${activeSession.conversationId}\` (${activeSession.title || '未命名'}) · **数据源**: \`${activeSession.dataSource.toUpperCase()}\``
  );
  out.push('');
  out.push(`### 1. 紧凑概览（当前消息 + 上下文窗口）`);
  out.push('```text');
  out.push(renderCompactSummary(report));
  out.push('```');
  out.push('');

  out.push(`### 2. 当前模型与上下文窗口详情`);
  out.push(`| 指标 | 数值 | 说明 |`);
  out.push(`| :--- | :--- | :--- |`);
  out.push(`| **实际返回模型 ID** | \`${cw.responseModel}\` | 显示名: **${cw.modelDisplayName}** |`);
  out.push(`| **内部枚举 / 提供商** | \`${cw.modelEnum}\` | \`${cw.apiProvider}\` |`);
  if (q && q.remainingPercent !== null) {
    out.push(
      `| **当前模型配额剩余** | **${q.remainingPercent}%** | 重置时间: \`${q.resetTime || '-'}\` |`
    );
  }
  out.push(
    `| **上下文窗口（服务商实际值）** | **${fmtNum(cw.actualTokensUsed)} / ${fmtNum(cw.maxContextTokens)}** (**${cw.actualPercent}%**) | 剩余可用: ${fmtNum(cw.remainingTokens)} tokens |`
  );
  out.push(
    `| **上下文窗口（Antigravity 估算值）** | ${fmtNum(cw.estimatedTokensUsed)} / ${fmtNum(cw.maxContextTokens)} (${cw.estimatedPercent}%) | 用于内部压缩阈值判断 |`
  );
  out.push(`| **单次最大输出上限** | ${fmtNum(cw.maxOutputTokens)} tokens | Planner 配置上限 |`);
  out.push('');

  if (cw.breakdownGroups && cw.breakdownGroups.length > 0) {
    out.push(`#### 🧩 上下文窗口结构拆解 (估算基准)`);
    out.push(`| 分组 | Token 数量 | 占比 | Top 子项 |`);
    out.push(`| :--- | ---: | ---: | :--- |`);
    for (const g of cw.breakdownGroups) {
      const topStr = g.topChildren
        .slice(0, 4)
        .map((c) => `\`${c.name}\` (${fmtNum(c.numTokens)})`)
        .join(', ');
      out.push(`| **${g.name}** | ${fmtNum(g.numTokens)} | ${g.ratioPercent}% | ${topStr || '-'} |`);
    }
    out.push('');
  }

  out.push(`### 3. 三级累计开销汇总（总开销 = 主会话 + Subagents）`);
  out.push(
    `| 统计层级 | 调用次数 | 新增输入 (Input) | 缓存命中 (Cached) | 缓存写入 (Write) | 缓存命中率 | 总输出 (Output) | 🧠 思考 (Thinking) | 💬 回复 (Response) | **总计 Token** |`
  );
  out.push(`| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  const rowFmt = (label, item) =>
    `| **${label}** | ${fmtNum(item.callCount)} | ${fmtNum(item.inputTokens)} | ${fmtNum(item.cacheReadTokens)} | ${fmtNum(item.cacheWriteTokens)} | ${item.cacheHitRate}% | ${fmtNum(item.outputTokens)} | ${fmtNum(item.thinkingTokens)} | ${fmtNum(item.responseTokens)} | **${fmtNum(item.totalTokens)}** |`;
  if (lt) {
    out.push(rowFmt(`本条消息 (#${lt.turnIndex})`, lt));
  }
  out.push(rowFmt('主会话 (Main)', main));
  out.push(rowFmt(`子代理合计 (Subagents ×${sub.count})`, sub));
  out.push(rowFmt('🔥 全局总开销 (Grand Total)', tot));
  out.push('');

  if (tot.byModel && tot.byModel.length > 0) {
    out.push(`#### 🤖 按模型分类累计开销（含主会话与 Subagents）`);
    out.push(
      `| 返回模型 ID | 显示名称 | 调用次数 | 新增输入 | 缓存命中 | 缓存命中率 | 总输出 (思考 / 回复) | 总计 Token |`
    );
    out.push(`| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const m of tot.byModel) {
      out.push(
        `| \`${m.responseModel}\` | ${m.modelDisplayName} | ${fmtNum(m.callCount)} | ${fmtNum(m.inputTokens)} | ${fmtNum(m.cacheReadTokens)} | ${m.cacheHitRate}% | ${fmtNum(m.outputTokens)} (${fmtNum(m.thinkingTokens)} / ${fmtNum(m.responseTokens)}) | **${fmtNum(m.totalTokens)}** |`
      );
    }
    out.push('');
  }

  if (sub.items && sub.items.length > 0) {
    out.push(`#### 🌿 Subagent 独立会话明细 (${sub.items.length} 个)`);
    out.push(
      `| Subagent 会话 ID | 角色 / 名称 | 模型 | 调用次数 | 新增输入 | 缓存命中 | 总输出 | 总计 Token | 上下文峰值 |`
    );
    out.push(`| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const s of sub.items) {
      out.push(
        `| \`${s.conversationId.slice(0, 8)}…\` | ${s.title} (\`${s.agentName}\`) | \`${s.responseModel}\` | ${fmtNum(s.summary.callCount)} | ${fmtNum(s.summary.inputTokens)} | ${fmtNum(s.summary.cacheReadTokens)} | ${fmtNum(s.summary.outputTokens)} | **${fmtNum(s.summary.totalTokens)}** | ${fmtShort(s.contextWindow.actualTokensUsed)} (${s.contextWindow.actualPercent}%) |`
      );
    }
    out.push('');
  }

  const recentCalls = activeSession.calls.slice(-10);
  if (recentCalls.length > 0) {
    out.push(
      `### 4. 最近 ${recentCalls.length} 次模型调用明细（共 ${activeSession.calls.length} 次）`
    );
    out.push(
      `| # | 轮次 | Step | 返回模型 ID | Input | Cached | 命中率 | Output (🧠/💬) | 实际上下文 | TTFT | 速率 |`
    );
    out.push(`| ---: | ---: | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const c of recentCalls) {
      const stepStr =
        c.firstStep === c.lastStep ? `${c.firstStep}` : `${c.firstStep}-${c.lastStep}`;
      const flags = [
        c.modelSwitched ? '🔄' : '',
        c.compressed ? '🗜️' : '',
        c.retryCount > 0 ? `🔁×${c.retryCount}` : '',
        c.hasError ? '⚠️' : '',
      ]
        .filter(Boolean)
        .join('');
      out.push(
        `| ${c.callIndex} | T${c.turnIndex} | \`${stepStr}\` | \`${c.responseModel}\` ${flags} | ${fmtNum(c.inputTokens)} | ${fmtNum(c.cacheReadTokens)} | ${c.cacheHitRate}% | ${fmtNum(c.outputTokens)} (${fmtNum(c.thinkingTokens)}/${fmtNum(c.responseTokens)}) | ${fmtShort(c.actualContextTokens)} (${c.actualContextRatio ?? '-'}%) | ${c.ttftSeconds !== null ? `${c.ttftSeconds}s` : '-'} | ${c.tokensPerSecond !== null ? `${c.tokensPerSecond} t/s` : '-'} |`
      );
    }
  }

  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const targetId = positional[0] || process.env.ANTIGRAVITY_CONVERSATION_ID || undefined;

  if (flags.has('--sessions')) {
    const sessions = await listRecentSessions(25);
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  const report = await getFullSessionReport(targetId);
  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.has('--compact')) {
    console.log(renderCompactSummary(report));
  } else {
    console.log(renderMarkdownReport(report));
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
