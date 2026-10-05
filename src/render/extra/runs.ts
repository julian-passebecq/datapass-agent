// Add-on screen "Run strips" (P6 + P11): one row per repository (or provider / model) with one tick per
// session over 7 / 14 / 30 days, coloured by observed outcome; then concurrency per bucket against the
// optional `agent.parallelTarget`. Logic lives in src/activity/runs.ts; this file only renders (escaped).
import type { AgentSessionSnapshot } from '../../model';
import type { WsData, WsState } from '../workspace';
import { ago, prettyModel, repoOf, titleOf } from '../workspace';
import { esc } from '../html';
import { hhmm } from '../views';
import { duration } from '../../activity/activity';
import { isLive, Outcome, OUTCOME_LABEL } from '../../activity/insights';
import { Bucket, buildRuns, concurrency, hourGrid, parseTarget, Run, RowBy, RunRow, runRows, summarize, tickLanes } from '../../activity/runs';
import { dayAt, dayStarts, HOUR } from '../../activity/week';
import { feedValue, Feed } from './feeds';
import { ExtraView, opt, seg, toolbar } from './kit';
import { colorOf } from './week';

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const OUT_ORDER: Outcome[] = ['committed', 'changed', 'nochange', 'live'];
const OUT_COLOR: Record<Outcome, string> = { live: 'var(--ok)', committed: 'var(--accent)', changed: 'var(--warn)', nochange: 'var(--quiet)' };
const GAPS: Record<string, number> = { '15m': 15 * 60_000, '30m': 30 * 60_000, '60m': HOUR };
const RANGES: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30 };
const MAX_LANES = 4;
const LANE_PX = 7;
const FEED_ID = 'runs.config';

interface Cfg {
  view: 'time' | 'sequence' | 'grid';
  days: number;
  by: RowBy;
  color: string;
  workers: boolean;
  gapKey: string;
  sort: 'recent' | 'runs' | 'name';
  seqN: number;
  win: '24h' | '7d' | '14d';
  gran: 'quarter' | 'hour' | 'day';
  chart: 'columns' | 'line' | 'heat';
  idle: boolean;
}

function cfg(st: WsState): Cfg {
  const pick = <T extends string>(name: string, ok: readonly T[], fb: T): T => {
    const v = opt(st, name, fb);
    return (ok as readonly string[]).includes(v) ? (v as T) : fb;
  };
  const win = pick('runs.win', ['24h', '7d', '14d'] as const, '24h');
  let gran = pick('runs.gran', ['quarter', 'hour', 'day'] as const, 'hour');
  if (gran === 'quarter' && win !== '24h') gran = 'hour';
  if (gran === 'day' && win === '24h') gran = 'hour';
  return {
    view: pick('runs.view', ['time', 'sequence', 'grid'] as const, 'time'),
    days: RANGES[pick('runs.range', ['7d', '14d', '30d'] as const, '14d')],
    by: pick('runs.by', ['repo', 'provider', 'model'] as const, 'repo'),
    color: pick('runs.color', ['outcome', 'provider', 'model', 'repo'] as const, 'outcome'),
    workers: opt(st, 'runs.workers', 'off') === 'on',
    gapKey: pick('runs.gap', ['15m', '30m', '60m'] as const, '30m'),
    sort: pick('runs.sort', ['recent', 'runs', 'name'] as const, 'recent'),
    seqN: { '30': 30, '60': 60, '120': 120 }[opt(st, 'runs.seqn', '60')] ?? 60,
    win,
    gran,
    chart: pick('runs.chart', ['columns', 'line', 'heat'] as const, 'columns'),
    idle: opt(st, 'runs.idle', 'off') === 'on',
  };
}

function rowLabel(s: AgentSessionSnapshot, by: RowBy): string {
  if (by === 'provider') return PROV[s.provider] ?? s.provider;
  if (by === 'model') return prettyModel(s.model) || 'model not recorded';
  return repoOf(s);
}

const fmtDay = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString(undefined, o);
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)} %` : '—');

function runTip(r: Run, s: AgentSessionSnapshot | undefined): string {
  return [
    s ? titleOf(s) : r.key,
    s ? [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ') + (s.isWorker ? ' · worker' : '') : '',
    s ? [repoOf(s), s.branch].filter(Boolean).join(' · ') : '',
    `${fmtDay(r.a, { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(r.a)} → ${r.live ? 'now' : hhmm(r.b)} · open ${duration(r.b - r.a)} · active ${duration(r.activeMs)} (${r.spans.length} span${r.spans.length > 1 ? 's' : ''})`,
    `${OUTCOME_LABEL[r.outcome]}${r.commits ? ` · ${r.commits} commit(s)` : ''}${r.pass + r.fail ? ` · tests ${r.pass} pass · ${r.fail} fail` : ''}${r.waiting ? ' · waiting for you' : ''}`,
    r.kind === 'INFERRED'
      ? 'INFERRED: only first and last activity recorded'
      : 'DERIVED from OBSERVED event times; outcome OBSERVED (commits, edits) or INFERRED (live)',
  ].filter(Boolean).join('\n');
}

function tickColor(r: Run, s: AgentSessionSnapshot | undefined, by: string): string {
  if (by === 'outcome' || !s) return OUT_COLOR[r.outcome];
  return colorOf(s, by)[1];
}

function tickCls(r: Run, sel: string | undefined, base: string): string {
  return [base, r.live ? 'rn-live' : '', r.kind === 'INFERRED' ? 'rn-inf' : '', r.fail && !r.pass ? 'rn-fail' : '', r.worker ? 'rn-w' : '', sel === r.key ? 'sel' : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- strips

function outcomeBar(counts: Record<Outcome, number>, total: number): string {
  if (!total) return '<span class="rn-ob"></span>';
  return `<span class="rn-ob" title="${esc(OUT_ORDER.filter(o => counts[o]).map(o => `${OUTCOME_LABEL[o]}: ${counts[o]}`).join('\n'))}">${OUT_ORDER.map(o => (counts[o] ? `<i style="width:${((100 * counts[o]) / total).toFixed(2)}%;background:${OUT_COLOR[o]}"></i>` : '')).join('')}</span>`;
}

/** Grid row: label cell, the given middle cell, stats cell. */
function gridRow(row: RunRow, now: number, middle: string): string {
  const n = row.runs.length;
  const ended = n - row.counts.live;
  return `<div class="rn-lab" title="${esc(row.key)}"><b>${esc(row.key)}</b><span class="muted">${n} run${n > 1 ? 's' : ''} · ${row.counts.live ? `<span class="rn-lv">${row.counts.live} live</span>` : esc(ago(now, row.lastAt) || '')}</span></div>${middle}`
    + `<div class="rn-st">${outcomeBar(row.counts, n)}<span class="rn-num" title="DERIVED: runs with a commit observed / ended runs">${esc(pct(row.counts.committed, ended))}</span><span class="rn-num muted" title="DERIVED: sum of active spans">${esc(duration(row.activeMs))}</span></div>`;
}

function stripsTime(rows: RunRow[], c: Cfg, d: WsData, st: WsState, by: Map<string, AgentSessionSnapshot>, from: number, to: number): string {
  const bounds = dayStarts(from, c.days);
  const span = to - from;
  const x = (t: number) => (100 * (Math.min(Math.max(t, from), to) - from)) / span;
  const nowX = x(d.now);
  const dense = c.days > 14;
  const heads = bounds.slice(0, c.days).map((t, i) => {
    const wd = new Date(t).getDay();
    const label = dense ? fmtDay(t, { day: 'numeric' }) : fmtDay(t, { weekday: 'short', day: 'numeric' });
    return `<span class="${wd === 0 || wd === 6 ? 'rn-we' : ''}${t === dayAt(d.now) ? ' rn-tod' : ''}" style="left:${x(t).toFixed(3)}%;width:${(x(bounds[i + 1]) - x(t)).toFixed(3)}%" title="${esc(fmtDay(t, { weekday: 'long', day: 'numeric', month: 'long' }))}">${esc(label)}</span>`;
  }).join('');
  const shade = bounds.slice(0, c.days).map((t, i) => {
    const wd = new Date(t).getDay();
    return wd === 0 || wd === 6 ? `<span class="rn-wes" style="left:${x(t).toFixed(3)}%;width:${(x(bounds[i + 1]) - x(t)).toFixed(3)}%"></span>` : '';
  }).join('') + bounds.slice(1, c.days).map(t => `<span class="rn-dl" style="left:${x(t).toFixed(3)}%"></span>`).join('');
  let h = `<div class="rn-grid rn-time"><div></div><div class="rn-days">${heads}</div><div class="rn-sth muted"><span title="Outcome mix">outcomes</span><span title="Runs with a commit / ended runs">commit</span><span title="Active time">active</span></div>`;
  for (const row of rows) {
    const lanes = tickLanes(row.runs, MAX_LANES, (span / 900) * 3);
    const nl = Math.max(1, ...lanes.map(l => l + 1));
    const ticks = row.runs.map((r, i) => {
      const s = by.get(r.key);
      const w = Math.max(0, x(r.b) - x(r.a));
      // Open interval as a thin line, active spans as solid segments inside it (positions relative to the tick).
      const len = Math.max(1, r.b - r.a);
      const segs = r.kind === 'INFERRED' || r.spans.length === 0 ? '' : r.spans.map(p => `<i style="left:${((100 * (Math.max(p.a, r.a) - r.a)) / len).toFixed(2)}%;width:${((100 * (Math.min(p.b, r.b) - Math.max(p.a, r.a))) / len).toFixed(2)}%"></i>`).join('');
      return `<span class="${tickCls(r, st.selected, 'rn-tk')}" data-select="${esc(r.key)}" tabindex="0" style="left:${x(r.a).toFixed(3)}%;width:${w.toFixed(3)}%;top:${2 + lanes[i] * LANE_PX}px;--c:${tickColor(r, s, c.color)}" title="${esc(runTip(r, s))}">${segs}</span>`;
    }).join('');
    h += gridRow(row, d.now, `<div class="rn-trk" style="height:${nl * LANE_PX + 4}px">${shade}${ticks}<span class="rn-now" style="left:${nowX.toFixed(3)}%"></span></div>`);
  }
  return h + '</div>';
}

function stripsSequence(rows: RunRow[], c: Cfg, d: WsData, st: WsState, by: Map<string, AgentSessionSnapshot>): string {
  let h = `<div class="rn-grid rn-seq"><div></div><div class="muted rn-seqh">oldest ← last ${c.seqN} runs per row → newest</div><div class="rn-sth muted"><span>outcomes</span><span>commit</span><span>active</span></div>`;
  for (const row of rows) {
    const list = row.runs.slice(-c.seqN);
    let prevDay = -1;
    const cells = list.map(r => {
      const day = dayAt(r.a);
      const newDay = prevDay !== -1 && day !== prevDay;
      prevDay = day;
      return `<span class="${tickCls(r, st.selected, 'rn-sq')}${newDay ? ' rn-nd' : ''}" data-select="${esc(r.key)}" tabindex="0" style="--c:${tickColor(r, by.get(r.key), c.color)}" title="${esc(runTip(r, by.get(r.key)))}"></span>`;
    }).join('');
    const more = row.runs.length - list.length;
    h += gridRow(row, d.now, `<div class="rn-sqs">${more > 0 ? `<span class="muted rn-more" title="Older runs not shown">+${more}</span>` : ''}${cells}</div>`);
  }
  return h + '</div>';
}

function stripsGrid(rows: RunRow[], c: Cfg, d: WsData, from: number): string {
  const bounds = dayStarts(from, c.days);
  const max = Math.max(1, ...rows.flatMap(r => r.perDay));
  let h = `<div class="rn-mx" style="grid-template-columns:minmax(120px,200px) repeat(${c.days}, minmax(${c.days > 14 ? 18 : 30}px, 1fr)) 44px"><span></span>`;
  h += bounds.slice(0, c.days).map(t => {
    const wd = new Date(t).getDay();
    return `<span class="rn-mxh${wd === 0 || wd === 6 ? ' rn-we' : ''}${t === dayAt(d.now) ? ' rn-tod' : ''}" title="${esc(fmtDay(t, { weekday: 'long', day: 'numeric', month: 'long' }))}">${esc(c.days > 14 ? fmtDay(t, { day: 'numeric' }) : fmtDay(t, { weekday: 'narrow', day: 'numeric' }))}</span>`;
  }).join('') + '<span class="rn-mxh r">Σ</span>';
  for (const row of rows) {
    h += `<span class="rn-mxl" title="${esc(row.key)}">${esc(row.key)}</span>`;
    h += row.perDay.map((n, i) => {
      const oc = row.perDayOutcome[i];
      const tip = `${row.key} · ${fmtDay(bounds[i], { weekday: 'short', day: 'numeric', month: 'short' })}: ${n} run(s) started${n ? '\n' + OUT_ORDER.filter(o => oc[o]).map(o => `${OUTCOME_LABEL[o]}: ${oc[o]}`).join('\n') : ''}`;
      return `<span class="rn-mxc${n ? '' : ' z'}" style="--a:${n ? (14 + (70 * n) / max).toFixed(0) : 0}%" title="${esc(tip)}">${n ? `<b>${n}</b>${outcomeBar(oc, n)}` : ''}</span>`;
    }).join('');
    h += `<span class="rn-mxs">${row.runs.length}</span>`;
  }
  return h + '</div>';
}

// ---------------------------------------------------------------- concurrency

function xLabel(t: number, gran: Cfg['gran'], first: boolean): string {
  const dt = new Date(t);
  if (gran === 'day') return fmtDay(t, { weekday: 'short', day: 'numeric' });
  const hh = `${String(dt.getHours()).padStart(2, '0')}${gran === 'quarter' ? ':' + String(dt.getMinutes()).padStart(2, '0') : 'h'}`;
  return dt.getHours() === 0 && dt.getMinutes() === 0 || first ? `${fmtDay(t, { weekday: 'short' })} ${hh}` : hh;
}

function bucketTip(b: Bucket, target: number, gran: Cfg['gran'], waitingNow: number, isNow: boolean): string {
  const range = gran === 'day' ? fmtDay(b.t0, { weekday: 'long', day: 'numeric', month: 'short' }) : `${fmtDay(b.t0, { weekday: 'short', day: 'numeric' })} ${hhmm(b.t0)}–${hhmm(b.t1)}`;
  return [
    range,
    `peak active at once: ${b.peak}${target ? ` (target ${target}${b.peak > target ? ', over' : ''})` : ''}`,
    `mean active: ${b.avg.toFixed(2)}`,
    `peak sessions open (incl. idle): ${b.open}`,
    `${b.keys.length} distinct run(s) active`,
    isNow ? `waiting for you now: ${waitingNow} (current status, not historical)` : '',
    'DERIVED: sweep over active spans built from OBSERVED event times',
  ].filter(Boolean).join('\n');
}

function columns(bk: Bucket[], c: Cfg, target: number, waitingNow: number, now: number): string {
  const max = Math.max(1, target, ...bk.map(b => (c.idle ? b.open : b.peak + (now >= b.t0 && now < b.t1 ? waitingNow : 0))));
  const every = Math.max(1, Math.ceil(bk.length / (c.gran === 'quarter' ? 12 : 16)));
  const nowIdx = bk.findIndex(b => now >= b.t0 && now < b.t1);
  const ticks = Array.from({ length: max + 1 }, (_, k) => k).filter(k => max <= 6 || k % Math.ceil(max / 5) === 0 || k === max);
  let h = `<div class="rn-cc"><div class="rn-yax">${ticks.map(k => `<span style="bottom:${((100 * k) / max).toFixed(2)}%">${k}</span>`).join('')}</div><div class="rn-plot">`;
  h += ticks.map(k => `<span class="rn-gl" style="bottom:${((100 * k) / max).toFixed(2)}%"></span>`).join('');
  if (target) h += `<span class="rn-tgt" style="bottom:${((100 * target) / max).toFixed(2)}%" title="agent.parallelTarget = ${target}"><b>target ${target}</b></span>`;
  h += `<div class="rn-cols">${bk.map((b, i) => {
    const over = target > 0 && b.peak > target;
    const isNow = i === nowIdx;
    const wait = isNow ? waitingNow : 0;
    return `<div class="rn-c${isNow ? ' rn-cnow' : ''}${b.t0 > now ? ' rn-fut' : ''}" title="${esc(bucketTip(b, target, c.gran, waitingNow, isNow))}">${c.idle ? `<i class="rn-open" style="height:${((100 * b.open) / max).toFixed(2)}%"></i>` : ''}<i class="rn-pk${over ? ' over' : ''}" style="height:${((100 * b.peak) / max).toFixed(2)}%"></i><i class="rn-avg" style="bottom:${((100 * b.avg) / max).toFixed(2)}%"></i>${wait ? `<i class="rn-wait" style="bottom:${((100 * b.peak) / max).toFixed(2)}%;height:${((100 * wait) / max).toFixed(2)}%"></i>` : ''}</div>`;
  }).join('')}</div></div></div>`;
  h += `<div class="rn-xax">${bk.map((b, i) => `<span>${i % every === 0 ? esc(xLabel(b.t0, c.gran, i === 0)) : ''}</span>`).join('')}</div>`;
  return h;
}

function lineChart(bk: Bucket[], c: Cfg, target: number, now: number): string {
  const W = 900, H = 200, L = 30, R = 8, T = 8, B = 22;
  const max = Math.max(1, target, ...bk.map(b => (c.idle ? b.open : b.peak)));
  const n = bk.length;
  const px = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const py = (v: number) => T + (H - T - B) * (1 - v / max);
  const past = bk.filter(b => b.t0 <= now);
  const poly = (f: (b: Bucket) => number) => past.map((b, i) => `${px(i).toFixed(1)},${py(f(b)).toFixed(1)}`).join(' ');
  let svg = `<svg class="rn-ln" viewBox="0 0 ${W} ${H}" role="img" aria-label="Concurrency per ${esc(c.gran)}">`;
  const step = Math.max(1, Math.ceil(max / 5));
  for (let k = 0; k <= max; k += step) svg += `<line class="rn-g" x1="${L}" x2="${W - R}" y1="${py(k).toFixed(1)}" y2="${py(k).toFixed(1)}"/><text class="rn-ax" x="${L - 5}" y="${(py(k) + 3).toFixed(1)}" text-anchor="end">${k}</text>`;
  const every = Math.max(1, Math.ceil(n / 12));
  bk.forEach((b, i) => {
    if (i % every === 0) svg += `<text class="rn-ax" x="${px(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(xLabel(b.t0, c.gran, i === 0))}</text>`;
  });
  if (target) svg += `<line class="rn-tl" x1="${L}" x2="${W - R}" y1="${py(target).toFixed(1)}" y2="${py(target).toFixed(1)}"><title>agent.parallelTarget = ${target}</title></line>`;
  if (c.idle) svg += `<polyline class="rn-lo" points="${poly(b => b.open)}"><title>peak open (incl. idle)</title></polyline>`;
  svg += `<polyline class="rn-la" points="${poly(b => b.avg)}"><title>mean active</title></polyline>`;
  svg += `<polyline class="rn-lp" points="${poly(b => b.peak)}"><title>peak active</title></polyline>`;
  if (past.length <= 120) svg += past.map((b, i) => (b.peak ? `<circle class="rn-pt${target && b.peak > target ? ' over' : ''}" cx="${px(i).toFixed(1)}" cy="${py(b.peak).toFixed(1)}" r="2.6"><title>${esc(bucketTip(b, target, c.gran, 0, false))}</title></circle>` : '')).join('');
  return svg + '</svg>';
}

function heat(runs: Run[], c: Cfg, target: number, now: number): string {
  const days = c.win === '24h' ? 2 : c.win === '7d' ? 7 : 14;
  const grid = hourGrid(runs, now, days);
  const max = Math.max(1, ...grid.flatMap(g => g.cells.map(x => x.peak)));
  let h = `<div class="rn-hm"><span></span>${Array.from({ length: 24 }, (_, i) => `<span class="rn-hh">${i % 3 === 0 ? String(i).padStart(2, '0') : ''}</span>`).join('')}<span class="rn-hh">max</span>`;
  for (const g of grid) {
    const isToday = g.day === dayAt(now);
    h += `<span class="rn-hl${isToday ? ' rn-tod' : ''}">${esc(fmtDay(g.day, { weekday: 'short', day: 'numeric' }))}</span>`;
    h += g.cells.slice(0, 24).map(b => {
      const over = target > 0 && b.peak > target;
      const fut = b.t0 > now;
      return `<i class="${over ? 'over' : ''}${fut ? ' fut' : ''}${b.peak / max > 0.55 ? ' hi' : ''}" style="--a:${b.peak ? (15 + (85 * b.peak) / max).toFixed(0) : 0}%" title="${esc(bucketTip(b, target, 'hour', 0, false))}">${b.peak || ''}</i>`;
    }).join('');
    h += `<span class="rn-hs">${Math.max(0, ...g.cells.map(x => x.peak))}</span>`;
  }
  return h + `</div><div class="legend">peak active runs per hour · darker = more${target ? ` · <span class="rn-key"><i class="rn-sw-over"></i>over target ${target}</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const target = parseTarget(feedValue<{ target: number }>(FEED_ID).value?.target);
  const events = d.timeline?.(undefined, 200_000) ?? d.events;
  const to = dayAt(d.now, 1);
  const from = dayAt(d.now, -(c.days - 1));
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const runs = buildRuns(d.sessions, events, { from, to, now: d.now, gapMs: GAPS[c.gapKey], workers: c.workers, by: c.by, label: rowLabel });
  let rows = runRows(runs.filter(r => r.a < to), from, c.days);
  if (c.sort === 'runs') rows = [...rows].sort((a, b) => b.runs.length - a.runs.length || b.lastAt - a.lastAt);
  else if (c.sort === 'name') rows = [...rows].sort((a, b) => a.key.localeCompare(b.key));

  const tb1 = toolbar(
    seg(st, 'runs.view', [['time', 'Time strip'], ['sequence', 'Run sequence'], ['grid', 'Day grid']], 'time', 'Strip layout: ticks on a time axis, equal cells in run order, or a repo × day grid'),
    seg(st, 'runs.range', [['7d', '7 d'], ['14d', '14 d'], ['30d', '30 d']], '14d', 'Days shown (loaded history follows agent.historyDays)'),
    `<span class="muted">rows</span>`, seg(st, 'runs.by', [['repo', 'Repo'], ['provider', 'Provider'], ['model', 'Model']], 'repo', 'One row per'),
    `<span class="muted">colour</span>`, seg(st, 'runs.color', [['outcome', 'Outcome'], ['provider', 'Provider'], ['model', 'Model'], ['repo', 'Repo']], 'outcome', 'Tick colour'),
  );
  const tb2 = toolbar(
    seg(st, 'runs.sort', [['recent', 'Recent'], ['runs', 'Most runs'], ['name', 'A–Z']], 'recent', 'Row order'),
    seg(st, 'runs.workers', [['off', 'Leads'], ['on', '+ workers']], 'off', 'Include worker / subagent sessions (also in concurrency)'),
    seg(st, 'runs.gap', [['15m', 'idle 15m'], ['30m', '30m'], ['60m', '1h']], '30m', 'A run is active until no activity was recorded for longer than this'),
    c.view === 'sequence' ? seg(st, 'runs.seqn', [['30', '30'], ['60', '60'], ['120', '120']], '60', 'Runs per row') : '',
  );

  // ---- KPIs
  const ended = runs.filter(r => !r.live);
  const committed = ended.filter(r => r.outcome === 'committed').length;
  const leads = d.sessions.filter(s => isLive(s) && (c.workers || !s.isWorker));
  const runningNow = leads.filter(s => s.status === 'RUNNING').length;
  const waitingNow = leads.filter(s => s.status === 'NEEDS_INPUT').length;
  const winFrom = c.win === '24h' ? d.now - 24 * HOUR : dayAt(d.now, -(c.win === '7d' ? 6 : 13));
  const winRuns = c.win === '24h' || RANGES[c.win] <= c.days ? runs : buildRuns(d.sessions, events, { from: winFrom, to, now: d.now, gapMs: GAPS[c.gapKey], workers: c.workers });
  const bk = concurrency(winRuns, winFrom, c.win === '24h' ? d.now + 1 : to, c.gran, d.now);
  const sum = summarize(bk.filter(b => b.t0 <= d.now), target);
  const unit = c.gran === 'quarter' ? '15 min' : c.gran;
  const kpis = `<div class="kpis rn-k">
<div class="kpi" title="DERIVED: sessions with activity in the last ${c.days} days${c.workers ? ' (incl. workers)' : ' (leads only)'}"><b>${runs.length}</b><span>Runs · ${c.days} d</span></div>
<div class="kpi" title="DERIVED: distinct rows"><b>${rows.length}</b><span>${esc(c.by === 'repo' ? 'Repos' : c.by === 'provider' ? 'Providers' : 'Models')}</span></div>
<div class="kpi" title="DERIVED: ended runs with a commit observed / ended runs (${committed} / ${ended.length})"><b>${esc(pct(committed, ended.length))}</b><span>Commit rate</span></div>
<div class="kpi k-run" title="Current provider status (INFERRED from recency)"><b>${runningNow}</b><span>Running now</span></div>
<div class="kpi k-need" title="Current provider status NEEDS_INPUT: counted apart from running"><b>${waitingNow}</b><span>Waiting for you</span></div>
<div class="kpi" title="DERIVED: most runs active at one instant in the ${esc(c.win)} window${sum.peakAt ? ` (${fmtDay(sum.peakAt, { weekday: 'short' })} ${hhmm(sum.peakAt)})` : ''}"><b>${sum.peak}${target ? `<small> / ${target}</small>` : ''}</b><span>Peak · ${esc(c.win)}</span></div>
${target ? `<div class="kpi${sum.over ? ' k-need' : ''}" title="DERIVED: ${esc(unit)} buckets whose peak exceeds agent.parallelTarget"><b>${sum.over}</b><span>${esc(unit)}s over target</span></div>` : ''}
<div class="kpi" title="DERIVED: mean active runs over buckets with any activity"><b>${sum.avgBusy.toFixed(1)}</b><span>Mean when busy</span></div>
</div>`;

  // ---- strips
  let strips: string;
  if (!rows.length) strips = `<div class="empty">No session with recorded activity in the last ${c.days} days${c.workers ? '' : ' (leads only)'}. Loaded history follows <code>agent.historyDays</code>.</div>`;
  else if (c.view === 'sequence') strips = stripsSequence(rows, c, d, st, by);
  else if (c.view === 'grid') strips = stripsGrid(rows, c, d, from);
  else strips = stripsTime(rows, c, d, st, by, from, to);

  const legendItems = c.color === 'outcome'
    ? OUT_ORDER.map(o => `<span class="rn-key"><i style="background:${OUT_COLOR[o]}"></i>${esc(OUTCOME_LABEL[o])}</span>`).join('')
    : colorLegend(runs, by, c.color);
  const legend = `<div class="legend">${legendItems}<span class="rn-key"><i class="rn-sw-inf"></i>INFERRED (first + last only)</span><span class="rn-key"><i class="rn-sw-fail"></i>tests failed</span><span class="rn-key"><i class="rn-sw-live"></i>live</span>${c.view === 'time' ? '<span class="rn-key"><i class="rn-sw-now"></i>now</span>' : ''}</div>`;

  // ---- concurrency
  const tb3 = toolbar(
    seg(st, 'runs.win', [['24h', '24 h'], ['7d', '7 d'], ['14d', '14 d']], '24h', 'Concurrency window'),
    c.chart !== 'heat' ? seg(st, 'runs.gran', c.win === '24h' ? [['quarter', '15 min'], ['hour', 'Hour']] : [['hour', 'Hour'], ['day', 'Day']], c.gran, 'Bucket size') : '',
    seg(st, 'runs.chart', [['columns', '▥ Columns'], ['line', 'Line'], ['heat', 'Day × hour']], 'columns', 'Chart type'),
    c.chart !== 'heat' ? seg(st, 'runs.idle', [['off', 'Active'], ['on', '+ open idle']], 'off', 'Also show sessions open but idle (first → last activity)') : '',
  );
  const concBody = !winRuns.length
    ? `<div class="empty">No active span in this window.</div>`
    : c.chart === 'heat' ? heat(winRuns, c, target, d.now) : c.chart === 'line' ? lineChart(bk, c, target, d.now) : columns(bk, c, target, waitingNow, d.now);
  const concLegend = c.chart === 'heat' ? '' : `<div class="legend"><span class="rn-key"><i class="rn-sw-pk"></i>peak active</span>${c.idle ? '<span class="rn-key"><i class="rn-sw-open"></i>open incl. idle</span>' : ''}<span class="rn-key"><i class="rn-sw-avg"></i>mean active</span>${c.chart === 'columns' ? '<span class="rn-key"><i class="rn-sw-wait"></i>waiting for you (now only)</span>' : ''}${target ? '<span class="rn-key"><i class="rn-sw-tgt"></i>target</span><span class="rn-key"><i class="rn-sw-over"></i>over target</span>' : ''}</div>`;
  const tgtNote = target
    ? `Target ${target} from <code>agent.parallelTarget</code>.`
    : 'No target: set <code>agent.parallelTarget</code> (e.g. 4) to draw a line and count buckets above it.';

  return `<div class="rn">${tb1}${tb2}${kpis}<h2>Run strips · ${c.days} days · one ${c.view === 'grid' ? 'cell per day' : 'tick per session'}</h2>${strips}${legend}
<h2>Concurrency · ${esc(c.win)}${c.chart === 'heat' ? ' · per hour' : ` · per ${esc(unit)}`}</h2>${tb3}${concBody}${concLegend}
<div class="foot">A run is one session. Its active spans are DERIVED from OBSERVED event times (commands, tools, edits, model calls, commits), split where nothing was recorded for longer than ${esc(c.gapKey)}; "open" runs from first to last activity. Outcome: commit observed, files edited without commit, no change, or still live. "Waiting for you" is the current NEEDS_INPUT status, counted apart from running; past waits are not recorded per instant. ${tgtNote} Click a tick to select its session.</div></div>`;
}

function colorLegend(runs: Run[], by: Map<string, AgentSessionSnapshot>, colorBy: string): string {
  const counts = new Map<string, { color: string; n: number }>();
  for (const r of runs) {
    const s = by.get(r.key);
    if (!s) continue;
    const [l, col] = colorOf(s, colorBy);
    counts.set(l, { color: col, n: (counts.get(l)?.n ?? 0) + 1 });
  }
  const items = [...counts].sort((a, b) => b[1].n - a[1].n);
  return items.slice(0, 10).map(([l, x]) => `<span class="rn-key"><i style="background:${x.color}"></i>${esc(l)} <span class="muted">${x.n}</span></span>`).join('') + (items.length > 10 ? `<span class="muted">+${items.length - 10} more</span>` : '');
}

const configFeed: Feed<{ target: number }> = {
  id: FEED_ID,
  intervalMs: 15_000,
  load: async ctx => ({ target: parseTarget(ctx.config<unknown>('agent.parallelTarget', 0)) }),
};

const CSS = `
.rn .tb { margin: 0 0 6px; }
.rn .rn-k { margin: 6px 0 4px; } .rn .rn-k small { font-size: 11px; color: var(--vscode-descriptionForeground); font-weight: 400; }
.rn .rn-grid { display: grid; grid-template-columns: minmax(110px, 190px) minmax(0, 1fr) 150px; column-gap: 10px; row-gap: 3px; align-items: center; max-width: 1400px; }
.rn .rn-lab { display: flex; flex-direction: column; min-width: 0; font-size: 11.5px; line-height: 14px; }
.rn .rn-lab b, .rn .rn-lab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .rn .rn-lab span { font-size: 10px; }
.rn .rn-st, .rn .rn-sth { display: grid; grid-template-columns: 1fr 38px 44px; gap: 6px; align-items: center; font-size: 10.5px; }
.rn .rn-sth { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; } .rn .rn-sth span:not(:first-child) { text-align: right; }
.rn .rn-lv { color: var(--ok); }
.rn .rn-num { text-align: right; font-variant-numeric: tabular-nums; }
.rn .rn-ob { display: flex; height: 7px; border-radius: 2px; overflow: hidden; background: var(--raise); } .rn .rn-ob i { display: block; height: 100%; }
.rn .rn-days { position: relative; height: 16px; font-size: 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); }
.rn .rn-days span { position: absolute; top: 0; overflow: hidden; white-space: nowrap; text-overflow: clip; padding-left: 3px; box-sizing: border-box; }
.rn .rn-we { opacity: .75; } .rn .rn-tod { color: var(--accent); font-weight: 600; opacity: 1; }
.rn .rn-trk { position: relative; background: var(--raise); border-radius: 3px; min-height: 11px; }
.rn .rn-wes { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
.rn .rn-dl { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--line) 80%, transparent); }
.rn .rn-now { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--bad); transform: translateX(-1px); pointer-events: none; z-index: 2; }
.rn .rn-tk { position: absolute; height: 6px; min-width: 3px; box-sizing: border-box; border-radius: 2px; cursor: pointer; background: linear-gradient(var(--c), var(--c)) center / 100% 2px no-repeat; opacity: .92; }
.rn .rn-tk i { position: absolute; top: 0; bottom: 0; min-width: 2px; background: var(--c); border-radius: 1px; }
.rn .rn-tk:hover { opacity: 1; z-index: 3; outline: 1px solid var(--vscode-foreground); }
.rn .rn-tk.rn-inf, .rn .rn-sq.rn-inf { background: color-mix(in srgb, var(--c) 35%, transparent); border: 1px dashed var(--c); }
.rn .rn-tk.rn-fail, .rn .rn-sq.rn-fail { box-shadow: inset 0 -2px 0 var(--bad); }
.rn .rn-tk.rn-w { opacity: .6; }
.rn .rn-tk.rn-live, .rn .rn-sq.rn-live { animation: rn-pulse 2s ease-out infinite; }
@keyframes rn-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 70% { box-shadow: 0 0 0 4px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .rn .rn-tk.rn-live, .rn .rn-sq.rn-live { animation: none; outline: 1px solid var(--ok); } }
.rn .rn-tk.sel, .rn .rn-sq.sel { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; z-index: 4; opacity: 1; }
.rn .rn-tk:focus-visible, .rn .rn-sq:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
.rn .rn-seqh { font-size: 10px; border-bottom: 1px solid var(--line); padding-bottom: 2px; }
.rn .rn-sqs { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; min-height: 14px; }
.rn .rn-sq { width: 10px; height: 12px; border-radius: 2px; background: var(--c); cursor: pointer; box-sizing: border-box; }
.rn .rn-sq:hover { outline: 1px solid var(--vscode-foreground); }
.rn .rn-sq.rn-nd { margin-left: 4px; position: relative; } .rn .rn-sq.rn-nd::before { content: ''; position: absolute; left: -4px; top: -2px; bottom: -2px; width: 1px; background: var(--line); }
.rn .rn-more { font-size: 10px; margin-right: 4px; }
.rn .rn-mx { display: grid; gap: 2px; font-size: 10px; max-width: 1400px; overflow-x: auto; align-items: stretch; }
.rn .rn-mxh { text-align: center; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; } .rn .rn-mxh.r { text-align: right; }
.rn .rn-mxl { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; align-self: center; padding-right: 6px; }
.rn .rn-mxc { display: flex; flex-direction: column; justify-content: space-between; gap: 2px; padding: 2px 3px; min-height: 26px; box-sizing: border-box; border-radius: 3px; border: 1px solid var(--line); background: color-mix(in srgb, var(--accent) var(--a), transparent); font-variant-numeric: tabular-nums; }
.rn .rn-mxc.z { background: none; opacity: .5; } .rn .rn-mxc b { font-size: 10.5px; } .rn .rn-mxc .rn-ob { height: 4px; }
.rn .rn-mxs { text-align: right; align-self: center; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.rn .rn-key { display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; }
.rn .rn-key i { display: inline-block; width: 10px; height: 8px; border-radius: 2px; }
.rn .rn-key i.rn-sw-inf { border: 1px dashed var(--vscode-descriptionForeground); }
.rn .rn-key i.rn-sw-fail { background: var(--raise); box-shadow: inset 0 -2px 0 var(--bad); }
.rn .rn-key i.rn-sw-live { background: var(--ok); }
.rn .rn-key i.rn-sw-now { width: 2px; background: var(--bad); }
.rn .rn-key i.rn-sw-pk { background: var(--accent); } .rn .rn-key i.rn-sw-open { border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.rn .rn-key i.rn-sw-avg { height: 2px; background: var(--vscode-foreground); } .rn .rn-key i.rn-sw-wait { background: var(--warn); }
.rn .rn-key i.rn-sw-tgt { height: 0; border-top: 2px dashed var(--bad); } .rn .rn-key i.rn-sw-over { background: color-mix(in srgb, var(--bad) 62%, transparent); }
.rn .rn-cc { display: grid; grid-template-columns: 28px minmax(0, 1fr); height: 170px; max-width: 1400px; }
.rn .rn-yax { position: relative; font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.rn .rn-yax span { position: absolute; right: 5px; transform: translateY(50%); }
.rn .rn-plot { position: relative; border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.rn .rn-gl { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in srgb, var(--line) 60%, transparent); }
.rn .rn-tgt { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--bad); z-index: 2; pointer-events: none; }
.rn .rn-tgt b { position: absolute; right: 2px; top: -15px; font-size: 9.5px; color: var(--bad); background: var(--vscode-editor-background, transparent); padding: 0 3px; }
.rn .rn-cols { position: absolute; inset: 0; display: flex; gap: 1px; padding: 0 1px; }
.rn .rn-c { position: relative; flex: 1 1 0; min-width: 0; }
.rn .rn-c:hover { background: var(--vscode-list-hoverBackground); }
.rn .rn-c i { position: absolute; left: 12%; right: 12%; bottom: 0; display: block; }
.rn .rn-open { background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-bottom: none; box-sizing: border-box; border-radius: 2px 2px 0 0; }
.rn .rn-pk { background: var(--accent); border-radius: 2px 2px 0 0; } .rn .rn-pk.over { background: color-mix(in srgb, var(--bad) 62%, transparent); border-top: 2px solid var(--bad); box-sizing: border-box; }
.rn .rn-avg { height: 2px; background: var(--vscode-foreground); left: 4% !important; right: 4% !important; opacity: .7; }
.rn .rn-wait { background: repeating-linear-gradient(45deg, var(--warn) 0 3px, color-mix(in srgb, var(--warn) 45%, transparent) 3px 6px); border-radius: 2px 2px 0 0; }
.rn .rn-cnow { background: color-mix(in srgb, var(--accent) 7%, transparent); } .rn .rn-fut { opacity: .35; }
.rn .rn-xax { display: flex; gap: 1px; margin-left: 29px; padding: 0 1px; max-width: calc(1400px - 29px); overflow-x: clip; font-size: 9.5px; color: var(--vscode-descriptionForeground); }
.rn .rn-xax span { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: visible; }
.rn svg.rn-ln { width: 100%; max-width: 1400px; height: auto; display: block; }
.rn .rn-g { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.rn .rn-ax { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.rn .rn-tl { stroke: var(--bad); stroke-width: 1.5; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
.rn .rn-lp { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.rn .rn-la { fill: none; stroke: var(--vscode-foreground); stroke-width: 1; stroke-dasharray: 3 3; opacity: .7; vector-effect: non-scaling-stroke; }
.rn .rn-lo { fill: none; stroke: color-mix(in srgb, var(--accent) 45%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
.rn .rn-pt { fill: var(--accent); } .rn .rn-pt.over { fill: var(--bad); }
.rn .rn-hm { display: grid; grid-template-columns: 70px repeat(24, minmax(16px, 1fr)) 34px; gap: 2px; font-size: 10px; max-width: 1100px; overflow-x: auto; }
.rn .rn-hm i { height: 18px; border-radius: 2px; border: 1px solid var(--line); font-style: normal; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--accent) var(--a), transparent); color: var(--vscode-foreground); }
.rn .rn-hm i.hi { color: var(--vscode-button-foreground, #fff); } .rn .rn-hm i.over { outline: 1px solid var(--bad); outline-offset: -1px; } .rn .rn-hm i.fut { opacity: .3; }
.rn .rn-hh { color: var(--vscode-descriptionForeground); text-align: left; } .rn .rn-hl { align-self: center; white-space: nowrap; } .rn .rn-hs { align-self: center; text-align: right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
@media (max-width: 720px) { .rn .rn-grid { grid-template-columns: minmax(80px, 120px) minmax(0, 1fr) 0; } .rn .rn-st, .rn .rn-sth { display: none; } }
`;

export const runsView: ExtraView = {
  id: 'runs',
  label: 'Run strips',
  group: 'Time',
  hint: 'One row per repository, one tick per session over 14 days, and concurrency per hour against agent.parallelTarget.',
  ready: true,
  render,
  css: CSS,
  feeds: [configFeed as Feed],
};
