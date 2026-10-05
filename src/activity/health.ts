// Health: test pass rate, commits per session, context use and tool errors, overall, per group and over time.
// Pure functions of snapshots. Counts are provider-recorded (OBSERVED); rates and averages are DERIVED.
// A context window is OBSERVED when the provider records it (Codex token_count); otherwise the reference
// window from the setting `agent.health.contextWindow` is used and labelled as such.
import type { AgentSessionSnapshot, EvidenceKind } from '../model';
import { bucketStart, Gran, inPeriod, Period, periodStart } from './explore';
import { base } from './insights';

export const DEFAULT_WINDOW = 272_000;
export const GROUPS = ['session', 'repo', 'provider', 'model'] as const;
export type HealthGroup = (typeof GROUPS)[number];

export interface CtxInfo {
  /** Prompt size of the latest model call. */
  now?: number;
  /** Largest prompt size recorded (latest call when no per-call record). */
  peak?: number;
  window: number;
  /** OBSERVED: provider-recorded window. setting: reference window from agent.health.contextWindow. */
  windowSource: 'OBSERVED' | 'setting';
  /** now / window, 0–1+ (may exceed 1 when the reference window is smaller than the real one). */
  pct?: number;
  peakPct?: number;
  /** Peak prompt size reached or passed the reference marker. */
  overMarker: boolean;
  compactions: number;
}

export function ctxInfo(s: AgentSessionSnapshot, marker = DEFAULT_WINDOW): CtxInfo {
  const u = s.usage;
  const calls = s.facts?.calls ?? [];
  const now = u?.contextTokens ?? (calls.length ? calls[calls.length - 1][1] : undefined);
  let peak = now;
  for (const c of calls) if (peak === undefined || c[1] > peak) peak = c[1];
  const window = u?.contextWindow && u.contextWindow > 0 ? u.contextWindow : marker;
  const windowSource = u?.contextWindow && u.contextWindow > 0 ? 'OBSERVED' : 'setting';
  return {
    now,
    peak,
    window,
    windowSource,
    pct: now !== undefined && window > 0 ? now / window : undefined,
    peakPct: peak !== undefined && window > 0 ? peak / window : undefined,
    overMarker: peak !== undefined && peak >= marker,
    compactions: s.facts?.compactions ?? 0,
  };
}

/** Token count with one decimal under 100k: 17.5k, 272k, 1.2M. */
export function tok(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e5) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "17.5k / 272k · 6 %" */
export function ctxLabel(c: CtxInfo, which: 'now' | 'peak' = 'now'): string {
  const v = which === 'now' ? c.now : c.peak;
  const p = which === 'now' ? c.pct : c.peakPct;
  if (v === undefined) return '—';
  return `${tok(v)} / ${tok(c.window)} · ${Math.round(100 * (p ?? 0))} %`;
}

/** Context sizes over the session's model calls, downsampled to at most `n` points (max per slice). */
export function ctxSeries(s: AgentSessionSnapshot, n = 40): number[] {
  const calls = s.facts?.calls ?? [];
  if (!calls.length) return s.usage?.contextTokens ? [s.usage.contextTokens] : [];
  if (calls.length <= n) return calls.map(c => c[1]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * calls.length) / n), b = Math.floor(((i + 1) * calls.length) / n);
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, calls[k][1]);
    out.push(m);
  }
  return out;
}

export interface HealthRow {
  key: string;
  label: string;
  sessions: string[];
  pass: number;
  fail: number;
  unknownTests: number;
  /** pass / (pass + fail); undefined with no decided test. */
  passRate?: number;
  /** Sessions that ran at least one decided test. */
  tested: number;
  commits: number;
  /** Lead sessions only (workers' commits are counted against their lead's window anyway). */
  leads: number;
  commitsPerSession?: number;
  ctxNow?: number;
  ctxPeak?: number;
  /** Mean of per-session peak / window over sessions with a context record. */
  avgPeakPct?: number;
  maxPeakPct?: number;
  overMarker: number;
  compactions: number;
  tools: number;
  toolErrors: number;
  toolErrorRate?: number;
  lastAt: number;
  /** Set for session rows. */
  ctx?: CtxInfo;
  series?: number[];
}

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

function prettyModel(m: string | undefined): string {
  if (!m) return '(not recorded)';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

export function groupKey(s: AgentSessionSnapshot, g: HealthGroup): string {
  if (g === 'session') return s.key;
  if (g === 'repo') return base(s.repository) || base(s.cwd) || '(no repo)';
  if (g === 'provider') return PROV[s.provider] ?? s.provider;
  return prettyModel(s.model);
}

function toolTotal(s: AgentSessionSnapshot): number {
  const tc = s.facts?.toolCounts;
  return tc ? Object.values(tc).reduce((a, b) => a + b, 0) : s.counts.tools;
}

export interface HealthOpts {
  period: Period;
  now: number;
  leadsOnly?: boolean;
  marker?: number;
}

/** Tests and commits are counted when they happened inside the period; context is per session. */
export function healthRows(sessions: AgentSessionSnapshot[], group: HealthGroup, o: HealthOpts): HealthRow[] {
  return aggregate(inPeriod(sessions, o), s => groupKey(s, group), group === 'session', o);
}

/** Totals over every session of the period (same arithmetic, one group). */
export function healthTotal(sessions: AgentSessionSnapshot[], o: HealthOpts): HealthRow {
  return aggregate(inPeriod(sessions, o), () => 'All', false, o)[0] ?? { key: 'All', label: 'All', sessions: [], pass: 0, fail: 0, unknownTests: 0, tested: 0, commits: 0, leads: 0, overMarker: 0, compactions: 0, tools: 0, toolErrors: 0, lastAt: 0 };
}

function aggregate(list: AgentSessionSnapshot[], keyOf: (s: AgentSessionSnapshot) => string, perSession: boolean, o: HealthOpts): HealthRow[] {
  const since = periodStart(o.period, o.now);
  const marker = o.marker ?? DEFAULT_WINDOW;
  const m = new Map<string, HealthRow & { pctSum: number; pctN: number }>();
  for (const s of list) {
    const key = keyOf(s);
    const r = m.get(key) ?? { key, label: perSession ? s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8) : key, sessions: [], pass: 0, fail: 0, unknownTests: 0, tested: 0, commits: 0, leads: 0, overMarker: 0, compactions: 0, tools: 0, toolErrors: 0, lastAt: 0, pctSum: 0, pctN: 0 };
    r.sessions.push(s.key);
    let decided = 0;
    for (const t of s.tests) {
      if (t.at < since) continue;
      if (t.outcome === 'PASS') r.pass++, decided++;
      else if (t.outcome === 'FAIL') r.fail++, decided++;
      else r.unknownTests++;
    }
    if (decided) r.tested++;
    r.commits += s.commits.filter(c => c.at >= since).length;
    if (!s.isWorker) r.leads++;
    const c = ctxInfo(s, marker);
    if (c.now !== undefined) r.ctxNow = Math.max(r.ctxNow ?? 0, c.now);
    if (c.peak !== undefined) r.ctxPeak = Math.max(r.ctxPeak ?? 0, c.peak);
    if (c.peakPct !== undefined) {
      r.pctSum += c.peakPct;
      r.pctN++;
      r.maxPeakPct = Math.max(r.maxPeakPct ?? 0, c.peakPct);
    }
    if (c.overMarker) r.overMarker++;
    r.compactions += c.compactions;
    r.tools += toolTotal(s);
    r.toolErrors += s.facts?.toolErrors ?? 0;
    r.lastAt = Math.max(r.lastAt, s.lastActivityAt ?? s.startedAt ?? 0);
    if (perSession) {
      r.ctx = c;
      r.series = ctxSeries(s);
    }
    m.set(key, r);
  }
  return [...m.values()].map(({ pctSum, pctN, ...r }) => ({
    ...r,
    passRate: r.pass + r.fail ? r.pass / (r.pass + r.fail) : undefined,
    commitsPerSession: r.leads ? r.commits / r.leads : perSession ? r.commits : undefined,
    avgPeakPct: pctN ? pctSum / pctN : undefined,
    toolErrorRate: r.tools ? r.toolErrors / r.tools : undefined,
  }));
}

export const TREND_METRICS = ['pass', 'commits', 'context', 'tests'] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

export const TREND_INFO: Record<TrendMetric, { label: string; kind: EvidenceKind; basis: string }> = {
  pass: { label: 'Test pass rate', kind: 'DERIVED', basis: 'passing ÷ (passing + failing) test / build runs in the bucket; runs without a result are left out' },
  commits: { label: 'Commits / session', kind: 'DERIVED', basis: 'commits observed in the bucket ÷ lead sessions active in the bucket' },
  context: { label: 'Peak context', kind: 'DERIVED', basis: 'mean over sessions of the largest prompt recorded in the bucket ÷ window (recorded, else the reference window)' },
  tests: { label: 'Test runs', kind: 'OBSERVED', basis: 'test / build runs with a pass or fail result in the bucket' },
};

export interface Trend {
  x: number[];
  /** One value per bucket; undefined = no data in that bucket. */
  values: Record<TrendMetric, (number | undefined)[]>;
}

function addBucket(t: number, g: Gran): number {
  const span = g === 'hour' ? 3600_000 * 1.5 : g === 'day' ? 86400_000 * 1.5 : 86400_000 * 10;
  return bucketStart(t + span, g);
}

/** Buckets from the period start (or the first observation for "all") to now, capped at `maxBuckets` latest. */
export function healthTrend(sessions: AgentSessionSnapshot[], o: HealthOpts & { gran: Gran; maxBuckets?: number }): Trend {
  const list = inPeriod(sessions, o);
  const marker = o.marker ?? DEFAULT_WINDOW;
  let since = periodStart(o.period, o.now);
  if (!Number.isFinite(since)) since = Math.min(o.now, ...list.map(s => s.startedAt ?? s.lastActivityAt ?? o.now));
  const x: number[] = [];
  for (let b = bucketStart(since, o.gran); b <= o.now && x.length < 5000; b = addBucket(b, o.gran)) x.push(b);
  const cap = o.maxBuckets ?? 60;
  const xs = x.length > cap ? x.slice(-cap) : x;
  const idx = (t: number) => {
    const b = bucketStart(t, o.gran);
    let lo = 0, hi = xs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] === b) return mid;
      if (xs[mid] < b) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const n = xs.length;
  const pass = new Array<number>(n).fill(0), fail = new Array<number>(n).fill(0), commits = new Array<number>(n).fill(0);
  const active = Array.from({ length: n }, () => new Set<string>());
  const pctSum = new Array<number>(n).fill(0), pctN = new Array<number>(n).fill(0);
  for (const s of list) {
    for (const t of s.tests) {
      const i = idx(t.at);
      if (i < 0) continue;
      if (t.outcome === 'PASS') pass[i]++;
      else if (t.outcome === 'FAIL') fail[i]++;
    }
    for (const c of s.commits) {
      const i = idx(c.at);
      if (i >= 0) commits[i]++;
    }
    if (!s.isWorker) {
      const a = s.startedAt ?? s.lastActivityAt, z = s.lastActivityAt ?? s.startedAt;
      if (a !== undefined && z !== undefined) for (let i = 0; i < n; i++) if (xs[i] <= z && (i + 1 < n ? xs[i + 1] : Infinity) > a) active[i].add(s.key);
    }
    const window = s.usage?.contextWindow && s.usage.contextWindow > 0 ? s.usage.contextWindow : marker;
    const peaks = new Map<number, number>();
    for (const c of s.facts?.calls ?? []) {
      const i = idx(c[0]);
      if (i >= 0) peaks.set(i, Math.max(peaks.get(i) ?? 0, c[1]));
    }
    if (!s.facts?.calls?.length && s.usage?.contextTokens && s.lastActivityAt !== undefined) {
      const i = idx(s.lastActivityAt);
      if (i >= 0) peaks.set(i, s.usage.contextTokens);
    }
    for (const [i, p] of peaks) {
      pctSum[i] += p / window;
      pctN[i]++;
    }
  }
  return {
    x: xs,
    values: {
      pass: xs.map((_, i) => (pass[i] + fail[i] ? pass[i] / (pass[i] + fail[i]) : undefined)),
      commits: xs.map((_, i) => (active[i].size ? commits[i] / active[i].size : undefined)),
      context: xs.map((_, i) => (pctN[i] ? pctSum[i] / pctN[i] : undefined)),
      tests: xs.map((_, i) => (pass[i] + fail[i] ? pass[i] + fail[i] : undefined)),
    },
  };
}

export function pct(v: number | undefined, digits = 0): string {
  return v === undefined ? '—' : `${(100 * v).toFixed(digits)} %`;
}
