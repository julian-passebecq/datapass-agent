// Lifecycle state machines (pure, no I/O). Two machines are rebuilt from snapshots + the event timeline on
// every pass, nothing stored:
//  (1) session status: STARTED → RUNNING ⇄ IDLE → NEEDS_INPUT / ENDED / UNKNOWN. Start and the current status
//      come from the audit trail (src/activity/audit.ts `transitions`, same evidence); RUNNING ⇄ IDLE in between
//      is INFERRED from gaps between records (no status history is recorded by the providers).
//  (2) work loop: prompt → read / search → edit → test (→ fail → edit) → commit → reply, from tool / file /
//      test / commit events. Reply is OBSERVED for Codex ("turn completed"), INFERRED otherwise.
// Every visit carries its evidence kind; aggregates keep counts per kind.
import type { AgentSessionSnapshot, EvidenceKind, SessionStatus, TimelineEvent } from '../model';
import { transitions } from './audit';

export type StatusState = 'STARTED' | SessionStatus;
export const STATUS_STATES: StatusState[] = ['STARTED', 'RUNNING', 'IDLE', 'NEEDS_INPUT', 'ENDED', 'UNKNOWN'];

export type WorkState = 'prompt' | 'read' | 'edit' | 'test' | 'fail' | 'commit' | 'reply';
export const WORK_STATES: WorkState[] = ['prompt', 'read', 'edit', 'test', 'fail', 'commit', 'reply'];

export interface Visit<S extends string = string> {
  state: S;
  /** Entered at (epoch ms). */
  at: number;
  /** Records merged into this visit (consecutive events of the same state). */
  n: number;
  evidence: EvidenceKind;
  /** End of the last visit when it is still open (e.g. now for a live status); undefined = unknown. */
  until?: number;
}

export interface MachineNode {
  id: string;
  visits: number;
  /** Distinct sessions that entered the state. */
  sessions: number;
  /** DERIVED: median time between entering this state and leaving it (closed visits, plus open ones when given). */
  medianMs?: number;
  dwellSamples: number;
}

export interface MachineEdge {
  from: string;
  to: string;
  count: number;
  /** DERIVED: median time spent in `from` before taking this edge. */
  medianMs?: number;
  /** Count of transitions per weakest evidence kind of the two visits. */
  evidence: Partial<Record<EvidenceKind, number>>;
}

export interface Machine {
  nodes: Map<string, MachineNode>;
  edges: MachineEdge[];
  transitions: number;
}

export const DEFAULT_IDLE_GAP_MS = 5 * 60_000;

const RANK: Record<EvidenceKind, number> = { OBSERVED: 3, DERIVED: 2, INFERRED: 1, UNKNOWN: 0 };
export const weakest = (a: EvidenceKind, b: EvidenceKind): EvidenceKind => (RANK[a] <= RANK[b] ? a : b);

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Appends a visit, merging it into the previous one when the state repeats. */
function add<S extends string>(path: Visit<S>[], state: S, at: number, evidence: EvidenceKind): void {
  const last = path[path.length - 1];
  if (last && last.state === state) {
    last.n++;
    return;
  }
  path.push({ state, at: last ? Math.max(at, last.at) : at, n: 1, evidence });
}

// ---- (1) session status ------------------------------------------------------------------------------------

/**
 * Status path of one session, oldest first. `events` may hold other sessions' events (ignored).
 * STARTED = first record (OBSERVED / DERIVED as in the audit trail); RUNNING from the second record (INFERRED:
 * a record timestamp does not prove the process was running);
 * a gap ≥ idleGapMs between records = IDLE then RUNNING again (INFERRED); last state = the current status
 * with its evidence. The last visit stays open until `now` unless it is ENDED.
 */
export function statusPath(s: AgentSessionSnapshot, events: TimelineEvent[], o: { now: number; idleGapMs?: number }): Visit<StatusState>[] {
  const gap = o.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const mine = events.filter(e => e.sessionKey === s.key);
  const lc = transitions([s], mine.filter(e => e.type === 'SESSION_STARTED'), { now: o.now }).filter(t => t.cat === 'lifecycle');
  const start = lc.find(t => t.kind === 'started' || t.kind === 'worker-started');
  if (!start) return [];
  const path: Visit<StatusState>[] = [{ state: 'STARTED', at: start.at, n: 1, evidence: start.evidence }];
  const times = [...new Set([...mine.filter(e => e.type !== 'SESSION_ENDED').map(e => e.at), s.lastActivityAt ?? NaN])]
    .filter(t => Number.isFinite(t) && t > start.at)
    .sort((a, b) => a - b);
  if (times.length) {
    add(path, 'RUNNING', times[0], 'INFERRED');
    for (let i = 0; i + 1 < times.length; i++) {
      if (times[i + 1] - times[i] >= gap) {
        add(path, 'IDLE', times[i], 'INFERRED');
        add(path, 'RUNNING', times[i + 1], 'INFERRED');
      }
    }
  }
  const end = lc.find(t => t.kind !== 'started' && t.kind !== 'worker-started');
  const fin: StatusState | undefined = end ? (end.kind === 'ended' || end.kind === 'worker-ended' ? 'ENDED' : end.kind === 'needs-input' ? 'NEEDS_INPUT' : end.kind === 'idle' ? 'IDLE' : 'UNKNOWN') : s.status === 'RUNNING' ? 'RUNNING' : undefined;
  if (fin) {
    const last = path[path.length - 1];
    if (last.state === fin) {
      if (end) last.evidence = end.evidence;
    } else if (end) add(path, fin, end.at, end.evidence);
    else add(path, fin, s.lastActivityAt ?? last.at, 'INFERRED');
  }
  const last = path[path.length - 1];
  if (last.state !== 'ENDED') last.until = Math.max(o.now, last.at);
  return path;
}

// ---- (2) work loop -----------------------------------------------------------------------------------------

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'webfetch', 'websearch', 'toolsearch', 'read_file', 'list_dir', 'grep_search', 'file_search', 'view_image', 'imageview', 'web_search']);
const READ_CMD = /^(cat|ls|dir|rg|grep|find|fd|head|tail|wc|tree|less|more|jq|type|stat|file|get-content|get-childitem|select-string|gc|gci|sls|git\s+(status|diff|log|show|blame|grep|ls-files|branch|rev-parse))\b/i;

/** Work state of one timeline event, or undefined when it is none of the loop's states. */
export function workState(e: TimelineEvent): { state: WorkState; evidence: EvidenceKind } | undefined {
  const l = e.label.trim();
  switch (e.type) {
    case 'SESSION_STARTED':
      return { state: 'prompt', evidence: e.kind };
    case 'SESSION_ACTIVITY':
      if (/^(user turn|turn started)$/i.test(l)) return { state: 'prompt', evidence: e.kind };
      if (/^turn (completed|aborted)/i.test(l)) return { state: 'reply', evidence: e.kind };
      return undefined;
    case 'TOOL_ACTIVITY':
      return READ_TOOLS.has(l.toLowerCase()) ? { state: 'read', evidence: e.kind } : undefined;
    case 'PROCESS_ACTIVITY':
      return READ_CMD.test(l.replace(/^\s*\$\s*/, '')) ? { state: 'read', evidence: e.kind } : undefined;
    case 'FILE_CHANGE':
      return { state: 'edit', evidence: e.kind };
    case 'TEST':
      return { state: /^FAIL\b/.test(l) ? 'fail' : 'test', evidence: e.kind };
    case 'GIT_CHANGE':
      return /commit/i.test(l) ? { state: 'commit', evidence: e.kind } : undefined;
    case 'COMMIT':
      return { state: 'commit', evidence: e.kind };
    default:
      return undefined;
  }
}

const WORKING = new Set<WorkState>(['read', 'edit', 'test', 'fail', 'commit']);

/**
 * Work-loop path of one session, oldest first. Consecutive events of one state merge. A reply is inserted
 * (INFERRED) before a prompt that follows work, and at the end of a session that is no longer running.
 */
export function workPath(s: AgentSessionSnapshot, events: TimelineEvent[]): Visit<WorkState>[] {
  const path: Visit<WorkState>[] = [];
  const mine = events.filter(e => e.sessionKey === s.key && Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  for (const e of mine) {
    const w = workState(e);
    if (!w) continue;
    const last = path[path.length - 1];
    if (w.state === 'prompt' && last && WORKING.has(last.state)) add(path, 'reply', e.at, 'INFERRED');
    add(path, w.state, e.at, w.evidence);
  }
  const last = path[path.length - 1];
  if (last && s.status !== 'RUNNING' && (WORKING.has(last.state) || last.state === 'prompt')) add(path, 'reply', Math.max(last.at, s.lastActivityAt ?? last.at), 'INFERRED');
  return path;
}

export interface LoopStats {
  /** INFERRED: edit → fail → edit sequences (a failing test between two edits). */
  cycles: number;
  /** INFERRED: a failing test later followed by a passing test in the same turn. */
  fixed: number;
  /** OBSERVED: failing test visits. */
  fails: number;
  /** Prompts (turns). */
  turns: number;
  /** INFERRED: longest run of fail visits with only edits / reads between them. */
  maxFailStreak: number;
}

export function loopStats(path: Visit<WorkState>[]): LoopStats {
  let cycles = 0, fixed = 0, fails = 0, turns = 0, streak = 0, maxFailStreak = 0, open = false;
  for (let i = 0; i < path.length; i++) {
    const v = path[i].state;
    if (v === 'prompt') {
      turns++;
      open = false;
      streak = 0;
    } else if (v === 'fail') {
      fails++;
      open = true;
      streak++;
      maxFailStreak = Math.max(maxFailStreak, streak);
      if (path[i - 1]?.state === 'edit' && path[i + 1]?.state === 'edit') cycles++;
    } else if (v === 'test') {
      if (open) fixed++;
      open = false;
      streak = 0;
    } else if (v === 'commit' || v === 'reply') streak = 0;
  }
  return { cycles, fixed, fails, turns, maxFailStreak };
}

export function sumLoops(xs: LoopStats[]): LoopStats {
  return xs.reduce((a, b) => ({ cycles: a.cycles + b.cycles, fixed: a.fixed + b.fixed, fails: a.fails + b.fails, turns: a.turns + b.turns, maxFailStreak: Math.max(a.maxFailStreak, b.maxFailStreak) }), { cycles: 0, fixed: 0, fails: 0, turns: 0, maxFailStreak: 0 });
}

// ---- aggregation -------------------------------------------------------------------------------------------

/** Nodes and edges over many paths. Dwell = next visit's start − this visit's start (or `until` for an open last visit). */
export function machine(paths: Visit[][]): Machine {
  const nodes = new Map<string, MachineNode & { dw: number[]; who: Set<number> }>();
  const edges = new Map<string, MachineEdge & { dw: number[] }>();
  let n = 0;
  paths.forEach((path, pi) => {
    path.forEach((v, i) => {
      const node = nodes.get(v.state) ?? { id: v.state, visits: 0, sessions: 0, dwellSamples: 0, dw: [], who: new Set<number>() };
      node.visits++;
      node.who.add(pi);
      const next = path[i + 1];
      const end = next ? next.at : v.until;
      if (end !== undefined) node.dw.push(Math.max(0, end - v.at));
      nodes.set(v.state, node);
      if (next) {
        n++;
        const k = `${v.state}\u0000${next.state}`;
        const e = edges.get(k) ?? { from: v.state, to: next.state, count: 0, evidence: {}, dw: [] };
        e.count++;
        e.dw.push(Math.max(0, next.at - v.at));
        const ev = weakest(v.evidence, next.evidence);
        e.evidence[ev] = (e.evidence[ev] ?? 0) + 1;
        edges.set(k, e);
      }
    });
  });
  const out = new Map<string, MachineNode>();
  for (const [k, x] of nodes) out.set(k, { id: x.id, visits: x.visits, sessions: x.who.size, medianMs: median(x.dw), dwellSamples: x.dw.length });
  const es = [...edges.values()].map(({ dw, ...e }) => ({ ...e, medianMs: median(dw) })).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { nodes: out, edges: es, transitions: n };
}

/** Tool name → work state for provider-recorded tool counts (OBSERVED calls). Undefined = not a loop state. */
export function toolState(name: string): WorkState | undefined {
  const l = name.toLowerCase();
  if (READ_TOOLS.has(l)) return 'read';
  if (/^(edit|write|multiedit|notebookedit|apply_patch|filechange|file_change)$/.test(l)) return 'edit';
  return undefined;
}

/** Short duration for dwell labels: 42s, 7m, 3h05, 2d4h. */
export function dwell(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`;
}
