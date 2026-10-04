// Derived, factual projections over snapshots. Every item states the observation it comes from; nothing is scored.
import { AgentSessionSnapshot, TimelineEvent } from '../model';

export type Severity = 'high' | 'medium' | 'low';

export interface AttentionItem {
  key: string;
  severity: Severity;
  reason: string;
  /** Which observation produced the item. */
  basis: string;
  at: number;
}

const LIVE = new Set(['RUNNING', 'IDLE', 'NEEDS_INPUT']);
export const isLive = (s: AgentSessionSnapshot) => LIVE.has(s.status);

export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Where a human should look. Sorted by severity then recency. */
export function attention(sessions: AgentSessionSnapshot[], now: number, opts: { idleAlertMinutes?: number } = {}): AttentionItem[] {
  const idleAlert = (opts.idleAlertMinutes ?? 30) * 60_000;
  const today = now - 86400_000;
  const out: AttentionItem[] = [];
  for (const s of sessions) {
    const at = s.lastActivityAt ?? s.startedAt ?? 0;
    const lastTest = s.tests[s.tests.length - 1];
    if (s.status === 'NEEDS_INPUT') out.push({ key: s.key, severity: 'high', reason: 'Waiting for input', basis: s.statusReason, at });
    if (isLive(s) && lastTest?.outcome === 'FAIL') out.push({ key: s.key, severity: 'high', reason: `Last test failed: ${lastTest.command.length > 70 ? lastTest.command.slice(0, 69) + "…" : lastTest.command}`, basis: lastTest.exitCode !== undefined ? `exit code ${lastTest.exitCode}` : 'provider tool error flag', at: lastTest.at });
    const u = s.usage;
    if (isLive(s) && u?.contextTokens && u.contextWindow && u.contextTokens / u.contextWindow >= 0.8)
      out.push({ key: s.key, severity: 'medium', reason: `Context ${Math.round((100 * u.contextTokens) / u.contextWindow)}% full`, basis: 'provider token_count', at });
    if (s.status === 'UNKNOWN' && !s.isWorker && at >= today) out.push({ key: s.key, severity: 'medium', reason: 'Open turn, no recent activity', basis: s.statusReason, at });
    if (s.status === 'IDLE' && !s.isWorker && now - at >= idleAlert) out.push({ key: s.key, severity: 'low', reason: `Idle for ${Math.round((now - at) / 60_000)} min`, basis: s.statusReason, at });
    if (s.status === 'ENDED' && !s.isWorker && at >= today && s.commits.length === 0 && s.changedFiles.length > 0)
      out.push({ key: s.key, severity: 'low', reason: `Ended — ${s.changedFiles.length} file(s) edited, no commit observed`, basis: 'provider file edits; git log over session window', at });
  }
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at);
}

export type StageState = 'done' | 'fail' | 'live' | 'none';
export interface Stage {
  id: 'start' | 'edit' | 'verify' | 'commit' | 'end';
  label: string;
  state: StageState;
  detail: string;
}

/** Lifecycle strip from observed facts only: started → edited → verified → committed → ended. */
export function stages(s: AgentSessionSnapshot): Stage[] {
  const files = s.changedFiles.length;
  const last = s.tests[s.tests.length - 1];
  const live = isLive(s);
  return [
    { id: 'start', label: 'Start', state: 'done', detail: s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : 'start time not exposed' },
    { id: 'edit', label: 'Edit', state: files ? 'done' : 'none', detail: files ? `${files} file(s)` : 'no file edit observed' },
    { id: 'verify', label: 'Verify', state: !last ? 'none' : last.outcome === 'FAIL' ? 'fail' : last.outcome === 'PASS' ? 'done' : 'none', detail: last ? `${s.tests.length} run(s), last ${last.outcome}` : 'no test/build command observed' },
    { id: 'commit', label: 'Commit', state: s.commits.length ? 'done' : 'none', detail: s.commits.length ? `${s.commits.length} commit(s) observed` : 'no commit observed' },
    { id: 'end', label: live ? 'Live' : 'End', state: live ? 'live' : s.status === 'ENDED' ? 'done' : 'none', detail: live ? s.status : s.status === 'ENDED' ? 'ended' : 'status unknown' },
  ];
}

export type Outcome = 'live' | 'committed' | 'changed' | 'nochange';
export const OUTCOME_LABEL: Record<Outcome, string> = { live: 'Still live', committed: 'Commit observed', changed: 'Files edited, no commit', nochange: 'No file change observed' };

export function outcome(s: AgentSessionSnapshot): Outcome {
  if (isLive(s)) return 'live';
  if (s.commits.length) return 'committed';
  if (s.changedFiles.length) return 'changed';
  return 'nochange';
}

export interface FlowLink {
  /** 0: provider → repo, 1: repo → outcome. */
  stage: 0 | 1;
  from: string;
  to: string;
  value: number;
}

/** provider → repository → outcome, for top-level sessions. */
export function flow(sessions: AgentSessionSnapshot[], maxRepos = 8): { providers: string[]; repos: string[]; outcomes: Outcome[]; links: FlowLink[] } {
  const top = sessions.filter(s => !s.isWorker);
  const repoName = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';
  const counts = new Map<string, number>();
  for (const s of top) counts.set(repoName(s), (counts.get(repoName(s)) ?? 0) + 1);
  const keep = new Set([...counts].sort((a, b) => b[1] - a[1]).slice(0, maxRepos).map(([r]) => r));
  const name = (s: AgentSessionSnapshot) => (keep.has(repoName(s)) ? repoName(s) : 'other repos');
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const a = new Map<string, number>(), b = new Map<string, number>();
  for (const s of top) {
    add(a, `${s.provider}\u0000${name(s)}`);
    add(b, `${name(s)}\u0000${outcome(s)}`);
  }
  const links: FlowLink[] = [...[...a].map(e => [0, ...e] as const), ...[...b].map(e => [1, ...e] as const)].map(([stage, k, value]) => {
    const [from, to] = k.split('\u0000');
    return { stage, from, to, value };
  });
  const repos = [...new Set(top.map(name))].sort((x, y) => (x === 'other repos' ? 1 : y === 'other repos' ? -1 : (counts.get(y) ?? 0) - (counts.get(x) ?? 0)));
  return { providers: [...new Set(top.map(s => s.provider))].sort(), repos, outcomes: (['live', 'committed', 'changed', 'nochange'] as Outcome[]).filter(o => top.some(s => outcome(s) === o)), links };
}

/** Observed (non-noise) events per local hour for the last `days` days. rows[0] = oldest day. */
export function hourly(events: TimelineEvent[], now: number, days = 7): { day: number; counts: number[] }[] {
  const start = dayStart(now) - (days - 1) * 86400_000;
  const rows = Array.from({ length: days }, (_, i) => ({ day: start + i * 86400_000, counts: new Array(24).fill(0) as number[] }));
  for (const e of events) {
    if (e.at < start || e.type === 'SESSION_ACTIVITY' || e.type === 'TOOL_ACTIVITY') continue;
    const i = Math.floor((dayStart(e.at) - start) / 86400_000);
    if (rows[i]) rows[i].counts[new Date(e.at).getHours()]++;
  }
  return rows;
}

export interface UsageTotals {
  tokens: number;
  costUSD: number;
  costSessions: number;
  sessions: number;
}

/** Sums provider-recorded usage over sessions active since `since`. Cost only where the provider recorded one. */
export function usageSince(sessions: AgentSessionSnapshot[], since: number): UsageTotals {
  const t: UsageTotals = { tokens: 0, costUSD: 0, costSessions: 0, sessions: 0 };
  for (const s of sessions) {
    if ((s.lastActivityAt ?? 0) < since || !s.usage) continue;
    t.sessions++;
    t.tokens += s.usage.totalTokens;
    if (s.usage.costUSD !== undefined) {
      t.costUSD += s.usage.costUSD;
      t.costSessions++;
    }
  }
  return t;
}

/** Worker role as the provider labels it (Claude subagent type, Codex nickname). */
export function workerRole(s: AgentSessionSnapshot): string {
  return (s.workerLabel ?? '').split(' · ')[0] || 'worker';
}

export function base(p: string | undefined): string {
  return p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '';
}

/** Original Agent identity palette: mid-tone hues readable on dark and light themes. Not used for status. */
export const PALETTE = ['#4f9fd9', '#a07ce0', '#d39a45', '#4fb08a', '#d6739f', '#7486e6', '#3fb5b5', '#c2805a', '#8fa83f', '#b06fc4'];

export function identityColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}
