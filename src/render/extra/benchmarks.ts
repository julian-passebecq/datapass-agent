// Add-on screen "Model benchmarks": cost versus quality of coding models from Agent's weekly benchmark database
// (~/.agent/benchmarks, written by `npm run benchmarks`). SVG scatter with a log cost axis, one dot per row, the
// Pareto frontier (cheapest model for each level of score) as a line, labels on frontier points, a <title> tooltip
// per dot; Trend tab across weekly snapshots; table under the chart. Pure rendering of the feed value (escaped).
import * as fs from 'fs';
import {
  Axis, BenchRow, BenchSnapshot, BenchSource, benchSlug, linFrac, linTicks, logFrac, logTicks, pareto, trend, usd, usedLocally,
} from '../../activity/benchmarks';
import { compact, identityColor } from '../../activity/insights';
import { BENCH_FEED, BenchDb, benchmarksFeed, defaultBenchDir } from '../../feeds/benchmarks';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { kpi } from '../workspace';
import { feedValue } from './feeds';
import { ActCtx, actBtn, ExtraView, opt, seg, toolbar } from './kit';

const MAX_TABLE = 300;
const MAX_TREND = 12;
const MAX_CHOICES = 14;

const SCRIPT_CMD = 'npm run benchmarks';
const FETCH_CMD = 'npm run benchmarks -- --fetch';

const EV: Record<string, string> = {
  OBSERVED: 'OBSERVED: as recorded by the source.',
  DERIVED: 'DERIVED: computed deterministically from recorded values.',
  INFERRED: 'INFERRED: a heuristic, not a source fact.',
  UNKNOWN: 'UNKNOWN: not recorded.',
};
function ev(kind: keyof typeof EV, basis: string): string {
  return `<span class="bm-ev ${kind}" title="${esc(`${EV[kind]} ${basis}`)}">${kind.toLowerCase()}</span>`;
}

const day = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
const effortOf = (r: BenchRow) => r.effort ?? '';
const label = (r: BenchRow) => `${r.model}${r.effort ? ` · ${r.effort}` : ''}`;
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Evidence of a row's score and cost, from its source kind. */
export function rowEvidence(r: BenchRow, s: BenchSource | undefined): { score: string; cost: string } {
  const src = s ? `${s.name}${s.fetchedAt ? `, read ${day(s.fetchedAt)}` : ''}` : r.source;
  if (s?.kind === 'local') return {
    score: `DERIVED from your own dispatches (${s.metric})`,
    cost: r.costPerTask === undefined ? 'UNKNOWN: no price set for this model (agent.dispatch.pricePerMTok)' : 'DERIVED from your setting agent.dispatch.pricePerMTok',
  };
  if (s?.kind === 'manual') return {
    score: `OBSERVED as copied by you into manual/ (${src})`,
    cost: r.costPerTask === undefined ? 'UNKNOWN: not given in the file' : `OBSERVED as copied by you (${s.costBasis})`,
  };
  return {
    score: `OBSERVED from ${src}`,
    cost: r.costPerTask === undefined ? 'UNKNOWN: not recorded by the source' : `${s?.costBasis ?? 'as recorded by the source'} (${src})`,
  };
}

// ---- options -------------------------------------------------------------------------------------------------

interface Cfg {
  tab: 'chart' | 'trend';
  source: string;
  vendor: string;
  model: string;
  effort: string;
  mine: boolean;
  orient: 'x' | 'y';
  metric: 'score' | 'tokens';
  week?: BenchSnapshot;
}

function cfg(st: WsState, db: BenchDb): Cfg {
  const wk = opt(st, 'benchmarks.week', '');
  const weeks = db.weeks;
  return {
    tab: opt(st, 'benchmarks.tab', 'chart') === 'trend' ? 'trend' : 'chart',
    source: opt(st, 'benchmarks.source', 'all'),
    vendor: opt(st, 'benchmarks.vendor', 'all'),
    model: opt(st, 'benchmarks.model', 'all'),
    effort: opt(st, 'benchmarks.effort', 'all'),
    mine: opt(st, 'benchmarks.mine', 'all') === 'mine',
    orient: opt(st, 'benchmarks.orient', 'x') === 'y' ? 'y' : 'x',
    metric: opt(st, 'benchmarks.metric', 'score') === 'tokens' ? 'tokens' : 'score',
    week: weeks.find(w => w.week.toLowerCase() === wk) ?? weeks[weeks.length - 1],
  };
}

/** Words of model names, usable as a model filter ("opus", "gpt", "4.5"). */
export function modelWords(rows: BenchRow[]): [string, number][] {
  const n = new Map<string, number>();
  for (const r of rows) for (const w of new Set(r.model.toLowerCase().split(/[^a-z0-9.]+/).filter(x => x.length >= 2 && !/^\d{6,}$/.test(x)))) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
}

const modelHas = (m: string, word: string) => m.toLowerCase().split(/[^a-z0-9.]+/).includes(word);

export function filterRows(rows: BenchRow[], c: Cfg, localModels: string[]): BenchRow[] {
  return rows.filter(r =>
    (c.source === 'all' || benchSlug(r.source) === c.source) &&
    (c.vendor === 'all' || benchSlug(r.vendor) === c.vendor) &&
    (c.model === 'all' || modelHas(r.model, c.model)) &&
    (c.effort === 'all' || (c.effort === 'none' ? !r.effort : benchSlug(effortOf(r)) === c.effort)) &&
    (!c.mine || usedLocally(r.model, localModels)));
}

function select(name: string, cur: string, choices: [string, string][], title: string): string {
  return `<select class="bm-sel" data-opt="${esc(name)}" aria-label="${esc(title)}" title="${esc(title)}">${choices.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

function counted(values: string[]): [string, string][] {
  const n = new Map<string, { label: string; c: number }>();
  for (const v of values) {
    const k = benchSlug(v);
    n.set(k, { label: v, c: (n.get(k)?.c ?? 0) + 1 });
  }
  return [...n].sort((a, b) => b[1].c - a[1].c || a[1].label.localeCompare(b[1].label)).slice(0, MAX_CHOICES).map(([k, v]) => [k, `${trunc(v.label, 22)} ${v.c}`]);
}

// ---- markers -------------------------------------------------------------------------------------------------

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'] as const;
type Shape = (typeof SHAPES)[number];

function marker(shape: Shape, x: number, y: number, r: number, fill: string, extra: string): string {
  const p = (pts: [number, number][]) => pts.map(([a, b]) => `${(x + a).toFixed(1)},${(y + b).toFixed(1)}`).join(' ');
  switch (shape) {
    case 'square': return `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" fill="${fill}"${extra}/>`;
    case 'triangle': return `<polygon points="${p([[0, -r * 1.2], [r * 1.1, r * 0.8], [-r * 1.1, r * 0.8]])}" fill="${fill}"${extra}/>`;
    case 'diamond': return `<polygon points="${p([[0, -r * 1.3], [r * 1.3, 0], [0, r * 1.3], [-r * 1.3, 0]])}" fill="${fill}"${extra}/>`;
    case 'cross': {
      const a = r * 0.45;
      return `<polygon points="${p([[-a, -r], [a, -r], [a, -a], [r, -a], [r, a], [a, a], [a, r], [-a, r], [-a, a], [-r, a], [-r, -a], [-a, -a]])}" fill="${fill}"${extra}/>`;
    }
    default: return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"${extra}/>`;
  }
}

function shapeIcon(shape: Shape): string {
  return `<svg class="bm-ico" viewBox="-6 -6 12 12" width="11" height="11" aria-hidden="true">${marker(shape, 0, 0, 4, 'currentColor', '')}</svg>`;
}

// ---- scatter -------------------------------------------------------------------------------------------------

const W = 760, H = 430, ML = 66, MR = 28, MT = 18, MB = 50;
const PW = W - ML - MR, PH = H - MT - MB;

export interface Plotted {
  row: BenchRow;
  key: string;
  cost: number;
  value: number;
}

export function rowKeyOf(week: string, i: number): string {
  return `bench:${week}:${i}`;
}

function valueOf(r: BenchRow, metric: Cfg['metric']): number | undefined {
  return metric === 'tokens' ? (r.tokensPerTask !== undefined && r.tokensPerTask > 0 ? r.tokensPerTask : undefined) : r.score;
}

/** Frontier membership per source (indices into pts). */
export function frontiers(pts: Plotted[], metric: Cfg['metric']): Map<string, number[]> {
  const bySrc = new Map<string, number[]>();
  pts.forEach((p, i) => bySrc.set(p.row.source, [...(bySrc.get(p.row.source) ?? []), i]));
  const out = new Map<string, number[]>();
  for (const [src, idx] of bySrc) {
    const f = pareto(idx.map(i => ({ cost: pts[i].cost, value: pts[i].value })), metric === 'score');
    out.set(src, f.map(j => idx[j]));
  }
  return out;
}

function scatter(pts: Plotted[], c: Cfg, sources: Map<string, BenchSource>, shapeOf: (src: string) => Shape, sel: string | undefined, week: string): string {
  const costAx = logTicks(Math.min(...pts.map(p => p.cost)), Math.max(...pts.map(p => p.cost)));
  const vals = pts.map(p => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(1, (hi - lo) * 0.05);
  const valAx: Axis = c.metric === 'tokens' ? logTicks(lo, hi) : linTicks(lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad);
  const vFrac = (v: number) => (c.metric === 'tokens' ? logFrac(v, valAx) : linFrac(v, valAx));
  const units = [...new Set(pts.map(p => p.row.scoreUnit))];
  const valName = c.metric === 'tokens' ? 'Tokens per task (log)' : `Score${units.length === 1 ? ` (${units[0]})` : ' (units differ by source)'}`;
  const costName = 'Cost per task, USD (log)';
  // Cost on x: x = cost, y = value (up = better score). Cost on y: x = value, y = cost reversed (cheap at the top).
  const xy = (p: { cost: number; value: number }): [number, number] =>
    c.orient === 'x'
      ? [ML + logFrac(p.cost, costAx) * PW, MT + (1 - vFrac(p.value)) * PH]
      : [ML + vFrac(p.value) * PW, MT + logFrac(p.cost, costAx) * PH];
  const fmtVal = (v: number) => (c.metric === 'tokens' ? compact(Math.round(v)) : String(+v.toFixed(1)));
  let g = '';
  // grid + ticks
  const xTicks = c.orient === 'x' ? costAx.ticks.map(t => ({ f: logFrac(t, costAx), s: usd(t) })) : valAx.ticks.map(t => ({ f: vFrac(t), s: fmtVal(t) }));
  const yTicks = c.orient === 'x' ? valAx.ticks.map(t => ({ f: 1 - vFrac(t), s: fmtVal(t) })) : costAx.ticks.map(t => ({ f: logFrac(t, costAx), s: usd(t) }));
  for (const t of xTicks) {
    const x = ML + t.f * PW;
    g += `<line class="bm-grid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${MT}" y2="${MT + PH}"/><text class="bm-tick" x="${x.toFixed(1)}" y="${MT + PH + 14}" text-anchor="middle">${esc(t.s)}</text>`;
  }
  for (const t of yTicks) {
    const y = MT + t.f * PH;
    g += `<line class="bm-grid" x1="${ML}" x2="${ML + PW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="bm-tick" x="${ML - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(t.s)}</text>`;
  }
  g += `<rect class="bm-frame" x="${ML}" y="${MT}" width="${PW}" height="${PH}"/>`;
  g += `<text class="bm-axis" x="${ML + PW / 2}" y="${H - 8}" text-anchor="middle">${esc(c.orient === 'x' ? costName : valName)}</text>`;
  g += `<text class="bm-axis" transform="translate(14 ${MT + PH / 2}) rotate(-90)" text-anchor="middle">${esc(c.orient === 'x' ? valName : `${costName}, cheaper at the top`)}</text>`;
  // frontier lines
  const fr = frontiers(pts, c.metric);
  const onFrontier = new Set<number>();
  for (const idx of fr.values()) {
    idx.forEach(i => onFrontier.add(i));
    if (idx.length >= 2) g += `<polyline class="bm-front" points="${idx.map(i => xy(pts[i]).map(v => v.toFixed(1)).join(',')).join(' ')}"><title>${esc(`Pareto frontier · ${sources.get(pts[idx[0]].row.source)?.name ?? pts[idx[0]].row.source}: no other model of this source is both cheaper and ${c.metric === 'tokens' ? 'leaner' : 'better'} (DERIVED)`)}</title></polyline>`;
  }
  // dots (frontier last, on top)
  const order = pts.map((_, i) => i).sort((a, b) => Number(onFrontier.has(a)) - Number(onFrontier.has(b)));
  for (const i of order) {
    const p = pts[i];
    const [x, y] = xy(p);
    const s = sources.get(p.row.source);
    const e = rowEvidence(p.row, s);
    const tip = [
      label(p.row),
      `${p.row.vendor}${p.row.vendorInferred ? ' (vendor INFERRED from the name)' : ''}`,
      `score ${+p.row.score.toFixed(2)} ${p.row.scoreUnit}: ${e.score}`,
      `cost ${usd(p.cost)} per task: ${e.cost}`,
      p.row.tokensPerTask !== undefined ? `tokens per task ${compact(Math.round(p.row.tokensPerTask))}` : '',
      p.row.n !== undefined ? `n = ${p.row.n}` : '',
      `source ${s?.name ?? p.row.source} · week ${week}`,
      onFrontier.has(i) ? 'on the Pareto frontier (DERIVED)' : '',
      p.row.notes ?? '',
    ].filter(Boolean).join('\n');
    const isSel = sel === p.key;
    g += `<g class="bm-dot${onFrontier.has(i) ? ' fr' : ''}${isSel ? ' sel' : ''}" data-select="${esc(p.key)}">${marker(shapeOf(p.row.source), x, y, isSel ? 6.5 : onFrontier.has(i) ? 5 : 4, esc(identityColor(p.row.vendor)), ' class="bm-m"')}<title>${esc(tip)}</title></g>`;
  }
  // labels on frontier points
  for (const i of onFrontier) {
    const [x, y] = xy(pts[i]);
    const right = x < ML + PW * 0.75;
    g += `<text class="bm-lbl" x="${(x + (right ? 8 : -8)).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${esc(trunc(label(pts[i].row), 30))}</text>`;
  }
  return `<svg class="bm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${valName} versus ${costName}, ${pts.length} rows`)}">${g}</svg>`;
}

// ---- trend ---------------------------------------------------------------------------------------------------

function lineChart(series: { key: string; pts: { week: string; v?: number }[] }[], weeks: string[], log: boolean, title: string, fmt: (v: number) => string): string {
  const vals = series.flatMap(s => s.pts.map(p => p.v)).filter((v): v is number => v !== undefined && (!log || v > 0));
  if (!vals.length) return `<div class="muted bm-note">${esc(title)}: no value recorded ${ev('UNKNOWN', 'no row of these models carries this value')}</div>`;
  const ax = log ? logTicks(Math.min(...vals), Math.max(...vals)) : linTicks(Math.min(...vals), Math.max(...vals));
  const fy = (v: number) => (log ? logFrac(v, ax) : linFrac(v, ax));
  const w = 760, h = 260, ml = 66, mr = 150, mt = 14, mb = 34;
  const pw = w - ml - mr, ph = h - mt - mb;
  const fx = (wk: string) => ml + (weeks.length > 1 ? weeks.indexOf(wk) / (weeks.length - 1) : 0.5) * pw;
  let g = '';
  for (const t of ax.ticks) {
    const y = mt + (1 - fy(t)) * ph;
    g += `<line class="bm-grid" x1="${ml}" x2="${ml + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="bm-tick" x="${ml - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`;
  }
  const step = Math.max(1, Math.ceil(weeks.length / 10));
  weeks.forEach((wk, i) => {
    if (i % step === 0 || i === weeks.length - 1) g += `<text class="bm-tick" x="${fx(wk).toFixed(1)}" y="${mt + ph + 14}" text-anchor="middle">${esc(wk)}</text>`;
  });
  g += `<rect class="bm-frame" x="${ml}" y="${mt}" width="${pw}" height="${ph}"/>`;
  for (const s of series) {
    const col = esc(identityColor(s.key));
    const pts = s.pts.filter((p): p is { week: string; v: number } => p.v !== undefined && (!log || p.v > 0));
    if (!pts.length) continue;
    const xy = pts.map(p => [fx(p.week), mt + (1 - fy(p.v)) * ph] as const);
    if (xy.length > 1) g += `<polyline class="bm-tl" stroke="${col}" points="${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`;
    pts.forEach((p, i) => (g += `<circle cx="${xy[i][0].toFixed(1)}" cy="${xy[i][1].toFixed(1)}" r="3" fill="${col}"><title>${esc(`${s.key}\n${p.week}: ${fmt(p.v)}`)}</title></circle>`));
    const [lx, ly] = xy[xy.length - 1];
    g += `<text class="bm-lbl" x="${(ml + pw + 6).toFixed(1)}" y="${(ly + 3).toFixed(1)}" fill="${col}">${esc(trunc(s.key, 26))}</text><line class="bm-grid" x1="${lx.toFixed(1)}" x2="${ml + pw + 4}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"/>`;
  }
  return `<h3>${esc(title)}</h3><svg class="bm-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${g}</svg>`;
}

function trendView(db: BenchDb, c: Cfg, localModels: string[]): string {
  const keep = (r: BenchRow) => filterRows([r], c, localModels).length === 1;
  const tr = trend(db.weeks, keep);
  const weeks = db.weeks.map(w => w.week);
  const latest = (k: string) => tr.get(k)?.slice(-1)[0]?.score ?? -Infinity;
  const keys = [...tr.keys()].sort((a, b) => latest(b) - latest(a) || a.localeCompare(b)).slice(0, MAX_TREND);
  if (!keys.length) return '<div class="muted bm-note">No row matches the filters in any weekly snapshot.</div>';
  let h = `<div class="bm-note muted">Best score and its cost per model [· effort] [source] in each weekly snapshot, top ${keys.length} by latest score${tr.size > keys.length ? ` of ${tr.size}` : ''}. ${weeks.length < 2 ? 'Only one snapshot so far: lines appear after the next weekly run.' : `${weeks.length} snapshots.`}</div>`;
  const series = (f: (p: { score: number; cost?: number }) => number | undefined) => keys.map(k => ({ key: k, pts: (tr.get(k) ?? []).map(p => ({ week: p.week, v: f(p) })) }));
  h += lineChart(series(p => p.score), weeks, false, 'Score per week', v => String(+v.toFixed(1)));
  h += lineChart(series(p => p.cost), weeks, true, 'Cost per task per week (USD, log)', usd);
  return h;
}

// ---- screen --------------------------------------------------------------------------------------------------

function emptyState(db: BenchDb | undefined, error: string | undefined): string {
  const dir = db?.dir ?? defaultBenchDir();
  return `<div class="bm-empty">
<h3>No benchmark snapshot yet</h3>
<p>Agent keeps a local, week-by-week database of model benchmarks in <code>${esc(dir)}</code> (one file per ISO week, <code>YYYY-Www.json</code>). Nothing is downloaded unless you ask.</p>
<ol>
<li><code>${esc(SCRIPT_CMD)}</code> ${actBtn('copy', 'script', 'copy')}: writes this week's snapshot from your own dispatches (Local workload, DERIVED) and your manual files.</li>
<li><code>${esc(FETCH_CMD)}</code> ${actBtn('copy', 'fetch', 'copy')}: also downloads the public leaderboards (opt-in network: Aider polyglot).</li>
<li>Manual numbers (copied by you from Artificial Analysis, CursorBench …): put <code>*.json</code> files in <code>${esc(dir)}${esc(dir.includes('\\') ? '\\' : '/')}manual</code> (row format in the README), then run the script.</li>
</ol>
<p class="muted">Run it weekly next to the archive task (README, "Model benchmarks"). Older weeks are never deleted.${db?.manualFiles ? ` ${db.manualFiles} manual file(s) waiting for the next run.` : ''}</p>
${error ? `<p class="bm-err">Feed error: ${esc(error)}</p>` : ''}
${db?.errors.length ? `<p class="bm-err">${db.errors.map(e => `${esc(e.file)}: ${esc(e.error)}`).join('<br>')}</p>` : ''}
</div>`;
}

function sourceList(week: BenchSnapshot, shapeOf: (src: string) => Shape): string {
  return `<div class="bm-srcs">${week.sources.map(s => {
    const n = week.rows.filter(r => r.source === s.id).length;
    const kindEv = s.kind === 'local' ? ev('DERIVED', s.metric) : s.kind === 'manual' ? ev('OBSERVED', 'as copied by you into manual/') : ev('OBSERVED', `fetched ${day(s.fetchedAt)} from ${s.url ?? s.name}`);
    const tip = [s.name, `kind: ${s.kind}`, `score: ${s.metric}`, `cost: ${s.costBasis}`, s.license ? `license: ${s.license}` : '', s.url ?? '', `read ${day(s.fetchedAt)}`].filter(Boolean).join('\n');
    return `<span class="bm-src" title="${esc(tip)}">${shapeIcon(shapeOf(s.id))} <b>${esc(s.name)}</b> <span class="muted">${n} rows · ${esc(day(s.fetchedAt))}${s.license ? ` · ${esc(s.license)}` : ''}</span> ${kindEv}${s.url ? ` ${actBtn('url', s.url, 'source', s.url)}` : ''}</span>`;
  }).join('')}</div>`;
}

function table(rows: { row: BenchRow; key: string; front: boolean }[], sources: Map<string, BenchSource>, shapeOf: (src: string) => Shape, sel: string | undefined): string {
  const head: [string, string][] = [
    ['Model', 'model name as the source records it'], ['Vendor', 'as given, else INFERRED from the model name'], ['Effort', 'reasoning effort when recorded'], ['Source', ''],
    ['Score', 'OBSERVED from the source (local rows: DERIVED)'], ['Cost / task', 'USD per task; see the tooltip for its basis'], ['Tokens / task', 'when the source records tokens'], ['n', 'tasks or dispatches behind the score'], ['Frontier', 'DERIVED: on the Pareto frontier of its source in the current filter'], ['Notes', ''],
  ];
  let h = `<table class="bm-tb"><thead><tr>${head.map(([x, t]) => `<th${t ? ` title="${esc(t)}"` : ''}>${esc(x)}</th>`).join('')}</tr></thead><tbody>`;
  for (const { row: r, key, front } of rows.slice(0, MAX_TABLE)) {
    const s = sources.get(r.source);
    const e = rowEvidence(r, s);
    h += `<tr data-select="${esc(key)}" tabindex="0" class="${sel === key ? 'sel' : ''}"><td><span class="bm-sw" style="background:${esc(identityColor(r.vendor))}"></span>${esc(r.model)}</td><td${r.vendorInferred ? ' title="INFERRED from the model name" class="muted"' : ''}>${esc(r.vendor)}</td><td>${esc(r.effort ?? '—')}</td><td>${shapeIcon(shapeOf(r.source))} ${esc(s?.name ?? r.source)}</td><td class="r" title="${esc(e.score)}"><b>${esc(String(+r.score.toFixed(2)))}</b> <span class="muted">${esc(r.scoreUnit)}</span></td><td class="r" title="${esc(e.cost)}">${r.costPerTask === undefined ? '<span class="muted">—</span>' : esc(usd(r.costPerTask))}</td><td class="r">${r.tokensPerTask === undefined ? '<span class="muted">—</span>' : esc(compact(Math.round(r.tokensPerTask)))}</td><td class="r">${r.n === undefined ? '—' : esc(String(r.n))}</td><td>${front ? '●' : ''}</td><td class="muted bm-notes">${esc(r.notes ?? '')}</td></tr>`;
  }
  h += '</tbody></table>';
  if (rows.length > MAX_TABLE) h += `<div class="muted bm-note">+${rows.length - MAX_TABLE} more rows not shown.</div>`;
  return h;
}

export function renderBenchmarks(d: WsData, st: WsState, db: BenchDb | undefined, error?: string): string {
  if (!db || !db.weeks.length) return `<div class="bm">${emptyState(db, error)}</div>`;
  const c = cfg(st, db);
  const week = c.week as BenchSnapshot;
  const sources = new Map(week.sources.map(s => [s.id, s]));
  const allSrc = [...new Set(db.weeks.flatMap(w => w.sources.map(s => s.id)))].sort();
  const shapeOf = (src: string): Shape => SHAPES[Math.max(0, allSrc.indexOf(src)) % SHAPES.length];
  const localModels = [...new Set(d.sessions.map(s => s.model).filter((m): m is string => !!m))];
  const keyed = week.rows.map((row, i) => ({ row, key: rowKeyOf(week.week, i) }));
  const rows = filterRows(week.rows, c, localModels);
  const inRows = new Set(rows);
  const visible = keyed.filter(k => inRows.has(k.row));
  const hasTokens = week.rows.some(r => r.tokensPerTask !== undefined);
  const metric = c.metric === 'tokens' && hasTokens ? 'tokens' : 'score';
  const cc = { ...c, metric } as Cfg;

  let h = '<div class="bm">';
  h += toolbar(
    seg(st, 'benchmarks.tab', [['chart', 'Cost vs quality'], ['trend', 'Trend']], 'chart', 'View'),
    select('benchmarks.week', week.week.toLowerCase(), [...db.weeks].reverse().map(w => [w.week.toLowerCase(), `${w.week}${w === db.weeks[db.weeks.length - 1] ? ' (latest)' : ''}`]), 'Weekly snapshot'),
    c.tab === 'chart' ? seg(st, 'benchmarks.orient', [['x', 'Cost on x'], ['y', 'Cost on y (reversed)']], 'x', 'Orientation') : '',
    c.tab === 'chart' ? seg(st, 'benchmarks.metric', hasTokens ? [['score', 'Score'], ['tokens', 'Tokens / task']] : [['score', 'Score']], 'score', 'Other axis (tokens only when a source records them)') : '',
  );
  h += toolbar(
    seg(st, 'benchmarks.source', [['all', 'All sources'], ...week.sources.map(s => [benchSlug(s.id), trunc(s.name, 20)] as [string, string])], 'all', 'Source (all: one marker shape per source)'),
    select('benchmarks.vendor', c.vendor, [['all', 'All vendors'], ...counted(week.rows.map(r => r.vendor))], 'Vendor'),
    select('benchmarks.model', c.model, [['all', 'Any model name'], ...modelWords(week.rows).map(([w, n]) => [benchSlug(w), `contains “${w}” ${n}`] as [string, string])], 'Model name filter (words of the model names)'),
    select('benchmarks.effort', c.effort, [['all', 'Any effort'], ['none', 'No effort recorded'], ...counted(week.rows.map(effortOf).filter(Boolean))], 'Reasoning effort'),
    seg(st, 'benchmarks.mine', [['all', 'All models'], ['mine', 'Only models I use']], 'all', `Only models seen in your loaded sessions (INFERRED name match): ${localModels.slice(0, 8).join(', ') || 'none loaded'}`),
  );

  const plotted: Plotted[] = [];
  for (const k of visible) {
    const v = valueOf(k.row, metric);
    if (k.row.costPerTask !== undefined && k.row.costPerTask > 0 && v !== undefined) plotted.push({ row: k.row, key: k.key, cost: k.row.costPerTask, value: v });
  }
  const fr = frontiers(plotted, metric);
  const frontKeys = new Set([...fr.values()].flat().map(i => plotted[i].key));

  h += `<div class="kpis">${kpi(rows.length, 'Rows shown', '', `${week.rows.length} rows in ${week.week}`)}${kpi(new Set(rows.map(r => r.model)).size, 'Models')}${kpi(week.sources.length, 'Sources')}${kpi(frontKeys.size, 'On the frontier', '', 'DERIVED: Pareto frontier per source over the plotted rows')}${kpi(db.weeks.length, 'Weekly snapshots', '', `${db.dir}`)}</div>`;
  h += sourceList(week, shapeOf).replace(/<\/div>$/, ` ${actBtn('open', '', 'Open folder', db.dir)}</div>`);
  h += `<div class="bm-note muted">Week ${esc(week.week)} · captured ${esc(day(week.capturedAt))}${week.updatedAt ? `, updated ${esc(day(week.updatedAt))}` : ''} · public rows ${ev('OBSERVED', 'as recorded by the source, with its URL and read date')} · local rows ${ev('DERIVED', 'from your own dispatches')} · cost from your prices ${ev('DERIVED', 'from agent.dispatch.pricePerMTok')} · vendor ${ev('INFERRED', 'from the model name when the source gives none')} · colour = vendor, shape = source.</div>`;

  if (c.tab === 'trend') {
    h += trendView(db, cc, localModels);
  } else if (plotted.length) {
    h += scatter(plotted, cc, sources, shapeOf, st.selected, week.week);
    const missing = visible.length - plotted.length;
    if (missing) h += `<div class="bm-note muted">${missing} row(s) not plotted: no cost per task${metric === 'tokens' ? ' or no tokens per task' : ''} recorded ${ev('UNKNOWN', 'the source records no cost (or 0) for these rows; local rows need agent.dispatch.pricePerMTok')}. They stay in the table.</div>`;
  } else {
    h += `<div class="bm-note muted">No row in this filter has a cost per task${metric === 'tokens' ? ' and tokens per task' : ''}, so nothing can be placed on the log cost axis ${ev('UNKNOWN', 'cost not recorded')}. Local rows get a cost when you set agent.dispatch.pricePerMTok.</div>`;
  }
  const order = [...visible].sort((a, b) => b.row.score - a.row.score || a.row.model.localeCompare(b.row.model));
  h += `<h3>Rows <span class="muted bm-sub">${order.length} · best score first</span></h3>`;
  h += table(order.map(k => ({ ...k, front: frontKeys.has(k.key) })), sources, shapeOf, st.selected);
  if (db.errors.length) h += `<div class="bm-err">${db.errors.map(e => `${esc(e.file)}: ${esc(e.error)}`).join('<br>')}</div>`;
  return h + '</div>';
}

// ---- actions -------------------------------------------------------------------------------------------------

async function copy(arg: string, ctx: ActCtx): Promise<void> {
  const text = arg === 'script' ? SCRIPT_CMD : arg === 'fetch' ? FETCH_CMD : undefined;
  if (!text) return;
  await ctx.copy(text);
  ctx.info('Model benchmarks: command copied. Run it in a terminal at the Agent checkout.');
}

async function openUrl(arg: string, ctx: ActCtx): Promise<void> {
  const db = feedValue<BenchDb>(BENCH_FEED).value;
  const known = db?.weeks.some(w => w.sources.some(s => s.url === arg));
  if (!known || !/^https:\/\//i.test(arg)) return;
  await ctx.openUrl(arg);
}

async function openDir(_arg: string, ctx: ActCtx): Promise<void> {
  const dir = feedValue<BenchDb>(BENCH_FEED).value?.dir ?? defaultBenchDir();
  if (!fs.existsSync(dir)) return ctx.info(`Model benchmarks: ${dir} does not exist yet. Run ${SCRIPT_CMD} first.`);
  await ctx.revealInOs(dir);
}

const CSS = `
.bm h3 { font-size: 12px; margin: 12px 0 4px; }
.bm-sub { font-weight: normal; font-size: 11px; }
.bm-note { font-size: 11px; margin: 4px 0 8px; }
.bm-err { font-size: 11px; color: var(--bad); margin: 6px 0; }
.bm-sel { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--line); border-radius: 4px; font: inherit; padding: 1px 4px; max-width: 220px; }
.bm-ev { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; color: var(--vscode-descriptionForeground); cursor: help; }
.bm-ev.OBSERVED { border-color: var(--ok); }
.bm-ev.DERIVED { border-color: var(--accent); }
.bm-ev.INFERRED { border-color: var(--warn); border-style: dashed; }
.bm-ev.UNKNOWN { border-style: dotted; }
.bm-srcs { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px; margin: 6px 0; }
.bm-src { display: inline-flex; align-items: center; gap: 4px; }
.bm-ico { vertical-align: middle; color: var(--vscode-foreground); }
.bm-svg { width: 100%; max-width: 980px; height: auto; display: block; margin: 4px 0; }
.bm-svg .bm-grid { stroke: var(--line); stroke-width: .6; }
.bm-svg .bm-frame { fill: none; stroke: var(--line); }
.bm-svg .bm-tick { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.bm-svg .bm-axis { fill: var(--vscode-foreground); font-size: 11px; }
.bm-svg .bm-front { fill: none; stroke: var(--vscode-foreground); stroke-width: 1.6; }
.bm-svg .bm-lbl { fill: var(--vscode-foreground); font-size: 10px; paint-order: stroke; stroke: var(--vscode-editor-background); stroke-width: 3px; }
.bm-svg .bm-dot { cursor: pointer; }
.bm-svg .bm-dot .bm-m { stroke: var(--vscode-editor-background); stroke-width: 1; opacity: .8; }
.bm-svg .bm-dot.fr .bm-m { opacity: 1; stroke: var(--vscode-foreground); }
.bm-svg .bm-dot.sel .bm-m { stroke: var(--accent); stroke-width: 2.5; opacity: 1; }
.bm-svg .bm-tl { fill: none; stroke-width: 1.6; }
.bm-tb { border-collapse: collapse; width: 100%; font-size: 11px; }
.bm-tb th, .bm-tb td { padding: 2px 6px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
.bm-tb td.r { text-align: right; }
.bm-tb th { font-weight: 600; cursor: help; }
.bm-tb tr.sel td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.bm-tb tr[data-select] { cursor: pointer; }
.bm-notes { white-space: normal !important; }
.bm-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.bm-empty { max-width: 760px; font-size: 12px; }
.bm-empty code { font-size: 11px; }
.bm-empty li { margin: 4px 0; }
`;

export const benchmarksView: ExtraView = {
  id: 'benchmarks',
  label: 'Model benchmarks',
  group: 'Usage',
  hint: 'Cost versus quality of coding models from your weekly local benchmark database (public leaderboards opt-in, your own dispatches, manual imports), with the Pareto frontier and weekly trends.',
  ready: true,
  feeds: [benchmarksFeed],
  badge: () => '',
  render: (d, st) => {
    const f = feedValue<BenchDb>(BENCH_FEED);
    return renderBenchmarks(d, st, f.value, f.error);
  },
  css: CSS,
  actions: { copy, url: openUrl, open: openDir },
};
