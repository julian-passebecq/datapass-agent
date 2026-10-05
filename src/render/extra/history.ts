// Add-on screen "History": long-term weekly rollups read from the local archive (~/.agent/history/YYYY-Www.json,
// written by scripts/weekly.ts or the "Build now" action), weeks side by side, trends, a group × week matrix
// and one week in detail. Logic: src/activity/history.ts; files: src/feeds/history.ts. Everything escaped.
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../../model';
import {
  breakdown, daily, DAYS, delta, HDim, HDIMS, HIST_BASIS, HistRow, HistWeek, mergeWeek, OUT_LABEL, prettyModelName, rowKey, rowsByWeek, rowValue,
  shiftWeek, total, WEEK_RE, weekEndOf, weekId, weekLabel, weekStartOf,
} from '../../activity/history';
import { fmtMetric, isMetric, Metric, METRICS, csvValue } from '../../activity/explore';
import { identityColor } from '../../activity/insights';
import { ArchiveRead, collectAll, defaultHistoryDir, HISTORY_FEED, historyFeed, writeArchive } from '../../feeds/history';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ago, repoOf, scopeKey } from '../workspace';
import { ARCHIVE_FEED, archiveFeed, ArchiveView, archivedOnly } from '../../archive/reader';
import type { ArchivedSession } from '../../archive/archive';
import { actBtn, ActCtx, ExtraView, opt, seg, toolbar } from './kit';
import { Feed, FeedState, feedValue } from './feeds';

type View = 'weeks' | 'trend' | 'matrix' | 'week';
type Chart = 'bars' | 'stacked' | 'line';

const METRIC_SHORT: Record<Metric, string> = {
  sessions: 'Sessions', tokens: 'Tokens', output: 'Output', cost: 'Cost', active: 'Active', commits: 'Commits',
  pass: 'Pass', fail: 'Fail', edits: 'Edits', tools: 'Tools', prompts: 'Prompts',
};
const DIM_SHORT: Record<HDim, string> = { provider: 'Provider', repo: 'Repo', model: 'Model', effort: 'Effort', outcome: 'Outcome', worker: 'Worker type' };

interface Cfg {
  view: View;
  range: number;
  leadsOnly: boolean;
  live: boolean;
  archive: boolean;
  metric: Metric;
  orient: 'cols' | 'rows';
  cmp: 'value' | 'delta' | 'avg';
  gran: 'week' | 'day';
  chart: Chart;
  by: HDim;
  barDir: 'vertical' | 'horizontal';
  acc: boolean;
  norm: boolean;
  pick: string; // lowercase week id or ''
}

function cfg(st: WsState): Cfg {
  const v = opt(st, 'history.view', 'weeks');
  const m = opt(st, 'history.metric', 'tokens');
  const by = opt(st, 'history.by', 'provider') as HDim;
  const ch = opt(st, 'history.chart', 'stacked');
  return {
    view: (['weeks', 'trend', 'matrix', 'week'] as const).includes(v as View) ? (v as View) : 'weeks',
    range: { '4': 4, '8': 8, '13': 13, '26': 26, '52': 52 }[opt(st, 'history.range', '8')] ?? 8,
    leadsOnly: opt(st, 'history.who', 'all') === 'leads',
    live: opt(st, 'history.live', 'on') !== 'off',
    archive: opt(st, 'history.archive', 'on') !== 'off',
    metric: isMetric(m) ? m : 'tokens',
    orient: opt(st, 'history.orient', 'cols') === 'rows' ? 'rows' : 'cols',
    cmp: (['value', 'delta', 'avg'] as const).find(x => x === opt(st, 'history.cmp', 'value')) ?? 'value',
    gran: opt(st, 'history.gran', 'week') === 'day' ? 'day' : 'week',
    chart: ch === 'bars' || ch === 'line' ? ch : 'stacked',
    by: HDIMS.includes(by) ? by : 'provider',
    barDir: opt(st, 'history.dir', 'vertical') === 'horizontal' ? 'horizontal' : 'vertical',
    acc: opt(st, 'history.acc', 'rate') === 'cumulative',
    norm: opt(st, 'history.norm', 'abs') === 'share',
    pick: opt(st, 'history.pick', ''),
  };
}

// ---------------------------------------------------------------- data: archive + loaded overlay

interface Col {
  id: string;
  start: number;
  w?: HistWeek;
  /** Rows of this week after the who filter. */
  rows: HistRow[];
  current: boolean;
  /** Loaded sessions were merged in. */
  overlay: boolean;
}

// The workspace hands a new (scoped) array on every render: memo on a cheap content signature instead.
let overlayMemo: { sig: string; map: Map<string, HistRow[]> } | undefined;
function loadedRows(sessions: AgentSessionSnapshot[], git: boolean): Map<string, HistRow[]> {
  let last = 0, tok = 0, commits = 0;
  for (const s of sessions) {
    last = Math.max(last, s.lastActivityAt ?? 0);
    tok += s.usage?.totalTokens ?? 0;
    commits += s.commits.length;
  }
  const sig = `${git}|${sessions.length}|${last}|${tok}|${commits}|${sessions[0]?.key ?? ''}|${sessions[sessions.length - 1]?.key ?? ''}`;
  if (overlayMemo?.sig === sig) return overlayMemo.map;
  const map = rowsByWeek(sessions, git);
  overlayMemo = { sig, map };
  return map;
}

/** Archive weeks merged with what the workspace has loaded (only when the overlay is on). */
function allWeeks(arch: ArchiveRead | undefined, sessions: AgentSessionSnapshot[], c: { live: boolean; git: boolean; now: number }): { weeks: Map<string, HistWeek>; overlay: Set<string> } {
  const weeks = new Map<string, HistWeek>();
  for (const w of arch?.weeks ?? []) weeks.set(w.week, w);
  const overlay = new Set<string>();
  if (c.live) for (const [id, rows] of loadedRows(sessions, c.git)) {
    if (!weekStartOf(id)) continue;
    const prev = weeks.get(id);
    const m = mergeWeek(id, prev, rows, { by: 'workspace', git: c.git, days: 0, sessions: sessions.length }, c.now);
    // The overlay is a view, not a run: keep the file's own provenance.
    weeks.set(id, prev ? { ...m, generatedAt: prev.generatedAt, runs: prev.runs, source: prev.source, kept: prev.kept } : { ...m, runs: 0, kept: 0 });
    overlay.add(id);
  }
  return { weeks, overlay };
}

/** The last `range` weeks ending at the current week (gaps become empty columns). */
function columns(weeks: Map<string, HistWeek>, overlay: Set<string>, range: number, leadsOnly: boolean, now: number): Col[] {
  const cur = weekId(now);
  const out: Col[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const id = shiftWeek(cur, -i);
    if (!id) continue;
    const w = weeks.get(id);
    out.push({ id, start: weekStartOf(id)!, w, rows: w ? (leadsOnly ? w.rows.filter(r => !r.w) : w.rows) : [], current: id === cur, overlay: overlay.has(id) });
  }
  return out;
}

const short = (id: string) => id.replace(/^\d{4}-/, '');
const pickVal = (id: string) => id.toLowerCase();
const fromPick = (v: string) => (/^\d{4}-w\d{2}$/.test(v) ? v.toUpperCase() : '');
const evTitle = (m: Metric) => `${HIST_BASIS[m].kind}: ${HIST_BASIS[m].basis}`;

function colorOf(dim: HDim, key: string): string {
  if (key === 'other') return 'var(--quiet)';
  if (dim === 'provider') return key === 'Codex' ? 'var(--codex)' : 'var(--claude)';
  if (dim === 'outcome') return ({ 'Commit observed': 'var(--ok)', 'Files edited, no commit': 'var(--warn)', 'Still live': 'var(--accent)' } as Record<string, string>)[key] ?? 'var(--quiet)';
  if (key.startsWith('(')) return 'var(--quiet)';
  return identityColor(key);
}

function colHead(c: Col, cf: Cfg): string {
  const tag = c.current ? ' · in progress' : !c.w ? ' · no file' : '';
  const title = `${c.id} · ${weekLabel(c.start)}${tag}${c.overlay ? ' · includes sessions loaded in the workspace' : ''}${c.w ? ` · ${c.w.rows.length} rows${c.w.kept ? `, ${c.w.kept} kept from earlier runs` : ''}` : ''} · click to pick`;
  return `<button class="hi-wk${pickVal(c.id) === cf.pick ? ' on' : ''}${c.current ? ' cur' : ''}${c.w ? '' : ' none'}" data-opt="history.pick" data-val="${esc(pickVal(c.id))}" title="${esc(title)}"><b>${esc(short(c.id))}${c.overlay ? '<sup>+</sup>' : ''}</b><span>${esc(weekLabel(c.start))}</span></button>`;
}

// ---------------------------------------------------------------- small pieces

function spark(vals: number[], cls = ''): string {
  const W = 64, H = 18;
  const max = Math.max(...vals, 0);
  if (!max) return `<svg class="hi-sp ${cls}" viewBox="0 0 ${W} ${H}"></svg>`;
  const px = (i: number) => (vals.length === 1 ? W / 2 : (i * (W - 4)) / (vals.length - 1) + 2);
  const py = (v: number) => H - 2 - ((H - 4) * v) / max;
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const last = vals.length - 1;
  return `<svg class="hi-sp ${cls}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}"/><circle cx="${px(last).toFixed(1)}" cy="${py(vals[last]).toFixed(1)}" r="2"/></svg>`;
}

function deltaHtml(cur: number, prev: number | undefined, inProgress: boolean): string {
  if (prev === undefined) return '';
  const d = delta(cur, prev);
  if (d === undefined) return cur ? '<span class="hi-d up" title="previous week was 0">new</span>' : '';
  const cls = Math.abs(d) < 5 ? 'flat' : d > 0 ? 'up' : 'down';
  return `<span class="hi-d ${cls}" title="${esc(`vs previous week${inProgress ? ' (this week is still in progress)' : ''}`)}">${d >= 0 ? '▲' : '▼'}${Math.abs(d) >= 999 ? '999+' : Math.abs(d).toFixed(0)}%</span>`;
}

// ---------------------------------------------------------------- view: weeks side by side

function sideBySide(cols: Col[], cf: Cfg): string {
  const metrics = METRICS.filter(m => cols.some(c => total(c.rows, m) > 0));
  if (!metrics.length) return `<div class="empty">Nothing recorded in these ${cols.length} weeks.</div>`;
  const val = (c: Col, m: Metric) => total(c.rows, m);
  const ses = (c: Col) => total(c.rows, 'sessions');
  const show = (c: Col, i: number, m: Metric): { text: string; v: number } => {
    const v = val(c, m);
    if (cf.cmp === 'avg') {
      const n = ses(c);
      return m === 'sessions' ? { text: fmtMetric(m, v), v } : { text: n ? fmtMetric(m, v / n) : '—', v: n ? v / n : 0 };
    }
    if (cf.cmp === 'delta') {
      const p = i > 0 ? val(cols[i - 1], m) : undefined;
      const d = p === undefined ? undefined : delta(v, p);
      return { text: d === undefined ? (p === undefined ? (v ? fmtMetric(m, v) : '·') : v ? 'new' : '·') : `${d >= 0 ? '+' : ''}${d.toFixed(0)} %`, v: d ?? 0 };
    }
    return { text: v ? fmtMetric(m, v) : '·', v };
  };
  const heat = (m: Metric, x: number, list: number[]) => {
    if (cf.cmp === 'delta') {
      const mx = Math.max(...list.map(Math.abs), 1);
      const a = Math.min(100, (60 * Math.abs(x)) / mx);
      return x ? `background:color-mix(in srgb, ${x > 0 ? 'var(--accent)' : 'var(--warn)'} ${a.toFixed(0)}%, transparent)` : '';
    }
    const mx = Math.max(...list, 0);
    return mx && x ? `--f:${((100 * x) / mx).toFixed(1)}%` : '';
  };
  const label = (m: Metric) => `<span title="${esc(evTitle(m))}">${esc(HIST_BASIS[m].label)}</span>`;
  const note = cf.cmp === 'avg' ? 'per session' : cf.cmp === 'delta' ? 'change vs previous week' : '';
  if (cf.orient === 'rows') {
    let h = `<table class="hi-t hi-sbs"><tr><th>Week</th>${metrics.map(m => `<th class="r">${label(m)}</th>`).join('')}</tr>`;
    cols.forEach((c, i) => {
      h += `<tr class="${pickVal(c.id) === cf.pick ? 'on' : ''}${c.current ? ' cur' : ''}"><td>${colHead(c, cf)}</td>${metrics
        .map(m => {
          const list = cols.map((x, j) => show(x, j, m).v);
          const s = show(c, i, m);
          return `<td class="r hi-c${cf.cmp === 'delta' ? '' : ' hb'}" style="${heat(m, s.v, list)}" title="${esc(`${c.id} · ${HIST_BASIS[m].label}: ${fmtMetric(m, val(c, m))}${note ? ` · ${note}: ${s.text}` : ''} · ${HIST_BASIS[m].kind}`)}">${esc(s.text)}</td>`;
        })
        .join('')}</tr>`;
    });
    return `<div class="hi-scroll">${h}</table></div>`;
  }
  let h = `<table class="hi-t hi-sbs"><tr><th>Metric</th>${cols.map(c => `<th class="hi-wh${pickVal(c.id) === cf.pick ? ' on' : ''}">${colHead(c, cf)}</th>`).join('')}<th class="r" title="DERIVED: sum over the shown weeks">Σ</th><th>Trend</th></tr>`;
  for (const m of metrics) {
    const list = cols.map((x, j) => show(x, j, m).v);
    const sum = cols.reduce((a, c) => a + val(c, m), 0);
    h += `<tr><th class="hi-ml">${label(m)}</th>${cols
      .map((c, i) => {
        const s = show(c, i, m);
        return `<td class="r hi-c${cf.cmp === 'delta' ? '' : ' hb'}${pickVal(c.id) === cf.pick ? ' on' : ''}" style="${heat(m, s.v, list)}" title="${esc(`${c.id} · ${HIST_BASIS[m].label}: ${fmtMetric(m, val(c, m))}${note ? ` · ${note}: ${s.text}` : ''} · ${HIST_BASIS[m].kind}`)}">${esc(s.text)}</td>`;
      })
      .join('')}<td class="r muted">${esc(fmtMetric(m, sum))}</td><td>${spark(cols.map(c => val(c, m)))}</td></tr>`;
  }
  return `<div class="hi-scroll">${h}</table></div>`;
}

// ---------------------------------------------------------------- view: trend

interface Pt {
  label: string;
  sub: string;
  title: string;
  cur: boolean;
}

interface Series {
  keys: string[];
  /** keys × x values */
  vals: number[][];
  x: Pt[];
}

function trendSeries(cols: Col[], cf: Cfg, now: number): Series {
  const x: Pt[] = [];
  const perX: HistRow[][] = [];
  const dayIdx: number[] = [];
  for (const c of cols) {
    if (cf.gran === 'week') {
      x.push({ label: short(c.id), sub: weekLabel(c.start), title: `${c.id} · ${weekLabel(c.start)}`, cur: c.current });
      perX.push(c.rows);
      dayIdx.push(-1);
    } else {
      for (let i = 0; i < 7; i++) {
        const d = new Date(c.start);
        d.setDate(d.getDate() + i);
        if (d.getTime() > now) break;
        x.push({ label: DAYS[i], sub: `${d.getDate()}/${d.getMonth() + 1}`, title: `${DAYS[i]} ${d.toLocaleDateString('en-GB')} · ${c.id}`, cur: c.current && i === (new Date(now).getDay() + 6) % 7 });
        perX.push(c.rows);
        dayIdx.push(i);
      }
    }
  }
  const valueOf = (rows: HistRow[], i: number) => (dayIdx[i] < 0 ? rows.reduce((a, r) => a + rowValue(r, cf.metric), 0) : rows.reduce((a, r) => a + (r.d[cf.metric]?.[dayIdx[i]] ?? 0), 0));
  let keys: string[] = ['total'];
  let vals: number[][];
  if (cf.chart === 'bars') vals = [perX.map((rows, i) => valueOf(rows, i))];
  else {
    const tot = new Map<string, number>();
    for (const c of cols) for (const [k, v] of breakdown(c.rows, cf.metric, cf.by)) tot.set(k, (tot.get(k) ?? 0) + v);
    const ranked = [...tot].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    keys = ranked.slice(0, 6);
    const kept = new Set(keys);
    if (ranked.length > 6) keys.push('other');
    vals = keys.map(k => perX.map((rows, i) => valueOf(rows.filter(r => (k === 'other' ? !kept.has(rowKey(r, cf.by)) : rowKey(r, cf.by) === k)), i)));
    if (!keys.length) {
      keys = ['total'];
      vals = [perX.map(() => 0)];
    }
  }
  if (cf.acc) vals = vals.map(v => {
    let run = 0;
    return v.map(n => (run += n));
  });
  return { keys, vals, x };
}

function trend(cols: Col[], cf: Cfg, now: number): string {
  const s = trendSeries(cols, cf, now);
  const single = s.keys.length === 1 && s.keys[0] === 'total';
  const col = (k: string) => (single ? 'var(--accent)' : colorOf(cf.by, k));
  const sums = s.x.map((_, i) => s.vals.reduce((a, v) => a + v[i], 0));
  const stackedNow = cf.chart === 'stacked' || single;
  const max = Math.max(1e-9, ...(cf.chart === 'line' ? s.vals.flat() : stackedNow ? sums : s.vals.flat()));
  if (!sums.some(Boolean)) return `<div class="empty">${esc(HIST_BASIS[cf.metric].label)}: nothing recorded in these weeks.</div>`;
  const tip = (i: number, k?: string, v?: number) => `${s.x[i].title}${k && !single ? ` · ${k}` : ''}: ${fmtMetric(cf.metric, v ?? sums[i])}${cf.acc ? ' (cumulative)' : ''}${s.x[i].cur ? ' · in progress' : ''}`;
  const legend = `<div class="legend">${single ? `<span class="hi-lg"><span class="hi-sw" style="background:var(--accent)"></span>${esc(HIST_BASIS[cf.metric].label)}</span>` : s.keys.map((k, j) => `<span class="hi-lg"><span class="hi-sw" style="background:${col(k)}"></span>${esc(k)} <span class="muted">${esc(fmtMetric(cf.metric, cf.acc ? s.vals[j][s.vals[j].length - 1] : s.vals[j].reduce((a, b) => a + b, 0)))}</span></span>`).join('')}<span class="muted">· per ${cf.gran}${cf.acc ? ' · cumulative' : ''}${single ? '' : ` · by ${esc(DIM_SHORT[cf.by].toLowerCase())} (top 6)`}${cf.chart === 'line' ? ' · dashed ring = week in progress' : ' · hatched = week in progress'}</span></div>`;

  if (cf.chart !== 'line' && cf.barDir === 'horizontal') {
    const rows = s.x
      .map((p, i) => {
        const segs = s.keys
          .map((k, j) => {
            const v = s.vals[j][i];
            return v ? `<i style="width:${((100 * v) / max).toFixed(2)}%;background:${col(k)}" title="${esc(tip(i, k, v))}"></i>` : '';
          })
          .join('');
        return `<div class="hi-hr${p.cur ? ' cur' : ''}" title="${esc(tip(i))}"><span class="hi-hl"><b>${esc(p.label)}</b> <span class="muted">${esc(p.sub)}</span></span><span class="hi-htrk">${segs}</span><b class="hi-hv">${esc(fmtMetric(cf.metric, sums[i]))}</b></div>`;
      })
      .join('');
    return `<div class="hi-h">${rows}</div>${legend}`;
  }

  const W = 900, H = 250, L = 56, R = 10, T = 12, B = 34;
  const n = s.x.length;
  const slot = (W - L - R) / n;
  const py = (v: number) => T + (H - T - B) * (1 - v / max);
  let svg = `<svg class="hi-ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${HIST_BASIS[cf.metric].label} per ${cf.gran}`)}"><defs><pattern id="hi-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" class="hi-hatch"/></pattern></defs>`;
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4, y = py(v);
    svg += `<line class="hi-grid" x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="hi-ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmtMetric(cf.metric, v))}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 16));
  s.x.forEach((p, i) => {
    const cx = L + slot * (i + 0.5);
    if (i % every === 0) svg += `<text class="hi-ax" x="${cx.toFixed(1)}" y="${H - 18}" text-anchor="middle">${esc(p.label)}</text><text class="hi-ax2" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(p.sub)}</text>`;
  });
  if (cf.chart === 'line') {
    const px = (i: number) => L + slot * (i + 0.5);
    s.keys.forEach((k, j) => {
      const pts = s.vals[j].map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      svg += `<polyline class="hi-pl" points="${pts}" style="stroke:${col(k)}"><title>${esc(single ? HIST_BASIS[cf.metric].label : k)}</title></polyline>`;
      if (n <= 70) svg += s.vals[j].map((v, i) => `<circle class="hi-pt${s.x[i].cur ? ' cur' : ''}" cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.8" style="fill:${col(k)}"><title>${esc(tip(i, k, v))}</title></circle>`).join('');
    });
  } else {
    const bw = Math.max(2, slot * 0.72);
    s.x.forEach((p, i) => {
      let y0 = H - B;
      const x0 = L + slot * i + (slot - bw) / 2;
      s.keys.forEach((k, j) => {
        const v = s.vals[j][i];
        if (!v) return;
        const h = ((H - T - B) * v) / max;
        y0 -= h;
        svg += `<rect class="hi-bar" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" style="fill:${col(k)}"><title>${esc(tip(i, k, v))}</title></rect>`;
      });
      if (p.cur && sums[i]) svg += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - B - y0).toFixed(1)}" fill="url(#hi-hatch)" pointer-events="none"/>`;
      if (n <= 26 && sums[i]) svg += `<text class="hi-bv" x="${(x0 + bw / 2).toFixed(1)}" y="${(y0 - 3).toFixed(1)}" text-anchor="middle">${esc(fmtMetric(cf.metric, sums[i]))}</text>`;
    });
  }
  return svg + '</svg>' + legend;
}

// ---------------------------------------------------------------- view: group × week matrix

function matrix(cols: Col[], cf: Cfg): string {
  const tot = new Map<string, number>();
  const cell = new Map<string, number[]>();
  cols.forEach((c, i) => {
    for (const [k, v] of breakdown(c.rows, cf.metric, cf.by)) {
      tot.set(k, (tot.get(k) ?? 0) + v);
      (cell.get(k) ?? cell.set(k, new Array(cols.length).fill(0)).get(k)!)[i] = v;
    }
  });
  const keys = [...tot].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, 25);
  if (!keys.length) return `<div class="empty">${esc(HIST_BASIS[cf.metric].label)}: nothing recorded in these weeks.</div>`;
  const colTot = cols.map((_, i) => keys.reduce((a, k) => a + cell.get(k)![i], 0));
  const shown = (k: string, i: number) => (cf.norm ? (colTot[i] ? (100 * cell.get(k)![i]) / colTot[i] : 0) : cell.get(k)![i]);
  const max = Math.max(1e-9, ...keys.flatMap(k => cols.map((_, i) => shown(k, i))));
  const txt = (k: string, i: number) => {
    const v = cell.get(k)![i];
    if (!v) return '';
    return cf.norm ? `${shown(k, i).toFixed(0)}%` : fmtMetric(cf.metric, v);
  };
  const bg = (v: number) => (v ? `background:color-mix(in srgb, var(--accent) ${(10 + 80 * (v / max)).toFixed(0)}%, transparent)` : '');
  const tip = (k: string, i: number) => `${k} · ${cols[i].id}: ${fmtMetric(cf.metric, cell.get(k)![i])}${colTot[i] ? ` · ${((100 * cell.get(k)![i]) / colTot[i]).toFixed(1)} % of the week` : ''} · ${HIST_BASIS[cf.metric].kind}`;
  const hiCls = (v: number) => (v / max > 0.55 ? ' hx' : '');
  if (cf.orient === 'rows') {
    let h = `<div class="hi-mx" style="grid-template-columns:minmax(110px,max-content) repeat(${keys.length}, minmax(44px,1fr)) minmax(56px,max-content)"><span></span>${keys.map(k => `<span class="hi-mh" title="${esc(k)}"><span class="hi-sw" style="background:${colorOf(cf.by, k)}"></span>${esc(k)}</span>`).join('')}<span class="hi-mh r">Σ</span>`;
    cols.forEach((c, i) => {
      h += `<span class="hi-ml">${colHead(c, cf)}</span>${keys.map(k => `<i class="${hiCls(shown(k, i))}" style="${bg(shown(k, i))}" title="${esc(tip(k, i))}">${esc(txt(k, i))}</i>`).join('')}<span class="hi-ms r">${esc(fmtMetric(cf.metric, colTot[i]))}</span>`;
    });
    return h + '</div>';
  }
  let h = `<div class="hi-mx" style="grid-template-columns:minmax(120px,max-content) repeat(${cols.length}, minmax(48px,1fr)) minmax(56px,max-content) 70px"><span></span>${cols.map(c => `<span class="hi-mh">${colHead(c, cf)}</span>`).join('')}<span class="hi-mh r">Σ</span><span class="hi-mh">Trend</span>`;
  for (const k of keys) {
    h += `<span class="hi-ml" title="${esc(k)}"><span class="hi-sw" style="background:${colorOf(cf.by, k)}"></span>${esc(k)}</span>${cols.map((_, i) => `<i class="${hiCls(shown(k, i))}" style="${bg(shown(k, i))}" title="${esc(tip(k, i))}">${esc(txt(k, i))}</i>`).join('')}<span class="hi-ms r">${esc(fmtMetric(cf.metric, tot.get(k)!))}</span><span>${spark(cell.get(k)!)}</span>`;
  }
  h += `<span class="hi-ms">Σ</span>${colTot.map(v => `<span class="hi-ms r">${esc(fmtMetric(cf.metric, v))}</span>`).join('')}<span></span><span></span></div>`;
  return h;
}

// ---------------------------------------------------------------- view: one week

function barsList(list: [string, number][], dim: HDim, m: Metric, n = 10): string {
  if (!list.length) return '<div class="muted">—</div>';
  const top = list.slice(0, n);
  const rest = list.slice(n).reduce((a, [, v]) => a + v, 0);
  if (rest) top.push([`other (${list.length - n})`, rest]);
  const max = Math.max(...top.map(([, v]) => v), 1e-9);
  const sum = list.reduce((a, [, v]) => a + v, 0);
  return `<div class="hi-bl">${top.map(([k, v]) => `<div class="hi-blr" title="${esc(`${k}: ${fmtMetric(m, v)}${sum ? ` · ${((100 * v) / sum).toFixed(1)} %` : ''}`)}"><span class="hi-bll">${esc(k)}</span><span class="hi-trk"><i style="width:${Math.max(0.5, (100 * v) / max).toFixed(2)}%;background:${colorOf(dim, k.startsWith('other (') ? 'other' : k)}"></i></span><b>${esc(fmtMetric(m, v))}</b></div>`).join('')}</div>`;
}

function oneWeek(cols: Col[], weeks: Map<string, HistWeek>, overlay: Set<string>, cf: Cfg, d: WsData, st: WsState, reports: Set<string>, leadsOnly: boolean, archived: Map<string, ArchivedOnly> = new Map()): string {
  const picked = fromPick(cf.pick);
  const id = picked && weekStartOf(picked) !== undefined ? picked : [...cols].reverse().find(c => c.rows.length)?.id ?? weekId(d.now);
  const start = weekStartOf(id)!;
  const w = weeks.get(id);
  const rows = w ? (leadsOnly ? w.rows.filter(r => !r.w) : w.rows) : [];
  const prevId = shiftWeek(id, -1)!, nextId = shiftWeek(id, 1)!;
  const pw = weeks.get(prevId);
  const prevRows = pw ? (leadsOnly ? pw.rows.filter(r => !r.w) : pw.rows) : undefined;
  const isCur = id === weekId(d.now);
  const nav = `<div class="hi-nav"><button class="link" data-opt="history.pick" data-val="${esc(pickVal(prevId))}" title="Previous week">◀ ${esc(short(prevId))}</button><b>${esc(id)}</b><span class="muted">${esc(weekLabel(start))}${isCur ? ' · in progress' : ''}${overlay.has(id) ? ' · includes loaded sessions' : ''}</span>${weekEndOf(start) <= d.now ? `<button class="link" data-opt="history.pick" data-val="${esc(pickVal(nextId))}" title="Next week">${esc(short(nextId))} ▶</button>` : ''}${!isCur ? `<button class="link" data-opt="history.pick" data-val="" title="Latest week with data">latest</button>` : ''}${reports.has(id) ? actBtn('report', pickVal(id), 'Open audit report', 'Open the markdown weekly audit written next to the week file') : ''}</div>`;
  if (!rows.length) return `${nav}<div class="empty">No archived session for ${esc(id)}.${w ? '' : ' There is no week file: run the weekly script or Build now.'}</div>`;
  const kp = METRICS.filter(m => total(rows, m) > 0 || (prevRows && total(prevRows, m) > 0))
    .map(m => {
      const v = total(rows, m);
      const p = prevRows ? total(prevRows, m) : undefined;
      return `<div class="kpi hi-kpi${m === cf.metric ? ' on' : ''}" data-opt="history.metric" data-val="${esc(m)}" title="${esc(`${evTitle(m)}${p !== undefined ? ` · previous week ${fmtMetric(m, p)}` : ''}`)}"><b>${esc(fmtMetric(m, v))}</b><span>${esc(HIST_BASIS[m].label)} ${deltaHtml(v, p, isCur)}</span></div>`;
    })
    .join('');
  const dd = daily(rows, cf.metric);
  const pd = prevRows ? daily(prevRows, cf.metric) : undefined;
  const dmax = Math.max(...dd, ...(pd ?? []), 1e-9);
  const days = `<div class="hi-days">${dd
    .map((v, i) => {
      const day = new Date(start);
      day.setDate(day.getDate() + i);
      const fut = day.getTime() > d.now;
      return `<div class="hi-day${fut ? ' fut' : ''}" title="${esc(`${DAYS[i]} ${day.toLocaleDateString('en-GB')}: ${fmtMetric(cf.metric, v)}${pd ? ` · same day previous week ${fmtMetric(cf.metric, pd[i])}` : ''}`)}"><b>${v ? esc(fmtMetric(cf.metric, v)) : ''}</b><span class="hi-dcol">${pd ? `<i class="prev" style="height:${((100 * pd[i]) / dmax).toFixed(1)}%"></i>` : ''}<i style="height:${((100 * v) / dmax).toFixed(1)}%"></i></span><span class="hi-dl">${DAYS[i]} <span class="muted">${day.getDate()}</span></span></div>`;
    })
    .join('')}</div><div class="legend"><span class="hi-lg"><span class="hi-sw" style="background:var(--accent)"></span>${esc(id)}</span>${pd ? `<span class="hi-lg"><span class="hi-sw prev"></span>${esc(prevId)}</span>` : ''}<span class="muted">· ${esc(HIST_BASIS[cf.metric].label)} per day · ${esc(HIST_BASIS[cf.metric].kind)}</span></div>`;
  const panels = (['provider', 'repo', 'model', 'worker', 'effort', 'outcome'] as HDim[])
    .map(dim => {
      const m = dim === 'outcome' ? 'sessions' : cf.metric;
      const list = breakdown(dim === 'outcome' ? rows.filter(r => !r.w) : rows, m, dim);
      return `<div class="hi-pan"><h3>${esc(DIM_SHORT[dim])}${dim === 'outcome' ? ' <span class="muted">(lead sessions)</span>' : ''}</h3>${barsList(list, dim, m, dim === 'repo' ? 12 : 8)}</div>`;
    })
    .join('');
  const byKey = new Map(d.sessions.map(s => [s.key, s]));
  const top = [...rows].sort((a, b) => rowValue(b, cf.metric) - rowValue(a, cf.metric) || rowValue(b, 'tokens') - rowValue(a, 'tokens')).slice(0, 15).filter(r => rowValue(r, cf.metric) > 0);
  const extra = (['tokens', 'active', 'commits'] as Metric[]).filter(m => m !== cf.metric);
  const table = top.length
    ? `<h3>Largest sessions by ${esc(HIST_BASIS[cf.metric].label.toLowerCase())}</h3><table class="hi-t hi-top"><tr><th>Session</th><th>Repo</th><th>Provider · model</th><th class="r">${esc(METRIC_SHORT[cf.metric])}</th>${extra.map(m => `<th class="r">${esc(METRIC_SHORT[m])}</th>`).join('')}<th>Outcome</th></tr>${top
        .map(r => {
          const s = byKey.get(r.k);
          const a = s ? undefined : archived.get(r.k);
          const name = s ? (s.title ?? s.workerLabel ?? r.k.split(':')[1]?.slice(0, 8)) : a ? (a.s.title ?? a.s.workerLabel ?? r.k.split(':')[1]?.slice(0, 8)) : r.k.split(':')[1]?.slice(0, 8);
          return `<tr${s ? ` data-select="${esc(r.k)}" tabindex="0" class="${st.selected === r.k ? 'sel' : ''}"` : ` title="session no longer loaded in the workspace"`}><td>${esc((name ?? r.k).slice(0, 60))}${a ? ` ${archChip(a.rec)}` : ''}${r.w ? ` <span class="muted">${esc(r.wt ?? 'worker')}</span>` : ''}</td><td><span class="hi-sw" style="background:${identityColor(r.repo)}"></span>${esc(r.repo)}</td><td class="muted"><span class="prov ${esc(r.p)}">${esc(r.p)}</span> ${esc(prettyModelName(r.model) || '—')}${r.effort ? ` · ${esc(r.effort)}` : ''}</td><td class="r"><b>${esc(fmtMetric(cf.metric, rowValue(r, cf.metric)))}</b></td>${extra.map(m => `<td class="r">${esc(fmtMetric(m, rowValue(r, m)))}</td>`).join('')}<td class="muted">${esc(OUT_LABEL[r.o])}</td></tr>`;
        })
        .join('')}</table>`
    : '';
  const src = w && !w.runs
    ? `<div class="foot">${esc(id)} has no week file yet: these ${w.rows.length} row(s) come only from the sessions loaded in the workspace (agent.historyDays). Build now or run the weekly script to archive it.</div>`
    : w
    ? `<div class="foot">${esc(id)}: ${w.rows.length} session row(s) · written ${w.generatedAt ? esc(ago(d.now, w.generatedAt) || 'just now') : '—'} by the ${w.source.by === 'script' ? 'weekly script' : 'workspace'} · git ${w.source.git ? 'read' : 'not read (commits not counted)'} · ${w.runs} run(s) merged${w.kept ? ` · ${w.kept} row(s) kept from earlier runs` : ''}. Titles in the table come from sessions still loaded; the archive itself stores no title or prompt text.</div>`
    : '';
  return `${nav}<div class="kpis hi-kpis">${kp}</div>${days}<div class="hi-pans">${panels}</div>${table}${src}`;
}

// ---------------------------------------------------------------- archived sessions (daily archive)

interface ArchivedOnly {
  rec: ArchivedSession;
  s: AgentSessionSnapshot;
}

function archChip(rec: ArchivedSession): string {
  return `<span class="hi-arch" title="${esc(`ARCHIVED · OBSERVED on ${rec.day} by Agent's daily archive; no longer read from the provider's files (deleted by the provider's cleanup, or outside agent.historyDays)`)}">ARCHIVED ${esc(rec.day)}</span>`;
}

/** Sessions known only from the archive, newest first. */
function archivedList(extra: ArchivedOnly[], now: number): string {
  if (!extra.length) return '';
  const rows = extra
    .slice(0, 150)
    .map(({ rec, s }) => `<tr><td>${archChip(rec)}</td><td class="muted">${esc(s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleDateString() : '—')}</td><td><span class="prov ${esc(s.provider)}">${esc(s.provider)}</span></td><td><span class="hi-sw" style="background:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td>${esc((s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8)).slice(0, 70))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted">${esc(prettyModelName(s.model) || '—')}</td><td class="r" title="OBSERVED: provider-recorded tokens, as archived">${esc(fmtMetric('tokens', s.usage?.totalTokens ?? 0))}</td><td class="r" title="DERIVED: commits observed in the session window, as archived">${s.commits.length || ''}</td><td class="muted">${esc(s.status)}</td></tr>`)
    .join('');
  return `<details class="hi-how hi-archl"><summary>${extra.length} session(s) known only from the archive <span class="muted">(ARCHIVED, oldest kept ${esc(extra[extra.length - 1].rec.day)})</span></summary><table class="hi-t"><tr><th>Archived</th><th>Last activity</th><th>Provider</th><th>Repo</th><th>Session</th><th>Model</th><th class="r">Tokens</th><th class="r">Commits</th><th>Status</th></tr>${rows}</table>${extra.length > 150 ? `<div class="muted">+${extra.length - 150} more</div>` : ''}<div class="muted">Read ${esc(ago(now, extra[0].rec.archivedAt) || 'just now')} from the daily archive; titles only when the provider named the session (never prompt text).</div></details>`;
}

// ---------------------------------------------------------------- empty archive help

const SCRIPT_CMD = 'npm run compile-tests && node out-test/scripts/weekly.js';
const SCHEDULE_CMD = 'schtasks /Create /SC WEEKLY /D MON /ST 08:00 /TN "Agent weekly history" /TR "node <agent-vscode checkout>\\out-test\\scripts\\weekly.js"';

function howTo(dir: string, open: boolean): string {
  return `<details class="hi-how"${open ? ' open' : ''}><summary>How the archive is filled</summary><div>
<p>Week files live in <code>${esc(dir)}</code> (setting <code>agent.history.dir</code>). Each run merges by session, so weeks survive the providers' own transcript cleanup. Nothing leaves this machine.</p>
<p><b>Build now</b> reads all local Claude Code and Codex history in this window (git not read: commits are not counted). The weekly script also reads git, read-only.</p>
<p>${actBtn('copy', 'script', 'Copy script command', SCRIPT_CMD)} <code>${esc(SCRIPT_CMD)}</code> <span class="muted">(in the agent-vscode checkout; <code>--no-git</code>, <code>--days n</code>, <code>--out dir</code>, <code>--dry</code>)</span></p>
<p>${actBtn('copy', 'schedule', 'Copy Task Scheduler command', SCHEDULE_CMD)} <span class="muted">every Monday 08:00; replace the checkout path</span></p>
<p>Daily archive: <code>npm run archive</code> keeps one snapshot line per session (no prompt or reply text) in <code>~/.agent/archive</code> (setting <code>agent.archive.dir</code>), so sessions stay visible here after Claude Code (cleanupPeriodDays) or Codex delete their files. <code>scripts/install-archive-task.ps1</code> registers it daily at 03:17.</p>
</div></details>`;
}

// ---------------------------------------------------------------- screen

function stateLine(f: FeedState<ArchiveRead>, now: number): string {
  const a = f.value;
  const bits = [a ? `${a.files} week file(s)` : '', a?.at ? `read ${ago(now, a.at) || 'just now'}` : '', f.running ? 'reading…' : '', building ? 'building…' : '', a?.errors.length ? `${a.errors.length} unreadable` : ''].filter(Boolean);
  return `<span class="muted hi-state" title="${esc(a?.errors.map(e => `${e.file}: ${e.error}`).join('\n') ?? '')}">${esc(bits.join(' · '))}</span>`;
}

function render(d: WsData, st: WsState): string {
  const cf = cfg(st);
  const f = feedValue<ArchiveRead>(HISTORY_FEED);
  const arch = f.value;
  const dir = arch?.dir ?? defaultHistoryDir();
  const av = feedValue<ArchiveView>(ARCHIVE_FEED).value;
  const scope = st.opts?.scope;
  const extra = cf.archive ? archivedOnly(av, d.sessions, scope ? s => scopeKey(s) === scope : undefined) : [];
  const extraS = extra.map(x => x.s);
  const { weeks, overlay } = allWeeks(arch, cf.live ? (extraS.length ? d.sessions.concat(extraS) : d.sessions) : extraS, { live: cf.live || extraS.length > 0, git: !!d.git?.enabled, now: d.now });
  const cols = columns(weeks, overlay, cf.range, cf.leadsOnly, d.now);
  const metricSeg = seg(st, 'history.metric', METRICS.map(m => [m, METRIC_SHORT[m]] as [string, string]), 'tokens', 'Metric');
  const bySeg = seg(st, 'history.by', HDIMS.map(x => [x, DIM_SHORT[x]] as [string, string]), 'provider', 'Group by');
  const tb1 = toolbar(
    seg(st, 'history.view', [['weeks', 'Side by side'], ['trend', 'Trend'], ['matrix', 'Matrix'], ['week', 'One week']], 'weeks', 'Weeks side by side, a trend chart, a group × week matrix, or one week in detail'),
    seg(st, 'history.range', [['4', '4 wk'], ['8', '8 wk'], ['13', '13 wk'], ['26', '26 wk'], ['52', '52 wk']], '8', 'Weeks shown, ending with the current week'),
    seg(st, 'history.who', [['all', 'All'], ['leads', 'Leads only']], 'all', 'Include worker sessions (subagents) or only top-level sessions'),
    seg(st, 'history.live', [['on', '+ Loaded'], ['off', 'Archive only']], 'on', 'Merge the sessions loaded in the workspace (agent.historyDays) into the archive weeks, so the current week is up to date'),
    seg(st, 'history.archive', [['on', '+ Archive'], ['off', 'No archive']], 'on', `Include sessions kept in Agent's daily archive (npm run archive, ${av?.dir ?? '~/.agent/archive'}) that are no longer loaded from provider files: shown as ARCHIVED, OBSERVED on the archive day`),
    actBtn('build', 'all', 'Build now', 'Read all local history now and write the week files (asks first)', 'btn'),
    actBtn('open', '', 'Open folder', 'Reveal the archive folder'),
    actBtn('csv', cf.leadsOnly ? 'leads' : 'all', 'Export CSV', 'Weeks × metrics as CSV (numbers only)'),
    stateLine(f, d.now),
  );
  let tb2 = '';
  if (cf.view === 'weeks') tb2 = toolbar(seg(st, 'history.orient', [['cols', 'Weeks as columns'], ['rows', 'Weeks as rows']], 'cols', 'Orientation'), seg(st, 'history.cmp', [['value', 'Values'], ['delta', 'Δ vs previous'], ['avg', 'Per session']], 'value', 'What each cell shows'));
  else if (cf.view === 'trend')
    tb2 = toolbar(
      metricSeg,
      seg(st, 'history.gran', [['week', 'Week'], ['day', 'Day']], 'week', 'Granularity'),
      seg(st, 'history.chart', [['bars', 'Bars'], ['stacked', 'Stacked'], ['line', 'Lines']], 'stacked', 'Chart type'),
      cf.chart !== 'bars' ? bySeg : '',
      cf.chart !== 'line' ? seg(st, 'history.dir', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], 'vertical', 'Bar orientation') : '',
      seg(st, 'history.acc', [['rate', 'Per period'], ['cumulative', 'Cumulative']], 'rate', 'Rate or running total'),
    );
  else if (cf.view === 'matrix') tb2 = toolbar(metricSeg, bySeg, seg(st, 'history.orient', [['cols', 'Weeks as columns'], ['rows', 'Weeks as rows']], 'cols', 'Orientation'), seg(st, 'history.norm', [['abs', 'Values'], ['share', '% of week']], 'abs', 'Absolute values or share of each week'));
  else tb2 = toolbar(metricSeg);

  const hasData = cols.some(c => c.rows.length) || weeks.size > 0;
  if (!arch && f.running && !hasData) return `<div class="hi">${tb1}<div class="empty">Reading the history archive…</div></div>`;
  const missing = !arch?.files;
  const banner = missing
    ? `<div class="hi-ban">No week file yet in <code>${esc(dir)}</code>${cf.live ? ': showing only the sessions loaded in the workspace' : ''}. ${actBtn('build', 'all', 'Build now', 'Read all local history now and write the week files (asks first)')}</div>`
    : '';
  if (!hasData) return `<div class="hi">${tb1}${banner}<div class="empty">Nothing to show for the last ${cf.range} weeks.</div>${howTo(dir, true)}</div>`;

  const archived = cols.filter(c => c.w).length;
  const tokens = cols.reduce((a, c) => a + total(c.rows, 'tokens'), 0);
  const repos = new Set(cols.flatMap(c => c.rows.map(r => r.repo))).size;
  const ses = cols.reduce((a, c) => a + total(c.rows, 'sessions'), 0);
  const kp = `<div class="kpis hi-k">${[
    `<div class="kpi" title="weeks with a file or loaded sessions, out of the range shown"><b>${archived}/${cols.length}</b><span>Weeks with data</span></div>`,
    `<div class="kpi" title="${esc(evTitle('sessions'))}"><b>${esc(fmtMetric('sessions', ses))}</b><span>Session-weeks</span></div>`,
    `<div class="kpi" title="${esc(evTitle('tokens'))}"><b>${esc(fmtMetric('tokens', tokens))}</b><span>Tokens</span></div>`,
    `<div class="kpi" title="DERIVED: distinct repository folder names"><b>${repos}</b><span>Repositories</span></div>`,
    extra.length ? `<div class="kpi" title="ARCHIVED: sessions read from Agent's daily archive that the providers no longer expose (or that are outside agent.historyDays); OBSERVED on the archive day"><b>${extra.length}</b><span>From archive</span></div>` : '',
  ].join('')}</div>`;

  let body: string;
  if (cf.view === 'trend') body = trend(cols, cf, d.now);
  else if (cf.view === 'matrix') body = matrix(cols, cf);
  else if (cf.view === 'week') body = oneWeek(cols, weeks, overlay, cf, d, st, new Set(arch?.reports ?? []), cf.leadsOnly, new Map(extra.map(x => [x.s.key, x])));
  else body = sideBySide(cols, cf) + (cf.pick ? `<div class="hi-open"><button class="link" data-opt="history.view" data-val="week">Open ${esc(fromPick(cf.pick))} in detail ▸</button></div>` : '');

  const shownMetric = cf.view === 'weeks' ? undefined : cf.metric;
  const foot = `<div class="foot">${shownMetric ? `<b>${esc(HIST_BASIS[shownMetric].kind)}</b> · ${esc(HIST_BASIS[shownMetric].basis)}. ` : 'Hover a metric for its basis. '}Weeks are ISO weeks in local time (Monday → Sunday). <sup>+</sup> marks weeks that include the sessions loaded in the workspace; the archive itself holds counts, tokens, repositories, models and outcomes only.</div>`;
  return `<div class="hi">${tb1}${tb2}${banner}${kp}${body}${archivedList(extra, d.now)}${foot}${howTo(dir, false)}</div>`;
}

// ---------------------------------------------------------------- actions

let building = false;

function archiveDir(): string {
  return feedValue<ArchiveRead>(HISTORY_FEED).value?.dir ?? defaultHistoryDir();
}

async function build(_arg: string, ctx: ActCtx): Promise<void> {
  if (building) return ctx.info('History: a build is already running.');
  const dir = archiveDir();
  const ok = await ctx.confirm(`Build the weekly history now?\n\nAgent reads all local Claude Code and Codex history (it can take a minute; this window may be slower meanwhile) and merges it into the week files in ${dir}. Provider files are only read. Git is not read from here: run the weekly script to count commits.`, 'Build');
  if (!ok) return;
  building = true;
  ctx.refreshFeeds();
  try {
    const { sessions, ms } = await collectAll({ days: 3650, maxSessions: 100_000, git: false });
    const r = writeArchive(dir, sessions, { by: 'workspace', git: false, days: 3650 });
    ctx.info(`History: ${sessions.length} sessions read in ${(ms / 1000).toFixed(0)} s → ${r.weeks.length} week file(s) in ${dir}.`);
  } catch (e: any) {
    ctx.info(`History: build failed (${String(e?.message ?? e).slice(0, 200)}).`);
  } finally {
    building = false;
    ctx.refreshFeeds();
  }
}

async function openDir(_arg: string, ctx: ActCtx): Promise<void> {
  const dir = archiveDir();
  if (!fs.existsSync(dir)) return ctx.info(`History: ${dir} does not exist yet. Build the archive first.`);
  await ctx.revealInOs(dir);
}

async function report(arg: string, ctx: ActCtx): Promise<void> {
  const id = fromPick(arg);
  if (!id || !WEEK_RE.test(id)) return;
  const file = path.join(archiveDir(), `${id}.md`);
  if (!fs.existsSync(file)) return ctx.info(`History: no report for ${id}.`);
  await ctx.openFile(file);
}

async function copy(arg: string, ctx: ActCtx): Promise<void> {
  const text = arg === 'script' ? SCRIPT_CMD : arg === 'schedule' ? SCHEDULE_CMD : undefined;
  if (!text) return;
  await ctx.copy(text);
  ctx.info('History: command copied.');
}

/** Weeks × metrics CSV of what the archive (and loaded sessions) hold. */
export function historyCsv(weeks: HistWeek[], leadsOnly: boolean): string {
  const lines = [['week', 'start', ...METRICS.map(m => (m === 'active' ? 'active_minutes' : m === 'cost' ? 'cost_usd_recorded' : m)), 'rows'].join(',')];
  for (const w of [...weeks].sort((a, b) => a.start - b.start)) {
    const rows = leadsOnly ? w.rows.filter(r => !r.w) : w.rows;
    lines.push([w.week, new Date(w.start).toISOString().slice(0, 10), ...METRICS.map(m => csvValue(m, total(rows, m))), String(rows.length)].join(','));
  }
  return lines.join('\n') + '\n';
}

async function csv(arg: string, ctx: ActCtx): Promise<void> {
  if (arg !== 'all' && arg !== 'leads') return;
  const now = Date.now();
  const { weeks } = allWeeks(feedValue<ArchiveRead>(HISTORY_FEED).value, ctx.sessions(), { live: true, git: false, now });
  if (!weeks.size) return ctx.info('History: nothing to export yet.');
  const saved = await ctx.saveText(`agent-history-weeks-${arg}.csv`, historyCsv([...weeks.values()], arg === 'leads'));
  if (saved) ctx.info(`History: saved ${saved}`);
}

const CSS = `
.hi .tb { margin: 0 0 6px; }
.hi .hi-state { margin-left: 4px; }
.hi .hi-k { margin: 6px 0 10px; }
.hi .hi-ban { border: 1px dashed var(--line); border-radius: 4px; padding: 6px 10px; margin: 4px 0 8px; font-size: 12px; background: var(--raise); }
.hi .hi-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.hi .hi-sw.prev { background: color-mix(in srgb, var(--quiet) 55%, transparent); }
.hi .hi-lg { display: inline-flex; align-items: center; gap: 2px; margin-right: 10px; }
.hi .r { text-align: right; }
.hi button.hi-wk { background: none; border: 1px solid transparent; border-radius: 3px; color: inherit; font: inherit; cursor: pointer; display: inline-flex; flex-direction: column; align-items: flex-start; padding: 1px 4px; line-height: 1.15; }
.hi button.hi-wk b { font-size: 11px; }
.hi button.hi-wk span { font-size: 10px; color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; }
.hi button.hi-wk:hover { border-color: var(--line); }
.hi button.hi-wk.on { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.hi button.hi-wk.cur b { color: var(--accent); }
.hi button.hi-wk.none { opacity: .55; }
.hi button.hi-wk sup { color: var(--accent); font-size: 9px; }
.hi table.hi-t { font-size: 12px; border-collapse: separate; border-spacing: 0; }
.hi table.hi-t th, .hi table.hi-t td { padding: 3px 7px; }
.hi table.hi-sbs th.hi-ml { text-align: left; font-weight: 600; white-space: nowrap; }
.hi table.hi-sbs th.hi-wh { text-align: right; vertical-align: bottom; }
.hi table.hi-sbs th.hi-wh button.hi-wk { align-items: flex-end; }
.hi td.hi-c { font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 52px; }
.hi td.hi-c.hb { background-image: linear-gradient(to top, color-mix(in srgb, var(--accent) 32%, transparent), color-mix(in srgb, var(--accent) 32%, transparent)); background-repeat: no-repeat; background-position: left bottom; background-size: var(--f, 0%) 3px; }
.hi td.hi-c.on, .hi tr.on td { background-color: var(--vscode-list-hoverBackground); }
.hi table.hi-sbs tr:hover td, .hi table.hi-sbs tr:hover th { background-color: var(--vscode-list-hoverBackground); }
.hi .hi-scroll { overflow-x: auto; max-width: 100%; }
.hi svg.hi-sp { width: 64px; height: 18px; display: block; }
.hi svg.hi-sp polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.hi svg.hi-sp circle { fill: var(--accent); }
.hi .hi-d { font-size: 10px; margin-left: 4px; font-variant-numeric: tabular-nums; }
.hi .hi-d.up { color: var(--accent); } .hi .hi-d.down { color: var(--warn); } .hi .hi-d.flat { color: var(--vscode-descriptionForeground); }
.hi svg.hi-ch { width: 100%; max-width: 1100px; height: auto; display: block; }
.hi .hi-grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.hi .hi-ax { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.hi .hi-ax2 { fill: var(--vscode-descriptionForeground); font-size: 9px; opacity: .8; }
.hi .hi-bv { fill: var(--vscode-foreground); font-size: 9px; }
.hi .hi-bar { opacity: .9; } .hi .hi-bar:hover { opacity: 1; stroke: var(--vscode-focusBorder); stroke-width: 1; }
.hi .hi-hatch { fill: var(--vscode-editor-background, #fff); opacity: .45; }
.hi .hi-pl { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.hi .hi-pt.cur { stroke: var(--vscode-foreground); stroke-width: 1; stroke-dasharray: 2 1; }
.hi .hi-h { display: grid; gap: 2px; max-width: 1000px; }
.hi .hi-hr { display: grid; grid-template-columns: 150px minmax(0, 1fr) 70px; gap: 8px; align-items: center; font-size: 12px; padding: 1px 4px; border-radius: 3px; }
.hi .hi-hr:hover { background: var(--vscode-list-hoverBackground); }
.hi .hi-hr.cur .hi-htrk { background-image: repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--quiet) 25%, transparent) 4px 6px); }
.hi .hi-hl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hi .hi-htrk { display: flex; height: 13px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.hi .hi-htrk i { display: block; height: 100%; opacity: .9; }
.hi .hi-hv { text-align: right; font-variant-numeric: tabular-nums; }
.hi .hi-mx { display: grid; gap: 2px; font-size: 11px; max-width: 1300px; overflow-x: auto; align-items: center; }
.hi .hi-mx i { height: 22px; border-radius: 2px; border: 1px solid var(--line); font-style: normal; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; font-size: 10px; color: var(--vscode-foreground); }
.hi .hi-mx i.hx { color: var(--vscode-button-foreground, #fff); }
.hi .hi-mh { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.hi .hi-ml { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; }
.hi .hi-ms { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; padding-left: 4px; }
.hi .hi-nav { display: flex; gap: 10px; align-items: baseline; margin: 2px 0 8px; flex-wrap: wrap; }
.hi .hi-nav b { font-size: 14px; }
.hi .hi-kpis .hi-kpi { cursor: pointer; border-radius: 4px; padding: 2px 6px; }
.hi .hi-kpis .hi-kpi:hover { background: var(--vscode-list-hoverBackground); }
.hi .hi-kpis .hi-kpi.on { outline: 1px solid var(--vscode-focusBorder); }
.hi .hi-days { display: grid; grid-template-columns: repeat(7, minmax(44px, 110px)); gap: 6px; height: 150px; margin: 8px 0 2px; }
.hi .hi-day { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
.hi .hi-day.fut { opacity: .45; }
.hi .hi-day b { font-size: 10px; min-height: 13px; font-variant-numeric: tabular-nums; }
.hi .hi-dcol { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 2px; border-bottom: 1px solid var(--line); }
.hi .hi-dcol i { display: block; width: 42%; background: var(--accent); border-radius: 2px 2px 0 0; opacity: .9; }
.hi .hi-dcol i.prev { background: color-mix(in srgb, var(--quiet) 55%, transparent); }
.hi .hi-dl { font-size: 10px; color: var(--vscode-descriptionForeground); }
.hi .hi-pans { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px 18px; margin: 10px 0; }
.hi .hi-pan h3, .hi h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); margin: 4px 0; font-weight: 600; }
.hi .hi-bl { display: grid; gap: 1px; }
.hi .hi-blr { display: grid; grid-template-columns: minmax(70px, 140px) minmax(0, 1fr) 56px; gap: 6px; align-items: center; font-size: 11px; }
.hi .hi-bll { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hi .hi-trk { height: 9px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.hi .hi-trk i { display: block; height: 100%; opacity: .9; }
.hi .hi-blr b { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.hi table.hi-top tr[data-select] { cursor: pointer; }
.hi table.hi-top tr[data-select]:hover td { background: var(--vscode-list-hoverBackground); }
.hi table.hi-top td { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hi .hi-open { margin: 6px 0; }
.hi details.hi-how { margin-top: 10px; font-size: 12px; }
.hi details.hi-how summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
.hi details.hi-how code { font-size: 11px; }
.hi .hi-arch { display: inline-block; font-size: 9.5px; font-weight: 600; letter-spacing: .03em; padding: 0 5px; border-radius: 8px; border: 1px dashed var(--quiet); color: var(--vscode-descriptionForeground); white-space: nowrap; }
`;

export const historyView: ExtraView = {
  id: 'history',
  label: 'History',
  group: 'Time',
  hint: 'Long-term weekly rollups from the local archive (built by the weekly script), including archived Claude / Codex sessions.',
  ready: true,
  feeds: [historyFeed as Feed, archiveFeed as Feed],
  render,
  css: CSS,
  actions: { build, open: openDir, report, copy, csv },
};
