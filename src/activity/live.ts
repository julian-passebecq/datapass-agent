// "Who does what right now": live sessions and workers with their current tool, pace and context.
// Pure projections over snapshots. Rates come only from provider-recorded model calls (facts.calls).
import { AgentSessionSnapshot } from '../model';
import { isLive } from './insights';
import { matchSpawns } from './topology';

export type LiveSort = 'activity' | 'rate' | 'status' | 'start' | 'tokens';

export interface LiveOpts {
  now: number;
  /** Rate window (ms) for tokens / min. */
  windowMs?: number;
  /** Also include sessions that ended within this many ms (0 = live only). */
  recentMs?: number;
  /** Spark buckets (one per minute). */
  sparkMinutes?: number;
  sort?: LiveSort;
}

export interface LiveRow {
  s: AgentSessionSnapshot;
  live: boolean;
  /** 0 = lead / standalone, 1+ = worker nesting below a row in this list. */
  depth: number;
  /** Tool call with no recorded result yet (OBSERVED), with elapsed ms (DERIVED). */
  tool?: { name: string; detail: string; elapsedMs: number };
  /** Total (prompt + output) and output tokens per minute over the window, from recorded calls. undefined = no call data. */
  rate?: number;
  outRate?: number;
  /** Model calls in the window. */
  callsInWindow: number;
  /** Tokens per minute bucket, oldest first (sparkMinutes buckets). */
  spark: number[];
  /** Context fill: tokens of the latest call, % only when the provider recorded the window. */
  ctxTokens?: number;
  ctxPct?: number;
  prompts?: number;
  files: number;
  /** Live / total workers recorded below this session. */
  workersLive: number;
  workersTotal: number;
  /** Spawn description of the parent call that probably started this worker (INFERRED). */
  spawn?: string;
  /** Time since the latest recorded activity. */
  idleMs?: number;
}

export interface LiveTotals {
  /** Every live session, leads and workers. */
  agents: number;
  /** Live non-worker sessions (human conversations). */
  conversations: number;
  workers: number;
  running: number;
  needsInput: number;
  idle: number;
  byProvider: Record<string, number>;
  /** Sum of row rates (only rows with call data) and how many rows contributed. */
  rate: number;
  outRate: number;
  rateRows: number;
  /** Tools in flight right now. */
  toolsInFlight: number;
  repos: number;
}

const MIN = 60_000;
const STATUS_ORDER: Record<string, number> = { NEEDS_INPUT: 0, RUNNING: 1, IDLE: 2, UNKNOWN: 3, ENDED: 4 };

/** Tokens per minute over [now - windowMs, now] from recorded calls. */
export function rateOf(s: AgentSessionSnapshot, now: number, windowMs: number): { rate?: number; outRate?: number; calls: number } {
  const calls = s.facts?.calls;
  if (!calls) return { calls: 0 };
  const from = now - windowMs;
  let tot = 0;
  let out = 0;
  let n = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const [at, p, o] = calls[i];
    if (at > now) continue;
    if (at < from) break;
    tot += p + o;
    out += o;
    n++;
  }
  const mins = windowMs / MIN;
  return { rate: tot / mins, outRate: out / mins, calls: n };
}

/** Per-minute token buckets, oldest first. */
export function spark(s: AgentSessionSnapshot, now: number, minutes: number): number[] {
  const b = new Array<number>(minutes).fill(0);
  const calls = s.facts?.calls;
  if (!calls) return b;
  const from = now - minutes * MIN;
  for (let i = calls.length - 1; i >= 0; i--) {
    const [at, p, o] = calls[i];
    if (at > now) continue;
    if (at < from) break;
    const k = Math.min(minutes - 1, Math.floor((at - from) / MIN));
    b[k] += p + o;
  }
  return b;
}

function row(s: AgentSessionSnapshot, now: number, o: Required<Pick<LiveOpts, 'windowMs' | 'sparkMinutes'>>, all: AgentSessionSnapshot[], depth: number): LiveRow {
  const live = isLive(s);
  const ct = live ? s.facts?.currentTool : undefined;
  const r = rateOf(s, now, o.windowMs);
  const u = s.usage;
  const kids = all.filter(k => k.parentSessionId === s.key);
  return {
    s,
    live,
    depth,
    tool: ct ? { name: ct.name, detail: ct.detail, elapsedMs: Math.max(0, now - ct.startedAt) } : undefined,
    rate: r.rate,
    outRate: r.outRate,
    callsInWindow: r.calls,
    spark: spark(s, now, o.sparkMinutes),
    ctxTokens: u?.contextTokens,
    ctxPct: u?.contextTokens && u.contextWindow ? Math.min(100, (100 * u.contextTokens) / u.contextWindow) : undefined,
    prompts: s.facts?.prompts,
    files: s.facts?.files?.length ?? s.changedFiles.length,
    workersLive: kids.filter(isLive).length,
    workersTotal: kids.length,
    idleMs: s.lastActivityAt !== undefined ? Math.max(0, now - s.lastActivityAt) : undefined,
  };
}

function sortKey(sort: LiveSort): (a: LiveRow, b: LiveRow) => number {
  const act = (r: LiveRow) => r.s.lastActivityAt ?? 0;
  switch (sort) {
    case 'rate':
      return (a, b) => (b.rate ?? -1) - (a.rate ?? -1) || act(b) - act(a);
    case 'status':
      return (a, b) => (STATUS_ORDER[a.s.status] ?? 9) - (STATUS_ORDER[b.s.status] ?? 9) || act(b) - act(a);
    case 'start':
      return (a, b) => (b.s.startedAt ?? 0) - (a.s.startedAt ?? 0);
    case 'tokens':
      return (a, b) => (b.s.usage?.totalTokens ?? 0) - (a.s.usage?.totalTokens ?? 0) || act(b) - act(a);
    default:
      return (a, b) => Number(b.live) - Number(a.live) || act(b) - act(a);
  }
}

function shown(s: AgentSessionSnapshot, now: number, recentMs: number): boolean {
  if (isLive(s)) return true;
  if (!recentMs) return false;
  const end = s.endedAt ?? s.lastActivityAt;
  return end !== undefined && now - end <= recentMs;
}

/**
 * Rows for every shown session. With nest = true, workers follow their parent (depth + 1) when the parent is
 * shown too; a worker whose parent is not shown appears at depth 0. With nest = false the list is flat.
 */
export function liveRows(sessions: AgentSessionSnapshot[], opts: LiveOpts, nest = true): LiveRow[] {
  const now = opts.now;
  const o = { windowMs: opts.windowMs ?? 5 * MIN, sparkMinutes: opts.sparkMinutes ?? 15 };
  const recentMs = opts.recentMs ?? 0;
  const cmp = sortKey(opts.sort ?? 'activity');
  const pick = sessions.filter(s => shown(s, now, recentMs));
  if (!nest) return pick.map(s => row(s, now, o, sessions, 0)).sort(cmp);
  const keys = new Set(pick.map(s => s.key));
  const byParent = new Map<string, AgentSessionSnapshot[]>();
  for (const s of pick) {
    if (s.parentSessionId && keys.has(s.parentSessionId)) {
      const l = byParent.get(s.parentSessionId) ?? [];
      l.push(s);
      byParent.set(s.parentSessionId, l);
    }
  }
  const out: LiveRow[] = [];
  const seen = new Set<string>();
  const visit = (r: LiveRow) => {
    if (seen.has(r.s.key)) return;
    seen.add(r.s.key);
    out.push(r);
    const kids = byParent.get(r.s.key);
    if (!kids || r.depth > 8) return;
    const spawns = matchSpawns(r.s, kids);
    for (const k of kids.map(k => row(k, now, o, sessions, r.depth + 1)).sort(cmp)) {
      k.spawn = spawns.get(k.s.key);
      visit(k);
    }
  };
  const roots = pick.filter(s => !(s.parentSessionId && keys.has(s.parentSessionId))).map(s => row(s, now, o, sessions, 0)).sort(cmp);
  for (const r of roots) visit(r);
  // Cycles (never expected): anything not reached yet goes at the end, flat.
  for (const s of pick) if (!seen.has(s.key)) out.push(row(s, now, o, sessions, 0));
  return out;
}

export function liveTotals(rows: LiveRow[], repoOf: (s: AgentSessionSnapshot) => string): LiveTotals {
  const t: LiveTotals = { agents: 0, conversations: 0, workers: 0, running: 0, needsInput: 0, idle: 0, byProvider: {}, rate: 0, outRate: 0, rateRows: 0, toolsInFlight: 0, repos: 0 };
  const repos = new Set<string>();
  for (const r of rows) {
    if (!r.live) continue;
    t.agents++;
    if (r.s.isWorker) t.workers++;
    else t.conversations++;
    if (r.s.status === 'RUNNING') t.running++;
    else if (r.s.status === 'NEEDS_INPUT') t.needsInput++;
    else if (r.s.status === 'IDLE') t.idle++;
    t.byProvider[r.s.provider] = (t.byProvider[r.s.provider] ?? 0) + 1;
    if (r.rate !== undefined) {
      t.rate += r.rate;
      t.outRate += r.outRate ?? 0;
      t.rateRows++;
    }
    if (r.tool) t.toolsInFlight++;
    repos.add(repoOf(r.s));
  }
  t.repos = repos.size;
  return t;
}

/** Groups rows into lanes by a key, lanes ordered by live count then name. Rows keep their order. */
export function lanes(rows: LiveRow[], keyOf: (r: LiveRow) => string): [string, LiveRow[]][] {
  const m = new Map<string, LiveRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const l = m.get(k) ?? [];
    l.push(r);
    m.set(k, l);
  }
  return [...m].sort((a, b) => b[1].filter(r => r.live).length - a[1].filter(r => r.live).length || a[0].localeCompare(b[0]));
}
