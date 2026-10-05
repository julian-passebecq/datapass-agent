// Generic pivot over sessions: dimension × metric × period, plus dim × dim and time series.
// Pure functions of snapshots. Every metric is provider-recorded (OBSERVED) or arithmetic over it (DERIVED);
// nothing is estimated or priced here.
import type { AgentSessionSnapshot, EvidenceKind } from '../model';
import { base, isLive, outcome, OUTCOME_LABEL, workerRole } from './insights';

export const DIMS = ['provider', 'repo', 'model', 'effort', 'status', 'outcome', 'day', 'hour', 'weekday', 'worker', 'tool'] as const;
export type Dim = (typeof DIMS)[number];
export const METRICS = ['sessions', 'tokens', 'output', 'cost', 'active', 'commits', 'pass', 'fail', 'edits', 'tools', 'prompts'] as const;
export type Metric = (typeof METRICS)[number];
export const PERIODS = ['24h', '7d', '30d', 'all'] as const;
export type Period = (typeof PERIODS)[number];
export const GRANS = ['hour', 'day', 'week'] as const;
export type Gran = (typeof GRANS)[number];

export const DIM_LABEL: Record<Dim, string> = {
  provider: 'Provider', repo: 'Repo', model: 'Model', effort: 'Effort', status: 'Status', outcome: 'Outcome',
  day: 'Day', hour: 'Hour', weekday: 'Weekday', worker: 'Worker type', tool: 'Tool',
};

export interface MetricInfo {
  label: string;
  kind: EvidenceKind;
  /** Where the number comes from (tooltip / legend). */
  basis: string;
}

export const METRIC_INFO: Record<Metric, MetricInfo> = {
  sessions: { label: 'Sessions', kind: 'DERIVED', basis: 'count of sessions (and workers) active in the period' },
  tokens: { label: 'Tokens', kind: 'OBSERVED', basis: 'provider-recorded prompt + output tokens; per model call when recorded, else the session total at its last activity' },
  output: { label: 'Output tokens', kind: 'OBSERVED', basis: 'provider-recorded output tokens; per model call when recorded, else the session total' },
  cost: { label: 'Cost recorded', kind: 'OBSERVED', basis: 'Claude Code cost-state total of the session; Codex records no cost; Agent never prices' },
  active: { label: 'Active time', kind: 'DERIVED', basis: 'sum of gaps < 5 min between events when exposed, else first → last observed activity' },
  commits: { label: 'Commits', kind: 'OBSERVED', basis: 'commits observed during the session window, at commit time' },
  pass: { label: 'Tests pass', kind: 'OBSERVED', basis: 'test / build commands with a pass result (exit code or tool status), at run time' },
  fail: { label: 'Tests fail', kind: 'OBSERVED', basis: 'test / build commands with a fail result (exit code or tool status), at run time' },
  edits: { label: 'Edits', kind: 'OBSERVED', basis: 'file edit tool calls recorded by the provider' },
  tools: { label: 'Tool calls', kind: 'OBSERVED', basis: 'tool calls recorded by the provider (per tool when the tool dimension is used)' },
  prompts: { label: 'Prompts', kind: 'OBSERVED', basis: 'human prompts recorded by the provider (absent when not exposed)' },
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PERIOD_MS: Record<Period, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
export const TIME_DIMS = new Set<Dim>(['day', 'hour', 'weekday']);

export function isDim(v: string): v is Dim {
  return (DIMS as readonly string[]).includes(v);
}
export function isMetric(v: string): v is Metric {
  return (METRICS as readonly string[]).includes(v);
}
export function isPeriod(v: string): v is Period {
  return (PERIODS as readonly string[]).includes(v);
}

export function periodStart(p: Period, now: number): number {
  return PERIOD_MS[p] === Infinity ? -Infinity : now - PERIOD_MS[p];
}

const at0 = (s: AgentSessionSnapshot) => s.startedAt ?? s.lastActivityAt ?? 0;
const at1 = (s: AgentSessionSnapshot) => (isLive(s) ? Math.max(s.lastActivityAt ?? 0, at0(s)) : (s.lastActivityAt ?? at0(s)));

/** [time, value] pieces of one session for one metric, timed where the provider records a time. */
export function contributions(s: AgentSessionSnapshot, m: Metric): [number, number][] {
  const f = s.facts;
  switch (m) {
    case 'sessions':
      return [[at0(s), 1]];
    case 'tokens':
    case 'output': {
      const total = m === 'tokens' ? s.usage?.totalTokens ?? 0 : s.usage?.outputTokens ?? 0;
      const out: [number, number][] = [];
      let sum = 0;
      for (const [at, p, o] of f?.calls ?? []) {
        const v = m === 'tokens' ? p + o : o;
        if (v > 0) out.push([at, v]);
        sum += v;
      }
      if (total - sum > 0) out.push([at1(s), total - sum]);
      return out;
    }
    case 'cost':
      return s.usage?.costUSD !== undefined ? [[at1(s), s.usage.costUSD]] : [];
    case 'active': {
      const ms = f?.activeMs ?? Math.max(0, at1(s) - at0(s));
      return ms > 0 ? [[at1(s), ms]] : [];
    }
    case 'commits':
      return s.commits.map(c => [c.at, 1]);
    case 'pass':
      return s.tests.filter(t => t.outcome === 'PASS').map(t => [t.at, 1]);
    case 'fail':
      return s.tests.filter(t => t.outcome === 'FAIL').map(t => [t.at, 1]);
    case 'edits':
      return s.counts.fileEdits ? [[at1(s), s.counts.fileEdits]] : [];
    case 'tools':
      return s.counts.tools ? [[at1(s), s.counts.tools]] : [];
    case 'prompts':
      return f?.prompts ? [[at1(s), f.prompts]] : [];
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day key YYYY-MM-DD. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Keys of one session in one dimension (time dims use the contribution time; tool may give several). */
export function dimKeys(s: AgentSessionSnapshot, dim: Dim, at: number): string[] {
  switch (dim) {
    case 'provider':
      return [PROV[s.provider] ?? s.provider];
    case 'repo':
      return [base(s.repository) || base(s.cwd) || '(no repo)'];
    case 'model':
      return [prettyModelName(s.model) || '(not recorded)'];
    case 'effort':
      return [s.effort || '(not recorded)'];
    case 'status':
      return [s.status];
    case 'outcome':
      return [OUTCOME_LABEL[outcome(s)]];
    case 'day':
      return [dayKey(at)];
    case 'hour':
      return [`${pad2(new Date(at).getHours())}h`];
    case 'weekday':
      return [WEEKDAYS[(new Date(at).getDay() + 6) % 7]];
    case 'worker':
      return [s.isWorker ? workerRole(s) : 'lead'];
    case 'tool': {
      const t = Object.keys(s.facts?.toolCounts ?? {});
      return t.length ? t : ['(not exposed)'];
    }
  }
}

function prettyModelName(m: string | undefined): string {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

/** Natural order for time-like keys; undefined for value-sorted dimensions. */
export function naturalOrder(dim: Dim): ((a: string, b: string) => number) | undefined {
  if (dim === 'day' || dim === 'hour') return (a, b) => a.localeCompare(b);
  if (dim === 'weekday') return (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b);
  return undefined;
}

export interface PivotOpts {
  dim: Dim;
  metric: Metric;
  period: Period;
  now: number;
  /** Keep only top-level sessions. */
  leadsOnly?: boolean;
}

export interface Group {
  key: string;
  value: number;
  /** Session keys that contributed. */
  sessions: string[];
}

export interface Pivot {
  groups: Group[];
  total: number;
  /** Sessions in the period (after filters). */
  sessionCount: number;
  /** True when one session can count in several groups (tool dimension). */
  overlap: boolean;
}

/** Sessions in the period: last activity at or after the period start. */
export function inPeriod(sessions: AgentSessionSnapshot[], o: { period: Period; now: number; leadsOnly?: boolean }): AgentSessionSnapshot[] {
  const since = periodStart(o.period, o.now);
  return sessions.filter(s => (!o.leadsOnly || !s.isWorker) && at1(s) >= since);
}

/** Iterates every (keys, value) piece of the period, after clipping to the period start. */
function pieces(s: AgentSessionSnapshot, dim: Dim, metric: Metric, since: number, fn: (key: string, value: number, at: number) => void): void {
  for (const [at0_, v] of contributions(s, metric)) {
    let at = at0_;
    if (at < since) {
      if (metric !== 'sessions') continue; // timed pieces before the period are outside it
      at = since;
    }
    if (dim === 'tool' && metric === 'tools' && s.facts?.toolCounts) {
      for (const [k, n] of Object.entries(s.facts.toolCounts)) fn(k, n, at);
      continue;
    }
    for (const k of dimKeys(s, dim, at)) fn(k, v, at);
  }
}

export function pivot(sessions: AgentSessionSnapshot[], o: PivotOpts): Pivot {
  const list = inPeriod(sessions, o);
  const since = periodStart(o.period, o.now);
  const m = new Map<string, { value: number; sessions: Set<string> }>();
  let total = 0;
  for (const s of list) {
    pieces(s, o.dim, o.metric, since, (k, v) => {
      const g = m.get(k) ?? { value: 0, sessions: new Set<string>() };
      // A session counts once per group for the sessions metric, even with several pieces.
      if (o.metric === 'sessions' && g.sessions.has(s.key)) return;
      g.value += v;
      g.sessions.add(s.key);
      m.set(k, g);
    });
  }
  const groups = [...m].map(([key, g]) => ({ key, value: g.value, sessions: [...g.sessions] }));
  const nat = naturalOrder(o.dim);
  groups.sort(nat ? (a, b) => nat(a.key, b.key) : (a, b) => b.value - a.value || a.key.localeCompare(b.key));
  for (const g of groups) total += g.value;
  const overlap = o.dim === 'tool' && o.metric !== 'tools';
  return { groups, total: overlap ? sumOnce(list, o.metric, since) : total, sessionCount: list.length, overlap };
}

function sumOnce(list: AgentSessionSnapshot[], metric: Metric, since: number): number {
  let t = 0;
  for (const s of list) for (const [at, v] of contributions(s, metric)) if (at >= since || metric === 'sessions') t += v;
  return t;
}

/** Keeps the first `n` groups and folds the rest into "other". */
export function topN(groups: Group[], n: number): Group[] {
  if (groups.length <= n) return groups;
  const keep = groups.slice(0, n);
  const rest = groups.slice(n);
  const sessions = new Set(rest.flatMap(g => g.sessions));
  return [...keep, { key: `other (${rest.length})`, value: rest.reduce((a, g) => a + g.value, 0), sessions: [...sessions] }];
}

export interface Cross {
  rows: string[];
  cols: string[];
  /** cells[row][col] */
  cells: number[][];
  max: number;
}

/** dim × dim2 matrix of the metric (rows / cols ordered like pivot, capped). */
export function cross(sessions: AgentSessionSnapshot[], o: PivotOpts & { dim2: Dim; maxRows?: number; maxCols?: number }): Cross {
  const since = periodStart(o.period, o.now);
  const list = inPeriod(sessions, o);
  const cell = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  const add = (r: string, c: string, v: number) => {
    const row = cell.get(r) ?? new Map<string, number>();
    row.set(c, (row.get(c) ?? 0) + v);
    cell.set(r, row);
  };
  for (const s of list) {
    // For dim2 we evaluate keys at the same piece time so day × hour etc. stay consistent.
    for (const [at0_, v] of contributions(s, o.metric)) {
      let at = at0_;
      if (at < since) {
        if (o.metric !== 'sessions') continue;
        at = since;
      }
      const toolCounts = o.metric === 'tools' ? s.facts?.toolCounts : undefined;
      const rk = o.dim === 'tool' && toolCounts ? Object.keys(toolCounts) : dimKeys(s, o.dim, at);
      const ck = o.dim2 === 'tool' && toolCounts ? Object.keys(toolCounts) : dimKeys(s, o.dim2, at);
      for (const r of rk)
        for (const c of ck) {
          let val = v;
          if (toolCounts && (o.dim === 'tool' || o.dim2 === 'tool')) val = toolCounts[o.dim === 'tool' ? r : c] ?? 0;
          if (o.metric === 'sessions') {
            const id = `${s.key}\u0000${r}\u0000${c}`;
            if (seen.has(id)) continue;
            seen.add(id);
          }
          add(r, c, val);
        }
    }
  }
  const rowTot = new Map<string, number>(), colTot = new Map<string, number>();
  for (const [r, row] of cell)
    for (const [c, v] of row) {
      rowTot.set(r, (rowTot.get(r) ?? 0) + v);
      colTot.set(c, (colTot.get(c) ?? 0) + v);
    }
  const order = (d: Dim, tot: Map<string, number>, cap: number) => {
    const nat = naturalOrder(d);
    const keys = [...tot.keys()];
    if (nat) return keys.sort(nat).slice(-cap);
    return keys.sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0) || a.localeCompare(b)).slice(0, cap);
  };
  const rows = order(o.dim, rowTot, o.maxRows ?? 20);
  const cols = order(o.dim2, colTot, o.maxCols ?? 24);
  const cells = rows.map(r => cols.map(c => cell.get(r)?.get(c) ?? 0));
  return { rows, cols, cells, max: Math.max(0, ...cells.flat()) };
}

export function bucketStart(t: number, g: Gran): number {
  const d = new Date(t);
  if (g === 'hour') {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  d.setHours(0, 0, 0, 0);
  if (g === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function nextBucket(t: number, g: Gran): number {
  const d = new Date(t);
  if (g === 'hour') d.setHours(d.getHours() + 1);
  else d.setDate(d.getDate() + (g === 'week' ? 7 : 1));
  return d.getTime();
}

export interface Series {
  /** Bucket start times. */
  x: number[];
  lines: { key: string; values: number[]; total: number }[];
}

/**
 * Metric over time by bucket, one line per group of `dim` (top `maxLines`, rest folded into "other").
 * A time dimension gives one line ("all").
 */
export function series(sessions: AgentSessionSnapshot[], o: PivotOpts & { gran: Gran; maxLines?: number; maxBuckets?: number }): Series {
  const since = periodStart(o.period, o.now);
  const list = inPeriod(sessions, o);
  const raw: { key: string; at: number; v: number }[] = [];
  const single = TIME_DIMS.has(o.dim);
  let first = Infinity;
  for (const s of list)
    pieces(s, single ? 'provider' : o.dim, o.metric, since, (k, v, at) => {
      raw.push({ key: single ? 'all' : k, at, v });
      if (at < first) first = at;
    });
  const cap = o.maxBuckets ?? 400;
  let lo = bucketStart(Number.isFinite(since) ? since : first === Infinity ? o.now : first, o.gran);
  const x: number[] = [];
  for (let t = lo; t <= o.now && x.length < cap + 1; t = nextBucket(t, o.gran)) x.push(t);
  if (x.length > cap) {
    // too many buckets for "all" with a fine granularity: keep the latest ones
    x.splice(0, x.length - cap);
    lo = x[0];
  }
  const idx = (t: number) => {
    const b = bucketStart(t, o.gran);
    let i = x.indexOf(b);
    if (i < 0 && b > x[x.length - 1]) i = x.length - 1;
    return i;
  };
  const tot = new Map<string, number>();
  for (const r of raw) tot.set(r.key, (tot.get(r.key) ?? 0) + r.v);
  const nat = naturalOrder(o.dim);
  const ranked = [...tot.keys()].sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0) || a.localeCompare(b));
  if (nat && !single) ranked.sort(nat);
  const maxLines = o.maxLines ?? 6;
  const keep = new Set(ranked.slice(0, maxLines));
  const lines = new Map<string, number[]>();
  for (const k of ranked.slice(0, maxLines)) lines.set(k, new Array(x.length).fill(0));
  if (ranked.length > maxLines) lines.set('other', new Array(x.length).fill(0));
  for (const r of raw) {
    if (r.at < lo) continue;
    const i = idx(r.at);
    if (i < 0) continue;
    lines.get(keep.has(r.key) ? r.key : 'other')![i] += r.v;
  }
  return { x, lines: [...lines].map(([key, values]) => ({ key, values, total: values.reduce((a, b) => a + b, 0) })) };
}

/** Formats a metric value for display. */
export function fmtMetric(m: Metric, v: number): string {
  if (m === 'cost') return `$${v.toFixed(2)}`;
  if (m === 'active') {
    const min = Math.round(v / 60_000);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    return h < 48 ? `${h}h${pad2(min % 60)}` : `${Math.floor(h / 24)}d${h % 24}h`;
  }
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}k`;
  if (v < 1e9) return `${(v / 1e6).toFixed(1)}M`;
  return `${(v / 1e9).toFixed(1)}B`;
}

/** Raw value for CSV (no unit, cost with cents, active in minutes). */
export function csvValue(m: Metric, v: number): string {
  if (m === 'cost') return v.toFixed(2);
  if (m === 'active') return (v / 60_000).toFixed(1);
  return String(Math.round(v));
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV of a pivot (or a dim × dim2 cross in long form). Labels only, no prompt text. */
export function pivotCsv(sessions: AgentSessionSnapshot[], o: PivotOpts & { dim2?: Dim }): string {
  const unit = o.metric === 'active' ? 'minutes' : o.metric === 'cost' ? 'usd_recorded' : o.metric;
  if (o.dim2) {
    const c = cross(sessions, { ...o, dim2: o.dim2, maxRows: 1000, maxCols: 1000 });
    const lines = [[o.dim, o.dim2, unit].join(',')];
    c.rows.forEach((r, i) => c.cols.forEach((col, j) => {
      if (c.cells[i][j]) lines.push([csvCell(r), csvCell(col), csvValue(o.metric, c.cells[i][j])].join(','));
    }));
    return lines.join('\n') + '\n';
  }
  const p = pivot(sessions, o);
  const lines = [[o.dim, unit, 'sessions'].join(',')];
  for (const g of p.groups) lines.push([csvCell(g.key), csvValue(o.metric, g.value), String(g.sessions.length)].join(','));
  return lines.join('\n') + '\n';
}

/** Option-safe slug of a group key ([a-z0-9._:-], ≤ 40) used for drill-down selection. */
export function slug(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '-';
}
