// Token rhythm: provider-recorded tokens per model call, bucketed per minute / 5 min / 15 min / hour / day / week,
// stacked by provider / model / repo / session / kind. Pure functions of snapshots.
// OBSERVED: per-call [at, prompt, output] (SessionFacts.calls) and session totals. DERIVED: buckets, rates, peaks.
// Tokens a provider recorded without a per-call time (session total minus the sum of recorded calls) are "untimed":
// they are counted apart and only placed on the time axis (at the session's last activity) when asked to.
import type { AgentSessionSnapshot } from '../model';
import { base, isLive } from './insights';
import { bucketStart as calBucket, slug } from './explore';

export const T_GRANS = ['minute', '5min', '15min', 'hour', 'day', 'week'] as const;
export type TGran = (typeof T_GRANS)[number];
export const T_BYS = ['provider', 'model', 'repo', 'session', 'kind'] as const;
export type TBy = (typeof T_BYS)[number];
export const T_METRICS = ['total', 'output', 'prompt'] as const;
export type TMetric = (typeof T_METRICS)[number];
export const T_PERIODS = ['1h', '6h', '24h', '7d', '30d', 'all'] as const;
export type TPeriod = (typeof T_PERIODS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PERIOD_MS: Record<TPeriod, number> = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
const FIXED: Partial<Record<TGran, number>> = { minute: MIN, '5min': 5 * MIN, '15min': 15 * MIN };
const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

export const isTGran = (v: string): v is TGran => (T_GRANS as readonly string[]).includes(v);
export const isTBy = (v: string): v is TBy => (T_BYS as readonly string[]).includes(v);
export const isTMetric = (v: string): v is TMetric => (T_METRICS as readonly string[]).includes(v);
export const isTPeriod = (v: string): v is TPeriod => (T_PERIODS as readonly string[]).includes(v);

/** Default bucket for a period: about 60–170 buckets. */
export function autoGran(p: TPeriod): TGran {
  return ({ '1h': 'minute', '6h': '5min', '24h': '15min', '7d': 'hour', '30d': 'day', all: 'day' } as Record<TPeriod, TGran>)[p];
}

/** Bucket length in minutes (calendar buckets use their nominal length). */
export function granMinutes(g: TGran): number {
  return { minute: 1, '5min': 5, '15min': 15, hour: 60, day: 1440, week: 10080 }[g];
}

export function tBucketStart(t: number, g: TGran): number {
  const f = FIXED[g];
  if (f) {
    // local-time aligned (time zone offsets are whole minutes; 15 min aligns for every real offset but a few)
    const off = new Date(t).getTimezoneOffset() * MIN;
    return Math.floor((t - off) / f) * f + off;
  }
  return calBucket(t, g as 'hour' | 'day' | 'week');
}

function tNext(t: number, g: TGran): number {
  const f = FIXED[g];
  if (f) return t + f;
  const d = new Date(t);
  if (g === 'hour') d.setHours(d.getHours() + 1);
  else d.setDate(d.getDate() + (g === 'week' ? 7 : 1));
  return d.getTime();
}

/** One token piece: a recorded model call (timed) or a session's untimed remainder. */
export interface TokenPiece {
  at: number;
  prompt: number;
  output: number;
  timed: boolean;
}

const lastAt = (s: AgentSessionSnapshot) => s.lastActivityAt ?? s.endedAt ?? s.startedAt ?? 0;

/** Per-call pieces of a session plus, when the session total exceeds the recorded calls, one untimed remainder. */
export function tokenPieces(s: AgentSessionSnapshot): TokenPiece[] {
  const out: TokenPiece[] = [];
  let sp = 0, so = 0;
  for (const c of s.facts?.calls ?? []) {
    const [at, p, o] = c;
    if (!Number.isFinite(at)) continue;
    const pp = Math.max(0, p || 0), oo = Math.max(0, o || 0);
    sp += pp;
    so += oo;
    if (pp + oo > 0) out.push({ at, prompt: pp, output: oo, timed: true });
  }
  const tot = s.usage?.totalTokens ?? 0;
  const outTot = s.usage?.outputTokens ?? 0;
  const rp = Math.max(0, tot - outTot - sp);
  const ro = Math.max(0, outTot - so);
  if (rp + ro > 0) out.push({ at: lastAt(s), prompt: rp, output: ro, timed: false });
  return out;
}

export function metricOf(p: { prompt: number; output: number }, m: TMetric): number {
  return m === 'output' ? p.output : m === 'prompt' ? p.prompt : p.prompt + p.output;
}

function prettyModelName(m: string | undefined): string {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

export function sessionLabel(s: AgentSessionSnapshot): string {
  return (s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8)).slice(0, 60);
}

/** Group key of a session (the "kind" grouping splits each piece instead). */
export function groupOf(s: AgentSessionSnapshot, by: TBy): string {
  switch (by) {
    case 'provider':
      return PROV[s.provider] ?? s.provider;
    case 'model':
      return prettyModelName(s.model) || '(model not recorded)';
    case 'repo':
      return base(s.repository) || base(s.cwd) || '(no repo)';
    case 'session':
      return s.key;
    case 'kind':
      return 'kind';
  }
}

export interface RhythmOpts {
  period: TPeriod;
  now: number;
  gran: TGran;
  by: TBy;
  metric: TMetric;
  leadsOnly?: boolean;
  /** Place untimed remainders at the session's last activity (default: count apart, keep off the axis). */
  untimed?: boolean;
  /** Stacks kept before folding into "other" (default 8). */
  maxStacks?: number;
  /** Bucket cap; the latest buckets are kept (default 720). */
  maxBuckets?: number;
}

export interface Stack {
  key: string;
  label: string;
  values: number[];
  total: number;
  sessions: number;
}

export interface Peak {
  at: number;
  value: number;
  /** Largest stack in that bucket. */
  top: string;
  topValue: number;
}

export interface SessionRow {
  key: string;
  label: string;
  tokens: number;
  output: number;
  prompt: number;
  calls: number;
  firstAt?: number;
  lastAt?: number;
  /** Highest one-minute sum of this session's calls in the period. DERIVED. */
  peakMin: number;
  /** tokens / minutes between first and last call (≥ 1 min). DERIVED. */
  ratePerMin: number;
  untimed: number;
}

export interface Rhythm {
  x: number[];
  gran: TGran;
  stacks: Stack[];
  /** Per-bucket total over all stacks. */
  totals: number[];
  /** Metric total on the axis (timed pieces, plus untimed when placed). */
  total: number;
  timedTotal: number;
  /** Untimed remainder in the period (metric), and sessions carrying one. */
  untimed: { value: number; sessions: number };
  calls: number;
  sessions: number;
  peaks: Peak[];
  /** Metric in the last 5 minutes / 5, and over the last 60 minutes / 60. DERIVED. */
  ratePerMin5: number;
  ratePerMin60: number;
  rows: SessionRow[];
  /** Buckets dropped by the cap (oldest first). */
  clipped: number;
}

export function periodStart(p: TPeriod, now: number): number {
  return PERIOD_MS[p] === Infinity ? -Infinity : now - PERIOD_MS[p];
}

/** Token rhythm over the period: stacked buckets, peaks, rates and a per-session table. */
export function rhythm(sessions: AgentSessionSnapshot[], o: RhythmOpts): Rhythm {
  const since = periodStart(o.period, o.now);
  const list = sessions.filter(s => !o.leadsOnly || !s.isWorker);
  type Raw = { key: string; at: number; v: number; sk: string };
  const raw: Raw[] = [];
  const rows = new Map<string, SessionRow>();
  const labels = new Map<string, string>();
  let untimedV = 0, calls = 0, timedTotal = 0, first = Infinity;
  const untimedS = new Set<string>();
  const minuteSums = new Map<string, Map<number, number>>();
  let last5 = 0, last60 = 0;
  for (const s of list) {
    const g = groupOf(s, o.by);
    if (o.by === 'session') labels.set(s.key, sessionLabel(s));
    for (const p of tokenPieces(s)) {
      if (p.at < since || p.at > o.now + MIN) continue;
      const v = metricOf(p, o.metric);
      const row = rows.get(s.key) ?? { key: s.key, label: sessionLabel(s), tokens: 0, output: 0, prompt: 0, calls: 0, peakMin: 0, ratePerMin: 0, untimed: 0 };
      rows.set(s.key, row);
      if (!p.timed) {
        untimedV += v;
        row.untimed += v;
        if (v > 0) untimedS.add(s.key);
        if (!o.untimed) continue;
      } else {
        calls++;
        row.calls++;
        timedTotal += v;
        row.firstAt = Math.min(row.firstAt ?? p.at, p.at);
        row.lastAt = Math.max(row.lastAt ?? p.at, p.at);
        const mk = Math.floor(p.at / MIN);
        const ms = minuteSums.get(s.key) ?? new Map<number, number>();
        ms.set(mk, (ms.get(mk) ?? 0) + v);
        minuteSums.set(s.key, ms);
        if (p.at > o.now - 5 * MIN) last5 += v;
        if (p.at > o.now - HOUR) last60 += v;
      }
      row.tokens += p.prompt + p.output;
      row.prompt += p.prompt;
      row.output += p.output;
      if (o.by === 'kind') {
        if (o.metric !== 'output' && p.prompt) raw.push({ key: 'prompt', at: p.at, v: p.prompt, sk: s.key });
        if (o.metric !== 'prompt' && p.output) raw.push({ key: 'output', at: p.at, v: p.output, sk: s.key });
      } else if (v > 0) raw.push({ key: g, at: p.at, v, sk: s.key });
      if (p.at < first) first = p.at;
    }
  }
  for (const [k, ms] of minuteSums) {
    const r = rows.get(k)!;
    r.peakMin = Math.max(0, ...ms.values());
    const span = Math.max(1, ((r.lastAt ?? 0) - (r.firstAt ?? 0)) / MIN);
    r.ratePerMin = metricOf(r, o.metric) / span;
  }
  // buckets
  const cap = o.maxBuckets ?? 720;
  let lo0 = tBucketStart(Number.isFinite(since) ? since : first === Infinity ? o.now : first, o.gran);
  const x: number[] = [];
  let clipped = 0;
  const f = FIXED[o.gran];
  if (f) {
    // fixed buckets: jump straight to the latest `cap` buckets
    const minLo = tBucketStart(o.now, o.gran) - (cap - 1) * f;
    if (lo0 < minLo) {
      clipped = Math.round((minLo - lo0) / f);
      lo0 = minLo;
    }
  }
  for (let t = lo0; t <= o.now; t = tNext(t, o.gran)) {
    x.push(t);
    if (x.length > cap) {
      x.shift();
      clipped++;
    }
  }
  if (!x.length) x.push(tBucketStart(o.now, o.gran));
  const lo = x[0];
  const index = new Map(x.map((t, i) => [t, i]));
  const idx = (t: number) => index.get(tBucketStart(t, o.gran)) ?? (t >= x[x.length - 1] ? x.length - 1 : -1);
  // stacks: rank groups by total, keep top N, fold the rest into "other"
  const tot = new Map<string, number>();
  const sess = new Map<string, Set<string>>();
  for (const r of raw) {
    if (r.at < lo) continue;
    tot.set(r.key, (tot.get(r.key) ?? 0) + r.v);
    const ss = sess.get(r.key) ?? new Set<string>();
    ss.add(r.sk);
    sess.set(r.key, ss);
  }
  const ranked = [...tot.keys()].sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0) || a.localeCompare(b));
  if (o.by === 'kind') ranked.sort((a, b) => (a === 'prompt' ? -1 : 1) - (b === 'prompt' ? -1 : 1));
  const maxStacks = o.maxStacks ?? 8;
  const keep = ranked.slice(0, maxStacks);
  const keepSet = new Set(keep);
  const stacks = new Map<string, Stack>();
  for (const k of keep) stacks.set(k, { key: k, label: labels.get(k) ?? k, values: new Array(x.length).fill(0), total: 0, sessions: sess.get(k)?.size ?? 0 });
  const rest = ranked.slice(maxStacks);
  if (rest.length) {
    const ss = new Set(rest.flatMap(k => [...(sess.get(k) ?? [])]));
    stacks.set('other', { key: 'other', label: `other (${rest.length})`, values: new Array(x.length).fill(0), total: 0, sessions: ss.size });
  }
  let total = 0;
  for (const r of raw) {
    if (r.at < lo) continue;
    const i = idx(r.at);
    if (i < 0) continue;
    const st = stacks.get(keepSet.has(r.key) ? r.key : 'other')!;
    st.values[i] += r.v;
    st.total += r.v;
    total += r.v;
  }
  const out = [...stacks.values()];
  const totals = x.map((_, i) => out.reduce((a, st) => a + st.values[i], 0));
  const peaks = totals
    .map((v, i) => ({ v, i }))
    .filter(p => p.v > 0)
    .sort((a, b) => b.v - a.v || b.i - a.i)
    .slice(0, 5)
    .map(({ v, i }) => {
      const top = out.reduce((m, st) => (st.values[i] > m.values[i] ? st : m), out[0]);
      return { at: x[i], value: v, top: top.label, topValue: top.values[i] };
    });
  const rowList = [...rows.values()].filter(r => r.tokens > 0 || r.untimed > 0).sort((a, b) => metricOf(b, o.metric) - metricOf(a, o.metric) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return {
    x, gran: o.gran, stacks: out, totals, total, timedTotal,
    untimed: { value: untimedV, sessions: untimedS.size },
    calls, sessions: rowList.length, peaks,
    ratePerMin5: last5 / 5, ratePerMin60: last60 / 60,
    rows: rowList, clipped,
  };
}

/** Running sum of a series. */
export function cumulative(values: number[]): number[] {
  let run = 0;
  return values.map(v => (run += v));
}

export interface CtxPoint {
  at: number;
  /** Prompt tokens of the call: what the model read, i.e. context held (OBSERVED). */
  tokens: number;
  /** DERIVED: prompt size fell by ≥ 40 % from the previous call (likely compaction or a fresh context). */
  drop: boolean;
}

export interface CtxLine {
  key: string;
  label: string;
  provider: string;
  points: CtxPoint[];
  window?: number;
  live: boolean;
  max: number;
  last: number;
}

/** Context growth: prompt size of each recorded call over the period, per session. */
export function contextLines(sessions: AgentSessionSnapshot[], o: { period: TPeriod; now: number; maxPoints?: number }): CtxLine[] {
  const since = periodStart(o.period, o.now);
  const cap = o.maxPoints ?? 400;
  const out: CtxLine[] = [];
  for (const s of sessions) {
    const calls = (s.facts?.calls ?? []).filter(c => Number.isFinite(c[0]) && c[0] >= since && c[1] > 0).sort((a, b) => a[0] - b[0]);
    if (!calls.length) continue;
    let pts: CtxPoint[] = [];
    let prev = 0;
    for (const [at, p] of calls) {
      pts.push({ at, tokens: p, drop: prev > 0 && p < prev * 0.6 });
      prev = p;
    }
    if (pts.length > cap) {
      // keep drops and evenly spaced points, always the last one
      const step = pts.length / cap;
      const keep = new Set<number>();
      for (let i = 0; i < cap; i++) keep.add(Math.floor(i * step));
      keep.add(pts.length - 1);
      pts = pts.filter((p, i) => keep.has(i) || p.drop);
    }
    out.push({
      key: s.key, label: sessionLabel(s), provider: s.provider, points: pts, window: s.usage?.contextWindow,
      live: isLive(s), max: Math.max(...pts.map(p => p.tokens)), last: pts[pts.length - 1].tokens,
    });
  }
  return out;
}

/** Option-safe id for a stack key (reuses the Explore slug). */
export const stackSlug = slug;

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Long-form CSV of a rhythm: bucket start (ISO), group key, value. Keys (session keys, not titles) and numbers only. */
export function rhythmCsv(r: Rhythm, metric: TMetric): string {
  const lines = [`bucket_start,group,${metric}_tokens`];
  r.x.forEach((t, i) => {
    for (const st of r.stacks) if (st.values[i]) lines.push([new Date(t).toISOString(), csvCell(st.key === 'other' ? st.label : st.key), String(Math.round(st.values[i]))].join(','));
  });
  return lines.join('\n') + '\n';
}
