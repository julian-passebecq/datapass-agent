// Failure signals with an observed basis (P2). Each signal names the observation it comes from and the
// event times; nothing reads or judges message text. Signals needing judgement (invented, unhappy,
// unsafe) are deliberately absent. "unsolved" never means "failed": it means the end state shows open work.
import { AgentSessionSnapshot, EvidenceKind, TimelineEvent } from '../model';

export type SignalKind = 'unsolved' | 'blocked' | 'permissions' | 'swallowed' | 'looping';
export const SIGNAL_KINDS: SignalKind[] = ['unsolved', 'blocked', 'permissions', 'swallowed', 'looping'];

export const SIGNAL_META: Record<SignalKind, { label: string; rule: string }> = {
  unsolved: { label: 'Unsolved', rule: 'Session ended (or inactive 6 h without an end event) with its last test failing, or with repo file edits and no commit observed (temp / scratch files ignored; needs a git repository). Never means "failed".' },
  blocked: { label: 'Blocked', rule: 'A command could not run: exit code 127 (command not found) recorded by the provider, or provider API errors.' },
  permissions: { label: 'Permissions', rule: 'Waiting on a permission / approval prompt, exit code 126 (permission denied / not executable), or a turn aborted over an approval.' },
  swallowed: { label: 'Swallowed', rule: 'A failing test or a command with exit ≥ 2, never re-run before the session ended.' },
  looping: { label: 'Looping', rule: 'The same command (normalised) run N times or more, each within 15 min of the previous, with no file change in between. Waits (sleep) excluded.' },
};

export interface Signal {
  kind: SignalKind;
  key: string;
  /** Latest time the signal applies (for sorting and period filters). */
  at: number;
  /** Times of the observations behind it, oldest first, at most 12. */
  times: number[];
  reason: string;
  basis: string;
  evidence: EvidenceKind;
}

export interface SignalOptions {
  now?: number;
  /** Same command this many times without a file change counts as looping. Default 4. */
  loopMin?: number;
  /** A session with no end event and no activity for this long counts as ended (INFERRED). Default 6 h. */
  inactiveMs?: number;
}

const MAX_TIMES = 12;
const WAIT = /^(sleep|start-sleep|timeout|wait)\b/;
/** Edits that are not repo work: temp dirs, agent scratchpads, provider home folders (except worktrees). '/'-paths. */
const SCRATCH = /(^|\/)(temp|tmp|scratchpad)\/|\/users\/[^/]+\/\.(claude|codex)\/(?!(.*\/)?worktrees\/)/i;
/** Runs of the same command further apart than this are polling, not a loop. */
const LOOP_GAP_MS = 15 * 60_000;

/** Command label → comparison key: lowercase, no `$ ` prefix, no exit suffix or chain marker, single spaces. */
export function normalizeCommand(label: string): string {
  return label
    .replace(/^\s*\$\s*/, '')
    .replace(/\s+→\s+(exit\s+-?\d+|failed)\s*$/i, '')
    .replace(/\s+·\s+in command chain\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Exit code recorded in a PROCESS_ACTIVITY label ("$ cmd  → exit 2"). */
export function exitOf(label: string): number | undefined {
  const m = /→\s+exit\s+(-?\d+)\s*$/.exec(label);
  return m ? Number(m[1]) : undefined;
}

interface Run {
  at: number;
  cmd: string;
  norm: string;
  exit?: number;
  fail: boolean;
  test: boolean;
}

/** Commands of one session in time order: shell events (Codex carries exit codes) plus recorded tests. */
function runs(s: AgentSessionSnapshot, ev: TimelineEvent[]): Run[] {
  const out: Run[] = [];
  for (const e of ev) {
    if (e.type !== 'PROCESS_ACTIVITY' || e.sessionKey !== s.key) continue;
    const exit = exitOf(e.label);
    const cmd = e.label.replace(/^\s*\$\s*/, '').replace(/\s+→\s+(exit\s+-?\d+|failed)\s*$/i, '');
    out.push({ at: e.at, cmd, norm: normalizeCommand(e.label), exit, fail: (exit !== undefined && exit !== 0) || /→\s+failed\s*$/.test(e.label), test: false });
  }
  for (const t of s.tests) out.push({ at: t.at, cmd: t.command, norm: normalizeCommand(t.command), exit: t.exitCode, fail: t.outcome === 'FAIL', test: true });
  return out.filter(r => r.norm).sort((a, b) => a.at - b.at);
}

const fmtCmd = (c: string) => (c.length > 70 ? `${c.slice(0, 69)}…` : c);
const cap = (xs: number[]) => (xs.length > MAX_TIMES ? [...xs.slice(0, MAX_TIMES - 1), xs[xs.length - 1]] : xs);

/** Ended per the provider, or (INFERRED) inactive long enough without an end event. */
function endState(s: AgentSessionSnapshot, now: number, inactiveMs: number): { ended: boolean; kind: EvidenceKind; basis: string } {
  if (s.status === 'ENDED') return { ended: true, kind: 'OBSERVED', basis: s.statusReason || 'session ended' };
  if (s.status === 'UNKNOWN' && s.lastActivityAt !== undefined && now - s.lastActivityAt >= inactiveMs)
    return { ended: true, kind: 'INFERRED', basis: `no end event exposed; inactive ${Math.round((now - s.lastActivityAt) / 3600_000)} h` };
  return { ended: false, kind: 'UNKNOWN', basis: '' };
}

/** All signals of one session. `events` may include other sessions' events; only this session's are used. */
export function signals(s: AgentSessionSnapshot, events: TimelineEvent[], opts: SignalOptions = {}): Signal[] {
  const now = opts.now ?? Date.now();
  const loopMin = Math.max(2, opts.loopMin ?? 4);
  const end = endState(s, now, opts.inactiveMs ?? 6 * 3600_000);
  const ev = events.filter(e => e.sessionKey === s.key).sort((a, b) => a.at - b.at);
  const rs = runs(s, ev);
  const out: Signal[] = [];
  const last = s.lastActivityAt ?? s.endedAt ?? s.startedAt ?? 0;

  // unsolved — top-level only (workers hand their edits to the lead, who commits).
  const lastTest = s.tests.length ? [...s.tests].sort((a, b) => a.at - b.at)[s.tests.length - 1] : undefined;
  let unsolvedTest = false;
  if (end.ended && !s.isWorker) {
    const endAt = s.endedAt ?? last;
    if (lastTest?.outcome === 'FAIL') {
      unsolvedTest = true;
      out.push({ kind: 'unsolved', key: s.key, at: endAt, times: [lastTest.at, endAt], reason: `Ended with the last test failing: ${fmtCmd(lastTest.command)}`, basis: `${lastTest.exitCode !== undefined ? `exit code ${lastTest.exitCode}` : 'provider tool error flag'}; ${end.basis}`, evidence: end.kind === 'INFERRED' ? 'INFERRED' : 'OBSERVED' });
    } else {
      // Only work files count, and only when git correlation can see the repository at all.
      const work = s.changedFiles.filter(f => !SCRATCH.test(f.replace(/\\/g, '/')));
      const ranCommit = s.evidence.some(e => e.field === 'commit-command');
      if (work.length && !s.commits.length && !ranCommit && s.repository)
        out.push({ kind: 'unsolved', key: s.key, at: endAt, times: [endAt], reason: `Ended with ${work.length} file(s) edited, no commit observed`, basis: `provider file edits (temp / scratch / agent-config files ignored); no commit in git log over the session window and no git commit command recorded; ${end.basis}`, evidence: end.kind === 'INFERRED' ? 'INFERRED' : 'DERIVED' });
    }
  }

  // blocked / permissions from exit codes, one signal per command.
  const byExit = (code: number) => {
    const m = new Map<string, Run[]>();
    for (const r of rs) if (r.exit === code) m.set(r.norm, [...(m.get(r.norm) ?? []), r]);
    return m;
  };
  for (const [, list] of byExit(127)) {
    const times = list.map(r => r.at);
    out.push({ kind: 'blocked', key: s.key, at: times[times.length - 1], times: cap(times), reason: `Command not found${list.length > 1 ? ` ×${list.length}` : ''}: ${fmtCmd(list[0].cmd)}`, basis: 'process exit code 127 recorded by the provider (shell: command not found)', evidence: 'OBSERVED' });
  }
  const api = ev.filter(e => e.type === 'SESSION_ACTIVITY' && /provider API error/i.test(e.label)).map(e => e.at);
  if (api.length) out.push({ kind: 'blocked', key: s.key, at: api[api.length - 1], times: cap(api), reason: `Provider API error${api.length > 1 ? `s ×${api.length}` : ''}`, basis: 'provider system record subtype api_error', evidence: 'OBSERVED' });

  for (const [, list] of byExit(126)) {
    const times = list.map(r => r.at);
    out.push({ kind: 'permissions', key: s.key, at: times[times.length - 1], times: cap(times), reason: `Permission denied / not executable${list.length > 1 ? ` ×${list.length}` : ''}: ${fmtCmd(list[0].cmd)}`, basis: 'process exit code 126 recorded by the provider', evidence: 'OBSERVED' });
  }
  const aborted = ev.filter(e => e.type === 'SESSION_ACTIVITY' && /^turn aborted \(.*(approv|denied|permission|reject).*\)/i.test(e.label));
  if (aborted.length) out.push({ kind: 'permissions', key: s.key, at: aborted[aborted.length - 1].at, times: cap(aborted.map(e => e.at)), reason: `Turn aborted over an approval${aborted.length > 1 ? ` ×${aborted.length}` : ''}`, basis: `provider turn_aborted reason: ${aborted[aborted.length - 1].label.replace(/^turn aborted /, '')}`, evidence: 'OBSERVED' });
  if (s.status === 'NEEDS_INPUT' && /permission|approval/i.test(s.statusReason))
    out.push({ kind: 'permissions', key: s.key, at: last, times: [last], reason: 'Waiting on a permission / approval prompt', basis: s.statusReason, evidence: 'OBSERVED' });

  // swallowed — a failure never re-run before the end.
  if (end.ended) {
    const seen = new Set<string>();
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const counts = r.test ? r.fail : r.exit !== undefined && r.exit >= 2 && r.exit !== 126 && r.exit !== 127;
      if (!counts || seen.has(r.norm)) continue;
      if (unsolvedTest && r.test && lastTest && r.at === lastTest.at && r.cmd === lastTest.command) continue;
      const retried = rs.slice(i + 1).some(x => x.norm === r.norm || x.norm.startsWith(r.norm + ' ') || r.norm.startsWith(x.norm + ' '));
      if (retried) continue;
      seen.add(r.norm);
      out.push({ kind: 'swallowed', key: s.key, at: r.at, times: [r.at], reason: `${r.test ? 'Failing test' : `Exit ${r.exit}`} never re-run: ${fmtCmd(r.cmd)}`, basis: `${r.test ? (r.exit !== undefined ? `exit code ${r.exit}` : 'provider tool error flag') : `process exit code ${r.exit}`}; no later run of the same command; ${end.basis}`, evidence: end.kind === 'INFERRED' ? 'INFERRED' : 'DERIVED' });
    }
  }

  // looping — same command ≥ loopMin times with no file change in between. Only inside the event window
  // (older file changes may have been trimmed from the session's bounded event list).
  const from = ev.length ? ev[0].at : Infinity;
  const files = ev.filter(e => e.type === 'FILE_CHANGE').map(e => e.at);
  const seq = rs.filter(r => r.at >= from && !WAIT.test(r.norm));
  const streak = new Map<string, Run[]>();
  const flush = (norm: string) => {
    const list = streak.get(norm);
    streak.delete(norm);
    if (!list || list.length < loopMin) return;
    const times = list.map(r => r.at);
    out.push({ kind: 'looping', key: s.key, at: times[times.length - 1], times: cap(times), reason: `Same command ×${list.length} with no file change: ${fmtCmd(list[0].cmd)}`, basis: `${list.length} runs between ${fmtTime(times[0])} and ${fmtTime(times[times.length - 1])}; no file edit recorded in between`, evidence: 'DERIVED' });
  };
  let fi = 0;
  for (const r of seq) {
    while (fi < files.length && files[fi] <= r.at) {
      for (const k of [...streak.keys()]) flush(k);
      fi++;
    }
    const prev = streak.get(r.norm);
    if (prev && r.at - prev[prev.length - 1].at > LOOP_GAP_MS) flush(r.norm);
    streak.set(r.norm, [...(streak.get(r.norm) ?? []), r]);
  }
  for (const k of [...streak.keys()]) flush(k);

  return out.sort((a, b) => b.at - a.at);
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Signals of many sessions. `events` holds every session's events (e.g. store.timeline()). */
export function allSignals(sessions: AgentSessionSnapshot[], events: TimelineEvent[], opts: SignalOptions = {}): Signal[] {
  const by = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const l = by.get(e.sessionKey);
    if (l) l.push(e);
    else by.set(e.sessionKey, [e]);
  }
  return sessions.flatMap(s => signals(s, by.get(s.key) ?? [], opts)).sort((a, b) => b.at - a.at);
}

