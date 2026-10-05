// Add-on screen "Token rhythm": tokens per minute / hour / day stacked by provider, model, repo, session or kind;
// rate vs cumulative, context growth per session, top sessions and peaks.
// Logic lives in src/activity/tokens.ts; this file only renders (escaped) and wires the CSV export.
import type { AgentSessionSnapshot } from '../../model';
import {
  autoGran, contextLines, CtxLine, cumulative, granMinutes, isTBy, isTGran, isTMetric, isTPeriod, metricOf, periodStart,
  Rhythm, rhythm, rhythmCsv, stackSlug, Stack, TBy, TGran, TMetric, TPeriod,
} from '../../activity/tokens';
import { compact, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ago, prettyModel, repoOf } from '../workspace';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';

const CHARTS = ['columns', 'area', 'lines', 'heatmap', 'table'] as const;
type Chart = (typeof CHARTS)[number];
type Mode = 'bucket' | 'permin' | 'cumulative';
type CtxPick = 'top' | 'live' | 'selected' | 'off';

interface Cfg {
  period: TPeriod;
  gran: TGran;
  granAuto: boolean;
  by: TBy;
  metric: TMetric;
  chart: Chart;
  horizontal: boolean;
  mode: Mode;
  leadsOnly: boolean;
  untimed: boolean;
  only: string;
  ctx: CtxPick;
}

function cfg(st: WsState): Cfg {
  const period = opt(st, 'tokens.period', '24h');
  const p: TPeriod = isTPeriod(period) ? period : '24h';
  const g = opt(st, 'tokens.gran', 'auto');
  const by = opt(st, 'tokens.by', 'provider');
  const metric = opt(st, 'tokens.metric', 'total');
  const chart = opt(st, 'tokens.chart', 'columns');
  const mode = opt(st, 'tokens.mode', 'bucket');
  const ctx = opt(st, 'tokens.ctx', 'top');
  return {
    period: p,
    gran: isTGran(g) ? g : autoGran(p),
    granAuto: !isTGran(g),
    by: isTBy(by) ? by : 'provider',
    metric: isTMetric(metric) ? metric : 'total',
    chart: (CHARTS as readonly string[]).includes(chart) ? (chart as Chart) : 'columns',
    horizontal: opt(st, 'tokens.orient', 'vertical') === 'horizontal',
    mode: mode === 'permin' || mode === 'cumulative' ? mode : 'bucket',
    leadsOnly: opt(st, 'tokens.who', 'all') === 'leads',
    untimed: opt(st, 'tokens.untimed', 'apart') === 'place',
    only: opt(st, 'tokens.only', ''),
    ctx: ctx === 'live' || ctx === 'selected' || ctx === 'off' ? ctx : 'top',
  };
}

const METRIC_LABEL: Record<TMetric, string> = { total: 'Tokens', output: 'Output tokens', prompt: 'Prompt tokens' };
const BY_LABEL: Record<TBy, string> = { provider: 'Provider', model: 'Model', repo: 'Repo', session: 'Session', kind: 'Prompt / output' };
const OBS = 'OBSERVED: provider-recorded tokens per model call (prompt incl. cache reads + output)';

function colorOf(by: TBy, key: string): string {
  if (key === 'other') return 'var(--quiet)';
  if (by === 'provider') return key === 'Codex' ? 'var(--codex)' : key === 'Claude Code' ? 'var(--claude)' : 'var(--quiet)';
  if (by === 'kind') return key === 'output' ? 'var(--ok)' : 'var(--accent)';
  if (key.startsWith('(')) return 'var(--quiet)';
  return identityColor(key);
}

const pad = (n: number) => String(n).padStart(2, '0');

function tLabel(t: number, g: TGran, long: boolean): string {
  const d = new Date(t);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (g === 'minute' || g === '5min' || g === '15min') return long || (d.getHours() === 0 && d.getMinutes() === 0) ? `${md} ${hm}` : hm;
  if (g === 'hour') return long || d.getHours() === 0 ? `${md} ${pad(d.getHours())}h` : `${pad(d.getHours())}h`;
  return g === 'week' ? `wk ${md}` : md;
}

const GRAN_TXT: Record<TGran, string> = { minute: 'minute', '5min': '5 min', '15min': '15 min', hour: 'hour', day: 'day', week: 'week' };

/** Values as displayed: per bucket, per minute (last bucket divided by its elapsed part) or running sum. */
function shape(c: Cfg, r: Rhythm, values: number[], now: number): number[] {
  if (c.mode === 'cumulative') return cumulative(values);
  if (c.mode === 'permin') {
    const gm = granMinutes(c.gran);
    const lastI = r.x.length - 1;
    return values.map((v, i) => v / (i === lastI ? Math.min(gm, Math.max(1, (now - r.x[i]) / 60_000)) : gm));
  }
  return values;
}

const unitTxt = (c: Cfg) => (c.mode === 'permin' ? ' / min' : c.mode === 'cumulative' ? ' cumulative' : ` / ${GRAN_TXT[c.gran]}`);

function visible(c: Cfg, r: Rhythm): Stack[] {
  if (!c.only) return r.stacks;
  const s = r.stacks.filter(x => stackSlug(x.key) === c.only);
  return s.length ? s : r.stacks;
}

function bucketTitle(c: Cfg, r: Rhythm, stacks: Stack[], shaped: number[][], i: number): string {
  const parts = stacks.map((s, k) => ({ l: s.label, v: shaped[k][i] })).filter(p => p.v > 0).sort((a, b) => b.v - a.v);
  const tot = parts.reduce((a, p) => a + p.v, 0);
  return `${tLabel(r.x[i], c.gran, true)} · ${compact(Math.round(tot))} ${METRIC_LABEL[c.metric].toLowerCase()}${unitTxt(c)}${parts.length ? '\n' + parts.slice(0, 6).map(p => `${p.l}: ${compact(Math.round(p.v))}`).join('\n') : ''}`;
}

// ---------------------------------------------------------------- main charts

const W = 1000, H = 250, L = 56, R = 10, TP = 8, B = 24;

function axes(max: number, n: number, x: number[], c: Cfg, px: (i: number) => number): string {
  let svg = '';
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4, y = TP + (H - TP - B) * (1 - k / 4);
    svg += `<line class="tk-grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="tk-ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(compact(Math.round(v)))}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += every) svg += `<text class="tk-ax" x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(tLabel(x[i], c.gran, i === 0))}</text>`;
  return svg;
}

function columnsV(c: Cfg, r: Rhythm, stacks: Stack[], shaped: number[][]): string {
  const n = r.x.length;
  const tot = r.x.map((_, i) => shaped.reduce((a, v) => a + v[i], 0));
  const max = Math.max(1, ...tot);
  const bw = (W - L - R) / n;
  const gap = bw > 4 ? Math.min(2, bw * 0.15) : 0;
  const px = (i: number) => L + bw * (i + 0.5);
  const sy = (v: number) => ((H - TP - B) * v) / max;
  let svg = `<svg class="tk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${METRIC_LABEL[c.metric]} per ${GRAN_TXT[c.gran]}`)}">${axes(max, n, r.x, c, px)}`;
  for (let i = 0; i < n; i++) {
    if (!tot[i]) continue;
    let y = H - B;
    let g = `<g class="tk-col"><title>${esc(bucketTitle(c, r, stacks, shaped, i))}</title>`;
    stacks.forEach((s, k) => {
      const h = sy(shaped[k][i]);
      if (h <= 0) return;
      y -= h;
      g += `<rect x="${(L + bw * i + gap / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.6, bw - gap).toFixed(2)}" height="${h.toFixed(2)}" style="fill:${colorOf(c.by, s.key)}"/>`;
    });
    svg += g + '</g>';
  }
  return svg + '</svg>';
}

function columnsH(c: Cfg, r: Rhythm, stacks: Stack[], shaped: number[][]): string {
  const n = r.x.length;
  const tot = r.x.map((_, i) => shaped.reduce((a, v) => a + v[i], 0));
  const max = Math.max(1, ...tot);
  const CAP = 240;
  const from = Math.max(0, n - CAP);
  let h = `<div class="tk-hb">`;
  for (let i = n - 1; i >= from; i--) {
    const segs = stacks.map((s, k) => (shaped[k][i] > 0 ? `<i style="width:${((100 * shaped[k][i]) / max).toFixed(3)}%;background:${colorOf(c.by, s.key)}"></i>` : '')).join('');
    h += `<div class="tk-hr${tot[i] ? '' : ' z'}" title="${esc(bucketTitle(c, r, stacks, shaped, i))}"><span class="tk-ht">${esc(tLabel(r.x[i], c.gran, i === n - 1 || i === from))}</span><span class="tk-htr">${segs}</span><b>${tot[i] ? esc(compact(Math.round(tot[i]))) : ''}</b></div>`;
  }
  h += `</div>`;
  return h + (from ? `<div class="muted tk-note">Newest ${CAP} of ${n} buckets shown (newest first). Use a coarser bucket for the whole period.</div>` : '');
}

function area(c: Cfg, r: Rhythm, stacks: Stack[], shaped: number[][], stacked: boolean): string {
  const n = r.x.length;
  const px = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const tot = r.x.map((_, i) => shaped.reduce((a, v) => a + v[i], 0));
  const max = Math.max(1, ...(stacked ? tot : shaped.flat()));
  const py = (v: number) => TP + (H - TP - B) * (1 - v / max);
  let svg = `<svg class="tk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${METRIC_LABEL[c.metric]} over time`)}">${axes(max, n, r.x, c, px)}`;
  if (stacked) {
    const base = new Array(n).fill(0);
    stacks.forEach((s, k) => {
      const top = base.map((b, i) => b + shaped[k][i]);
      const pts = [...top.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`), ...base.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).reverse()].join(' ');
      svg += `<polygon class="tk-ar" points="${pts}" style="fill:${colorOf(c.by, s.key)}"><title>${esc(`${s.label}: ${compact(Math.round(s.total))} in period`)}</title></polygon>`;
      top.forEach((v, i) => (base[i] = v));
    });
  } else {
    stacks.forEach((s, k) => {
      const pts = shaped[k].map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      svg += `<polyline class="tk-pl" points="${pts}" style="stroke:${colorOf(c.by, s.key)}"><title>${esc(`${s.label}: ${compact(Math.round(s.total))} in period`)}</title></polyline>`;
    });
    if (stacks.length > 1) svg += `<polyline class="tk-pl tk-tot" points="${tot.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')}"><title>all groups</title></polyline>`;
  }
  // invisible hover columns carry the per-bucket breakdown
  const bw = (W - L - R) / Math.max(1, n - 1);
  if (n <= 400)
    for (let i = 0; i < n; i++)
      if (tot[i]) svg += `<rect class="tk-hov" x="${(px(i) - bw / 2).toFixed(1)}" y="${TP}" width="${bw.toFixed(2)}" height="${H - TP - B}"><title>${esc(bucketTitle(c, r, stacks, shaped, i))}</title></rect>`;
  return svg + '</svg>';
}

function heatmap(c: Cfg, d: WsData): string {
  // Day × hour of day, from an hourly rhythm of the same period (capped to the last 31 days).
  const p: TPeriod = c.period === '1h' || c.period === '6h' ? '24h' : c.period;
  const r = rhythm(d.sessions, { period: p, now: d.now, gran: 'hour', by: 'provider', metric: c.metric, leadsOnly: c.leadsOnly, untimed: c.untimed, maxBuckets: 31 * 24 });
  const cells = new Map<string, number[]>();
  r.x.forEach((t, i) => {
    const v = r.totals[i];
    const dt = new Date(t);
    const k = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const row = cells.get(k) ?? new Array(24).fill(0);
    row[dt.getHours()] += v;
    cells.set(k, row);
  });
  const days = [...cells.keys()].sort().reverse();
  const max = Math.max(1, ...[...cells.values()].flat());
  const bg = (v: number) => (v ? `color-mix(in srgb, var(--accent) ${(10 + 90 * Math.sqrt(v / max)).toFixed(0)}%, transparent)` : 'transparent');
  let h = `<div class="tk-hm"><span></span>${Array.from({ length: 24 }, (_, i) => `<span class="tk-hh">${pad(i)}</span>`).join('')}<span class="tk-hh">Σ</span>`;
  for (const k of days) {
    const row = cells.get(k)!;
    const dn = new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
    h += `<span class="tk-hl">${esc(dn)} ${esc(k.slice(5))}</span>`;
    h += row.map((v, i) => `<i style="background:${bg(v)}" title="${esc(`${k} ${pad(i)}:00–${pad(i + 1)}:00 · ${compact(Math.round(v))} ${METRIC_LABEL[c.metric].toLowerCase()} · OBSERVED per call`)}"></i>`).join('');
    h += `<span class="tk-hs">${esc(compact(Math.round(row.reduce((a, b) => a + b, 0))))}</span>`;
  }
  h += `</div><div class="legend">rows: days (newest first) · columns: hour of day (local) · darker = more (square-root scale) · max hour ${esc(compact(Math.round(max)))}</div>`;
  return days.length ? h : `<div class="empty">No timed calls in this period.</div>`;
}

function table(c: Cfg, r: Rhythm, stacks: Stack[], shaped: number[][]): string {
  const rows: string[] = [];
  const n = r.x.length;
  for (let i = n - 1; i >= 0 && rows.length < 200; i--) {
    const tot = shaped.reduce((a, v) => a + v[i], 0);
    if (!tot && c.mode !== 'cumulative') continue;
    rows.push(`<tr><td class="tk-nw">${esc(tLabel(r.x[i], c.gran, true))}</td>${stacks.map((s, k) => `<td class="r">${shaped[k][i] ? esc(compact(Math.round(shaped[k][i]))) : '<span class="muted">·</span>'}</td>`).join('')}<td class="r"><b>${esc(compact(Math.round(tot)))}</b></td></tr>`);
  }
  if (!rows.length) return `<div class="empty">No timed calls in this period.</div>`;
  return `<div class="tk-tw"><table class="tk-t"><tr><th>${esc(GRAN_TXT[c.gran])} (newest first)</th>${stacks.map(s => `<th class="r"><span class="tk-sw" style="background:${colorOf(c.by, s.key)}"></span>${esc(s.label.slice(0, 22))}</th>`).join('')}<th class="r">All</th></tr>${rows.join('')}</table></div>${rows.length >= 200 ? '<div class="muted tk-note">Newest 200 non-empty buckets.</div>' : ''}`;
}

function legend(c: Cfg, r: Rhythm): string {
  const sum = r.stacks.reduce((a, s) => a + s.total, 0) || 1;
  return `<div class="legend tk-lg">${r.stacks
    .map(s => {
      const sl = stackSlug(s.key);
      const on = c.only === sl;
      return `<button class="tk-lgi${on ? ' on' : ''}${c.only && !on ? ' dim' : ''}" data-opt="tokens.only" data-val="${esc(on ? '' : s.key === 'other' ? '' : sl)}" title="${esc(`${s.label}: ${compact(Math.round(s.total))} (${((100 * s.total) / sum).toFixed(1)} %) · ${s.sessions} session(s)${s.key === 'other' ? '' : ' · click to isolate'}`)}"><span class="tk-sw" style="background:${colorOf(c.by, s.key)}"></span>${esc(s.label.slice(0, 32))} <span class="muted">${esc(compact(Math.round(s.total)))}</span></button>`;
    })
    .join('')}${c.only ? `<button class="link" data-opt="tokens.only" data-val="">show all</button>` : ''}</div>`;
}

// ---------------------------------------------------------------- side panels

function peaks(c: Cfg, r: Rhythm): string {
  if (!r.peaks.length) return '';
  const max = r.peaks[0].value || 1;
  return `<div class="tk-box"><h3 title="DERIVED: busiest buckets of the chart">Peaks · per ${esc(GRAN_TXT[c.gran])}</h3>${r.peaks
    .map(p => `<div class="tk-pk" title="${esc(`${tLabel(p.at, c.gran, true)}: ${compact(Math.round(p.value))}; largest: ${p.top} ${compact(Math.round(p.topValue))}`)}"><span class="tk-nw">${esc(tLabel(p.at, c.gran, true))}</span><span class="tk-trk"><i style="width:${((100 * p.value) / max).toFixed(1)}%"></i></span><b>${esc(compact(Math.round(p.value)))}</b><span class="muted tk-ell">${esc(p.top.slice(0, 28))}</span></div>`)
    .join('')}</div>`;
}

function topSessions(c: Cfg, r: Rhythm, d: WsData, st: WsState): string {
  if (!r.rows.length) return '';
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const val = (x: { prompt: number; output: number }) => metricOf(x, c.metric);
  const max = Math.max(1, ...r.rows.map(val));
  const sum = r.rows.reduce((a, x) => a + val(x), 0) || 1;
  const rows = r.rows.slice(0, 15).map((x, i) => {
    const s = by.get(x.key);
    const who = s ? [s.provider === 'codex' ? 'Codex' : 'Claude', prettyModel(s.model)].filter(Boolean).join(' · ') : '';
    const repo = s ? repoOf(s) : '';
    return `<tr class="${st.selected === x.key ? 'sel' : ''}" data-select="${esc(x.key)}" tabindex="0"><td class="muted r">${i + 1}</td><td class="tk-ell"><span class="dot ${esc(s?.status ?? 'UNKNOWN')}"></span> ${esc(x.label)}${s?.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted tk-ell"><span class="tk-sw" style="background:${identityColor(repo)}"></span>${esc(repo)}</td><td class="muted tk-nw">${esc(who)}</td><td class="r"><b>${esc(compact(Math.round(val(x))))}</b></td><td class="tk-tb"><i style="width:${((100 * val(x)) / max).toFixed(1)}%;background:${s?.provider === 'codex' ? 'var(--codex)' : 'var(--claude)'}"></i></td><td class="r muted">${((100 * val(x)) / sum).toFixed(0)} %</td><td class="r">${x.calls}</td><td class="r" title="DERIVED: ${esc(METRIC_LABEL[c.metric].toLowerCase())} / minutes between first and last call in the period">${x.calls ? esc(compact(Math.round(x.ratePerMin))) : '—'}</td><td class="r" title="DERIVED: busiest single minute of this session">${x.calls ? esc(compact(Math.round(x.peakMin))) : '—'}</td><td class="r muted" title="Recorded in the session total without a per-call time">${x.untimed ? esc(compact(Math.round(x.untimed))) : ''}</td><td class="muted tk-nw">${esc(ago(d.now, x.lastAt))}</td></tr>`;
  });
  return `<div class="tk-box tk-wide"><h3>Top sessions · ${esc(METRIC_LABEL[c.metric].toLowerCase())} in period</h3><div class="tk-tw"><table class="tk-t"><tr><th></th><th>Session</th><th>Repo</th><th>Who</th><th class="r" title="${esc(OBS)}">${esc(METRIC_LABEL[c.metric])}</th><th></th><th class="r">Share</th><th class="r">Calls</th><th class="r">Avg / min</th><th class="r">Peak min</th><th class="r">Untimed</th><th>Last call</th></tr>${rows.join('')}</table></div>${r.rows.length > 15 ? `<div class="muted tk-note">… ${r.rows.length - 15} more session(s)</div>` : ''}</div>`;
}

function contextGrowth(c: Cfg, d: WsData, st: WsState, r: Rhythm): string {
  const head = toolbar(
    `<h3 class="tk-h3" title="OBSERVED: prompt tokens of each recorded call = what the model read (context held). DERIVED: drops ≥ 40 % marked as likely compaction / fresh context.">Context growth</h3>`,
    seg(st, 'tokens.ctx', [['top', 'Top 5'], ['live', 'Live'], ['selected', 'Selected'], ['off', 'Hide']], 'top', 'Which sessions to draw'),
  );
  if (c.ctx === 'off') return `<div class="tk-ctx">${head}</div>`;
  const pool = d.sessions.filter(s => !c.leadsOnly || !s.isWorker);
  let pick: AgentSessionSnapshot[];
  if (c.ctx === 'selected') pick = pool.filter(s => s.key === st.selected);
  else if (c.ctx === 'live') pick = pool.filter(isLive);
  else {
    const order = new Map(r.rows.map((x, i) => [x.key, i]));
    pick = pool.filter(s => order.has(s.key)).sort((a, b) => order.get(a.key)! - order.get(b.key)!).slice(0, 5);
  }
  let lines: CtxLine[] = contextLines(pick, { period: c.period, now: d.now });
  if (c.ctx === 'live') lines = lines.sort((a, b) => b.last - a.last).slice(0, 8);
  if (!lines.length) {
    const why = c.ctx === 'selected' ? (st.selected ? 'The selected session has no recorded calls in this period.' : 'Select a session (click a row) to draw its context.') : c.ctx === 'live' ? 'No live session with recorded calls in this period.' : 'No session with recorded calls in this period.';
    return `<div class="tk-ctx">${head}<div class="empty">${esc(why)}</div></div>`;
  }
  const since = periodStart(c.period, d.now);
  const t0 = Number.isFinite(since) ? since : Math.min(...lines.map(l => l.points[0].at));
  const t1 = d.now;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(1, ...lines.map(l => Math.max(l.max, l.window ?? 0)));
  const CW = 1000, CH = 200;
  const px = (t: number) => L + ((W - L - R) * (t - t0)) / span;
  const py = (v: number) => TP + (CH - TP - B) * (1 - v / max);
  let svg = `<svg class="tk-svg tk-csvg" viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" role="img" aria-label="Context growth per session">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4, y = py(v);
    svg += `<line class="tk-grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="tk-ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(compact(Math.round(v)))}</text>`;
  }
  for (let k = 0; k <= 6; k++) {
    const t = t0 + (span * k) / 6;
    const g: TGran = span <= 2 * 86_400_000 ? 'minute' : 'day';
    svg += `<text class="tk-ax" x="${px(t).toFixed(1)}" y="${CH - 8}" text-anchor="middle">${esc(tLabel(t, g, k === 0))}</text>`;
  }
  const colorL = (l: CtxLine) => identityColor(l.key);
  const windows = new Set<number>();
  for (const l of lines) {
    if (l.window && !windows.has(l.window)) {
      windows.add(l.window);
      svg += `<line class="tk-win" x1="${L}" x2="${W - R}" y1="${py(l.window).toFixed(1)}" y2="${py(l.window).toFixed(1)}"><title>${esc(`context window ${compact(l.window)} (recorded by the provider)`)}</title></line>`;
    }
  }
  for (const l of lines) {
    const sel = st.selected === l.key;
    // step line: context holds until the next call
    let pts = '';
    l.points.forEach((p, i) => {
      if (i) pts += ` ${px(p.at).toFixed(1)},${py(l.points[i - 1].tokens).toFixed(1)}`;
      pts += ` ${px(p.at).toFixed(1)},${py(p.tokens).toFixed(1)}`;
    });
    if (l.live) pts += ` ${px(t1).toFixed(1)},${py(l.last).toFixed(1)}`;
    svg += `<polyline class="tk-pl${sel ? ' sel' : ''}" points="${pts.trim()}" style="stroke:${colorL(l)}"><title>${esc(`${l.label}: last ${compact(l.last)}, max ${compact(l.max)}${l.window ? `, ${Math.round((100 * l.last) / l.window)} % of window` : ''}`)}</title></polyline>`;
    for (const p of l.points)
      if (p.drop) svg += `<circle class="tk-drop" cx="${px(p.at).toFixed(1)}" cy="${py(p.tokens).toFixed(1)}" r="3.2" style="stroke:${colorL(l)}"><title>${esc(`${l.label} · ${tLabel(p.at, 'minute', true)}: context fell to ${compact(p.tokens)} (DERIVED: likely compaction or fresh context)`)}</title></circle>`;
  }
  svg += '</svg>';
  const lg = `<div class="legend">${lines
    .map(l => `<span class="tk-cl${st.selected === l.key ? ' sel' : ''}" data-select="${esc(l.key)}" tabindex="0" title="${esc(`${l.points.length} call(s) drawn · max ${compact(l.max)}${l.window ? ` · window ${compact(l.window)}` : ''}`)}"><span class="tk-sw" style="background:${colorL(l)}"></span>${l.live ? '<span class="dot RUNNING"></span>' : ''}${esc(l.label.slice(0, 34))} <span class="muted">${esc(compact(l.last))}${l.window ? ` · ${Math.round((100 * l.last) / l.window)} %` : ''}${l.points.some(p => p.drop) ? ` · ${l.points.filter(p => p.drop).length}↓` : ''}</span></span>`)
    .join('')}<span class="muted">· dashed = recorded context window · ○ = drop ≥ 40 %</span></div>`;
  return `<div class="tk-ctx">${head}${svg}${lg}</div>`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const tb1 = toolbar(
    seg(st, 'tokens.period', [['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '24h', 'Period (calls recorded in it)'),
    seg(st, 'tokens.gran', [['auto', `Auto · ${GRAN_TXT[autoGran(c.period)]}`], ['minute', 'Min'], ['5min', '5 min'], ['15min', '15 min'], ['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']], 'auto', 'Bucket size (granularity)'),
    seg(st, 'tokens.metric', [['total', 'All tokens'], ['output', 'Output'], ['prompt', 'Prompt']], 'total', 'Prompt = what the model read (incl. cache reads); output = what it wrote'),
  );
  const tb2 = toolbar(
    `<span class="muted">stack by</span>`,
    seg(st, 'tokens.by', [['provider', 'Provider'], ['model', 'Model'], ['repo', 'Repo'], ['session', 'Session'], ['kind', 'Prompt / output']], 'provider', 'Stack groups'),
    seg(st, 'tokens.chart', [['columns', '▥ Columns'], ['area', 'Area'], ['lines', 'Lines'], ['heatmap', 'Day × hour'], ['table', 'Table']], 'columns', 'Chart type'),
    c.chart === 'columns' ? seg(st, 'tokens.orient', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], 'vertical', 'Time on the x axis or as rows') : '',
  );
  const tb3 = toolbar(
    c.chart !== 'heatmap' ? seg(st, 'tokens.mode', [['bucket', `Per ${GRAN_TXT[c.gran]}`], ['permin', 'Per minute'], ['cumulative', 'Cumulative']], 'bucket', 'Rate per bucket, normalised per minute, or running total') : '',
    seg(st, 'tokens.who', [['all', 'All'], ['leads', 'Leads only']], 'all', 'Include worker sessions (subagents) or only top-level sessions'),
    seg(st, 'tokens.untimed', [['apart', 'Untimed apart'], ['place', 'Place untimed']], 'apart', 'Tokens in a session total without a per-call time: count apart (default) or place them at the session’s last activity'),
    actBtn('csv', [c.period, c.gran, c.by, c.metric, c.leadsOnly ? 'leads' : 'all', c.untimed ? 'place' : 'apart'].join('|'), 'Export CSV', 'Save the buckets as CSV (time, group, tokens; no prompt text)'),
  );

  const r = rhythm(d.sessions, { period: c.period, now: d.now, gran: c.gran, by: c.by, metric: c.metric, leadsOnly: c.leadsOnly, untimed: c.untimed });
  const stacks = visible(c, r);
  const shaped = stacks.map(s => shape(c, r, s.values, d.now));
  const peak = r.peaks[0];
  const outTot = r.rows.reduce((a, x) => a + x.output, 0);
  const kpis = `<div class="kpis tk-k">${[
    [compact(Math.round(r.total)), `${METRIC_LABEL[c.metric]} on chart`, `${OBS}. Untimed tokens are ${c.untimed ? 'placed at the last activity' : 'counted apart'}.`],
    [compact(Math.round(r.ratePerMin5)), 'per min · last 5 min', 'DERIVED: tokens of calls in the last 5 minutes / 5'],
    [compact(Math.round(r.ratePerMin60)), 'per min · last hour', 'DERIVED: tokens of calls in the last 60 minutes / 60'],
    [peak ? compact(Math.round(peak.value)) : '—', peak ? `peak ${GRAN_TXT[c.gran]} · ${tLabel(peak.at, c.gran, true)}` : 'peak', 'DERIVED: busiest bucket of the chart'],
    [String(r.calls), 'model calls', 'OBSERVED: recorded per-call token entries'],
    [String(r.sessions), 'sessions', 'DERIVED: sessions with tokens in the period'],
    [compact(Math.round(outTot)), 'output tokens', 'OBSERVED: output tokens in the period (timed, plus untimed when placed)'],
    [r.untimed.value ? compact(Math.round(r.untimed.value)) : '0', `untimed · ${r.untimed.sessions} session(s)`, 'OBSERVED session totals minus the recorded calls: no time is known for these tokens'],
  ]
    .map(([v, l, t]) => `<div class="kpi" title="${esc(t)}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
    .join('')}</div>`;

  let body: string;
  const any = r.stacks.some(s => s.total > 0);
  if (c.chart === 'heatmap') body = heatmap(c, d);
  else if (!any)
    body = `<div class="empty">No timed model call in this period${r.untimed.value ? ` (${esc(compact(r.untimed.value))} untimed tokens; switch to “Place untimed” to show them at each session’s last activity)` : ''}. Try a longer period.</div>`;
  else if (c.chart === 'table') body = table(c, r, stacks, shaped);
  else if (c.chart === 'area') body = area(c, r, stacks, shaped, true);
  else if (c.chart === 'lines') body = area(c, r, stacks, shaped, false);
  else if (c.horizontal) body = columnsH(c, r, stacks, shaped);
  else body = columnsV(c, r, stacks, shaped);
  const lg = c.chart !== 'heatmap' && any ? legend(c, r) : '';
  const cap = c.chart !== 'heatmap' && any ? `<div class="muted tk-cap">${esc(METRIC_LABEL[c.metric])}${esc(unitTxt(c))} · stacked by ${esc(BY_LABEL[c.by].toLowerCase())}${c.chart === 'lines' ? ' (lines not stacked; dashed = all)' : ''}${r.clipped ? ` · latest ${r.x.length} buckets (${r.clipped} older dropped: choose a coarser bucket)` : ''}</div>` : '';

  const notes = [
    `<b>OBSERVED</b> · tokens per model call as the provider recorded them (Claude: input + cache creation + cache read + output per assistant message; Codex: token_count deltas). Prompt tokens include cache reads, so a long context counts again on every call.`,
    `<b>DERIVED</b> · buckets, rates, peaks, cumulative sums, context drops. Untimed = session total minus recorded calls (older or capped history); Agent never estimates nor prices tokens.`,
    `Click a legend item to isolate it; click a session row to select it (inspector, context growth “Selected”).`,
  ].join(' ');

  return `<div class="tk">${tb1}${tb2}${tb3}${kpis}${cap}${body}${lg}${contextGrowth(c, d, st, r)}<div class="tk-grid2">${topSessions(c, r, d, st)}${peaks(c, r)}</div><div class="foot">${notes}</div></div>`;
}

const CSS = `
.tk .tb { margin: 0 0 6px; }
.tk .tk-k { margin: 6px 0 8px; }
.tk .tk-k .kpi { background: var(--raise); }
.tk .tk-cap { font-size: 11px; margin: 0 0 2px; }
.tk .tk-note { font-size: 11px; margin-top: 2px; }
.tk .tk-svg { width: 100%; max-width: 1200px; height: 250px; display: block; }
.tk .tk-csvg { height: 200px; }
.tk .tk-grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.tk .tk-ax { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.tk .tk-col rect { opacity: .88; }
.tk .tk-col:hover rect { opacity: 1; }
.tk .tk-ar { opacity: .78; stroke: var(--vscode-editor-background, transparent); stroke-width: .5; vector-effect: non-scaling-stroke; }
.tk .tk-ar:hover { opacity: .95; }
.tk .tk-pl { fill: none; stroke-width: 1.8; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.tk .tk-pl.sel { stroke-width: 3.2; }
.tk .tk-tot { stroke: var(--vscode-foreground); stroke-dasharray: 4 3; opacity: .55; }
.tk .tk-hov { fill: transparent; }
.tk .tk-hov:hover { fill: var(--vscode-list-hoverBackground); fill-opacity: .5; }
.tk .tk-win { stroke: var(--warn); stroke-dasharray: 6 4; stroke-width: 1; vector-effect: non-scaling-stroke; }
.tk .tk-drop { fill: var(--vscode-editor-background, transparent); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.tk .tk-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.tk .tk-lg { gap: 4px; }
.tk .tk-lgi { background: none; border: 1px solid transparent; border-radius: 3px; color: var(--vscode-foreground); font: inherit; font-size: 11px; padding: 1px 6px; cursor: pointer; }
.tk .tk-lgi:hover { background: var(--vscode-list-hoverBackground); }
.tk .tk-lgi.on { border-color: var(--vscode-focusBorder); }
.tk .tk-lgi.dim { opacity: .5; }
.tk .tk-hb { display: grid; gap: 1px; max-width: 1100px; max-height: 520px; overflow-y: auto; }
.tk .tk-hr { display: grid; grid-template-columns: 96px minmax(0, 1fr) 56px; gap: 8px; align-items: center; font-size: 11px; padding: 0 4px; border-radius: 2px; }
.tk .tk-hr:hover { background: var(--vscode-list-hoverBackground); }
.tk .tk-hr.z { opacity: .45; }
.tk .tk-ht { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.tk .tk-htr { display: flex; height: 10px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.tk .tk-htr i { display: block; height: 100%; opacity: .9; }
.tk .tk-hr b { text-align: right; font-variant-numeric: tabular-nums; }
.tk .tk-hm { display: grid; grid-template-columns: 84px repeat(24, minmax(14px, 1fr)) 52px; gap: 2px; font-size: 10px; max-width: 1100px; }
.tk .tk-hm i { height: 16px; border-radius: 2px; border: 1px solid var(--line); }
.tk .tk-hh { color: var(--vscode-descriptionForeground); text-align: center; }
.tk .tk-hl { white-space: nowrap; font-size: 11px; align-self: center; }
.tk .tk-hs { color: var(--vscode-descriptionForeground); text-align: right; align-self: center; font-variant-numeric: tabular-nums; }
.tk .tk-tw { overflow-x: auto; max-width: 100%; }
.tk table.tk-t { font-size: 12px; border-collapse: collapse; }
.tk table.tk-t th { font-weight: 600; text-align: left; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; padding: 2px 6px; }
.tk table.tk-t td { padding: 2px 6px; }
.tk table.tk-t .r { text-align: right; font-variant-numeric: tabular-nums; }
.tk table.tk-t tr[data-select] { cursor: pointer; }
.tk table.tk-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); }
.tk table.tk-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.tk .tk-tb { width: 90px; } .tk .tk-tb i { display: block; height: 7px; border-radius: 2px; opacity: .85; }
.tk .tk-nw { white-space: nowrap; font-variant-numeric: tabular-nums; }
.tk .tk-ell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk .tk-grid2 { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 1fr); gap: 12px; margin-top: 10px; align-items: start; }
@media (max-width: 900px) { .tk .tk-grid2 { grid-template-columns: minmax(0, 1fr); } }
.tk .tk-box { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: var(--raise); min-width: 0; }
.tk .tk-box h3, .tk .tk-h3 { font-size: 12px; margin: 0 0 4px; font-weight: 600; }
.tk .tk-pk { display: grid; grid-template-columns: max-content minmax(40px, 1fr) 48px; column-gap: 6px; align-items: center; font-size: 11px; padding: 2px 0; }
.tk .tk-pk .tk-ell { grid-column: 1 / -1; max-width: 100%; font-size: 10px; }
.tk .tk-pk b { text-align: right; font-variant-numeric: tabular-nums; }
.tk .tk-trk { height: 8px; background: var(--vscode-editor-background, transparent); border-radius: 2px; overflow: hidden; } .tk .tk-trk i { display: block; height: 100%; background: var(--accent); }
.tk .tk-ctx { margin-top: 12px; }
.tk .tk-cl { cursor: pointer; border-radius: 3px; padding: 1px 4px; display: inline-flex; align-items: center; gap: 3px; }
.tk .tk-cl:hover { background: var(--vscode-list-hoverBackground); }
.tk .tk-cl.sel { outline: 1px solid var(--vscode-focusBorder); }
`;

export const tokensView: ExtraView = {
  id: 'tokens',
  label: 'Token rhythm',
  group: 'Usage',
  hint: 'Tokens per minute / hour / day by provider, model, repo or session; burn rate, peaks and context growth.',
  ready: true,
  render,
  css: CSS,
  badge(d) {
    // live burn: tokens per minute over the last 5 minutes (calls are appended in time order; scan from the end)
    let v = 0;
    const since = d.now - 5 * 60_000;
    for (const s of d.sessions) {
      const calls = s.facts?.calls;
      if (!calls) continue;
      for (let i = calls.length - 1; i >= 0 && calls[i][0] > since; i--) v += calls[i][1] + calls[i][2];
    }
    return v / 5 >= 1 ? `${compact(Math.round(v / 5))}/m` : '';
  },
  actions: {
    async csv(arg, ctx) {
      const [period, gran, by, metric, who, untimed] = arg.split('|');
      if (!isTPeriod(period) || !isTGran(gran) || !isTBy(by) || !isTMetric(metric) || (who !== 'all' && who !== 'leads') || (untimed !== 'place' && untimed !== 'apart')) {
        ctx.info('Token rhythm: invalid export request.');
        return;
      }
      const r = rhythm(ctx.sessions(), { period, now: Date.now(), gran, by, metric, leadsOnly: who === 'leads', untimed: untimed === 'place', maxStacks: 50, maxBuckets: 5000 });
      const saved = await ctx.saveText(`agent-tokens-${period}-${gran}-${by}-${metric}.csv`, rhythmCsv(r, metric));
      if (saved) ctx.info(`Token rhythm: saved ${saved}`);
    },
  },
};
