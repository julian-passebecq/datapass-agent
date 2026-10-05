// Add-on screen "Health": test pass rate, commits per session, context use against a reference window
// (272k by default, setting agent.health.contextWindow), compactions and tool errors, with sparklines.
// Logic lives in src/activity/health.ts; this file only renders (escaped).
import type { AgentSessionSnapshot } from '../../model';
import { Gran, isPeriod, Period } from '../../activity/explore';
import {
  ctxInfo, ctxLabel, DEFAULT_WINDOW, GROUPS, HealthGroup, HealthRow, healthRows, healthTotal, healthTrend, pct, tok, Trend, TREND_INFO, TREND_METRICS, TrendMetric,
} from '../../activity/health';
import { identityColor, isLive } from '../../activity/insights';
import { duration } from '../../activity/activity';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ago, repoOf, titleOf } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';
import { TOKEN_FACTS_CSS, tokenFacts, tokenFactsStrip } from './ctxcost';

// ---------------------------------------------------------------- settings (via feed)

export interface HealthConfig {
  /** Reference context window (tokens): the marker line and the window for sessions that record none. */
  window: number;
  /** Context % from which a bar turns red. */
  warn: number;
}

const CFG_FEED = 'health.config';
export function parseConfig(window: unknown, warn: unknown): HealthConfig {
  const w = typeof window === 'number' && Number.isFinite(window) && window >= 1000 && window <= 10_000_000 ? Math.round(window) : DEFAULT_WINDOW;
  const p = typeof warn === 'number' && Number.isFinite(warn) && warn >= 10 && warn <= 100 ? warn : 80;
  return { window: w, warn: p };
}

const cfgFeed: Feed<HealthConfig> = {
  id: CFG_FEED,
  intervalMs: 30_000,
  load: async ctx => parseConfig(ctx.config<unknown>('agent.health.contextWindow', DEFAULT_WINDOW), ctx.config<unknown>('agent.health.warnPercent', 80)),
};

function settings(): HealthConfig {
  return feedValue<HealthConfig>(CFG_FEED).value ?? { window: DEFAULT_WINDOW, warn: 80 };
}

// ---------------------------------------------------------------- options

type Sort = 'context' | 'pass' | 'commits' | 'recent';
type TrendChart = 'spark' | 'bars' | 'table';

interface Cfg {
  period: Period;
  leadsOnly: boolean;
  group: HealthGroup;
  sort: Sort;
  gran: Gran;
  trend: TrendChart;
  orient: 'h' | 'v';
  top: number;
  marker: number;
  warn: number;
}

function cfg(st: WsState): Cfg {
  const p = opt(st, 'health.period', '7d');
  const period: Period = isPeriod(p) ? p : '7d';
  const g = opt(st, 'health.group', 'session');
  const s = opt(st, 'health.sort', 'context');
  const gr = opt(st, 'health.gran', 'auto');
  const t = opt(st, 'health.trend', 'spark');
  const conf = settings();
  return {
    period,
    leadsOnly: opt(st, 'health.who', 'all') === 'leads',
    group: (GROUPS as readonly string[]).includes(g) ? (g as HealthGroup) : 'session',
    sort: s === 'pass' || s === 'commits' || s === 'recent' ? s : 'context',
    gran: gr === 'hour' || gr === 'day' || gr === 'week' ? gr : period === '24h' ? 'hour' : period === 'all' ? 'week' : 'day',
    trend: t === 'bars' || t === 'table' ? t : 'spark',
    orient: opt(st, 'health.orient', 'h') === 'v' ? 'v' : 'h',
    top: { '15': 15, '30': 30, all: 300 }[opt(st, 'health.top', '30')] ?? 30,
    marker: conf.window,
    warn: conf.warn / 100,
  };
}

// ---------------------------------------------------------------- small marks

const passCls = (r: number | undefined) => (r === undefined ? 'hl-q' : r >= 0.9 ? 'hl-ok' : r >= 0.6 ? 'hl-warn' : 'hl-bad');
const ctxCls = (p: number | undefined, warn: number) => (p === undefined ? 'hl-q' : p >= warn ? 'hl-bad' : p >= 0.5 ? 'hl-warn' : 'hl-ok');

/** Inline sparkline. `marker` (same unit as values) draws a dashed reference line. Gaps stay gaps. */
export function spark(values: (number | undefined)[], o: { w?: number; h?: number; max?: number; marker?: number; cls?: string; title?: string; bars?: boolean } = {}): string {
  const W = o.w ?? 120, H = o.h ?? 26, P = 2;
  const vals = values.map(v => (v === undefined || !Number.isFinite(v) ? undefined : v));
  const defined = vals.filter((v): v is number => v !== undefined);
  if (!defined.length) return `<span class="hl-nos muted" title="${esc(o.title ?? 'no data')}">—</span>`;
  const max = Math.max(o.max ?? 0, o.marker ?? 0, ...defined) || 1;
  const n = vals.length;
  const y = (v: number) => P + (H - 2 * P) * (1 - v / max);
  let svg = `<svg class="hl-sp ${esc(o.cls ?? '')}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="${W}" height="${H}" role="img"${o.title ? ` aria-label="${esc(o.title)}"` : ''}>${o.title ? `<title>${esc(o.title)}</title>` : ''}`;
  if (o.marker !== undefined && o.marker <= max) svg += `<line class="hl-mk" x1="0" x2="${W}" y1="${y(o.marker).toFixed(1)}" y2="${y(o.marker).toFixed(1)}"/>`;
  if (o.bars) {
    const bw = W / n;
    vals.forEach((v, i) => {
      if (v !== undefined) svg += `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0.8, H - P - y(v)).toFixed(1)}"/>`;
    });
  } else {
    const x = (i: number) => (n === 1 ? W / 2 : P + ((W - 2 * P) * i) / (n - 1));
    let seg: string[] = [];
    const flush = () => {
      if (seg.length > 1) svg += `<polyline points="${seg.join(' ')}"/>`;
      seg = [];
    };
    vals.forEach((v, i) => {
      if (v === undefined) return flush();
      seg.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    flush();
    const li = vals.map((v, i) => (v === undefined ? -1 : i)).filter(i => i >= 0).pop()!;
    svg += `<circle cx="${x(li).toFixed(1)}" cy="${y(vals[li]!).toFixed(1)}" r="2"/>`;
  }
  return svg + '</svg>';
}

/** Context meter: solid = latest call, light = peak, dashed marker = reference window. Scale = max(window, marker, peak). */
function ctxMeter(c: ReturnType<typeof ctxInfo>, marker: number, warn: number): string {
  if (c.now === undefined && c.peak === undefined) return '<span class="muted">not recorded</span>';
  const scale = Math.max(c.window, marker, c.peak ?? 0) * 1.02;
  const w = (v: number | undefined) => (v === undefined ? 0 : Math.min(100, (100 * v) / scale));
  const win = c.windowSource === 'OBSERVED' && c.window !== marker ? `<b class="hl-win" style="left:${w(c.window).toFixed(2)}%" title="${esc(`window ${tok(c.window)} (OBSERVED, provider token_count)`)}"></b>` : '';
  return `<span class="hl-m ${ctxCls(c.pct, warn)}" title="${esc(`latest ${ctxLabel(c)} · peak ${ctxLabel(c, 'peak')} · window ${c.windowSource === 'OBSERVED' ? 'OBSERVED' : 'reference (setting agent.health.contextWindow)'}`)}"><i class="pk" style="width:${w(c.peak).toFixed(2)}%"></i><i class="nw" style="width:${w(c.now).toFixed(2)}%"></i><b class="hl-mark" style="left:${w(marker).toFixed(2)}%"></b>${win}</span>`;
}

// ---------------------------------------------------------------- sections

function kpis(c: Cfg, t: HealthRow, live: AgentSessionSnapshot[]): string {
  const k = (v: string, label: string, cls: string, title: string) => `<div class="kpi ${cls}" title="${esc(title)}"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
  const hottest = live.map(s => ({ s, c: ctxInfo(s, c.marker) })).filter(x => x.c.now !== undefined).sort((a, b) => (b.c.pct ?? 0) - (a.c.pct ?? 0))[0];
  return `<div class="kpis big hl-k">${[
    k(pct(t.passRate), 'Test pass rate', passCls(t.passRate), `DERIVED: ${t.pass} passing ÷ ${t.pass + t.fail} decided test / build runs in the period${t.unknownTests ? ` (${t.unknownTests} without result left out)` : ''}`),
    k(`${t.pass}✓ ${t.fail}✗`, 'Runs', '', 'OBSERVED: test / build runs with a provider-recorded result (exit code or tool status)'),
    k(`${t.tested}/${t.sessions.length}`, 'Sessions tested', '', 'DERIVED: sessions that ran at least one test with a result in the period'),
    k(t.commitsPerSession === undefined ? '—' : t.commitsPerSession.toFixed(2), 'Commits / session', '', `DERIVED: ${t.commits} commits observed in the period ÷ ${t.leads} lead session(s)`),
    k(pct(t.avgPeakPct), 'Avg peak context', ctxCls(t.avgPeakPct, c.warn), `DERIVED: mean of each session's largest recorded prompt ÷ its window (recorded, else ${tok(c.marker)} reference)`),
    k(String(t.overMarker), `≥ ${tok(c.marker)}`, t.overMarker ? 'hl-warn' : '', `DERIVED: sessions whose largest recorded prompt reached the ${tok(c.marker)} reference marker`),
    k(String(t.compactions), 'Compactions', '', 'OBSERVED: context compactions recorded by the provider'),
    k(pct(t.toolErrorRate, 1), 'Tool errors', t.toolErrorRate && t.toolErrorRate > 0.1 ? 'hl-warn' : '', `DERIVED: ${t.toolErrors} tool results flagged as error ÷ ${t.tools} tool calls (provider flag)`),
    hottest ? k(ctxLabel(hottest.c), `Hottest live · ${titleOf(hottest.s).slice(0, 18)}`, ctxCls(hottest.c.pct, c.warn), `OBSERVED: context of the latest model call; window ${hottest.c.windowSource === 'OBSERVED' ? 'recorded' : 'reference'}`) : '',
  ].join('')}</div>`;
}

function bucketLabel(t: number, g: Gran): string {
  const d = new Date(t);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return g === 'hour' ? `${md} ${String(d.getHours()).padStart(2, '0')}h` : g === 'week' ? `wk ${md}` : md;
}

function fmtTrend(m: TrendMetric, v: number | undefined): string {
  if (v === undefined) return '—';
  return m === 'pass' || m === 'context' ? pct(v) : m === 'commits' ? v.toFixed(2) : Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function trends(c: Cfg, tr: Trend): string {
  if (!tr.x.length) return '';
  if (c.trend === 'table') {
    const rows = tr.x.map((t, i) => ({ t, i })).filter(({ i }) => TREND_METRICS.some(m => tr.values[m][i] !== undefined)).reverse();
    if (!rows.length) return `<div class="empty">No test, commit or context record in this period.</div>`;
    return `<table class="hl-t hl-tt"><tr><th>${esc(c.gran)}</th>${TREND_METRICS.map(m => `<th class="r" title="${esc(`${TREND_INFO[m].kind}: ${TREND_INFO[m].basis}`)}">${esc(TREND_INFO[m].label)}</th>`).join('')}</tr>${rows
      .slice(0, 60)
      .map(({ t, i }) => `<tr><td>${esc(bucketLabel(t, c.gran))}</td>${TREND_METRICS.map(m => `<td class="r ${m === 'pass' ? passCls(tr.values.pass[i]) : m === 'context' ? ctxCls(tr.values.context[i], c.warn) : ''}">${esc(fmtTrend(m, tr.values[m][i]))}</td>`).join('')}</tr>`)
      .join('')}</table>`;
  }
  const first = bucketLabel(tr.x[0], c.gran), last = bucketLabel(tr.x[tr.x.length - 1], c.gran);
  return `<div class="hl-tr">${TREND_METRICS.map(m => {
    const vals = tr.values[m];
    const def = vals.filter((v): v is number => v !== undefined);
    const latest = [...vals].reverse().find(v => v !== undefined);
    const mean = def.length ? def.reduce((a, b) => a + b, 0) / def.length : undefined;
    const ratio = m === 'pass' || m === 'context';
    const cls = m === 'pass' ? passCls(latest) : m === 'context' ? ctxCls(latest, c.warn) : 'hl-acc';
    const title = `${TREND_INFO[m].label} per ${c.gran}, ${first} → ${last} · ${TREND_INFO[m].kind}: ${TREND_INFO[m].basis}`;
    return `<div class="hl-tc" title="${esc(title)}"><div class="hl-th"><span>${esc(TREND_INFO[m].label)}</span><b class="${cls}">${esc(fmtTrend(m, latest))}</b></div>${spark(vals, { w: 220, h: 38, max: ratio ? 1 : undefined, marker: m === 'context' ? c.warn : undefined, cls, bars: c.trend === 'bars', title })}<div class="hl-tf muted"><span>${esc(first)}</span><span>${def.length ? `mean ${esc(fmtTrend(m, mean))} · ${def.length}/${vals.length} ${esc(c.gran)}s` : 'no data'}</span><span>${esc(last)}</span></div></div>`;
  }).join('')}</div>`;
}

function contextChart(c: Cfg, rows: HealthRow[], d: WsData, st: WsState): string {
  const list = rows.filter(r => r.ctx && r.ctx.peak !== undefined).sort((a, b) => (b.ctx!.peak ?? 0) - (a.ctx!.peak ?? 0)).slice(0, c.top);
  if (!list.length) return `<div class="empty">No context size recorded for sessions in this period.</div>`;
  const by = new Map(d.sessions.map(s => [s.key, s]));
  if (c.orient === 'v') {
    const scale = Math.max(c.marker, ...list.map(r => Math.max(r.ctx!.peak ?? 0, r.ctx!.windowSource === 'OBSERVED' ? r.ctx!.window : 0))) * 1.05;
    const h = (v: number | undefined) => (v === undefined ? 0 : Math.min(100, (100 * v) / scale));
    return `<div class="hl-cv"><b class="hl-cvm" style="bottom:${h(c.marker).toFixed(2)}%" title="${esc(`reference ${tok(c.marker)} (setting agent.health.contextWindow)`)}"><span>${esc(tok(c.marker))}</span></b>${list
      .map(r => {
        const s = by.get(r.sessions[0]);
        return `<div class="hl-cvc${st.selected === r.key ? ' sel' : ''}" data-select="${esc(r.key)}" tabindex="0" title="${esc(`${r.label} · ${s ? repoOf(s) : ''} · latest ${ctxLabel(r.ctx!)} · peak ${ctxLabel(r.ctx!, 'peak')}${r.compactions ? ` · ${r.compactions} compaction(s)` : ''}`)}"><span class="hl-cvb ${ctxCls(r.ctx!.pct, c.warn)}"><i class="pk" style="height:${h(r.ctx!.peak).toFixed(2)}%"></i><i class="nw" style="height:${h(r.ctx!.now).toFixed(2)}%"></i></span><span class="hl-cvl">${esc(r.label.slice(0, 14))}</span></div>`;
      })
      .join('')}</div>`;
  }
  return `<div class="hl-ch">${list
    .map(r => {
      const s = by.get(r.sessions[0]);
      const repo = s ? repoOf(s) : '';
      return `<div class="hl-chr${st.selected === r.key ? ' sel' : ''}" data-select="${esc(r.key)}" tabindex="0"><span class="hl-lab"><span class="dot ${esc(s?.status ?? 'UNKNOWN')}"></span> ${esc(r.label.slice(0, 48))}</span><span class="hl-repo muted"><span class="hl-sw" style="background:${identityColor(repo)}"></span>${esc(repo)}</span>${ctxMeter(r.ctx!, c.marker, c.warn)}<span class="hl-num ${ctxCls(r.ctx!.pct, c.warn)}">${esc(ctxLabel(r.ctx!))}</span>${spark(r.series ?? [], { w: 90, h: 18, marker: c.marker, cls: 'hl-acc', title: `context per model call · peak ${ctxLabel(r.ctx!, 'peak')}` })}<span class="hl-cmp muted" title="OBSERVED: compactions recorded">${r.compactions ? `⟲${r.compactions}` : ''}</span></div>`;
    })
    .join('')}</div><div class="legend"><span class="hl-lg nw"></span> latest call <span class="hl-lg pk"></span> peak <span class="hl-lg mk"></span> ${esc(tok(c.marker))} reference (agent.health.contextWindow) <span class="hl-lg win"></span> recorded window (Codex) · ⟲ compactions · sparkline = prompt size per recorded model call</div>`;
}

function sortRows(rows: HealthRow[], s: Sort): HealthRow[] {
  const key: Record<Sort, (r: HealthRow) => number> = {
    context: r => r.maxPeakPct ?? -1,
    pass: r => (r.passRate === undefined ? 2 : r.passRate), // worst first, untested last
    commits: r => r.commits,
    recent: r => r.lastAt,
  };
  const dir = s === 'pass' ? 1 : -1;
  return [...rows].sort((a, b) => dir * (key[s](a) - key[s](b)) || b.lastAt - a.lastAt);
}

function table(c: Cfg, rows: HealthRow[], d: WsData, st: WsState): string {
  if (!rows.length) return '';
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const per = c.group === 'session';
  const head = `<tr><th>${per ? 'Session' : esc(c.group[0].toUpperCase() + c.group.slice(1))}</th>${per ? '<th>Repo</th>' : '<th class="r">Sessions</th>'}<th class="r" title="OBSERVED: test / build runs with a result">Tests</th><th title="DERIVED: passing ÷ decided runs">Pass rate</th><th class="r" title="OBSERVED: commits in the period">Commits</th>${per ? '' : '<th class="r" title="DERIVED: commits ÷ lead sessions">/ session</th>'}<th title="${esc(per ? 'OBSERVED: latest prompt size / window' : 'DERIVED: mean and max of per-session peak ÷ window')}">Context</th>${per ? '<th>Trend</th>' : `<th class="r" title="DERIVED: sessions whose peak reached ${esc(tok(c.marker))}">≥ ${esc(tok(c.marker))}</th>`}<th class="r" title="OBSERVED: compactions recorded by the provider">⟲</th><th class="r" title="DERIVED: tool results flagged error ÷ tool calls">Tool err</th><th class="r" title="OBSERVED: time of the last recorded activity">Last</th></tr>`;
  const body = sortRows(rows, c.sort)
    .slice(0, per ? c.top * 2 : 200)
    .map(r => {
      const s = per ? by.get(r.key) : undefined;
      const pr = r.passRate;
      const passBar = pr === undefined ? '<span class="muted">no result</span>' : `<span class="hl-pb ${passCls(pr)}" title="${esc(`${r.pass} pass · ${r.fail} fail${r.unknownTests ? ` · ${r.unknownTests} no result` : ''}`)}"><i style="width:${(100 * pr).toFixed(1)}%"></i></span> <b class="${passCls(pr)}">${esc(pct(pr))}</b>`;
      const ctxCell = per
        ? r.ctx && r.ctx.now !== undefined
          ? `${ctxMeter(r.ctx, c.marker, c.warn)} <span class="hl-num ${ctxCls(r.ctx.pct, c.warn)}">${esc(ctxLabel(r.ctx))}</span>`
          : '<span class="muted">—</span>'
        : r.avgPeakPct !== undefined
          ? `<span class="${ctxCls(r.avgPeakPct, c.warn)}">avg ${esc(pct(r.avgPeakPct))}</span> <span class="muted">· max ${esc(pct(r.maxPeakPct))}${r.ctxPeak ? ` · ${esc(tok(r.ctxPeak))}` : ''}</span>`
          : '<span class="muted">—</span>';
      const attrs = per ? ` data-select="${esc(r.key)}" tabindex="0" class="${st.selected === r.key ? 'sel' : ''}"` : '';
      const name = per && s ? `<span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 56))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}` : `<span class="hl-sw" style="background:${c.group === 'provider' ? (r.key === 'Codex' ? 'var(--codex)' : 'var(--claude)') : identityColor(r.key)}"></span>${esc(r.label)}`;
      return `<tr${attrs}><td class="hl-name">${name}</td>${per ? `<td class="muted hl-rp">${s ? esc(repoOf(s)) : ''}</td>` : `<td class="r">${r.sessions.length}</td>`}<td class="r">${r.pass + r.fail ? `<span class="pass">${r.pass}✓</span> <span class="fail">${r.fail}✗</span>` : '<span class="muted">—</span>'}</td><td class="hl-prc">${passBar}</td><td class="r">${r.commits || '<span class="muted">0</span>'}</td>${per ? '' : `<td class="r">${r.commitsPerSession === undefined ? '—' : r.commitsPerSession.toFixed(2)}</td>`}<td class="hl-ctxc">${ctxCell}</td>${per ? `<td>${spark(r.series ?? [], { w: 80, h: 16, marker: c.marker, cls: 'hl-acc', title: 'prompt size per recorded model call' })}</td>` : `<td class="r${r.overMarker ? ' hl-warn' : ''}">${r.overMarker || '<span class="muted">0</span>'}</td>`}<td class="r">${r.compactions || '<span class="muted">0</span>'}</td><td class="r ${r.toolErrorRate && r.toolErrorRate > 0.1 ? 'hl-warn' : ''}" title="${esc(`${r.toolErrors} / ${r.tools}`)}">${r.tools ? esc(pct(r.toolErrorRate, 1)) : '<span class="muted">—</span>'}</td><td class="r muted">${esc(ago(d.now, r.lastAt) || '—')}</td></tr>`;
    })
    .join('');
  return `<table class="hl-t">${head}${body}</table>`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const o = { period: c.period, now: d.now, leadsOnly: c.leadsOnly, marker: c.marker };
  const tb1 = toolbar(
    seg(st, 'health.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period: sessions active in it; tests and commits counted when they happened in it'),
    seg(st, 'health.who', [['all', 'All'], ['leads', 'Leads only']], 'all', 'Include worker sessions (subagents) or only top-level sessions'),
    `<span class="muted">group</span>`,
    seg(st, 'health.group', [['session', 'Session'], ['repo', 'Repo'], ['provider', 'Provider'], ['model', 'Model']], 'session', 'Rows of the table'),
    `<span class="muted">sort</span>`,
    seg(st, 'health.sort', [['context', 'Context'], ['pass', 'Pass rate ↑'], ['commits', 'Commits'], ['recent', 'Recent']], 'context', 'Table order (pass rate: worst first)'),
  );
  const tb2 = toolbar(
    `<span class="muted">trend</span>`,
    seg(st, 'health.gran', [['auto', 'Auto'], ['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']], 'auto', 'Trend bucket'),
    seg(st, 'health.trend', [['spark', '⌇ Lines'], ['bars', '▥ Bars'], ['table', 'Table']], 'spark', 'Trend chart type'),
    `<span class="muted">context</span>`,
    seg(st, 'health.orient', [['h', '▤ Rows'], ['v', '▥ Columns']], 'h', 'Context chart orientation'),
    seg(st, 'health.top', [['15', 'Top 15'], ['30', 'Top 30'], ['all', 'All']], '30', 'Sessions in the context chart'),
  );
  const total = healthTotal(d.sessions, o);
  if (!total.sessions.length) return `<div class="hl">${tb1}${tb2}<div class="empty">No session active in this period. Try a longer period or All loaded (loaded history follows <code>agent.historyDays</code>).</div></div>`;
  const live = d.sessions.filter(isLive);
  const sessionRows = healthRows(d.sessions, 'session', o);
  const rows = c.group === 'session' ? sessionRows : healthRows(d.sessions, c.group, o);
  const tr = healthTrend(d.sessions, { ...o, gran: c.gran, maxBuckets: c.gran === 'hour' ? 72 : 60 });
  const noFacts = !d.sessions.some(s => s.facts?.calls?.length);
  const notes = [
    `Context: latest model call prompt size; "${esc(tok(c.marker))}" is the reference window from <code>agent.health.contextWindow</code>, used as the window when the provider records none (Claude Code). Codex records its window (OBSERVED).`,
    'Pass rate counts runs whose result the provider recorded (exit code or tool status); runs without a result are left out.',
    'Commits are those observed in the session window.',
    noFacts ? 'Per-call token records are not exposed in this build, so context peaks fall back to the latest call.' : '',
    `Period ${esc(c.period)} · ${total.sessions.length} session(s) · ${esc(duration(d.now - Math.min(...d.sessions.map(s => s.startedAt ?? d.now))))} of history loaded.`,
  ].filter(Boolean).join(' ');
  const keys = new Set(total.sessions);
  const facts = tokenFactsStrip(tokenFacts(d.sessions.filter(s => keys.has(s.key))), d.now, 'hl-pf');
  return `<div class="hl">${tb1}${tb2}${kpis(c, total, live)}${facts}<h2>Trends · per ${esc(c.gran)}</h2>${trends(c, tr)}<h2>Context use · ${esc(tok(c.marker))} marker</h2>${contextChart(c, sessionRows, d, st)}<h2>${c.group === 'session' ? 'Sessions' : `By ${esc(c.group)}`} · ${rows.length}</h2>${table(c, rows, d, st)}<div class="foot">${notes}</div></div>`;
}

const CSS = `
.hl .tb { margin: 0 0 6px; }
.hl .hl-k { margin: 6px 0 4px; }
.hl .kpi.hl-ok b, .hl .hl-ok { color: var(--ok); }
.hl .kpi.hl-warn b, .hl .hl-warn { color: var(--warn); }
.hl .kpi.hl-bad b, .hl .hl-bad { color: var(--bad); }
.hl .hl-q { color: var(--quiet); }
.hl .hl-acc { color: var(--accent); }
.hl .r { text-align: right; }
.hl .hl-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.hl svg.hl-sp { display: inline-block; vertical-align: middle; overflow: visible; }
.hl svg.hl-sp polyline { fill: none; stroke: currentColor; stroke-width: 1.6; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.hl svg.hl-sp circle, .hl svg.hl-sp rect { fill: currentColor; }
.hl svg.hl-sp rect { opacity: .85; }
.hl svg.hl-sp .hl-mk { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 3 3; stroke-width: 1; vector-effect: non-scaling-stroke; opacity: .7; }
.hl .hl-tr { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; max-width: 1100px; }
.hl .hl-tc { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 6px 8px 4px; min-width: 0; }
.hl .hl-tc svg.hl-sp { width: 100%; }
.hl .hl-th { display: flex; justify-content: space-between; align-items: baseline; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.hl .hl-th b { font-size: 16px; text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.hl .hl-tf { display: flex; justify-content: space-between; gap: 6px; font-size: 10px; }
.hl .hl-m { position: relative; display: inline-block; width: 140px; height: 8px; border-radius: 2px; background: var(--line); vertical-align: middle; }
.hl .hl-m i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: currentColor; }
.hl .hl-m i.pk { opacity: .3; }
.hl .hl-m b.hl-mark, .hl .hl-m b.hl-win { position: absolute; top: -3px; bottom: -3px; width: 0; border-left: 2px dashed var(--vscode-foreground); opacity: .65; }
.hl .hl-m b.hl-win { border-left: 2px solid var(--codex); opacity: .9; }
.hl .hl-num { font-variant-numeric: tabular-nums; font-size: 11px; white-space: nowrap; }
.hl .hl-ch { display: grid; gap: 1px; max-width: 1100px; overflow-x: auto; }
.hl .hl-chr { display: grid; grid-template-columns: minmax(120px, 2fr) minmax(70px, 1fr) 150px 150px 96px 28px; gap: 8px; align-items: center; padding: 2px 4px; border-radius: 3px; font-size: 12px; cursor: pointer; }
.hl .hl-chr .hl-m { width: 100%; }
@media (max-width: 760px) { .hl .hl-chr { grid-template-columns: minmax(90px, 2fr) minmax(56px, 1fr) 96px 110px 90px 22px; gap: 6px; } }
.hl .hl-chr:hover { background: var(--vscode-list-hoverBackground); }
.hl .hl-chr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.hl .hl-lab, .hl .hl-repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl .hl-cmp { font-size: 11px; text-align: right; }
.hl .hl-cv { position: relative; display: flex; align-items: stretch; gap: 3px; height: 220px; border-bottom: 1px solid var(--line); padding: 4px 0 0; overflow-x: auto; max-width: 1100px; }
.hl .hl-cvm { position: absolute; left: 0; right: 0; height: 0; border-top: 2px dashed var(--vscode-foreground); opacity: .55; pointer-events: none; margin-bottom: 30px; z-index: 1; }
.hl .hl-cvm span { position: absolute; right: 2px; top: -14px; font-size: 10px; font-weight: 400; }
.hl .hl-cvc { flex: 1 0 22px; max-width: 56px; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; cursor: pointer; border-radius: 3px; }
.hl .hl-cvc:hover, .hl .hl-cvc.sel { background: var(--vscode-list-hoverBackground); }
.hl .hl-cvb { position: relative; flex: 1; width: 70%; }
.hl .hl-cvb i { position: absolute; left: 0; right: 0; bottom: 0; background: currentColor; border-radius: 2px 2px 0 0; }
.hl .hl-cvb i.pk { opacity: .3; }
.hl .hl-cvl { font-size: 9px; height: 28px; writing-mode: vertical-rl; transform: rotate(180deg); overflow: hidden; color: var(--vscode-descriptionForeground); white-space: nowrap; text-overflow: ellipsis; }
.hl .hl-lg { display: inline-block; width: 14px; height: 8px; border-radius: 2px; vertical-align: middle; }
.hl .hl-lg.nw { background: var(--ok); } .hl .hl-lg.pk { background: color-mix(in srgb, var(--ok) 30%, transparent); }
.hl .hl-lg.mk { width: 0; height: 12px; border-left: 2px dashed var(--vscode-foreground); border-radius: 0; }
.hl .hl-lg.win { width: 0; height: 12px; border-left: 2px solid var(--codex); border-radius: 0; }
.hl table.hl-t { max-width: 1200px; font-size: 12px; margin-top: 2px; }
.hl table.hl-t th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
.hl table.hl-t th.r, .hl table.hl-t td.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hl table.hl-t tr[data-select] { cursor: pointer; }
.hl table.hl-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); }
.hl table.hl-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.hl .hl-name { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl .hl-prc, .hl .hl-ctxc, .hl .hl-rp { white-space: nowrap; }
.hl .hl-ctxc .hl-m { width: 90px; }
.hl .hl-pb { display: inline-block; width: 52px; height: 6px; border-radius: 2px; background: color-mix(in srgb, var(--bad) 35%, transparent); vertical-align: middle; overflow: hidden; }
.hl .hl-pb i { display: block; height: 100%; background: var(--ok); }
.hl .hl-tt { max-width: 640px; }
`;

const FACTS_CSS = TOKEN_FACTS_CSS('hl-pf');

export const healthView: ExtraView = {
  id: 'health',
  label: 'Health',
  group: 'Quality',
  hint: 'Test pass rate, commits per session and context use against a reference window, with trends and sparklines.',
  ready: true,
  render,
  css: CSS + FACTS_CSS,
  feeds: [cfgFeed as Feed],
  badge: d => {
    const n = d.sessions.filter(s => isLive(s) && (ctxInfo(s, settings().window).pct ?? 0) >= settings().warn / 100).length;
    return n ? String(n) : '';
  },
};
