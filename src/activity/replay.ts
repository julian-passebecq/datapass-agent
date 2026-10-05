// Session replay: turns one session's recorded events (plus its workers') into playback steps, and keeps the
// transport state (play / pause / seek / speed) per session. Pure functions; no vscode import.
// Playback time is DERIVED from the recorded event times; nothing here is estimated or invented.
import type { AgentSessionSnapshot, EventType, EvidenceKind, TimelineEvent } from '../model';

/** Diagram node an event lights (besides its actor). */
export type Cat = 'life' | 'tools' | 'cmds' | 'files' | 'tests' | 'git';
export const CATS: Cat[] = ['tools', 'cmds', 'files', 'tests', 'git', 'life'];
export const CAT_LABEL: Record<Cat, string> = { life: 'Lifecycle', tools: 'Tools', cmds: 'Commands', files: 'Files', tests: 'Tests', git: 'Git / commits' };

export type Timing = 'even' | 'gaps' | 'real';
export type Show = 'all' | 'work' | 'milestones';

const CAT_OF: Record<EventType, Cat> = {
  SESSION_STARTED: 'life', SESSION_ACTIVITY: 'life', SESSION_ENDED: 'life', WORKER_STARTED: 'life', WORKER_ENDED: 'life',
  TOOL_ACTIVITY: 'tools', PROCESS_ACTIVITY: 'cmds', FILE_CHANGE: 'files', TEST: 'tests', GIT_CHANGE: 'git', COMMIT: 'git',
};

export function catOf(t: EventType): Cat {
  return CAT_OF[t] ?? 'life';
}

/** Categories whose events also touch the repository / worktree node. */
export function touchesRepo(c: Cat): boolean {
  return c === 'files' || c === 'git';
}

export interface Step {
  i: number;
  at: number;
  type: EventType;
  label: string;
  kind: EvidenceKind;
  cat: Cat;
  /** Index into actors (0 = the replayed session). */
  actor: number;
  /** Real gap to the previous step (ms), 0 for the first. */
  gapMs: number;
  /** Playback position at 1× (seconds from the first step). */
  p: number;
  /** For WORKER_STARTED: the worker actor it most likely spawned (INFERRED: nearest worker start after the call). */
  spawn?: number;
  /** TEST outcome parsed from the recorded label. */
  outcome?: 'PASS' | 'FAIL';
  /** Same-timestamp ordinal (seek anchor tiebreak). */
  ord: number;
}

export interface Actor {
  key: string;
  label: string;
  worker: boolean;
}

export interface Plan {
  steps: Step[];
  actors: Actor[];
  /** Total playback length at 1× (seconds), last step + tail. */
  total: number;
  /** Events before filtering / windowing, for "showing n of m". */
  available: number;
  /** Idle gaps shortened by the timing rule. */
  skipped: number;
}

export const MAX_ACTORS = 9;
const TAIL = 1.5;
/** "real" timing: one minute of recorded time plays in one second at 1×, gaps capped at 5 s. */
const REAL_SCALE = 60;
const REAL_CAP = 5;

/** Playback seconds (at 1×) a gap takes under a timing rule. DERIVED. */
export function stepGap(gapMs: number, timing: Timing): number {
  const s = Math.max(0, gapMs) / 1000;
  if (timing === 'even') return 0.6;
  if (timing === 'real') return Math.min(REAL_CAP, s / REAL_SCALE);
  return Math.min(3, Math.max(0.25, 0.25 + 0.55 * Math.log10(1 + s)));
}

function keep(e: TimelineEvent, show: Show): boolean {
  if (show === 'all') return true;
  if (show === 'work') return e.type !== 'SESSION_ACTIVITY';
  return e.type !== 'SESSION_ACTIVITY' && e.type !== 'TOOL_ACTIVITY' && e.type !== 'PROCESS_ACTIVITY';
}

export interface PlanOpts {
  timing: Timing;
  show: Show;
  workers: boolean;
  /** Keep the latest n events. */
  limit: number;
}

/**
 * Builds the playback plan of `root` from `events` (root's and its workers' events, any order).
 * `sessions` resolves worker labels and spawn matches.
 */
export function plan(root: AgentSessionSnapshot, events: TimelineEvent[], sessions: AgentSessionSnapshot[], o: PlanOpts): Plan {
  const kids = sessions.filter(s => s.parentSessionId === root.key);
  const kidKeys = new Set(kids.map(k => k.key));
  const mine = events.filter(e => e.sessionKey === root.key || (o.workers && kidKeys.has(e.sessionKey)));
  const sorted = mine.filter(e => keep(e, o.show)).sort((a, b) => a.at - b.at);
  const win = sorted.slice(-Math.max(1, o.limit));

  // Actors: root first, then workers in order of first appearance; overflow folds into one "other workers" lane.
  const actors: Actor[] = [{ key: root.key, label: 'this session', worker: false }];
  const idx = new Map<string, number>([[root.key, 0]]);
  const byKey = new Map(kids.map(k => [k.key, k]));
  const order = [...new Set(win.map(e => e.sessionKey).filter(k => k !== root.key))];
  for (const k of order) {
    if (actors.length < MAX_ACTORS - 1 || order.length <= MAX_ACTORS - 1) {
      idx.set(k, actors.length);
      actors.push({ key: k, label: workerName(byKey.get(k)), worker: true });
    }
  }
  if (order.some(k => !idx.has(k))) actors.push({ key: '', label: `other workers (${order.filter(k => !idx.has(k)).length})`, worker: true });
  const other = actors.length - 1;

  // Spawn matching: nearest unused worker start in [-10 s, +180 s] around the WORKER_STARTED call. INFERRED.
  const used = new Set<string>();
  const steps: Step[] = [];
  let p = 0;
  let skipped = 0;
  let prevAt = 0;
  for (let i = 0; i < win.length; i++) {
    const e = win[i];
    const gapMs = i ? e.at - prevAt : 0;
    if (i) {
      const g = stepGap(gapMs, o.timing);
      if (o.timing === 'real' && gapMs / 1000 / REAL_SCALE > REAL_CAP) skipped++;
      p += g;
    }
    prevAt = e.at;
    const cat = catOf(e.type);
    const st: Step = { i, at: e.at, type: e.type, label: e.label, kind: e.kind, cat, actor: idx.get(e.sessionKey) ?? other, gapMs, p: round(p), ord: 0 };
    if (i && win[i - 1].at === e.at) st.ord = steps[i - 1].ord + 1;
    if (e.type === 'TEST') {
      if (/^PASS\b/.test(e.label)) st.outcome = 'PASS';
      else if (/^FAIL\b/.test(e.label)) st.outcome = 'FAIL';
    }
    if (e.type === 'WORKER_STARTED' && o.workers) {
      const parentKey = e.sessionKey;
      let best: AgentSessionSnapshot | undefined;
      for (const s of sessions) {
        if (s.parentSessionId !== parentKey || used.has(s.key) || s.startedAt === undefined || !idx.has(s.key)) continue;
        const d = s.startedAt - e.at;
        if (d < -10_000 || d > 180_000) continue;
        if (!best || Math.abs(d) < Math.abs((best.startedAt ?? 0) - e.at)) best = s;
      }
      if (best) {
        used.add(best.key);
        st.spawn = idx.get(best.key);
      }
    }
    steps.push(st);
  }
  return { steps, actors, total: round((steps.length ? steps[steps.length - 1].p : 0) + TAIL), available: mine.length, skipped };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function workerName(s: AgentSessionSnapshot | undefined): string {
  if (!s) return 'worker';
  const role = (s.workerLabel ?? '').split(' · ')[0];
  return (role || s.title || s.sessionId.slice(0, 8)).slice(0, 40);
}

/** Last step at or before playback position `pos` (−1 before the first). Binary search. */
export function indexAt(steps: Step[], pos: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (steps[m].p <= pos + 1e-9) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

/** Step matching a seek anchor (event time + same-time ordinal); nearest following step if it left the window. */
export function findStep(steps: Step[], at: number, ord: number): number {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].at === at && steps[i].ord === ord) return i;
    if (steps[i].at > at) return i;
  }
  return steps.length - 1;
}

/** Per-category and per-actor counts of steps 0..upTo (inclusive). */
export function countsUpTo(steps: Step[], upTo: number, actors: number): { cat: Record<Cat, number>; actor: number[]; pass: number; fail: number } {
  const cat = { life: 0, tools: 0, cmds: 0, files: 0, tests: 0, git: 0 } as Record<Cat, number>;
  const actor = new Array<number>(actors).fill(0);
  let pass = 0;
  let fail = 0;
  for (let i = 0; i <= upTo && i < steps.length; i++) {
    const s = steps[i];
    cat[s.cat]++;
    actor[s.actor]++;
    if (s.outcome === 'PASS') pass++;
    if (s.outcome === 'FAIL') fail++;
  }
  return { cat, actor, pass, fail };
}

// ---------------------------------------------------------------- transport

/** Playback state of one session. Positions are playback seconds at 1×. */
export interface Transport {
  /** Anchor step (event time + ordinal) where `played` counts from. */
  at: number;
  ord: number;
  /** Seconds played (at 1×) from the anchor up to `wall`. */
  played: number;
  /** Wall clock when the state last changed (ms). */
  wall: number;
  speed: number;
  paused: boolean;
}

export const SPEEDS = [1, 2, 4, 16, 64];

const transports = new Map<string, Transport>();

export function transportOf(key: string): Transport | undefined {
  return transports.get(key);
}

export function setTransport(key: string, t: Transport): void {
  transports.set(key, t);
  if (transports.size > 50) transports.delete(transports.keys().next().value as string);
}

export function resetTransports(): void {
  transports.clear();
}

/** Current playback position (1× seconds) of a transport over a plan, clamped to [0, total]. No transport = paused at the end. */
export function position(t: Transport | undefined, pl: Plan, now: number): { pos: number; paused: boolean; speed: number; ended: boolean } {
  if (!t || !pl.steps.length) return { pos: pl.total, paused: true, speed: t?.speed ?? 4, ended: true };
  const a = findStep(pl.steps, t.at, t.ord);
  const raw = pl.steps[a].p + t.played + (t.paused ? 0 : (Math.max(0, now - t.wall) / 1000) * t.speed);
  const pos = Math.max(0, Math.min(pl.total, raw));
  const ended = pos >= pl.total - 1e-9;
  return { pos, paused: t.paused || ended, speed: t.speed, ended };
}

/** Play from the current point (or from the start when at the end). */
export function play(t: Transport | undefined, startAt: number, now: number, speed = t?.speed ?? 4, atEnd = false): Transport {
  if (!t || atEnd) return { at: startAt, ord: 0, played: 0, wall: now, speed, paused: false };
  if (!t.paused) return t;
  return { ...t, wall: now, paused: false };
}

export function pause(t: Transport | undefined, now: number): Transport | undefined {
  if (!t || t.paused) return t;
  return { ...t, played: t.played + (Math.max(0, now - t.wall) / 1000) * t.speed, wall: now, paused: true };
}

/** Jump to a step and stay paused there (step mode) unless `keepPlaying`. */
export function seek(t: Transport | undefined, at: number, ord: number, now: number, keepPlaying = false): Transport {
  return { at, ord, played: 0, wall: now, speed: t?.speed ?? 4, paused: !(keepPlaying && t && !t.paused) };
}

export function withSpeed(t: Transport | undefined, speed: number, now: number, fallbackAt: number): Transport {
  if (!t) return { at: fallbackAt, ord: 0, played: 0, wall: now, speed, paused: true };
  const played = t.paused ? t.played : t.played + (Math.max(0, now - t.wall) / 1000) * t.speed;
  return { ...t, played, wall: now, speed };
}

/** "m:ss" / "h:mm:ss" from ms. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Short gap text: "", "4s", "3m", "1h05". */
export function gapText(ms: number): string {
  if (ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
