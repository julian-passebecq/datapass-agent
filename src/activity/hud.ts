// Session HUD: compact per-session facts for a terminal-style side panel (plan / permission mode, subagents,
// todo progress, tests, CI, context, lessons, log tail). Pure functions of snapshots, events and feed values;
// no I/O here (the lessons files are read by src/feeds/lessons.ts). Every value carries its evidence kind.
import type { AgentSessionSnapshot, EvidenceKind, TimelineEvent, TodoList } from '../model';
import type { CiReport, CiStatus } from '../feeds/pipelines';
import { isLive } from './insights';
import { testVerdict } from '../sessions/classify';

export type WorkerState = 'run' | 'needs' | 'idle' | 'ended' | 'unknown';

export interface HudWorker {
  s: AgentSessionSnapshot;
  state: WorkerState;
}

/** Child sessions of `s` (parentSessionId = s.key), running first, then newest. */
export function workersOf(s: AgentSessionSnapshot, all: AgentSessionSnapshot[]): HudWorker[] {
  const order: Record<WorkerState, number> = { needs: 0, run: 1, idle: 2, unknown: 3, ended: 4 };
  return all
    .filter(w => w.parentSessionId === s.key && w.key !== s.key)
    .map(w => ({ s: w, state: workerState(w) }))
    .sort((a, b) => order[a.state] - order[b.state] || (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));
}

export function workerState(w: AgentSessionSnapshot): WorkerState {
  switch (w.status) {
    case 'RUNNING':
      return 'run';
    case 'NEEDS_INPUT':
      return 'needs';
    case 'IDLE':
      return 'idle';
    case 'ENDED':
      return 'ended';
    default:
      return 'unknown';
  }
}

export interface TodoProgress {
  done: number;
  total: number;
  active?: string;
  list: TodoList;
}

export function todoProgress(s: AgentSessionSnapshot): TodoProgress | undefined {
  const l = s.facts?.todos;
  if (!l) return undefined;
  return {
    done: l.items.filter(i => i.status === 'completed').length,
    total: l.items.length + (l.dropped ?? 0),
    active: l.items.find(i => i.status === 'in_progress')?.text,
    list: l,
  };
}

export interface TestSummary {
  /** Latest run per command label (the same command run again replaces its earlier outcome). */
  passed: number;
  failed: number;
  unknown: number;
  total: number;
  /** All observations, including reruns. */
  runs: number;
  last?: { command: string; outcome: string; at: number; source: string };
}

export function testSummary(s: AgentSessionSnapshot): TestSummary | undefined {
  if (!s.tests.length) return undefined;
  const latest = new Map<string, AgentSessionSnapshot['tests'][number]>();
  for (const t of [...s.tests].sort((a, b) => a.at - b.at)) latest.set(t.command, t);
  // Trusted outcome per command: a chained / piped test with only a tool error flag counts as no outcome.
  const v = [...latest.values()].map(t => ({ ...t, outcome: testVerdict(t).outcome }));
  const last = s.tests.reduce((a, b) => (b.at >= a.at ? b : a));
  return {
    passed: v.filter(t => t.outcome === 'PASS').length,
    failed: v.filter(t => t.outcome === 'FAIL').length,
    unknown: v.filter(t => t.outcome === 'UNKNOWN').length,
    total: v.length,
    runs: s.tests.length,
    last: { command: last.command, outcome: testVerdict(last).outcome, at: last.at, source: `${last.source}; ${testVerdict(last).basis}` },
  };
}

export interface CiState {
  status: CiStatus;
  ref: string;
  title: string;
  at: number;
  url?: string;
  /** branch: run on the session's branch; repo: newest run of the repository (no run on its branch). */
  basis: 'branch' | 'repo';
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** CI state of the session's repository from the Pipelines feed report (OBSERVED by the CI API). */
export function ciFor(s: AgentSessionSnapshot, report: CiReport | undefined): CiState | 'off' | 'none' {
  if (!report || report.state !== 'ok') return 'off';
  const root = s.repository ?? s.cwd;
  if (!root) return 'none';
  const repo = report.repos.find(r => norm(r.root) === norm(root));
  if (!repo?.runs.length) return 'none';
  const branch = s.branch ?? s.facts?.recordedBranch;
  const newest = (runs: typeof repo.runs) => runs.reduce((a, b) => ((b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt) ? b : a));
  const onBranch = branch ? repo.runs.filter(r => r.ref === branch) : [];
  const r = newest(onBranch.length ? onBranch : repo.runs);
  return { status: r.status, ref: r.ref, title: r.title, at: r.updatedAt ?? r.createdAt, url: r.url, basis: onBranch.length ? 'branch' : 'repo' };
}

// ---- lessons -----------------------------------------------------------------------------------------------

/** Files looked up in the repository root, in order; the first one found is used. */
export const LESSON_FILES: { rel: string; mode: 'all' | 'section' }[] = [
  { rel: 'handoff/MEMORY.md', mode: 'all' },
  { rel: 'tasks/lessons.md', mode: 'all' },
  { rel: 'CLAUDE.md', mode: 'section' },
];

const BULLET = /^\s{0,8}(?:[-*+]|\d{1,3}[.)])\s+\S/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Rules in a lessons file = bullet / numbered lines. mode "section": only lines under a heading containing
 * "lesson" (until the next heading of the same or a higher level). Fenced code blocks are skipped.
 */
export function countLessons(text: string, mode: 'all' | 'section'): number {
  let n = 0;
  let inFence = false;
  let sectionLevel = 0; // > 0 while inside a "Lessons" section
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = HEADING.exec(line);
    if (h) {
      const lvl = h[1].length;
      if (sectionLevel && lvl <= sectionLevel) sectionLevel = 0;
      if (!sectionLevel && /lesson/i.test(h[2])) sectionLevel = lvl;
      continue;
    }
    if (mode === 'section' && !sectionLevel) continue;
    if (BULLET.test(line)) n++;
  }
  return n;
}

export interface LessonsInfo {
  root: string;
  /** Relative file used, undefined when none of LESSON_FILES exists (or CLAUDE.md has no Lessons section). */
  file?: string;
  rules: number;
  bytes: number;
  truncated: boolean;
  error?: string;
}

// ---- log tail ----------------------------------------------------------------------------------------------

export interface LogLine {
  at: number;
  type: string;
  label: string;
  kind: EvidenceKind;
  /** Event of a worker of the session (timeline includes children). */
  child?: boolean;
}

/** Last `n` events of one session, oldest first. */
export function logTail(key: string, events: TimelineEvent[], n = 8): LogLine[] {
  return events
    .filter(e => e.sessionKey === key)
    .sort((a, b) => a.at - b.at)
    .slice(-n)
    .map(e => ({ at: e.at, type: e.type, label: e.label, kind: e.kind }));
}

// ---- which sessions get a card -----------------------------------------------------------------------------

/**
 * Cards: every live lead session (workers fold into their lead's card; a live worker whose lead is not
 * loaded gets its own card), newest first, capped; plus the pinned session if it is not already there.
 */
export function hudSessions(sessions: AgentSessionSnapshot[], pinned: AgentSessionSnapshot | undefined, max = 12): AgentSessionSnapshot[] {
  const keys = new Set(sessions.map(s => s.key));
  const live = sessions
    .filter(s => isLive(s) && (!s.isWorker || !s.parentSessionId || !keys.has(s.parentSessionId)))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, max);
  if (!pinned) return live;
  return [pinned, ...live.filter(s => s.key !== pinned.key)];
}
