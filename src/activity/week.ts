// Week calendar projection: turns sessions + observed event times into activity blocks per local day.
// Pure and deterministic (no Date.now, no I/O). Blocks are DERIVED from OBSERVED times: a session is split
// wherever no activity was recorded for longer than `gapMs`. A session with no intermediate observation is a
// single span from first to last recorded activity, marked INFERRED.
import { AgentSessionSnapshot, EvidenceKind, TimelineEvent } from '../model';
import { isLive } from './insights';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/** Local midnight of the Monday of t's week (+ offset weeks). */
export function weekStart(t: number, offsetWeeks = 0): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - back + offsetWeeks * 7);
  return d.getTime();
}

/** Local midnight of t's day (+ offset days). DST safe (calendar arithmetic, not ms). */
export function dayAt(t: number, offsetDays = 0): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

export interface Span {
  a: number;
  b: number;
  kind: EvidenceKind;
}

/** Observed activity times of one session (events, commits, tests, model calls, file edits, spawns). */
export function activityTimes(s: AgentSessionSnapshot, events: TimelineEvent[]): number[] {
  const t: number[] = [];
  if (s.startedAt) t.push(s.startedAt);
  if (s.lastActivityAt) t.push(s.lastActivityAt);
  for (const e of events) t.push(e.at);
  for (const c of s.commits) t.push(c.at);
  for (const x of s.tests) t.push(x.at);
  const f = s.facts;
  if (f?.calls) for (const c of f.calls) t.push(c[0]);
  if (f?.spawns) for (const x of f.spawns) t.push(x.at);
  if (f?.files) for (const x of f.files) t.push(x.lastAt);
  const lo = s.startedAt ?? -Infinity, hi = s.endedAt ?? Infinity;
  return [...new Set(t.filter(x => Number.isFinite(x) && x > 0 && x >= lo - 60_000 && x <= hi + 60_000))].sort((a, b) => a - b);
}

/** Splits observed times into spans at gaps longer than gapMs. A live session's last span runs to now. */
export function spans(times: number[], gapMs: number, live: boolean, now: number, minMs = 60_000): Span[] {
  if (!times.length) return [];
  const out: Span[] = [];
  const inferred = times.length <= 2;
  if (inferred) out.push({ a: times[0], b: times[times.length - 1], kind: 'INFERRED' });
  else {
    let a = times[0], b = times[0];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - b > gapMs) {
        out.push({ a, b, kind: 'DERIVED' });
        a = times[i];
      }
      b = times[i];
    }
    out.push({ a, b, kind: 'DERIVED' });
  }
  const last = out[out.length - 1];
  if (live && now > last.b && now - last.b <= gapMs) last.b = now;
  for (const s of out) if (s.b - s.a < minMs) s.b = s.a + minMs;
  return out;
}

export interface WeekBlock {
  key: string;
  /** Index of the day column / row (0-based from `from`). */
  day: number;
  a: number;
  b: number;
  kind: EvidenceKind;
  /** Lane within overlapping blocks of the same day and how many lanes the overlap cluster needs. */
  lane: number;
  lanes: number;
  /** This block holds the session's latest activity and the session is live. */
  live: boolean;
  /** First / last fragment of a span cut at midnight (for rounded corners and continuation marks). */
  cutStart: boolean;
  cutEnd: boolean;
  commits: { at: number; sha: string; subject: string }[];
  tests: { at: number; outcome: string }[];
  /** gh pr create / glab mr create commands observed in this block. */
  prs: number;
}

export interface WeekOptions {
  from: number;
  days: number;
  gapMs: number;
  now: number;
  workers?: boolean;
}

export interface DaySummary {
  day: number;
  start: number;
  sessions: number;
  activeMs: number;
  commits: number;
  peak: number;
}

const PR_RE = /\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/;

/** Day boundaries from `from` (calendar days, DST safe). */
export function dayStarts(from: number, days: number): number[] {
  return Array.from({ length: days + 1 }, (_, i) => dayAt(from, i));
}

export function weekBlocks(sessions: AgentSessionSnapshot[], events: TimelineEvent[], o: WeekOptions): WeekBlock[] {
  const bounds = dayStarts(o.from, o.days);
  const to = bounds[o.days];
  const byKey = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const l = byKey.get(e.sessionKey);
    if (l) l.push(e);
    else byKey.set(e.sessionKey, [e]);
  }
  const out: WeekBlock[] = [];
  for (const s of sessions) {
    if (s.isWorker && !o.workers) continue;
    const first = s.startedAt ?? s.lastActivityAt;
    const last = isLive(s) ? o.now : (s.lastActivityAt ?? s.startedAt);
    if (!first || !last || last < o.from || first >= to) continue;
    const ev = byKey.get(s.key) ?? [];
    const live = isLive(s);
    const sp = spans(activityTimes(s, ev), o.gapMs, live, o.now);
    const prTimes = ev.filter(e => PR_RE.test(e.label)).map(e => e.at);
    sp.forEach((x, si) => {
      const isLastSpan = si === sp.length - 1;
      for (let d = 0; d < o.days; d++) {
        const lo = bounds[d], hi = bounds[d + 1];
        if (x.b <= lo || x.a >= hi) continue;
        const a = Math.max(x.a, lo), b = Math.min(x.b, hi);
        const inBlock = (t: number) => t >= a - 1 && t <= b + 1;
        out.push({
          key: s.key,
          day: d,
          a,
          b,
          kind: x.kind,
          lane: 0,
          lanes: 1,
          live: live && isLastSpan && b >= Math.min(o.now, hi) - 1,
          cutStart: x.a < lo,
          cutEnd: x.b > hi,
          commits: s.commits.filter(c => inBlock(c.at)).map(c => ({ at: c.at, sha: c.sha, subject: c.subject })),
          tests: s.tests.filter(t => inBlock(t.at)).map(t => ({ at: t.at, outcome: t.outcome })),
          prs: prTimes.filter(inBlock).length,
        });
      }
    });
  }
  layoutLanes(out);
  return out;
}

/** Greedy interval colouring per day; every block of one overlap cluster shares the cluster's lane count. */
export function layoutLanes(blocks: WeekBlock[]): void {
  const days = new Map<number, WeekBlock[]>();
  for (const b of blocks) days.set(b.day, [...(days.get(b.day) ?? []), b]);
  for (const list of days.values()) {
    list.sort((x, y) => x.a - y.a || y.b - x.b);
    let cluster: WeekBlock[] = [];
    let clusterEnd = -Infinity;
    const laneEnd: number[] = [];
    const close = () => {
      const n = Math.max(1, ...cluster.map(c => c.lane + 1));
      for (const c of cluster) c.lanes = n;
      cluster = [];
      laneEnd.length = 0;
    };
    for (const b of list) {
      if (b.a >= clusterEnd && cluster.length) close();
      let lane = laneEnd.findIndex(e => e <= b.a);
      if (lane < 0) lane = laneEnd.length;
      laneEnd[lane] = b.b;
      b.lane = lane;
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.b);
    }
    if (cluster.length) close();
  }
}

/** Maximum number of blocks overlapping at one instant (sweep line). */
export function peakConcurrency(blocks: { a: number; b: number }[]): number {
  const pts = blocks.flatMap(b => [[b.a, 1], [b.b, -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let n = 0, max = 0;
  for (const [, d] of pts) max = Math.max(max, (n += d));
  return max;
}

/** Per day: distinct sessions, active time (union of blocks, no double count), commits, peak concurrency. */
export function daySummaries(blocks: WeekBlock[], from: number, days: number): DaySummary[] {
  const bounds = dayStarts(from, days);
  return Array.from({ length: days }, (_, d) => {
    const list = blocks.filter(b => b.day === d).sort((x, y) => x.a - y.a);
    let active = 0, curA = -1, curB = -1;
    for (const b of list) {
      if (b.a > curB) {
        if (curB > curA) active += curB - curA;
        curA = b.a;
        curB = b.b;
      } else curB = Math.max(curB, b.b);
    }
    if (curB > curA) active += curB - curA;
    const shas = new Set(list.flatMap(b => b.commits.map(c => c.sha)));
    return { day: d, start: bounds[d], sessions: new Set(list.map(b => b.key)).size, activeMs: active, commits: shas.size, peak: peakConcurrency(list) };
  });
}

/** First and last hour (0..24) that hold any block, padded by one hour; [0, 24] when empty. */
export function activeHours(blocks: WeekBlock[], bounds: number[]): [number, number] {
  if (!blocks.length) return [0, 24];
  let lo = 24, hi = 0;
  for (const b of blocks) {
    const base = bounds[b.day];
    const span = bounds[b.day + 1] - base;
    // Map onto a 24 h clock even across DST days.
    lo = Math.min(lo, Math.floor(((b.a - base) / span) * 24));
    hi = Math.max(hi, Math.ceil(((b.b - base) / span) * 24));
  }
  lo = Math.max(0, lo - 1);
  hi = Math.min(24, hi + 1);
  if (hi - lo < 6) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, Math.floor(mid - 3));
    hi = Math.min(24, lo + 6);
  }
  return [lo, hi];
}
