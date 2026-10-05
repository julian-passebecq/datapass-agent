// Audit trail (P7): a chronological list of observed transitions, rebuilt from snapshots and the event
// timeline on every pass (nothing stored). A transition is a change of state: a session or worker started
// or ended, a status it is in now, a commit, a test outcome, a failed command, a provider error, a
// compaction. Each one carries the evidence kind and the record it comes from. No message text is read.
import { AgentSessionSnapshot, EvidenceKind, Provider, TimelineEvent } from '../model';
import { statusEvidenceOf } from '../sessions/classify';
import { bounded } from '../util/redact';
import { base } from './insights';

export type AuditCat = 'lifecycle' | 'git' | 'tests' | 'problems' | 'context';
export const AUDIT_CATS: AuditCat[] = ['lifecycle', 'git', 'tests', 'problems', 'context'];

export type AuditKind =
  | 'started' | 'worker-started' | 'spawn' | 'ended' | 'worker-ended' | 'needs-input' | 'idle' | 'stalled'
  | 'commit' | 'commit-run'
  | 'test-pass' | 'test-fail' | 'test-unknown'
  | 'cmd-fail' | 'api-error'
  | 'compacted';

export const KIND_META: Record<AuditKind, { cat: AuditCat; label: string }> = {
  started: { cat: 'lifecycle', label: 'Started' },
  'worker-started': { cat: 'lifecycle', label: 'Worker started' },
  spawn: { cat: 'lifecycle', label: 'Spawned worker' },
  ended: { cat: 'lifecycle', label: 'Ended' },
  'worker-ended': { cat: 'lifecycle', label: 'Worker ended' },
  'needs-input': { cat: 'lifecycle', label: 'Needs input' },
  idle: { cat: 'lifecycle', label: 'Idle' },
  stalled: { cat: 'lifecycle', label: 'Status unknown' },
  commit: { cat: 'git', label: 'Commit' },
  'commit-run': { cat: 'git', label: 'git commit run' },
  'test-pass': { cat: 'tests', label: 'Test pass' },
  'test-fail': { cat: 'tests', label: 'Test fail' },
  'test-unknown': { cat: 'tests', label: 'Test ?' },
  'cmd-fail': { cat: 'problems', label: 'Command failed' },
  'api-error': { cat: 'problems', label: 'API error' },
  compacted: { cat: 'context', label: 'Compacted' },
};

export const CAT_LABEL: Record<AuditCat, string> = { lifecycle: 'Lifecycle', git: 'Git', tests: 'Tests', problems: 'Problems', context: 'Context' };

export interface Transition {
  at: number;
  key: string;
  provider: Provider;
  repo: string;
  title: string;
  isWorker: boolean;
  kind: AuditKind;
  cat: AuditCat;
  /** Bounded, redacted. */
  label: string;
  evidence: EvidenceKind;
  /** The record behind it ("rollout exec_command_end exit code", "git log in session window" …). */
  source: string;
  /** Tests only: the outcome differs from the previous test of the same session (or it is the first). DERIVED. */
  change?: 'first' | 'fixed' | 'broke';
}

export interface AuditOptions {
  now?: number;
  /** Exit codes treated as an ordinary "no" (grep / rg / diff no match). Default [1]. */
  quietExits?: number[];
}

const repoOf = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';
const titleOf = (s: AgentSessionSnapshot) => s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8);

/** Exit code recorded in a PROCESS_ACTIVITY label ("$ cmd  → exit 2"). */
function exitOf(label: string): number | undefined {
  const m = /→\s+exit\s+(-?\d+)\s*$/.exec(label);
  return m ? Number(m[1]) : undefined;
}

const STRENGTH: Record<EvidenceKind, number> = { OBSERVED: 3, DERIVED: 2, INFERRED: 1, UNKNOWN: 0 };

/**
 * Evidence kind of the current status, from statusEvidenceOf (an end only inferred from a gone registry entry
 * stays INFERRED). A weaker kind recorded by the provider adapter for the status field wins.
 */
export function statusEvidence(s: AgentSessionSnapshot): { kind: EvidenceKind; source: string } {
  const v = statusEvidenceOf(s);
  const e = s.evidence.find(x => x.field === 'status');
  const kind = e && STRENGTH[e.kind] < STRENGTH[v.kind] ? e.kind : v.kind;
  return { kind, source: e ? `${e.source}; ${v.basis}` : v.basis };
}

/**
 * True when the session's end is recorded by the provider (OBSERVED end time). Durations of any other
 * session stop at its last recorded activity (or now while live), so they are lower bounds: show them with "≥".
 */
export function endObserved(s: AgentSessionSnapshot): boolean {
  return s.status === 'ENDED' && s.endedAt !== undefined && statusEvidence(s).kind === 'OBSERVED';
}

/** The status rests on an alive check (registry pid signal-0, or an end inferred from a gone registry entry). */
export function aliveInferred(s: AgentSessionSnapshot, st = statusEvidence(s)): boolean {
  if (s.evidence.some(e => e.field === 'status.alive' && e.kind === 'INFERRED')) return true;
  if (/process alive: inferred/i.test(st.source)) return true;
  return s.status === 'ENDED' && st.kind === 'INFERRED';
}

/**
 * Every transition of the given sessions, newest first. `events` may hold events of other sessions
 * (they are ignored). Sessions give start / end / status / commits / tests (complete lists); events
 * give workers, git commit commands, failed commands, provider errors and compactions.
 */
export function transitions(sessions: AgentSessionSnapshot[], events: TimelineEvent[], o: AuditOptions = {}): Transition[] {
  const quiet = new Set(o.quietExits ?? [1]);
  const by = new Map(sessions.map(s => [s.key, s]));
  const out: Transition[] = [];
  const seen = new Set<string>();
  const push = (s: AgentSessionSnapshot, at: number | undefined, kind: AuditKind, label: string, evidence: EvidenceKind, source: string, change?: Transition['change']) => {
    if (at === undefined || !Number.isFinite(at)) return;
    const l = bounded(label, 160);
    const id = `${s.key}|${kind}|${at}|${l}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ at, key: s.key, provider: s.provider, repo: repoOf(s), title: bounded(titleOf(s), 80), isWorker: s.isWorker, kind, cat: KIND_META[kind].cat, label: l, evidence, source, ...(change ? { change } : {}) });
  };

  const observedStart = new Map<string, TimelineEvent>();
  for (const e of events) {
    const s = by.get(e.sessionKey);
    if (!s) continue;
    switch (e.type) {
      case 'SESSION_STARTED':
        if (e.kind === 'OBSERVED' && !observedStart.has(s.key)) observedStart.set(s.key, e);
        break;
      case 'WORKER_STARTED':
        push(s, e.at, 'spawn', e.label, e.kind, 'lead session tool call (Task / spawn_agent)');
        break;
      case 'WORKER_ENDED':
        push(s, e.at, 'worker-ended', e.label, e.kind, 'worker result recorded in the lead session');
        break;
      case 'GIT_CHANGE':
        if (/commit/i.test(e.label)) push(s, e.at, 'commit-run', e.label, e.kind, 'shell command recorded by the provider');
        break;
      case 'PROCESS_ACTIVITY': {
        const x = exitOf(e.label);
        if (x !== undefined && x !== 0 && !quiet.has(x)) push(s, e.at, 'cmd-fail', e.label.replace(/^\s*\$\s*/, ''), e.kind, `exit code ${x} recorded by the provider`);
        else if (x === undefined && /→\s+failed\s*$/.test(e.label)) push(s, e.at, 'cmd-fail', e.label.replace(/^\s*\$\s*/, ''), e.kind, 'provider tool error flag');
        break;
      }
      case 'SESSION_ACTIVITY':
        if (/compact/i.test(e.label)) push(s, e.at, 'compacted', e.label, e.kind, 'compact boundary record');
        else if (/api error/i.test(e.label)) push(s, e.at, 'api-error', e.label, e.kind, 'provider system record');
        break;
      default:
        break;
    }
  }

  for (const s of sessions) {
    const os = observedStart.get(s.key);
    const startAt = os?.at ?? s.startedAt;
    push(s, startAt, s.isWorker ? 'worker-started' : 'started', s.isWorker ? `worker ${s.workerLabel ?? ''}`.trim() : 'session started', os ? 'OBSERVED' : 'DERIVED', os ? 'first session record' : 'earliest record timestamp');

    const st = statusEvidence(s);
    // Transitions that rest on an alive check carry an "(inferred)" suffix (audit A3 P2-15).
    const inf = aliveInferred(s, st) ? ' (inferred)' : '';
    if (s.status === 'ENDED') {
      if (s.endedAt) push(s, s.endedAt, s.isWorker ? 'worker-ended' : 'ended', (s.isWorker ? 'worker ended' : 'session ended') + inf, st.kind, st.source);
      else push(s, s.lastActivityAt, s.isWorker ? 'worker-ended' : 'ended', 'ended at the time of the last record (inferred)', 'INFERRED', st.source);
    } else if (s.status === 'NEEDS_INPUT') push(s, s.lastActivityAt, 'needs-input', 'waiting for you since the last record' + inf, st.kind, st.source);
    else if (s.status === 'IDLE') push(s, s.lastActivityAt, 'idle', 'turn completed; thread open' + inf, st.kind, st.source);
    else if (s.status === 'UNKNOWN') push(s, s.lastActivityAt, 'stalled', s.statusReason, 'INFERRED', st.source);

    for (const c of s.commits)
      push(s, c.at, 'commit', `${c.sha.slice(0, 7)} ${c.subject}`, c.attribution === 'session-ran-git-commit' ? 'OBSERVED' : 'DERIVED', c.attribution === 'session-ran-git-commit' ? 'session ran git commit; sha from git log' : 'git log: commit inside the session window (not proof the session made it)');

    let prev: string | undefined;
    for (const t of [...s.tests].sort((a, b) => a.at - b.at)) {
      const kind: AuditKind = t.outcome === 'PASS' ? 'test-pass' : t.outcome === 'FAIL' ? 'test-fail' : 'test-unknown';
      const change: Transition['change'] = prev === undefined ? 'first' : prev !== t.outcome && t.outcome !== 'UNKNOWN' && prev !== 'UNKNOWN' ? (t.outcome === 'PASS' ? 'fixed' : 'broke') : undefined;
      if (t.outcome !== 'UNKNOWN') prev = t.outcome;
      else if (prev === undefined) prev = 'UNKNOWN';
      const src = t.source === 'provider-exit-code' ? `exit code ${t.exitCode ?? '?'} recorded by the provider` : 'provider tool error flag (no exit code)';
      push(s, t.at, kind, t.command + (t.durationMs !== undefined ? ` · ${Math.round(t.durationMs / 1000)} s` : ''), 'OBSERVED', src, change);
    }
  }
  return out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** One JSON object per line, oldest first. Only labels Agent already keeps (bounded, redacted). */
export function toJsonl(rows: Transition[]): string {
  return [...rows]
    .sort((a, b) => a.at - b.at)
    .map(r =>
      JSON.stringify({
        at: new Date(r.at).toISOString(),
        ts: r.at,
        session: r.key,
        provider: r.provider,
        repo: r.repo,
        worker: r.isWorker,
        title: r.title,
        category: r.cat,
        kind: r.kind,
        label: r.label,
        ...(r.change ? { change: r.change } : {}),
        evidence: r.evidence,
        source: r.source,
      }),
    )
    .join('\n') + (rows.length ? '\n' : '');
}

export type Gran = 'minute' | 'hour' | 'day' | 'week';
export const GRAN_MS: Record<Gran, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

/** Local-time bucket start for a timestamp. Weeks start on Monday. */
export function bucketStart(t: number, g: Gran): number {
  const d = new Date(t);
  if (g === 'minute') d.setSeconds(0, 0);
  else if (g === 'hour') d.setMinutes(0, 0, 0);
  else {
    d.setHours(0, 0, 0, 0);
    if (g === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  }
  return d.getTime();
}

/** Next bucket start (calendar-aware for day / week across DST). */
export function nextBucket(t: number, g: Gran): number {
  if (g === 'minute' || g === 'hour') return t + GRAN_MS[g];
  const d = new Date(t);
  d.setDate(d.getDate() + (g === 'week' ? 7 : 1));
  return bucketStart(d.getTime(), g);
}

/** Counts per bucket and category over [from, to]; empty buckets included, oldest first, capped at `max` buckets (newest kept). */
export function histogram(rows: Transition[], from: number, to: number, g: Gran, max = 400): { at: number; n: Record<AuditCat, number>; total: number }[] {
  const out: { at: number; n: Record<AuditCat, number>; total: number }[] = [];
  const idx = new Map<number, number>();
  let start = bucketStart(from, g);
  const minStart = bucketStart(to, g) - GRAN_MS[g] * (max - 1) * 1.1;
  if (start < minStart) start = bucketStart(minStart, g);
  for (let t = start; t <= to && out.length < max + 2; t = nextBucket(t, g)) {
    idx.set(t, out.length);
    out.push({ at: t, n: { lifecycle: 0, git: 0, tests: 0, problems: 0, context: 0 }, total: 0 });
  }
  for (const r of rows) {
    const i = idx.get(bucketStart(r.at, g));
    if (i === undefined) continue;
    out[i].n[r.cat]++;
    out[i].total++;
  }
  return out.slice(-max);
}

/** Granularity that keeps a period readable (≈ 24–60 buckets). */
export function autoGran(spanMs: number): Gran {
  if (spanMs <= 2 * 3_600_000) return 'minute';
  if (spanMs <= 3 * 86_400_000) return 'hour';
  if (spanMs <= 90 * 86_400_000) return 'day';
  return 'week';
}
