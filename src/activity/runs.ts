// Run strips (P6) and concurrency (P11). Pure and deterministic: no Date.now, no I/O.
// A "run" is one session. Its active spans are DERIVED from OBSERVED event times (same rule as the Week
// screen: split where nothing was recorded for longer than gapMs); its open interval runs from the first to
// the last recorded activity (to now while live). Concurrency counts overlapping spans per time bucket.
import { AgentSessionSnapshot, EvidenceKind, TimelineEvent } from '../model';
import { isLive, outcome, Outcome } from './insights';
import { activityTimes, dayAt, HOUR, peakConcurrency, Span, spans } from './week';

export type RowBy = 'repo' | 'provider' | 'model';

export interface Run {
  key: string;
  row: string;
  /** First and last recorded activity (last = now while live). */
  a: number;
  b: number;
  spans: Span[];
  /** Sum of active spans (DERIVED). */
  activeMs: number;
  outcome: Outcome;
  live: boolean;
  waiting: boolean;
  worker: boolean;
  commits: number;
  pass: number;
  fail: number;
  /** INFERRED when only a first and last record exist. */
  kind: EvidenceKind;
}

export interface RunRow {
  key: string;
  runs: Run[];
  counts: Record<Outcome, number>;
  /** Runs started per day of the range (index 0 = first day). */
  perDay: number[];
  /** Outcome counts per day of the range. */
  perDayOutcome: Record<Outcome, number>[];
  lastAt: number;
  activeMs: number;
  commits: number;
}

export interface RunOptions {
  from: number;
  to: number;
  now: number;
  gapMs: number;
  workers: boolean;
  by: RowBy;
  /** Row label of a session (injected so the renderer's repoOf / prettyModel stay the single source). */
  label: (s: AgentSessionSnapshot, by: RowBy) => string;
}

const emptyCounts = (): Record<Outcome, number> => ({ live: 0, committed: 0, changed: 0, nochange: 0 });

function indexEvents(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const m = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const l = m.get(e.sessionKey);
    if (l) l.push(e);
    else m.set(e.sessionKey, [e]);
  }
  return m;
}

/** One run per session whose open interval touches [from, to). */
export function buildRuns(sessions: AgentSessionSnapshot[], events: TimelineEvent[], o: Omit<RunOptions, 'by' | 'label'> & Partial<Pick<RunOptions, 'by' | 'label'>>): Run[] {
  const by = indexEvents(events);
  const out: Run[] = [];
  for (const s of sessions) {
    if (s.isWorker && !o.workers) continue;
    const live = isLive(s);
    const times = activityTimes(s, by.get(s.key) ?? []);
    if (!times.length) continue;
    const sp = spans(times, o.gapMs, live, o.now);
    const a = times[0];
    const b = Math.max(live ? o.now : times[times.length - 1], sp[sp.length - 1]?.b ?? a);
    if (b < o.from || a >= o.to) continue;
    out.push({
      key: s.key,
      row: o.label && o.by ? o.label(s, o.by) : '',
      a,
      b,
      spans: sp,
      activeMs: sp.reduce((n, x) => n + (x.b - x.a), 0),
      outcome: outcome(s),
      live,
      waiting: s.status === 'NEEDS_INPUT',
      worker: s.isWorker,
      commits: s.commits.length,
      pass: s.tests.filter(t => t.outcome === 'PASS').length,
      fail: s.tests.filter(t => t.outcome === 'FAIL').length,
      kind: times.length <= 2 ? 'INFERRED' : 'DERIVED',
    });
  }
  return out.sort((x, y) => x.a - y.a);
}

/** Groups runs into rows (most recent activity first). Days are calendar days from `from` (DST safe). */
export function runRows(runs: Run[], from: number, days: number): RunRow[] {
  const bounds = Array.from({ length: days + 1 }, (_, i) => dayAt(from, i));
  const dayOf = (t: number) => {
    for (let i = 0; i < days; i++) if (t >= bounds[i] && t < bounds[i + 1]) return i;
    return t < bounds[0] ? 0 : days - 1;
  };
  const rows = new Map<string, RunRow>();
  for (const r of runs) {
    let row = rows.get(r.row);
    if (!row) {
      row = { key: r.row, runs: [], counts: emptyCounts(), perDay: Array(days).fill(0), perDayOutcome: Array.from({ length: days }, emptyCounts), lastAt: 0, activeMs: 0, commits: 0 };
      rows.set(r.row, row);
    }
    row.runs.push(r);
    row.counts[r.outcome]++;
    const d = dayOf(Math.max(r.a, bounds[0]));
    row.perDay[d]++;
    row.perDayOutcome[d][r.outcome]++;
    row.lastAt = Math.max(row.lastAt, r.b);
    row.activeMs += r.activeMs;
    row.commits += r.commits;
  }
  return [...rows.values()].sort((x, y) => y.lastAt - x.lastAt || x.key.localeCompare(y.key));
}

/** Greedy lanes for overlapping run ticks within one row; lane >= maxLanes folds onto the last lane. */
export function tickLanes(runs: { a: number; b: number }[], maxLanes: number, minGap = 0): number[] {
  const end: number[] = [];
  return runs.map(r => {
    let lane = end.findIndex(e => e + minGap <= r.a);
    if (lane < 0) lane = end.length < maxLanes ? end.length : maxLanes - 1;
    end[lane] = Math.max(end[lane] ?? -Infinity, r.b);
    return lane;
  });
}

export interface Bucket {
  t0: number;
  t1: number;
  /** Most runs active at one instant (DERIVED, sweep over active spans). */
  peak: number;
  /** Mean number of active runs over the bucket (DERIVED, overlap time / bucket length). */
  avg: number;
  /** Most sessions open at one instant (first → last activity), active or not. */
  open: number;
  /** Keys of runs active at some point in the bucket. */
  keys: string[];
}

/** Bucket boundaries from `from` to `to`; hours and days use calendar arithmetic (DST safe). */
export function bucketStarts(from: number, to: number, gran: 'quarter' | 'hour' | 'day'): number[] {
  const out: number[] = [];
  const d = new Date(from);
  if (gran === 'day') d.setHours(0, 0, 0, 0);
  else if (gran === 'hour') d.setMinutes(0, 0, 0);
  else d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  for (let guard = 0; d.getTime() < to && guard < 5000; guard++) {
    out.push(d.getTime());
    if (gran === 'day') d.setDate(d.getDate() + 1);
    else if (gran === 'hour') d.setHours(d.getHours() + 1);
    else d.setMinutes(d.getMinutes() + 15);
  }
  out.push(d.getTime());
  return out;
}

function clip(list: { a: number; b: number }[], t0: number, t1: number): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  for (const x of list) if (x.b > t0 && x.a < t1) out.push({ a: Math.max(x.a, t0), b: Math.min(x.b, t1) });
  return out;
}

/** Concurrency per bucket over [from, to): peak and mean of active spans, peak of open sessions. */
export function concurrency(runs: Run[], from: number, to: number, gran: 'quarter' | 'hour' | 'day', now: number): Bucket[] {
  const starts = bucketStarts(from, to, gran);
  const act = runs.flatMap(r => r.spans.map(s => ({ a: s.a, b: s.b, key: r.key })));
  const open = runs.map(r => ({ a: r.a, b: r.b }));
  const out: Bucket[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const t0 = starts[i], t1 = starts[i + 1];
    const c = clip(act, t0, t1);
    const peak = peakConcurrency(c);
    // The bucket holding `now` is averaged over its elapsed part only.
    const len = Math.max(1, (now > t0 && now < t1 ? now : t1) - t0);
    out.push({
      t0,
      t1,
      peak,
      avg: c.reduce((n, x) => n + (x.b - x.a), 0) / len,
      open: Math.max(peak, peakConcurrency(clip(open, t0, t1))),
      keys: [...new Set(act.filter(x => x.b > t0 && x.a < t1).map(x => x.key))],
    });
  }
  return out;
}

export interface ConcSummary {
  peak: number;
  peakAt?: number;
  /** Buckets whose peak exceeds the target (0 when no target). */
  over: number;
  /** Buckets with any activity. */
  busy: number;
  /** Mean of bucket means over busy buckets. */
  avgBusy: number;
}

export function summarize(b: Bucket[], target: number): ConcSummary {
  let peak = 0, peakAt: number | undefined, over = 0, busy = 0, sum = 0;
  for (const x of b) {
    if (x.peak > peak) {
      peak = x.peak;
      peakAt = x.t0;
    }
    if (target > 0 && x.peak > target) over++;
    if (x.peak > 0) {
      busy++;
      sum += x.avg;
    }
  }
  return { peak, peakAt, over, busy, avgBusy: busy ? sum / busy : 0 };
}

/** Day × hour grid of peak concurrency for `days` calendar days ending with `now`'s day. */
export function hourGrid(runs: Run[], now: number, days: number): { day: number; cells: Bucket[] }[] {
  const out: { day: number; cells: Bucket[] }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d0 = dayAt(now, -i), d1 = dayAt(now, -i + 1);
    const cells = concurrency(runs, d0, d1, 'hour', now);
    out.push({ day: d0, cells });
  }
  return out;
}

export const GRAN_MS = { quarter: HOUR / 4, hour: HOUR, day: 24 * HOUR } as const;

/** Parses `agent.parallelTarget`: a non-negative integer ≤ 64, anything else is 0 (no target). */
export function parseTarget(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(64, Math.floor(n)) : 0;
}
