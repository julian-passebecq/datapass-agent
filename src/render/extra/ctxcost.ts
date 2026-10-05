// Add-on screen "Context cost": how many tokens each tool / method puts into the agent's context, as horizontal
// log-scale bars (median / p90 per call, or total in the period) against a context-window line, with "N× the
// smallest" labels, a table and one data-only tip per tool. Sizes come from facts.toolResultChars (characters of
// tool results as recorded; content never kept). Logic in src/activity/ctxcost.ts; this file only renders (escaped).
import {
  BIG_RESULT_TOKENS, CtxGroup, ctxCost, CtxMetric, CtxRow, fmt, logAxis, logPos, metricChars, sortRows, timesSmallest, tip, tokensOf,
} from '../../activity/ctxcost';
import { inPeriod, isPeriod, Period } from '../../activity/explore';
import { identityColor } from '../../activity/insights';
import { DEFAULT_WINDOW } from '../../activity/health';
import type { AgentSessionSnapshot } from '../../model';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { kpi, repoOf } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const MAX_ROWS = 40;

const EV: Record<string, string> = {
  OBSERVED: 'OBSERVED: read from the provider artifact as recorded.',
  DERIVED: 'DERIVED: computed deterministically from recorded values.',
  INFERRED: 'INFERRED: an estimate, not a provider fact.',
  UNKNOWN: 'UNKNOWN: not recorded.',
};
function ev(kind: keyof typeof EV, basis: string): string {
  return `<span class="cc-ev ${kind}" title="${esc(`${EV[kind]} ${basis}`)}">${kind.toLowerCase()}</span>`;
}

const T_TOK = `≈ chars / 4: tokens are estimated from the recorded character count of each tool result (no tokenizer; the provider records no per-result token count)`;
const T_SAMPLES = 'percentiles over the latest 200 recorded results per tool per session (facts.toolResultChars samples)';
const METRIC_LABEL: Record<CtxMetric, string> = { p50: 'median tokens per call', p90: 'p90 tokens per call', total: 'total tokens in period' };

interface Cfg {
  period: Period;
  metric: CtxMetric;
  group: CtxGroup;
  window: number;
  windowSource: string;
}

function settingWindow(d: WsData): number {
  const w = d.config?.<unknown>('agent.health.contextWindow', DEFAULT_WINDOW);
  return typeof w === 'number' && Number.isFinite(w) && w >= 1000 && w <= 10_000_000 ? Math.round(w) : DEFAULT_WINDOW;
}

function cfg(d: WsData, st: WsState): Cfg {
  const p = opt(st, 'ctxcost.period', '7d');
  const m = opt(st, 'ctxcost.metric', 'p50');
  const g = opt(st, 'ctxcost.group', 'tool');
  const w = opt(st, 'ctxcost.window', 'setting');
  const fixed: Record<string, number> = { '200k': 200_000, '272k': 272_000, '1m': 1_000_000 };
  return {
    period: isPeriod(p) ? p : '7d',
    metric: m === 'p90' || m === 'total' ? m : 'p50',
    group: g === 'provider' || g === 'repo' ? g : 'tool',
    window: fixed[w] ?? settingWindow(d),
    windowSource: fixed[w] ? 'chosen reference' : 'setting agent.health.contextWindow',
  };
}

function color(r: CtxRow, group: CtxGroup): string {
  if (group === 'repo') return identityColor(r.label);
  if (r.providers.length === 1) return r.providers[0] === 'codex' ? 'var(--codex)' : 'var(--claude)';
  return 'var(--accent)';
}

function times(x: number | undefined): string {
  if (x === undefined) return '';
  if (x < 1.05) return 'smallest';
  return `${x < 10 ? x.toFixed(1).replace(/\.0$/, '') : Math.round(x).toLocaleString()}× the smallest`;
}

function rowTip(r: CtxRow, c: Cfg): string {
  const t = (n: number | undefined) => (n === undefined ? '—' : `≈${fmt(tokensOf(n))}`);
  return [
    r.label,
    `${r.calls} results · ${r.sessions} session${r.sessions > 1 ? 's' : ''} · ${r.providers.join(' + ')}`,
    `median ${t(r.p50Chars)} · p90 ${t(r.p90Chars)} · max ${t(r.maxChars)} · total ${t(r.chars)} tokens`,
    `${r.chars.toLocaleString()} characters recorded (OBSERVED)`,
    r.partial ? 'partial: some session had more results in the period than samples kept' : '',
    `window line: ${fmt(c.window)} (${c.windowSource})`,
  ].filter(Boolean).join('\n');
}

function chart(rows: CtxRow[], c: Cfg): string {
  const vals = rows.map(r => metricChars(r, c.metric)).filter((v): v is number => v !== undefined && v > 0).map(tokensOf);
  if (!vals.length) return '<div class="muted cc-note">No tool result with a recorded size in this period.</div>';
  const ax = logAxis(vals, c.window);
  const smallest = Math.min(...vals);
  const winX = logPos(c.window, ax);
  const win = `<s class="cc-win" style="left:${winX.toFixed(2)}%"></s>`;
  let h = `<div class="cc-chart" role="img" aria-label="${esc(`${METRIC_LABEL[c.metric]} per ${c.group}, log scale`)}">`;
  h += `<div class="cc-row cc-head"><span></span><span class="cc-t cc-wl"><em style="left:${winX.toFixed(2)}%" title="${esc(`reference context window: ${c.windowSource}`)}">${esc(fmt(c.window))}-token context window</em></span><span></span></div>`;
  for (const r of rows) {
    const v = metricChars(r, c.metric);
    const tk = v === undefined ? undefined : tokensOf(v);
    const x = tk === undefined ? 0 : logPos(tk, ax);
    const ratio = timesSmallest(tk, smallest);
    h += `<div class="cc-row" title="${esc(rowTip(r, c))}"><span class="cc-l">${esc(r.label)}</span><span class="cc-t"><i style="width:${Math.max(0.5, x).toFixed(2)}%;background:${esc(color(r, c.group))}"></i>${win}</span><span class="cc-v"><b>${tk === undefined ? '—' : `≈${esc(fmt(tk))}`}</b> <span class="muted">${esc(times(ratio))}</span></span></div>`;
  }
  h += `<div class="cc-row cc-axis"><span></span><span class="cc-t">${ax.ticks.map(t => `<em style="left:${logPos(t, ax).toFixed(2)}%">${esc(fmt(t))}</em>`).join('')}</span><span class="muted">tokens (≈, log)</span></div>`;
  return h + '</div>';
}

function table(rows: CtxRow[], c: Cfg): string {
  const t = (n: number | undefined) => (n === undefined ? '—' : esc(fmt(tokensOf(n))));
  const head = ['', 'Results', 'Median', 'p90', 'Max', 'Total', 'Share', 'Tip'];
  const hTip = [
    '', 'OBSERVED: tool results recorded in the period', `DERIVED · ${T_SAMPLES} · tokens INFERRED ${T_TOK}`, `DERIVED · ${T_SAMPLES}`,
    'OBSERVED largest result (tokens INFERRED ≈ chars / 4)', 'OBSERVED sum of characters (tokens INFERRED ≈ chars / 4)', 'DERIVED: share of all tool-result characters in the period',
    `Data-only hint: results ≥ ${fmt(BIG_RESULT_TOKENS)} tokens (≈), p90 ≥ 5× median, or ≥ 30 % of all context`,
  ];
  let h = `<table class="cc-tb"><thead><tr>${head.map((x, i) => `<th title="${esc(hTip[i])}">${esc(x)}</th>`).join('')}</tr></thead><tbody>`;
  for (const r of rows) {
    const tp = tip(r, c.window);
    h += `<tr><td><span class="cc-dot" style="background:${esc(color(r, c.group))}"></span>${esc(r.label)}${r.partial ? ' <span class="muted" title="some session had more results in the period than samples kept: totals undercount">partial</span>' : ''}</td><td>${r.calls.toLocaleString()}</td><td>${t(r.p50Chars)}</td><td>${t(r.p90Chars)}</td><td>${t(r.maxChars)}</td><td>${t(r.chars)}</td><td><span class="cc-sh"><i style="width:${(r.share * 100).toFixed(1)}%"></i></span>${esc((r.share * 100).toFixed(r.share < 0.1 ? 1 : 0))} %</td><td class="cc-tip">${esc(tp)}</td></tr>`;
  }
  return h + '</tbody></table>';
}

// ---------------------------------------------------------------- provider token facts (shared with Health)

type Kind = 'OBSERVED' | 'DERIVED' | 'INFERRED' | 'UNKNOWN';

/** One provider token / compaction fact summed over sessions, with its evidence kind and basis. */
export interface TokenFact {
  value?: number;
  /** Sessions that record the field. */
  sessions: number;
  kind: Kind;
  basis: string;
}

export interface TokenFacts {
  sessions: number;
  /** Compactions: count (facts.compactions, or the recorded compact list when larger) and the latest compact record. */
  compacts: TokenFact;
  lastCompact?: { at: number; trigger?: string; preTokens?: number; postTokens?: number; window?: number };
  lastCompactKind: Kind;
  cacheRead: TokenFact;
  cacheWrite: TokenFact;
  reasoning: TokenFact;
}

/** Cache reads are OBSERVED when the provider adapter recorded its usage fields as read; otherwise DERIVED. */
function cacheReadKind(s: AgentSessionSnapshot): Kind {
  const ev = s.evidence ?? [];
  if (ev.some(e => e.field === 'usage.fields' && e.kind === 'OBSERVED')) return 'OBSERVED';
  if (s.provider === 'codex' && ev.some(e => e.field === 'usage' && e.kind === 'OBSERVED')) return 'OBSERVED';
  return 'DERIVED';
}

/**
 * Compactions, prompt-cache reads / writes and reasoning output tokens over a set of sessions, as the providers record
 * them. Pure. A field no session records stays UNKNOWN (value undefined), never 0.
 */
export function tokenFacts(sessions: AgentSessionSnapshot[]): TokenFacts {
  let compacts = 0, compactSessions = 0, read = 0, readN = 0, readDerived = false, write = 0, writeN = 0, reas = 0, reasN = 0;
  let last: TokenFacts['lastCompact'];
  for (const s of sessions) {
    const list = s.facts?.compacts ?? [];
    const n = Math.max(s.facts?.compactions ?? 0, list.length);
    if (s.facts?.compactions !== undefined || list.length) compactSessions++;
    compacts += n;
    for (const c of list) if (!last || c.at > last.at) last = { at: c.at, trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens, window: c.window };
    const u = s.usage;
    if (!u) continue;
    if (typeof u.cachedInputTokens === 'number') {
      read += u.cachedInputTokens;
      readN++;
      if (cacheReadKind(s) !== 'OBSERVED') readDerived = true;
    }
    if (typeof u.cacheCreationInputTokens === 'number') {
      write += u.cacheCreationInputTokens;
      writeN++;
    }
    if (typeof u.reasoningOutputTokens === 'number') {
      reas += u.reasoningOutputTokens;
      reasN++;
    }
  }
  const fact = (v: number, n: number, kind: Kind, basis: string, none: string): TokenFact =>
    n ? { value: v, sessions: n, kind, basis } : { sessions: 0, kind: 'UNKNOWN', basis: none };
  return {
    sessions: sessions.length,
    compacts: fact(compacts, compactSessions, 'OBSERVED', 'compaction records (Claude compact_boundary, Codex compacted) summed over sessions', 'no compaction record in these sessions'),
    lastCompact: last,
    lastCompactKind: last ? 'OBSERVED' : 'UNKNOWN',
    cacheRead: fact(read, readN, readDerived ? 'DERIVED' : 'OBSERVED', readDerived ? 'cache reads summed from usage records the adapter did not mark as read field by field' : 'Claude cache_read_input_tokens / Codex cached_input_tokens as recorded, summed over sessions', 'no usage recorded'),
    cacheWrite: fact(write, writeN, 'OBSERVED', 'Claude cache_creation_input_tokens / Codex cache_write_input_tokens as recorded, summed over sessions that record it', 'no session records cache writes'),
    reasoning: fact(reas, reasN, 'OBSERVED', 'Codex reasoning_output_tokens as recorded (part of output tokens), summed over sessions that record it', 'no session records reasoning output tokens (Claude Code does not)'),
  };
}

function factChip(kind: Kind, basis: string): string {
  return `<span class="chip ev ${esc(kind)}" title="${esc(`${kind}: ${basis}`)}">${esc(kind)}</span>`;
}

function agoText(now: number, t: number): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** A strip of small facts: compactions (count, latest), cache read / write, reasoning tokens, each with its evidence chip. */
export function tokenFactsStrip(f: TokenFacts, now: number, cls = 'tf'): string {
  const v = (x: TokenFact) => (x.value === undefined ? '—' : fmt(x.value));
  const of = (x: TokenFact) => (x.sessions && x.sessions < f.sessions ? ` <span class="muted">(${x.sessions}/${f.sessions} sessions)</span>` : '');
  const lc = f.lastCompact;
  const lcText = lc
    ? `${agoText(now, lc.at)}${lc.trigger ? ` · ${lc.trigger}` : ''}${lc.preTokens !== undefined ? ` · ${fmt(lc.preTokens)}→${lc.postTokens !== undefined ? fmt(lc.postTokens) : '?'}` : ''}${lc.window !== undefined ? ` · window ${lc.window}` : ''}`
    : '—';
  const item = (label: string, value: string, chip: string, extra = '') => `<span class="${cls}-i"><span class="muted">${esc(label)}</span> <b>${esc(value)}</b>${extra}${chip}</span>`;
  return `<div class="${cls}" data-facts="tokens">${[
    item('Compactions', f.compacts.value === undefined ? '—' : String(f.compacts.value), factChip(f.compacts.kind, f.compacts.basis), of(f.compacts)),
    item('Last compact', lcText, factChip(f.lastCompactKind, lc ? `latest recorded compact record${lc.trigger ? ' (trigger, pre → post tokens)' : ''}` : 'no compact record with a time (only a count, or none)')),
    item('Cache read', v(f.cacheRead), factChip(f.cacheRead.kind, f.cacheRead.basis), of(f.cacheRead)),
    item('Cache write', v(f.cacheWrite), factChip(f.cacheWrite.kind, f.cacheWrite.basis), of(f.cacheWrite)),
    item('Reasoning out', v(f.reasoning), factChip(f.reasoning.kind, f.reasoning.basis), of(f.reasoning)),
  ].join('')}</div>`;
}

export const TOKEN_FACTS_CSS = (cls: string) => `
.${cls} { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; font-size: 11px; margin: 4px 0 8px; }
.${cls}-i { white-space: nowrap; }
`;

export function renderCtxCost(d: WsData, st: WsState): string {
  const c = cfg(d, st);
  const res = ctxCost(d.sessions, { period: c.period, now: d.now, group: c.group, repoOf });
  const rows = sortRows(res.rows, c.metric);
  const shown = rows.slice(0, MAX_ROWS);
  let h = '<div class="cc">';
  h += toolbar(
    seg(st, 'ctxcost.metric', [['p50', 'Median / call'], ['p90', 'p90 / call'], ['total', 'Total in period']], 'p50', 'Bar length'),
    seg(st, 'ctxcost.group', [['tool', 'Tool'], ['provider', 'Tool × provider'], ['repo', 'Repo']], 'tool', 'Group by'),
    seg(st, 'ctxcost.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period'),
    seg(st, 'ctxcost.window', [['setting', `${fmt(settingWindow(d))} (setting)`], ['200k', '200k'], ['272k', '272k'], ['1m', '1M']], 'setting', 'Context-window reference line'),
  );
  const largest = rows.length ? sortRows(rows, 'p50')[0] : undefined;
  h += `<div class="kpis">${kpi(`≈${fmt(tokensOf(res.totalChars))}`, 'Tool-result tokens', '', `INFERRED ${T_TOK}; ${res.totalChars.toLocaleString()} characters OBSERVED`)}${kpi(res.totalCalls.toLocaleString(), 'Tool results', '', 'OBSERVED: tool_result / function_call_output records in the period')}${kpi(rows.length, c.group === 'repo' ? 'Repos' : 'Tools')}${largest?.p50Chars ? kpi(`≈${fmt(tokensOf(largest.p50Chars))}`, `Largest median · ${largest.label}`, '', `DERIVED · ${T_SAMPLES}`) : ''}</div>`;
  h += `<div class="cc-note muted">Bars: ${esc(METRIC_LABEL[c.metric])} on a log scale ${ev('OBSERVED', 'character length of the text of each tool_result (Claude) / function_call_output (Codex); content never kept; image results count as calls with no size (their token cost is not chars / 4)')} ${ev('DERIVED', T_SAMPLES)} ${ev('INFERRED', T_TOK)}${res.withoutData ? ` · ${res.withoutData} of ${res.sessions} session${res.sessions > 1 ? 's' : ''} in the period carry no tool-result size ${ev('UNKNOWN', 'no tool result recorded, or loaded before this field existed')}` : ''}${res.partial ? ' · some totals are partial (sessions that started before the period with more than 200 results per tool)' : ''}.</div>`;
  h += `<h3>Prompt cache, reasoning and compactions <span class="muted cc-sub">sessions active in the period, as the providers record them</span></h3>`;
  h += tokenFactsStrip(tokenFacts(inPeriod(d.sessions, { period: c.period, now: d.now })), d.now, 'cc-tf');
  h += chart(shown, c);
  if (rows.length > shown.length) h += `<div class="cc-note muted">+${rows.length - shown.length} more not shown (smallest).</div>`;
  const tips = shown.map(r => [r, tip(r, c.window)] as const).filter(([, t]) => t).slice(0, 6);
  if (tips.length) h += `<h3>Tips <span class="muted cc-sub">computed from the numbers above, no AI</span></h3><ul class="cc-tips">${tips.map(([r, t]) => `<li><b>${esc(r.label)}</b>: ${esc(t)}</li>`).join('')}</ul>`;
  if (shown.length) h += `<h3>Detail <span class="muted cc-sub">tokens ≈ chars / 4</span></h3>${table(shown, c)}`;
  return h + '</div>';
}

const CSS = TOKEN_FACTS_CSS('cc-tf') + `
.cc h3 { font-size: 12px; margin: 12px 0 4px; }
.cc-sub { font-weight: normal; font-size: 11px; }
.cc-note { font-size: 11px; margin: 4px 0 8px; }
.cc-ev { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; color: var(--vscode-descriptionForeground); cursor: help; }
.cc-ev.OBSERVED { border-color: var(--ok); }
.cc-ev.DERIVED { border-color: var(--accent); }
.cc-ev.INFERRED { border-color: var(--warn); border-style: dashed; }
.cc-ev.UNKNOWN { border-style: dotted; }
.cc-chart { display: flex; flex-direction: column; gap: 3px; }
.cc-row { display: grid; grid-template-columns: minmax(90px, 190px) 1fr minmax(120px, 170px); gap: 8px; align-items: center; font-size: 11px; }
.cc-l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.cc-t { position: relative; height: 14px; background: color-mix(in srgb, var(--line) 35%, transparent); border-radius: 2px; }
.cc-t i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; opacity: .9; }
.cc-win { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 1px dashed var(--vscode-foreground); opacity: .7; }
.cc-v { white-space: nowrap; }
.cc-head .cc-t, .cc-axis .cc-t { background: none; height: 14px; }
.cc-t em { position: absolute; transform: translateX(-50%); font-style: normal; font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.cc-wl em { transform: translateX(-100%); padding-right: 4px; color: var(--vscode-foreground); }
.cc-tips { margin: 2px 0; padding-left: 18px; font-size: 12px; }
.cc-tb { border-collapse: collapse; width: 100%; font-size: 11px; }
.cc-tb th, .cc-tb td { padding: 2px 6px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
.cc-tb th:first-child, .cc-tb td:first-child, .cc-tb td.cc-tip, .cc-tb th:last-child { text-align: left; }
.cc-tb th { cursor: help; font-weight: 600; }
.cc-tip { white-space: normal !important; color: var(--vscode-descriptionForeground); }
.cc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.cc-sh { display: inline-block; position: relative; width: 40px; height: 6px; margin-right: 4px; background: color-mix(in srgb, var(--line) 50%, transparent); border-radius: 3px; overflow: hidden; vertical-align: middle; }
.cc-sh i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); }
`;

export const ctxcostView: ExtraView = {
  id: 'ctxcost',
  label: 'Context cost',
  group: 'Usage',
  hint: 'How many tokens each tool puts into the agent context (median / p90 per call, total), log scale against the context window. Tokens ≈ chars / 4.',
  ready: true,
  render: renderCtxCost,
  css: CSS,
};
