// Add-on screen "Forecast": Gantt of workflow runs → phases → agents and lead sessions → workers on a shared
// time axis, with projected end times from local history only (src/activity/forecast.ts). No AI, no network.
import type { WfRun, WorkflowsSnapshot } from '../../providers/claude/workflows';
import { AccuracySummary, buildForecast, FcItem, fmtDur, Forecast } from '../../activity/forecast';
import { compact, identityColor } from '../../activity/insights';
import { esc } from '../html';
import { hhmm } from '../views';
import { kpi, WsData, WsState } from '../workspace';
import { feedValue, Feed } from './feeds';
import { ExtraView, loadError, loading, opt, seg, toolbar } from './kit';
import { workflowsFeed } from './workflows';

const ZOOM: Record<string, { span: number; tick: number }> = {
  '15m': { span: 15 * 60_000, tick: 3 * 60_000 },
  '1h': { span: 3600_000, tick: 10 * 60_000 },
  '6h': { span: 6 * 3600_000, tick: 3600_000 },
  '24h': { span: 24 * 3600_000, tick: 3 * 3600_000 },
};
/** Share of the axis left of the now line (past); the rest is room for projections. */
const PAST = 0.7;
const MAX_ROWS = 200;
const MAX_COLS = 48;

const KIND_LABEL: Record<string, string> = { run: 'workflow run', phase: 'phase', agent: 'workflow agent', lead: 'lead session', worker: 'worker' };
const STATE_LABEL: Record<string, string> = { running: 'running', done: 'done', failed: 'failed', stale: 'no result', pending: 'not started' };

interface Win {
  t0: number;
  t1: number;
  span: number;
}

const pct = (w: Win, t: number) => Math.min(100, Math.max(0, ((t - w.t0) / w.span) * 100));

function when(now: number, t: number | undefined): string {
  if (t === undefined || !isFinite(t)) return '—';
  return Math.abs(now - t) < 86400_000 ? hhmm(t) : `${new Date(t).toISOString().slice(5, 10)} ${hhmm(t)}`;
}

function colorOf(it: FcItem, by: string): string {
  if (by === 'identity') return identityColor(it.ident);
  if (by === 'provider') return it.provider === 'codex' ? 'var(--codex)' : 'var(--claude)';
  return ({ running: 'var(--accent)', done: 'var(--ok)', failed: 'var(--bad)', stale: 'var(--warn)', pending: 'var(--quiet)' } as Record<string, string>)[it.state];
}

/** End of what the bar must show: projection end for running / pending, actual end otherwise. */
const reach = (it: FcItem) => Math.max(it.end, it.est?.highAt ?? 0, it.est?.etaAt ?? 0);

function etaText(it: FcItem, now: number): string {
  const e = it.est;
  if (it.state !== 'running' && it.state !== 'pending') return it.state === 'done' ? `took ${fmtDur(it.end - it.start)}` : STATE_LABEL[it.state];
  if (!e) return 'no history';
  if (e.overrun) return 'over typical';
  if (e.etaAt === undefined) return '—';
  const left = e.etaAt - now;
  return left <= 0 ? `due ${fmtDur(-left)} ago` : `ETA ${when(now, e.etaAt)} · ${fmtDur(left)}`;
}

function tip(it: FcItem, now: number): string {
  const lines = [
    `${it.label} — ${KIND_LABEL[it.kind]} · ${STATE_LABEL[it.state]}`,
    it.detail,
    it.state === 'pending' ? `projected start ${when(now, it.start)}` : `started ${when(now, it.start)} (OBSERVED) · ${it.state === 'running' ? 'elapsed' : 'took'} ${fmtDur(it.end - it.start)} (DERIVED)`,
  ];
  if (it.progress) lines.push(`progress ${it.progress.done}/${it.progress.total} agents done${it.progress.phases ? ` · phase ${it.progress.phaseIdx ?? 0}/${it.progress.phases}${it.progress.phase ? ` ${it.progress.phase}` : ''}` : ''} (OBSERVED journal)`);
  if (it.tokens) lines.push(`${it.tokens.toLocaleString()} tokens (OBSERVED)`);
  if (it.ratePerMin) lines.push(`${compact(Math.round(it.ratePerMin))} tok/min — ${it.rateBasis ?? ''}`);
  if (it.est) {
    lines.push(`INFERRED: ${it.est.basis}`);
    if (it.est.etaAt !== undefined) lines.push(`ETA ${when(now, it.est.etaAt)}, range ${when(now, it.est.lowAt)}–${when(now, it.est.highAt)}`);
    if (it.est.projectedTokens) lines.push(`projected ${compact(it.est.projectedTokens)} tokens at ETA (INFERRED: current rate × remaining)`);
  } else if (it.state === 'running') lines.push('no ETA: fewer than the minimum similar finished items in local history');
  return lines.filter(Boolean).join('\n');
}

function rowAttrs(it: FcItem): string {
  return it.selectKey ? ` data-select="${esc(it.selectKey)}" tabindex="0"` : '';
}

function bars(it: FcItem, w: Win, color: string, vertical: boolean, now: number): string {
  const pos = (a: number, b: number) => {
    const s = pct(w, a), e = pct(w, b);
    const size = Math.max(e - s, 0.35);
    return vertical ? `top:${s.toFixed(2)}%;height:${size.toFixed(2)}%` : `left:${s.toFixed(2)}%;width:${size.toFixed(2)}%`;
  };
  const out: string[] = [];
  const e = it.est;
  if (e?.lowAt !== undefined && e.highAt !== undefined && e.highAt > w.t0 && e.lowAt < w.t1) out.push(`<i class="fc-band" style="${pos(e.lowAt, e.highAt)}" title="${esc(`p25–p75 range ${when(now, e.lowAt)}–${when(now, e.highAt)} (INFERRED)`)}"></i>`);
  if (it.state !== 'pending' && it.end >= w.t0 && it.start <= w.t1) out.push(`<i class="fc-bar fc-${esc(it.state)}" style="${pos(it.start, it.end)};--c:${color}"></i>`);
  if (e?.etaAt !== undefined && e.etaAt > Math.max(it.end, w.t0) && it.end < w.t1) out.push(`<i class="fc-proj" style="${pos(Math.max(it.end, it.start), e.etaAt)};--c:${color}"></i>`);
  if (e?.overrun && it.state === 'running') out.push(`<i class="fc-over" style="${vertical ? 'top' : 'left'}:${pct(w, it.end).toFixed(2)}%" title="already longer than similar items (INFERRED)">!</i>`);
  if (e?.etaAt !== undefined && e.etaAt > w.t1) out.push(`<i class="fc-clip" title="${esc(`ETA ${when(now, e.etaAt)} is beyond this zoom`)}">${vertical ? '▼' : '▶'}</i>`);
  return out.join('');
}

function axis(w: Win, now: number, tick: number, vertical: boolean): string {
  const first = Math.ceil(w.t0 / tick) * tick;
  const marks: string[] = [];
  // Labels too close to the edges would collide with the label / ETA columns.
  for (let t = first; t <= w.t1; t += tick) if (pct(w, t) > 2 && pct(w, t) < 96) marks.push(`<span style="${vertical ? 'top' : 'left'}:${pct(w, t).toFixed(2)}%">${esc(when(now, t))}</span>`);
  return marks.join('');
}

function gridLines(w: Win, tick: number, vertical: boolean): string {
  const first = Math.ceil(w.t0 / tick) * tick;
  const out: string[] = [];
  for (let t = first; t <= w.t1; t += tick) out.push(`<i class="fc-gl" style="${vertical ? 'top' : 'left'}:${pct(w, t).toFixed(2)}%"></i>`);
  return out.join('');
}

function ganttH(items: FcItem[], w: Win, d: WsData, st: WsState, tick: number): string {
  const by = opt(st, 'forecast.color', 'status');
  const nowAt = pct(w, d.now);
  const rows = items.map(it => {
    const c = colorOf(it, by);
    const ind = it.depth * 12;
    const prog = it.progress ? `<span class="fc-prog" title="agents done / started (OBSERVED)">${it.progress.done}/${it.progress.total}</span>` : '';
    const rate = it.ratePerMin ? `<span class="muted" title="${esc(it.rateBasis ?? '')}">${esc(compact(Math.round(it.ratePerMin)))}/min</span>` : '';
    const proj = it.est?.projectedTokens ? `<span class="muted" title="INFERRED: tokens now + current rate × remaining">→ ${esc(compact(it.est.projectedTokens))}</span>` : '';
    const n = it.est ? `<span class="fc-n" title="${esc(`INFERRED: ${it.est.basis}`)}">${it.est.source === 'composition' ? 'Σ' : `n=${it.est.total}`}</span>` : '';
    return `<div class="fc-row fc-k-${esc(it.kind)}${st.selected && st.selected === it.selectKey ? ' sel' : ''}"${rowAttrs(it)} title="${esc(tip(it, d.now))}">
<div class="fc-lab" style="padding-left:${ind + 4}px"><i class="fc-sw" style="background:${colorOf(it, by === 'status' ? 'identity' : by)}"></i><span class="fc-name">${esc(it.label)}</span>${prog}</div>
<div class="fc-track">${bars(it, w, c, false, d.now)}</div>
<div class="fc-eta"><span class="fc-e-${it.est?.overrun ? 'over' : it.state}">${esc(etaText(it, d.now))}</span> ${n} ${rate} ${proj}</div></div>`;
  }).join('');
  return `<div class="fc-g" style="--now:${nowAt.toFixed(2)}%">
<div class="fc-row fc-head"><div class="fc-lab muted">${items.length} items</div><div class="fc-axis">${axis(w, d.now, tick, false)}</div><div class="fc-eta muted">ETA (INFERRED)</div></div>
<div class="fc-body"><div class="fc-over-l"><div></div><div class="fc-ovl">${gridLines(w, tick, false)}<i class="fc-now" title="now ${esc(hhmm(d.now))}"></i></div><div></div></div>${rows}</div></div>`;
}

/** Keeps running / pending items (and their parents) first, then the most recent others, in display order. */
export function capItems(items: FcItem[], max: number): FcItem[] {
  if (items.length <= max) return items;
  const byId = new Map(items.map(it => [it.id, it]));
  const keep = new Set<string>();
  const add = (it: FcItem) => {
    const chain: FcItem[] = [];
    for (let x: FcItem | undefined = it; x && !keep.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) chain.push(x);
    if (keep.size + chain.length > max) return;
    for (const x of chain) keep.add(x.id);
  };
  for (const it of items) if (it.state === 'running' || it.state === 'pending') add(it);
  for (let i = items.length - 1; i >= 0 && keep.size < max; i--) add(items[i]);
  return items.filter(it => keep.has(it.id));
}

function ganttV(items: FcItem[], w: Win, d: WsData, st: WsState, tick: number): string {
  const by = opt(st, 'forecast.color', 'status');
  const cols = capItems(items, MAX_COLS);
  const body = cols.map(it => `<div class="fc-col fc-k-${esc(it.kind)}"${rowAttrs(it)} title="${esc(tip(it, d.now))}"><div class="fc-vlab"><span>${esc(it.label)}</span></div><div class="fc-vtrack">${bars(it, w, colorOf(it, by), true, d.now)}</div><div class="fc-veta">${esc(it.est?.etaAt !== undefined && (it.state === 'running' || it.state === 'pending') ? when(d.now, it.est.etaAt) : it.est?.overrun ? '!' : '')}</div></div>`).join('');
  return `<div class="fc-v" style="--now:${pct(w, d.now).toFixed(2)}%"><div class="fc-vaxis"><div class="fc-vlab"></div><div class="fc-vticks">${axis(w, d.now, tick, true)}</div><div class="fc-veta muted">ETA</div></div><div class="fc-vcols">${body}<div class="fc-vgrid">${gridLines(w, tick, true)}<i class="fc-now"></i></div></div></div>${items.length > MAX_COLS ? `<div class="muted">${MAX_COLS} of ${items.length} items (running first, then most recent); switch to horizontal for more.</div>` : ''}`;
}

function etaTable(items: FcItem[], d: WsData, st: WsState): string {
  const live = items.filter(it => it.state === 'running' || it.state === 'pending');
  if (!live.length) return '<div class="empty">Nothing running in this selection.</div>';
  const rows = live.map(it => {
    const e = it.est;
    return `<tr class="fc-tr${st.selected && st.selected === it.selectKey ? ' sel' : ''}"${rowAttrs(it)}>
<td style="padding-left:${it.depth * 12 + 4}px"><b>${esc(it.label)}</b> <span class="muted">${esc(it.detail)}</span></td>
<td class="fc-kind">${esc(KIND_LABEL[it.kind])}</td>
<td class="num" title="OBSERVED">${esc(it.state === 'pending' ? '—' : when(d.now, it.start))}</td>
<td class="num" title="DERIVED">${esc(it.state === 'pending' ? '—' : fmtDur(d.now - it.start))}</td>
<td class="num" title="${esc(it.progress ? 'agents done / started (OBSERVED)' : '')}">${it.progress ? `${it.progress.done}/${it.progress.total}${it.progress.phases ? ` · ph ${it.progress.phaseIdx ?? 0}/${it.progress.phases}` : ''}` : ''}</td>
<td class="num fc-e-${e?.overrun ? 'over' : 'running'}" title="INFERRED">${esc(e?.etaAt !== undefined ? when(d.now, e.etaAt) : e?.overrun ? 'over typical' : '—')}</td>
<td class="num" title="INFERRED">${esc(e?.etaAt !== undefined ? fmtDur(e.etaAt - d.now) : '—')}</td>
<td class="num" title="INFERRED p25–p75">${esc(e?.lowAt !== undefined ? `${when(d.now, e.lowAt)}–${when(d.now, e.highAt)}` : '—')}</td>
<td class="num" title="${esc(e ? `samples used / of the key (${e.keyLabel})` : '')}">${esc(e ? (e.source === 'composition' ? 'Σ' : `${e.n}/${e.total}`) : '0')}</td>
<td class="num" title="${esc(it.rateBasis ?? '')}">${esc(it.ratePerMin ? compact(Math.round(it.ratePerMin)) : '—')}</td>
<td class="num" title="INFERRED: tokens now + current rate × remaining">${esc(e?.projectedTokens ? compact(e.projectedTokens) : '—')}</td>
<td class="fc-basis">${esc(e?.basis ?? 'no similar finished items in local history')}</td></tr>`;
  }).join('');
  return `<table class="fc-t"><tr><th>Item</th><th>Level</th><th>Started</th><th>Elapsed</th><th>Progress</th><th>ETA</th><th>Left</th><th>p25–p75</th><th>n</th><th>tok/min</th><th>Tok at ETA</th><th>Basis (INFERRED)</th></tr>${rows}</table>`;
}

function pctText(x: number | undefined): string {
  return x === undefined || !isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${Math.round(x * 100)} %`;
}

function accuracyView(a: AccuracySummary, d: WsData, kinds: Set<string>): string {
  const rows = a.rows.filter(r => kinds.has(r.kind));
  if (!rows.length) return '<div class="empty">No finished item had enough earlier similar items to back-test the ETA rule.</div>';
  const scored = rows.filter(r => r.err !== undefined);
  const abs = scored.map(r => Math.abs(r.err!)).sort((x, y) => x - y);
  const med = abs.length ? abs[Math.floor((abs.length - 1) / 2)] : undefined;
  const inBand = scored.filter(r => r.inBand).length;
  const head = `<div class="kpis">${kpi(rows.length, 'back-tested', '', 'finished items with ≥ minimum earlier similar items')}${kpi(med !== undefined ? `${Math.round(med * 100)} %` : '—', 'median |error|', '', 'DERIVED: |predicted − actual| / actual')}${kpi(scored.length ? `${Math.round((100 * inBand) / scored.length)} %` : '—', 'inside p25–p75', '', 'DERIVED')}${kpi(rows.length - scored.length, 'flagged over typical')}</div>`;
  const body = rows.map(r => {
    // Per-row scale: durations range from seconds (agents) to days (lead sessions).
    const max = Math.max(r.actual, r.high ?? 0, r.predicted ?? 0, 1) * 1.08;
    const w = (x: number) => ((x / max) * 100).toFixed(2);
    const viz = `<div class="fc-acc">${r.low !== undefined && r.high !== undefined ? `<i class="fc-aband" style="left:${w(r.low)}%;width:${(Number(w(r.high)) - Number(w(r.low))).toFixed(2)}%"></i>` : ''}<i class="fc-aact" style="width:${w(r.actual)}%"></i>${r.predicted !== undefined ? `<i class="fc-apred" style="left:${w(r.predicted)}%"></i>` : ''}</div>`;
    const err = r.err === undefined ? 'over typical at 50 %' : pctText(r.err);
    return `<tr><td><b>${esc(r.label)}</b></td><td class="fc-kind">${esc(KIND_LABEL[r.kind])}</td><td class="num">${esc(when(d.now, r.start))}</td><td class="num" title="DERIVED">${esc(fmtDur(r.actual))}</td><td class="num" title="INFERRED at 50 % elapsed">${esc(r.predicted !== undefined ? fmtDur(r.predicted) : '—')}</td><td class="num">${esc(r.low !== undefined ? `${fmtDur(r.low)}–${fmtDur(r.high)}` : '—')}</td><td class="num fc-err ${r.inBand ? 'fc-good' : r.err !== undefined && Math.abs(r.err) > 0.5 ? 'fc-bad' : ''}">${esc(err)}</td><td class="num" title="${esc(r.keyLabel)}">${r.n}</td><td>${viz}</td></tr>`;
  }).join('');
  return `${head}<table class="fc-t"><tr><th>Item</th><th>Level</th><th>Started</th><th>Actual</th><th>Predicted</th><th>p25–p75</th><th>Error</th><th>n</th><th title="bar: actual · band: p25–p75 · tick: predicted median">Actual vs predicted</th></tr>${body}</table>
<div class="legend">Rule replayed at 50 % of each finished item with only items that had finished by then (OBSERVED times, INFERRED prediction). Error = (predicted − actual) / actual.</div>`;
}

function select(f: Forecast, w: Win, st: WsState): FcItem[] {
  const level = opt(st, 'forecast.level', 'all');
  const depth = { '1': 1, '2': 2, '3': 3 }[opt(st, 'forecast.depth', 'all')] ?? 99;
  const only = opt(st, 'forecast.only', 'all');
  const kinds = level === 'workflows' ? ['run', 'phase', 'agent'] : level === 'sessions' ? ['lead', 'worker'] : null;
  const keep = new Set<string>();
  const byId = new Map(f.items.map(it => [it.id, it]));
  for (const it of f.items) {
    if (kinds && !kinds.includes(it.kind)) continue;
    if (it.depth >= depth) continue;
    const live = it.state === 'running' || it.state === 'pending';
    if (only === 'live' && !live) continue;
    if (reach(it) < w.t0 || it.start > w.t1) continue;
    keep.add(it.id);
  }
  // A child is shown under its parent: keep the parent chain of every kept item.
  for (const id of [...keep]) {
    let p = byId.get(id)?.parentId;
    while (p && !keep.has(p)) {
      const pi = byId.get(p);
      if (!pi || pi.depth >= depth) break;
      keep.add(p);
      p = pi.parentId;
    }
  }
  return f.items.filter(it => keep.has(it.id));
}

export function renderForecast(d: WsData, st: WsState, snap: WorkflowsSnapshot | undefined, error?: string): string {
  const view = opt(st, 'forecast.view', 'gantt');
  const zoom = ZOOM[opt(st, 'forecast.zoom', '1h')] ?? ZOOM['1h'];
  const orient = opt(st, 'forecast.orient', 'horizontal');
  const minSamples = { '2': 2, '3': 3, '5': 5 }[opt(st, 'forecast.min', '3')] ?? 3;
  const bar = toolbar(
    seg(st, 'forecast.view', [['gantt', 'Gantt'], ['eta', 'ETA table'], ['accuracy', 'Accuracy']], 'gantt', 'View'),
    view === 'gantt' ? seg(st, 'forecast.zoom', [['15m', '15 min'], ['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h']], '1h', 'Zoom (time window)') : '',
    seg(st, 'forecast.level', [['all', 'All'], ['workflows', 'Workflows'], ['sessions', 'Sessions']], 'all', 'Level'),
    view !== 'accuracy' ? seg(st, 'forecast.depth', [['1', 'Depth 1'], ['2', '2'], ['all', 'All']], 'all', 'Depth: run → phase → agent · lead → workers') : '',
    view === 'gantt' ? seg(st, 'forecast.only', [['all', 'All in window'], ['live', 'Running only']], 'all', 'Filter') : '',
    view === 'gantt' ? seg(st, 'forecast.orient', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal', 'Orientation') : '',
    view === 'gantt' ? seg(st, 'forecast.color', [['status', 'Status'], ['identity', 'Repo / run'], ['provider', 'Provider']], 'status', 'Colour by') : '',
    seg(st, 'forecast.min', [['2', 'n≥2'], ['3', 'n≥3'], ['5', 'n≥5']], '3', 'Minimum similar finished items for an estimate'),
  );
  const keys = new Set(d.sessions.map(s => s.key));
  let runs: WfRun[] = snap?.runs ?? [];
  if (st.opts?.scope) runs = runs.filter(r => keys.has(r.parentKey));
  const f = buildForecast(d.sessions, runs, { now: d.now, minSamples });
  const running = f.items.filter(it => it.state === 'running');
  const withEta = running.filter(it => it.est?.etaAt !== undefined);
  const next = withEta.filter(it => it.est!.etaAt! > d.now).sort((a, b) => a.est!.etaAt! - b.est!.etaAt!)[0];
  const last = withEta.filter(it => it.depth === 0).sort((a, b) => b.est!.etaAt! - a.est!.etaAt!)[0];
  const rate = running.filter(it => it.depth === 0).reduce((n, it) => n + (it.ratePerMin ?? 0), 0);
  const kpis = `<div class="kpis">${kpi(running.length, 'running items', 'k-run', 'runs, phases, agents, sessions and workers (INFERRED from recency)')}${kpi(`${withEta.length}/${running.length}`, 'with ETA', '', 'INFERRED from local history')}${kpi(next ? `${hhmm(next.est!.etaAt)}` : '—', next ? `next: ${next.label.slice(0, 22)}` : 'next ETA', '', next ? `INFERRED: ${next.est!.basis}` : '')}${kpi(last ? hhmm(last.est!.etaAt) : '—', 'all top-level done', '', 'latest ETA among running top-level items (INFERRED)')}${kpi(running.filter(it => it.est?.overrun).length, 'over typical', '', 'running longer than almost every similar finished item')}${kpi(rate ? `${compact(Math.round(rate))}/min` : '—', 'tokens burn', '', 'sum of top-level token rates (DERIVED)')}${kpi(f.accuracy.medianAbsErr !== undefined ? `${Math.round(f.accuracy.medianAbsErr * 100)} %` : '—', 'median |error|', '', 'back-test at 50 % elapsed (Accuracy view)')}</div>`;
  const note = snap ? '' : `<div class="fc-note">${error ? loadError(`Workflow scan failed: ${error}`, 'refresh') : loading('forecast.workflows', 'Scanning ~/.claude/projects for workflow runs… sessions shown meanwhile.', { retry: 'refresh', inline: true })}</div>`;
  let body: string;
  if (view === 'accuracy') {
    const level = opt(st, 'forecast.level', 'all');
    const kinds = new Set(level === 'workflows' ? ['run', 'agent'] : level === 'sessions' ? ['lead', 'worker'] : ['run', 'agent', 'lead', 'worker']);
    body = accuracyView(f.accuracy, d, kinds);
  } else {
    const w: Win = view === 'gantt' ? { t0: d.now - zoom.span * PAST, t1: d.now + zoom.span * (1 - PAST), span: zoom.span } : { t0: -Infinity, t1: Infinity, span: 1 };
    let items = select(f, w, st);
    const cut = items.length > MAX_ROWS;
    if (cut) items = capItems(items, MAX_ROWS);
    if (view === 'eta') body = etaTable(items, d, st);
    else if (!items.length) body = '<div class="empty">Nothing ran in this window. Widen the zoom or switch level.</div>';
    else body = (orient === 'vertical' ? ganttV(items, w, d, st, zoom.tick) : ganttH(items, w, d, st, zoom.tick)) + (cut ? `<div class="muted">${MAX_ROWS} items shown (running first, then most recent).</div>` : '');
  }
  const legend = `<div class="legend fc-legend"><i class="fc-bar fc-sample fc-done" style="--c:var(--ok)"></i> done <i class="fc-bar fc-sample fc-running" style="--c:var(--accent)"></i> running <i class="fc-proj fc-sample" style="--c:var(--accent)"></i> projected to ETA <i class="fc-band fc-sample"></i> p25–p75 <i class="fc-nowk"></i> now · Σ = composed from child ETAs · times OBSERVED, durations DERIVED, every ETA INFERRED from finished items in local history (median, conditioned on the elapsed time; no AI, no network) · ${f.samples} history keys${snap ? ` · workflow scan ${snap.scanMs} ms` : ''}</div>`;
  return `${bar}${kpis}${note}${body}${legend}`;
}

export const forecastView: ExtraView = {
  id: 'forecast',
  label: 'Forecast',
  group: 'Time',
  hint: 'Gantt of running workflows, agents and sessions with projected end times from your own history (no AI).',
  ready: true,
  feeds: [workflowsFeed as Feed],
  badge: () => '',
  actions: { refresh: (_arg, ctx) => ctx.refreshFeeds() },
  render: (d, st) => {
    const fv = feedValue<WorkflowsSnapshot>(workflowsFeed.id);
    return `<div class="fc">${renderForecast(d, st, fv.value, fv.error)}</div>`;
  },
  css: `
.fc { --lw: 250px; --rw: 210px; }
.fc .fc-note { font-size: 11px; margin: 0 0 6px; }
.fc .fc-g { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 4px 0; }
.fc .fc-row { display: grid; grid-template-columns: var(--lw) 1fr var(--rw); align-items: center; min-height: 18px; }
.fc .fc-row[data-select] { cursor: pointer; }
.fc .fc-row:hover:not(.fc-head), .fc .fc-row.sel { background: var(--vscode-list-hoverBackground); }
.fc .fc-head { border-bottom: 1px solid var(--line); font-size: 10px; min-height: 16px; }
.fc .fc-body { position: relative; }
.fc .fc-over-l { position: absolute; inset: 0; display: grid; grid-template-columns: var(--lw) 1fr var(--rw); pointer-events: none; }
.fc .fc-ovl { position: relative; }
.fc .fc-gl { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--line) 80%, transparent); }
.fc .fc-now { position: absolute; top: -2px; bottom: 0; left: var(--now); width: 0; border-left: 2px solid var(--bad); opacity: .8; }
.fc .fc-lab { display: flex; gap: 5px; align-items: center; overflow: hidden; white-space: nowrap; font-size: 11px; min-width: 0; }
.fc .fc-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.fc .fc-k-run .fc-name, .fc .fc-k-lead .fc-name { font-weight: 600; }
.fc .fc-k-phase .fc-name { font-style: italic; }
.fc .fc-sw { flex: none; width: 4px; height: 12px; border-radius: 1px; }
.fc .fc-prog { font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.fc .fc-axis { position: relative; height: 14px; color: var(--vscode-descriptionForeground); }
.fc .fc-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.fc .fc-track { position: relative; height: 12px; }
.fc .fc-eta { font-size: 10.5px; padding-left: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.fc .fc-n { font-size: 10px; border: 1px solid var(--line); border-radius: 6px; padding: 0 4px; color: var(--vscode-descriptionForeground); }
.fc .fc-e-running { color: var(--accent); } .fc .fc-e-pending { color: var(--vscode-descriptionForeground); } .fc .fc-e-over { color: var(--warn); font-weight: 600; }
.fc .fc-e-done { color: var(--vscode-descriptionForeground); } .fc .fc-e-failed { color: var(--bad); } .fc .fc-e-stale { color: var(--warn); }
.fc .fc-bar { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; background: var(--c); z-index: 1; }
.fc .fc-bar.fc-done { opacity: .85; } .fc .fc-bar.fc-stale { opacity: .6; }
.fc .fc-bar.fc-running { box-shadow: 0 0 0 1px var(--c); }
.fc .fc-k-agent .fc-bar, .fc .fc-k-worker .fc-bar { top: 3px; bottom: 3px; }
.fc .fc-k-phase .fc-bar { top: 4px; bottom: 4px; }
.fc .fc-proj { position: absolute; top: 2px; bottom: 2px; border-radius: 0 2px 2px 0; border: 1px dashed var(--c); box-sizing: border-box; z-index: 1;
  background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--c) 55%, transparent) 0 3px, transparent 3px 6px); }
.fc .fc-band { position: absolute; top: 50%; height: 2px; margin-top: -1px; background: color-mix(in srgb, var(--vscode-foreground) 55%, transparent); z-index: 2; }
.fc .fc-band::before, .fc .fc-band::after { content: ''; position: absolute; top: -3px; width: 1px; height: 8px; background: inherit; }
.fc .fc-band::before { left: 0; } .fc .fc-band::after { right: 0; }
.fc .fc-over { position: absolute; top: -2px; font-style: normal; font-weight: 700; font-size: 11px; color: var(--warn); margin-left: 2px; z-index: 2; }
.fc .fc-clip { position: absolute; right: 0; top: -1px; font-style: normal; font-size: 9px; color: var(--vscode-descriptionForeground); }
.fc .fc-v { display: grid; grid-template-columns: 52px 1fr; border: 1px solid var(--line); border-radius: 6px; background: var(--raise); }
.fc .fc-v, .fc .fc-vaxis, .fc .fc-col { --vh: 420px; }
.fc .fc-vaxis, .fc .fc-col { display: grid; grid-template-rows: 110px var(--vh) 18px; }
.fc .fc-vticks { position: relative; font-size: 10px; color: var(--vscode-descriptionForeground); border-right: 1px solid var(--line); }
.fc .fc-vticks span { position: absolute; right: 4px; transform: translateY(-50%); white-space: nowrap; }
.fc .fc-vcols { position: relative; display: flex; overflow-x: auto; }
.fc .fc-col { flex: 0 0 24px; cursor: pointer; } .fc .fc-col:hover { background: var(--vscode-list-hoverBackground); }
.fc .fc-vlab { overflow: hidden; display: flex; align-items: flex-end; justify-content: center; }
.fc .fc-vlab span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 106px; }
.fc .fc-k-run .fc-vlab span, .fc .fc-k-lead .fc-vlab span { font-weight: 600; }
.fc .fc-vtrack { position: relative; }
.fc .fc-vtrack .fc-bar, .fc .fc-vtrack .fc-proj { top: auto; bottom: auto; left: 5px; right: 5px; }
.fc .fc-vtrack .fc-proj { border-radius: 0 0 2px 2px; background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--c) 55%, transparent) 0 3px, transparent 3px 6px); }
.fc .fc-vtrack .fc-band { top: auto; left: 50%; width: 2px; height: auto; margin: 0 0 0 -1px; }
.fc .fc-vtrack .fc-band::before, .fc .fc-vtrack .fc-band::after { left: -3px; width: 8px; height: 1px; top: auto; right: auto; }
.fc .fc-vtrack .fc-band::before { top: 0; } .fc .fc-vtrack .fc-band::after { bottom: 0; }
.fc .fc-vtrack .fc-over { left: 4px; margin: 0; }
.fc .fc-vtrack .fc-clip { right: auto; left: 7px; top: auto; bottom: 0; }
.fc .fc-veta { font-size: 9px; text-align: center; color: var(--accent); white-space: nowrap; overflow: hidden; }
.fc .fc-vgrid { position: absolute; left: 0; right: 0; top: 110px; height: var(--vh); pointer-events: none; }
.fc .fc-vgrid .fc-gl { left: 0; right: 0; width: auto; height: 1px; bottom: auto; }
.fc .fc-vgrid .fc-now { left: 0; right: 0; top: var(--now); bottom: auto; width: auto; height: 0; border-left: none; border-top: 2px solid var(--bad); }
.fc table.fc-t { width: 100%; font-size: 11.5px; }
.fc .fc-kind { white-space: nowrap; color: var(--vscode-descriptionForeground); }
.fc .fc-tr[data-select] { cursor: pointer; } .fc .fc-tr:hover, .fc .fc-tr.sel { background: var(--vscode-list-hoverBackground); }
.fc .fc-basis { font-size: 10.5px; color: var(--vscode-descriptionForeground); max-width: 420px; }
.fc .fc-err.fc-good { color: var(--ok); } .fc .fc-err.fc-bad { color: var(--bad); }
.fc .fc-acc { position: relative; width: 180px; height: 10px; background: color-mix(in srgb, var(--line) 35%, transparent); border-radius: 2px; }
.fc .fc-aact { position: absolute; left: 0; top: 2px; bottom: 2px; background: var(--ok); opacity: .75; border-radius: 2px; }
.fc .fc-aband { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 30%, transparent); border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); }
.fc .fc-apred { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--accent); }
.fc .fc-legend .fc-sample { position: relative; display: inline-block; top: 0; left: 0; width: 18px; height: 8px; vertical-align: middle; }
.fc .fc-legend .fc-band.fc-sample { height: 2px; margin: 0; }
.fc .fc-nowk { display: inline-block; width: 2px; height: 10px; background: var(--bad); vertical-align: middle; }
`,
};
