// Add-on screen "Explore": generic pivot of sessions by dimension × metric × chart × period.
// Logic lives in src/activity/explore.ts; this file only renders (escaped) and wires the CSV export.
import type { AgentSessionSnapshot } from '../../model';
import {
  cross, Dim, DIM_LABEL, DIMS, fmtMetric, Gran, Group, isDim, isMetric, isPeriod, Metric, METRIC_INFO, METRICS, naturalOrder,
  Period, pivot, pivotCsv, series, slug, TIME_DIMS, topN,
} from '../../activity/explore';
import { endObserved } from '../../activity/audit';
import { identityColor } from '../../activity/insights';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { repoOf, titleOf } from '../workspace';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';

const CHARTS = ['bars-h', 'bars-v', 'table', 'treemap', 'heatmap', 'line'] as const;
type Chart = (typeof CHARTS)[number];

const DIM_SHORT: Record<Dim, string> = {
  provider: 'Provider', repo: 'Repo', model: 'Model', effort: 'Effort', status: 'Status', outcome: 'Outcome',
  day: 'Day', hour: 'Hour', weekday: 'Weekday', worker: 'Worker', tool: 'Tool',
};
const METRIC_SHORT: Record<Metric, string> = {
  sessions: 'Sessions', tokens: 'Tokens', output: 'Output', cost: 'Cost', active: 'Active', commits: 'Commits',
  pass: 'Pass', fail: 'Fail', edits: 'Edits', tools: 'Tools', prompts: 'Prompts',
};

interface Cfg {
  dim: Dim;
  metric: Metric;
  chart: Chart;
  period: Period;
  leadsOnly: boolean;
  top: number;
  dim2: Dim;
  gran: Gran;
  acc: boolean;
  sort: 'value' | 'name';
  pick: string;
}

function cfg(st: WsState): Cfg {
  const dim = opt(st, 'explore.dim', 'repo');
  const metric = opt(st, 'explore.metric', 'sessions');
  const chart = opt(st, 'explore.chart', 'bars-h');
  const period = opt(st, 'explore.period', '7d');
  const d = isDim(dim) ? dim : 'repo';
  const p = isPeriod(period) ? period : '7d';
  const g = opt(st, 'explore.gran', 'auto');
  const dim2 = opt(st, 'explore.dim2', d === 'hour' ? 'weekday' : 'hour');
  return {
    dim: d,
    metric: isMetric(metric) ? metric : 'sessions',
    chart: (CHARTS as readonly string[]).includes(chart) ? (chart as Chart) : 'bars-h',
    period: p,
    leadsOnly: opt(st, 'explore.who', 'all') === 'leads',
    top: { '10': 10, '20': 20, all: 1000 }[opt(st, 'explore.top', '20')] ?? 20,
    dim2: isDim(dim2) && dim2 !== d ? dim2 : d === 'hour' ? 'weekday' : 'hour',
    gran: g === 'hour' || g === 'day' || g === 'week' ? g : p === '24h' ? 'hour' : 'day',
    acc: opt(st, 'explore.acc', 'rate') === 'cumulative',
    sort: opt(st, 'explore.sort', 'value') === 'name' ? 'name' : 'value',
    pick: opt(st, 'explore.pick', ''),
  };
}

/** Colour of a group: provider and status keep their meaning, other categories get a stable identity hue. */
function colorOf(dim: Dim, key: string): string {
  if (dim === 'provider') return key === 'Codex' ? 'var(--codex)' : key === 'Claude Code' ? 'var(--claude)' : 'var(--quiet)';
  if (dim === 'status') return ({ RUNNING: 'var(--ok)', NEEDS_INPUT: 'var(--warn)', IDLE: 'var(--vscode-charts-yellow, #cca700)', ENDED: 'var(--quiet)' } as Record<string, string>)[key] ?? 'var(--quiet)';
  if (dim === 'outcome') return ({ 'Commit observed': 'var(--ok)', 'Files edited, no commit': 'var(--warn)', 'Still live': 'var(--accent)' } as Record<string, string>)[key] ?? 'var(--quiet)';
  if (TIME_DIMS.has(dim)) return 'var(--accent)';
  if (key.startsWith('other (') || key === 'other' || key.startsWith('(')) return 'var(--quiet)';
  return identityColor(key);
}

const evTitle = (m: Metric) => `${METRIC_INFO[m].kind}: ${METRIC_INFO[m].basis}`;

/**
 * "≥ " when the metric is a duration and one of the sessions has no recorded end: its time stops at the last
 * recorded activity (or now while live), so the value is a lower bound (audit A3 P2-15).
 */
export function atLeast(m: Metric, keys: Iterable<string>, by: Map<string, AgentSessionSnapshot>): string {
  if (m !== 'active') return '';
  for (const k of keys) {
    const s = by.get(k);
    if (s && !endObserved(s)) return '≥ ';
  }
  return '';
}
const GE_NOTE = '; ≥ = at least one session has no recorded end, its time stops at the last recorded activity';

function valTitle(c: Cfg, g: Group, total: number): string {
  const share = total > 0 ? ` · ${((100 * g.value) / total).toFixed(1)} %` : '';
  return `${DIM_LABEL[c.dim]} ${g.key}: ${fmtMetric(c.metric, g.value)} ${METRIC_INFO[c.metric].label.toLowerCase()}${share} · ${g.sessions.length} session(s) · ${METRIC_INFO[c.metric].kind}`;
}

/** Click target that toggles the drill-down on a group. */
function pickAttr(c: Cfg, key: string): string {
  if (key.startsWith('other (') || key === 'other') return '';
  const s = slug(key);
  return ` data-opt="explore.pick" data-val="${esc(c.pick === s ? '' : s)}"`;
}

// ---------------------------------------------------------------- charts

function barsH(c: Cfg, groups: Group[], total: number): string {
  const max = Math.max(...groups.map(g => g.value), 0) || 1;
  return `<div class="ex-bh">${groups
    .map(g => `<div class="ex-bhr${c.pick === slug(g.key) ? ' on' : ''}"${pickAttr(c, g.key)} title="${esc(valTitle(c, g, total))}"><span class="ex-lab">${esc(g.key)}</span><span class="ex-trk"><i style="width:${Math.max(0.5, (100 * g.value) / max).toFixed(2)}%;background:${colorOf(c.dim, g.key)}"></i></span><b class="ex-v">${esc(fmtMetric(c.metric, g.value))}</b><span class="ex-n muted">${g.sessions.length}</span></div>`)
    .join('')}</div>`;
}

function barsV(c: Cfg, groups: Group[], total: number): string {
  const max = Math.max(...groups.map(g => g.value), 0) || 1;
  const dense = groups.length > 16;
  return `<div class="ex-bv${dense ? ' dense' : ''}">${groups
    .map(g => `<div class="ex-bvc${c.pick === slug(g.key) ? ' on' : ''}"${pickAttr(c, g.key)} title="${esc(valTitle(c, g, total))}"><b class="ex-v">${dense ? '' : esc(fmtMetric(c.metric, g.value))}</b><span class="ex-col"><i style="height:${Math.max(0.5, (100 * g.value) / max).toFixed(2)}%;background:${colorOf(c.dim, g.key)}"></i></span><span class="ex-lab">${esc(g.key)}</span></div>`)
    .join('')}</div>`;
}

function table(c: Cfg, groups: Group[], total: number, sessionsBy: Map<string, AgentSessionSnapshot>): string {
  const max = Math.max(...groups.map(g => g.value), 0) || 1;
  const repos = (g: Group) => new Set(g.sessions.map(k => sessionsBy.get(k)).filter(Boolean).map(s => repoOf(s!))).size;
  return `<table class="ex-t"><tr><th>${esc(DIM_LABEL[c.dim])}</th><th class="r" title="${esc(evTitle(c.metric))}">${esc(METRIC_INFO[c.metric].label)}</th><th></th><th class="r">Share</th><th class="r">Sessions</th><th class="r">Per session</th><th class="r">Repos</th></tr>${groups
    .map(g => `<tr class="${c.pick === slug(g.key) ? 'on' : ''}"${pickAttr(c, g.key)} title="${esc(valTitle(c, g, total))}"><td><span class="ex-sw" style="background:${colorOf(c.dim, g.key)}"></span>${esc(g.key)}</td><td class="r"><b>${esc(atLeast(c.metric, g.sessions, sessionsBy) + fmtMetric(c.metric, g.value))}</b></td><td class="ex-tb"><i style="width:${((100 * g.value) / max).toFixed(2)}%;background:${colorOf(c.dim, g.key)}"></i></td><td class="r muted">${total > 0 ? ((100 * g.value) / total).toFixed(1) + ' %' : '—'}</td><td class="r">${g.sessions.length}</td><td class="r muted">${g.sessions.length ? esc(fmtMetric(c.metric, g.value / g.sessions.length)) : '—'}</td><td class="r muted">${repos(g)}</td></tr>`)
    .join('')}<tr class="ex-tot"><td>Total</td><td class="r"><b>${esc(atLeast(c.metric, groups.flatMap(g => g.sessions), sessionsBy) + fmtMetric(c.metric, total))}</b></td><td></td><td></td><td class="r">${new Set(groups.flatMap(g => g.sessions)).size}</td><td></td><td></td></tr></table>`;
}

interface Rect {
  g: Group;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap in a W × H box (Bruls et al.), returns rectangles in box units. */
export function squarify(groups: Group[], W: number, H: number): Rect[] {
  const items = groups.filter(g => g.value > 0).sort((a, b) => b.value - a.value);
  const sum = items.reduce((a, g) => a + g.value, 0);
  if (!sum) return [];
  const scale = (W * H) / sum;
  const out: Rect[] = [];
  let x = 0, y = 0, w = W, h = H;
  let i = 0;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row), mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (i < items.length) {
    const side = Math.min(w, h);
    const row: number[] = [items[i].value * scale];
    let j = i + 1;
    while (j < items.length) {
      const next = [...row, items[j].value * scale];
      if (worst(next, side) > worst(row, side)) break;
      row.push(items[j].value * scale);
      j++;
    }
    const area = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const cw = area / h;
      let cy = y;
      row.forEach((a, k) => {
        out.push({ g: items[i + k], x, y: cy, w: cw, h: a / cw });
        cy += a / cw;
      });
      x += cw;
      w -= cw;
    } else {
      const rh = area / w;
      let cx = x;
      row.forEach((a, k) => {
        out.push({ g: items[i + k], x: cx, y, w: a / rh, h: rh });
        cx += a / rh;
      });
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

function treemap(c: Cfg, groups: Group[], total: number): string {
  const W = 1000, H = 380;
  const rects = squarify(groups, W, H);
  if (!rects.length) return `<div class="empty">Nothing to draw: every group is 0.</div>`;
  return `<div class="ex-tm">${rects
    .map(r => {
      const big = r.w > 90 && r.h > 34;
      return `<div class="ex-tmc${c.pick === slug(r.g.key) ? ' on' : ''}"${pickAttr(c, r.g.key)} style="left:${((100 * r.x) / W).toFixed(3)}%;top:${((100 * r.y) / H).toFixed(3)}%;width:${((100 * r.w) / W).toFixed(3)}%;height:${((100 * r.h) / H).toFixed(3)}%;--c:${colorOf(c.dim, r.g.key)}" title="${esc(valTitle(c, r.g, total))}">${big ? `<b>${esc(r.g.key)}</b><span>${esc(fmtMetric(c.metric, r.g.value))}${total > 0 ? ` · ${((100 * r.g.value) / total).toFixed(0)} %` : ''}</span>` : ''}</div>`;
    })
    .join('')}</div>`;
}

function heatmap(c: Cfg, sessions: AgentSessionSnapshot[], now: number): string {
  const x = cross(sessions, { dim: c.dim, dim2: c.dim2, metric: c.metric, period: c.period, now, leadsOnly: c.leadsOnly, maxRows: c.top, maxCols: 24 });
  if (!x.rows.length) return `<div class="empty">No data for ${esc(DIM_LABEL[c.dim])} × ${esc(DIM_LABEL[c.dim2])} in this period.</div>`;
  const showVals = x.cols.length <= 14;
  const rowT = x.cells.map(r => r.reduce((a, b) => a + b, 0));
  const colT = x.cols.map((_, j) => x.cells.reduce((a, r) => a + r[j], 0));
  const cellBg = (v: number) => (v ? `color-mix(in srgb, var(--accent) ${(12 + 88 * (v / (x.max || 1))).toFixed(0)}%, transparent)` : 'transparent');
  let h = `<div class="ex-hm" style="grid-template-columns:minmax(80px,max-content) repeat(${x.cols.length}, minmax(${showVals ? 38 : 18}px, 1fr)) minmax(48px,max-content)"><span class="ex-hh"></span>${x.cols.map(col => `<span class="ex-hh" title="${esc(col)}">${esc(col)}</span>`).join('')}<span class="ex-hh r">Σ</span>`;
  x.rows.forEach((r, i) => {
    h += `<span class="ex-hl"${pickAttr(c, r)} title="${esc(r)}">${esc(r)}</span>`;
    h += x.cells[i].map((v, j) => `<i class="${v / (x.max || 1) > 0.55 ? 'hi' : ''}" style="background:${cellBg(v)}" title="${esc(`${r} × ${x.cols[j]}: ${fmtMetric(c.metric, v)} ${METRIC_INFO[c.metric].label.toLowerCase()} · ${METRIC_INFO[c.metric].kind}`)}">${showVals && v ? esc(fmtMetric(c.metric, v)) : ''}</i>`).join('');
    h += `<span class="ex-hs r">${esc(fmtMetric(c.metric, rowT[i]))}</span>`;
  });
  h += `<span class="ex-hs">Σ</span>${colT.map(v => `<span class="ex-hs r">${showVals ? esc(fmtMetric(c.metric, v)) : ''}</span>`).join('')}<span></span></div>`;
  return h + `<div class="legend">rows ${esc(DIM_LABEL[c.dim])} (top ${x.rows.length}) · columns ${esc(DIM_LABEL[c.dim2])} (top ${x.cols.length}) · darker = more · max cell ${esc(fmtMetric(c.metric, x.max))}</div>`;
}

function xLabel(t: number, g: Gran, first: boolean): string {
  const d = new Date(t);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (g === 'hour') return d.getHours() === 0 || first ? `${md} ${String(d.getHours()).padStart(2, '0')}h` : `${String(d.getHours()).padStart(2, '0')}h`;
  return g === 'week' ? `wk ${md}` : md;
}

function line(c: Cfg, sessions: AgentSessionSnapshot[], now: number): string {
  const s = series(sessions, { dim: c.dim, metric: c.metric, period: c.period, now, leadsOnly: c.leadsOnly, gran: c.gran, maxLines: 6 });
  if (!s.x.length || !s.lines.length) return `<div class="empty">No timed data in this period.</div>`;
  const lines = s.lines.map(l => {
    if (!c.acc) return l;
    let run = 0;
    return { ...l, values: l.values.map(v => (run += v)) };
  });
  const W = 900, H = 240, L = 52, R = 10, T = 10, B = 26;
  const max = Math.max(1e-9, ...lines.flatMap(l => l.values));
  const n = s.x.length;
  const px = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const py = (v: number) => T + (H - T - B) * (1 - v / max);
  const single = TIME_DIMS.has(c.dim);
  const col = (k: string) => (single ? 'var(--accent)' : k === 'other' ? 'var(--quiet)' : colorOf(c.dim, k));
  let svg = `<svg class="ex-ln" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${METRIC_INFO[c.metric].label} per ${c.gran}`)}">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4, y = py(v);
    svg += `<line class="ex-grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="ex-ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmtMetric(c.metric, v))}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 10));
  s.x.forEach((t, i) => {
    if (i % every === 0) svg += `<text class="ex-ax" x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(xLabel(t, c.gran, i === 0))}</text>`;
  });
  for (const l of lines) {
    const pts = l.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    svg += `<polyline class="ex-pl" points="${pts}" style="stroke:${col(l.key)}"><title>${esc(`${l.key}: ${fmtMetric(c.metric, l.total)} total`)}</title></polyline>`;
    if (n <= 60) svg += l.values.map((v, i) => (v ? `<circle class="ex-pt" cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.6" style="fill:${col(l.key)}"><title>${esc(`${l.key} · ${xLabel(s.x[i], c.gran, true)}: ${fmtMetric(c.metric, v)}`)}</title></circle>` : '')).join('');
  }
  svg += `</svg>`;
  const legend = `<div class="legend">${lines.map(l => `<span class="ex-lg"${single ? '' : pickAttr(c, l.key)}><span class="ex-sw" style="background:${col(l.key)}"></span>${esc(single ? METRIC_INFO[c.metric].label : l.key)} <span class="muted">${esc(fmtMetric(c.metric, l.total))}</span></span>`).join('')}<span class="muted">· per ${esc(c.gran)}${c.acc ? ' · cumulative' : ''}${single ? '' : ` · one line per ${esc(DIM_LABEL[c.dim].toLowerCase())} (top 6)`}</span></div>`;
  return svg + legend;
}

// ---------------------------------------------------------------- drill-down

function drill(c: Cfg, g: Group | undefined, d: WsData, st: WsState): string {
  if (!c.pick) return '';
  if (!g) return `<div class="foot">Selected group not in this view. <button class="link" data-opt="explore.pick" data-val="">clear</button></div>`;
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const list = g.sessions.map(k => by.get(k)).filter((s): s is AgentSessionSnapshot => !!s);
  const val = (s: AgentSessionSnapshot) => pivot([s], { dim: c.dim, metric: c.metric, period: c.period, now: d.now }).groups.find(x => slug(x.key) === c.pick)?.value ?? 0;
  const rows = list.map(s => ({ s, v: val(s) })).sort((a, b) => b.v - a.v || (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));
  return `<h2>${esc(DIM_LABEL[c.dim])} · ${esc(g.key)} · ${list.length} session(s) <button class="link" data-opt="explore.pick" data-val="">✕</button></h2><table class="ex-t ex-dr">${rows
    .slice(0, 40)
    .map(({ s, v }) => `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}" tabindex="0"><td><span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 60))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted"><span class="ex-sw" style="background:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td class="muted">${esc(s.provider)}</td><td class="r"><b>${esc(atLeast(c.metric, [s.key], by) + fmtMetric(c.metric, v))}</b></td></tr>`)
    .join('')}</table>${rows.length > 40 ? `<div class="muted">… ${rows.length - 40} more</div>` : ''}`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const dims = DIMS.map(x => [x, DIM_SHORT[x]] as [string, string]);
  const tb1 = toolbar(
    `<span class="muted">by</span>`, seg(st, 'explore.dim', dims, 'repo', 'Dimension (rows / bars)'),
  );
  const tb2 = toolbar(
    seg(st, 'explore.metric', METRICS.map(m => [m, METRIC_SHORT[m]] as [string, string]), 'sessions', 'Metric'),
  );
  const tb3 = toolbar(
    seg(st, 'explore.chart', [['bars-h', '▤ Bars'], ['bars-v', '▥ Columns'], ['table', 'Table'], ['treemap', 'Treemap'], ['heatmap', 'Heatmap'], ['line', 'Line']], 'bars-h', 'Chart type'),
    seg(st, 'explore.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period: sessions active in it; timed values before it are dropped'),
    seg(st, 'explore.who', [['all', 'All'], ['leads', 'Leads only']], 'all', 'Include worker sessions (subagents) or only top-level sessions'),
    c.chart !== 'line' ? seg(st, 'explore.top', [['10', 'Top 10'], ['20', 'Top 20'], ['all', 'All']], '20', 'Groups shown (the rest folds into "other")') : '',
    c.chart !== 'line' && c.chart !== 'heatmap' && !naturalOrder(c.dim) ? seg(st, 'explore.sort', [['value', 'By value'], ['name', 'A–Z']], 'value', 'Sort') : '',
    actBtn('csv', [c.dim, c.metric, c.period, c.leadsOnly ? 'leads' : 'all', c.chart === 'heatmap' ? c.dim2 : ''].join('|'), 'Export CSV', 'Save this pivot as CSV (labels and numbers only)'),
  );
  const tb4 =
    c.chart === 'heatmap'
      ? toolbar(`<span class="muted">columns</span>`, seg(st, 'explore.dim2', DIMS.filter(x => x !== c.dim).map(x => [x, DIM_SHORT[x]] as [string, string]), c.dim2, 'Second dimension (columns)'))
      : c.chart === 'line'
        ? toolbar(seg(st, 'explore.gran', [['auto', 'Auto'], ['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']], 'auto', 'Time bucket'), seg(st, 'explore.acc', [['rate', 'Per bucket'], ['cumulative', 'Cumulative']], 'rate', 'Rate or running total'))
        : '';

  const p = pivot(d.sessions, { dim: c.dim, metric: c.metric, period: c.period, now: d.now, leadsOnly: c.leadsOnly });
  let groups = p.groups;
  if (c.sort === 'name' && !naturalOrder(c.dim)) groups = [...groups].sort((a, b) => a.key.localeCompare(b.key));
  // Time dimensions keep their latest buckets when capped; categories keep their biggest.
  const shown = naturalOrder(c.dim) ? (groups.length > c.top ? groups.slice(-c.top) : groups) : topN(groups, c.top);
  const sessionsBy = new Map(d.sessions.map(s => [s.key, s]));
  const info = METRIC_INFO[c.metric];
  const lead = p.groups.length ? [...p.groups].sort((a, b) => b.value - a.value)[0] : undefined;
  const geTotal = atLeast(c.metric, p.groups.flatMap(g => g.sessions), sessionsBy);
  const kpis = `<div class="kpis ex-k"><div class="kpi" title="${esc(evTitle(c.metric) + (geTotal ? GE_NOTE : ''))}"><b>${esc(geTotal + fmtMetric(c.metric, p.total))}</b><span>${esc(info.label)}</span></div><div class="kpi" title="DERIVED: sessions whose last activity falls in the period"><b>${p.sessionCount}</b><span>Sessions in period</span></div><div class="kpi" title="DERIVED: distinct ${esc(DIM_LABEL[c.dim].toLowerCase())} values with a non-zero piece"><b>${p.groups.length}</b><span>${esc(DIM_LABEL[c.dim])} groups</span></div>${lead && p.total > 0 ? `<div class="kpi" title="${esc(`DERIVED: share of the largest group · ${valTitle(c, lead, p.total)}`)}"><b>${((100 * lead.value) / p.total).toFixed(0)} %</b><span>top: ${esc(lead.key.slice(0, 24))}</span></div>` : ''}</div>`;

  let body: string;
  if (!p.sessionCount) body = `<div class="empty">No session active in this period. Try a longer period or All loaded (loaded history follows <code>agent.historyDays</code>).</div>`;
  else if (c.chart === 'heatmap') body = heatmap(c, d.sessions, d.now);
  else if (c.chart === 'line') body = line(c, d.sessions, d.now);
  else if (!p.groups.length || p.total === 0) body = `<div class="empty">${esc(info.label)} is 0 or not exposed for these ${p.sessionCount} session(s). ${esc(info.basis)}.</div>`;
  else if (c.chart === 'bars-v') body = barsV(c, shown, p.total);
  else if (c.chart === 'table') body = table(c, shown, p.total, sessionsBy);
  else if (c.chart === 'treemap') body = treemap(c, shown, p.total);
  else body = barsH(c, shown, p.total);

  const picked = c.pick ? p.groups.find(g => slug(g.key) === c.pick) : undefined;
  const notes = [
    `<b>${esc(info.kind)}</b> · ${esc(info.basis)}.`,
    p.overlap ? 'A session counts under every tool it used, so groups overlap; the total counts each session once.' : '',
    c.dim === 'tool' && !d.sessions.some(s => s.facts?.toolCounts) ? 'Per-tool counts are not exposed yet in this build (session facts).' : '',
    TIME_DIMS.has(c.dim) ? 'Time buckets use the time of each piece: model call, commit, test run; otherwise the session start (sessions) or last activity (totals).' : '',
    c.chart !== 'line' && c.chart !== 'heatmap' ? 'Click a group to list its sessions.' : '',
  ].filter(Boolean).join(' ');
  return `<div class="ex">${tb1}${tb2}${tb3}${tb4}${kpis}${body}<div class="foot">${notes}</div>${drill(c, picked, d, st)}</div>`;
}

const CSS = `
.ex .tb { margin: 0 0 6px; }
.ex .ex-k { margin: 6px 0 10px; }
.ex [data-opt="explore.pick"] { cursor: pointer; }
.ex .ex-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.ex .ex-bh { display: grid; gap: 2px; max-width: 980px; }
.ex .ex-bhr { display: grid; grid-template-columns: minmax(90px, 220px) minmax(0, 1fr) 64px 34px; gap: 8px; align-items: center; padding: 2px 4px; border-radius: 3px; font-size: 12px; }
.ex .ex-bhr:hover, .ex .ex-bhr.on { background: var(--vscode-list-hoverBackground); }
.ex .ex-bhr.on { outline: 1px solid var(--vscode-focusBorder); }
.ex .ex-lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex .ex-trk { height: 12px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.ex .ex-trk i { display: block; height: 100%; border-radius: 2px; opacity: .9; }
.ex .ex-v { font-variant-numeric: tabular-nums; text-align: right; font-weight: 600; }
.ex .ex-n { font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
.ex .ex-bv { display: flex; align-items: stretch; gap: 4px; height: 240px; padding: 4px 0 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.ex .ex-bvc { flex: 1 0 34px; max-width: 90px; display: flex; flex-direction: column; align-items: center; gap: 2px; border-radius: 3px; padding: 0 1px; min-width: 0; }
.ex .ex-bv.dense .ex-bvc { flex-basis: 16px; }
.ex .ex-bvc:hover, .ex .ex-bvc.on { background: var(--vscode-list-hoverBackground); }
.ex .ex-bvc .ex-v { font-size: 10px; min-height: 13px; }
.ex .ex-col { flex: 1; width: 70%; display: flex; align-items: flex-end; }
.ex .ex-col i { display: block; width: 100%; border-radius: 2px 2px 0 0; opacity: .9; }
.ex .ex-bvc .ex-lab { font-size: 10px; max-width: 100%; color: var(--vscode-descriptionForeground); }
.ex .ex-bv.dense .ex-lab { writing-mode: vertical-rl; transform: rotate(180deg); max-height: 64px; }
.ex table.ex-t { max-width: 1100px; font-size: 12px; }
.ex table.ex-t td.r, .ex table.ex-t th.r { text-align: right; white-space: nowrap; }
.ex table.ex-t tr[data-opt]:hover, .ex table.ex-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
.ex table.ex-t tr.on, .ex table.ex-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.ex .ex-tb { width: 28%; vertical-align: middle; } .ex .ex-tb i { display: block; height: 8px; border-radius: 2px; opacity: .85; }
.ex .ex-tot td { font-weight: 600; border-top: 1px solid var(--line); }
.ex .ex-tm { position: relative; height: 380px; max-width: 1100px; border-radius: 4px; overflow: hidden; }
.ex .ex-tmc { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background, #0000); background: color-mix(in srgb, var(--c) 72%, transparent); color: var(--vscode-editor-foreground, var(--vscode-foreground)); padding: 4px 6px; overflow: hidden; font-size: 11px; display: flex; flex-direction: column; gap: 1px; }
.ex .ex-tmc:hover, .ex .ex-tmc.on { background: var(--c); outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; z-index: 1; }
.ex .ex-tmc b, .ex .ex-tmc span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 3px var(--vscode-editor-background, #0008); }
.ex .ex-hm { display: grid; gap: 2px; font-size: 10px; max-width: 1200px; overflow-x: auto; }
.ex .ex-hm i { height: 20px; border-radius: 2px; border: 1px solid var(--line); font-style: normal; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; color: var(--vscode-foreground); }
.ex .ex-hm i.hi { color: var(--vscode-button-foreground, #fff); }
.ex .ex-hh { color: var(--vscode-descriptionForeground); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex .ex-hl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; align-self: center; font-size: 11px; }
.ex .ex-hs { color: var(--vscode-descriptionForeground); align-self: center; font-variant-numeric: tabular-nums; }
.ex .r { text-align: right; }
.ex svg.ex-ln { width: 100%; max-width: 1100px; height: auto; display: block; }
.ex .ex-grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.ex .ex-ax { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.ex .ex-pl { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.ex .ex-lg { display: inline-flex; align-items: center; gap: 2px; margin-right: 8px; }
.ex .ex-dr { margin-top: 2px; }
`;

const CSV_DIM = new Set<string>(DIMS);

export const exploreView: ExtraView = {
  id: 'explore',
  label: 'Explore',
  group: 'Usage',
  hint: 'Pivot sessions by any dimension and metric, as bars, table, treemap, heatmap or a line over time.',
  ready: true,
  render,
  css: CSS,
  actions: {
    async csv(arg, ctx) {
      const [dim, metric, period, who, dim2] = arg.split('|');
      if (!isDim(dim) || !isMetric(metric) || !isPeriod(period) || (who !== 'all' && who !== 'leads') || (dim2 && (!CSV_DIM.has(dim2) || dim2 === dim))) {
        ctx.info('Explore: invalid export request.');
        return;
      }
      const csv = pivotCsv(ctx.sessions(), { dim, metric, period, now: Date.now(), leadsOnly: who === 'leads', dim2: dim2 ? (dim2 as Dim) : undefined });
      const name = `agent-explore-${dim}${dim2 ? `-x-${dim2}` : ''}-${metric}-${period}.csv`;
      const saved = await ctx.saveText(name, csv);
      if (saved) ctx.info(`Explore: saved ${saved}`);
    },
  },
};
