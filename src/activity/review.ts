// Review pipeline: where each piece of agent work stands between "agent is working" and "merged".
// Pure projection of snapshots + timeline events (+ PR / MR state when the opt-in feed loaded it).
// Every lane carries the observation it comes from and its evidence kind; nothing is scored.
import type { AgentSessionSnapshot, EvidenceKind, TimelineEvent } from '../model';
import type { Forge, PrInfo } from '../feeds/review';
import { isLive } from './insights';
import { duration } from './activity';
import { normalizeCase } from '../util/paths';

export type Lane = 'needs' | 'working' | 'cifail' | 'review' | 'ready' | 'local' | 'merged' | 'quiet';
export const LANES: Lane[] = ['needs', 'working', 'cifail', 'review', 'ready', 'local', 'merged', 'quiet'];
export const LANE_LABEL: Record<Lane, string> = {
  needs: 'Needs you', working: 'Working', cifail: 'CI failed', review: 'In review', ready: 'Ready to merge', local: 'No PR yet', merged: 'Merged', quiet: 'No change',
};
export const LANE_HINT: Record<Lane, string> = {
  needs: 'Waiting for input, turn ended and waiting for your next prompt, or last local test failed.',
  working: 'The session or one of its workers is running now.',
  cifail: 'A PR / MR of this branch has a failing check or pipeline.',
  review: 'PR / MR open (or its creation observed) and not yet mergeable: draft, CI running, review required, conflict.',
  ready: 'PR / MR open, checks passed (or none), forge reports it mergeable, no change request.',
  local: 'Commits or edits observed, no PR / MR found for the branch.',
  merged: 'PR / MR merged (forge state) or a merge command observed.',
  quiet: 'Ended with no file change observed.',
};

// ---------------------------------------------------------------- commands

export type MarkKind = 'push' | 'pr-create' | 'pr-merge' | 'ci-watch';
export interface CmdMark {
  kind: MarkKind;
  at: number;
  sessionKey: string;
  forge?: Forge;
  head?: string;
  base?: string;
  number?: number;
  /** owner/name from --repo / -R on gh / glab commands. */
  slug?: string;
  /** Provider recorded a non-zero exit / failure for the command. */
  failed: boolean;
  label: string;
}

/** Shell-like split: whitespace, single and double quotes. */
function tokens(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function flag(tk: string[], names: string[]): string | undefined {
  for (let i = 0; i < tk.length; i++) {
    for (const n of names) {
      if (tk[i] === n && tk[i + 1] !== undefined && !tk[i + 1].startsWith('-')) return tk[i + 1];
      if (n.startsWith('--') && tk[i].startsWith(n + '=')) return tk[i].slice(n.length + 1);
    }
  }
  return undefined;
}

/** Positional arguments: drops flags (and the value of flags that take one) and redirections. */
function positional(tk: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tk.length; i++) {
    if (tk[i].startsWith('-')) {
      if (valueFlags.has(tk[i])) i++;
      continue;
    }
    if (/[<>]/.test(tk[i])) continue;
    out.push(tk[i]);
  }
  return out;
}
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const MERGE_VALUE_FLAGS = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '--match-head-commit', '-A', '--author-email', '-m', '--message', '--sha']);

/** owner/name from --repo / -R (a host prefix is dropped). */
function repoFlag(tk: string[]): string | undefined {
  const r = flag(tk, ['--repo', '-R']);
  if (!r) return undefined;
  const x = r.replace(/^https?:\/\//, '').replace(/\.git$/, '').split('/');
  const slug = (x.length > 2 && x[0].includes('.') ? x.slice(1) : x).join('/');
  return /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(slug) ? slug : undefined;
}

const BRANCH_OK =/^[A-Za-z0-9._\/-]{1,200}$/;
const cleanBranch = (b: string | undefined) => {
  if (!b) return undefined;
  const x = b.replace(/^\+/, '').replace(/^[^:]*:/, '').replace(/^refs\/heads\//, '');
  return BRANCH_OK.test(x) && x !== 'HEAD' ? x : undefined;
};

/** Git push / PR create / merge / CI-watch commands inside one recorded command label ("$ …", chains allowed). */
export function parseCommand(label: string): Omit<CmdMark, 'at' | 'sessionKey'>[] {
  const cmd = label.replace(/^\$\s*/, '');
  const failed = /→\s*(exit\s+[1-9]\d*|failed)/.test(cmd);
  const body = cmd.replace(/\s+→\s*(exit\s+-?\d+|failed).*$/, '');
  const out: Omit<CmdMark, 'at' | 'sessionKey'>[] = [];
  for (const seg of body.split(/&&|\|\||;|\|/)) {
    const s = seg.trim();
    let m: RegExpExecArray | null;
    if ((m = /\bgit(?:\.exe)?\s+(?:-[cC]\s+\S+\s+)*push\b(.*)$/i.exec(s))) {
      const pos = positional(tokens(m[1]), PUSH_VALUE_FLAGS);
      out.push({ kind: 'push', head: cleanBranch(pos[1]), failed, label: s.slice(0, 120) });
    } else if ((m = /\bgh(?:\.exe)?\s+pr\s+create\b(.*)$/i.exec(s))) {
      const tk = tokens(m[1]);
      out.push({ kind: 'pr-create', forge: 'github', slug: repoFlag(tk), head: cleanBranch(flag(tk, ['--head', '-H'])), base: cleanBranch(flag(tk, ['--base', '-B'])), failed, label: s.slice(0, 120) });
    } else if ((m = /\bglab(?:\.exe)?\s+mr\s+create\b(.*)$/i.exec(s))) {
      const tk = tokens(m[1]);
      out.push({ kind: 'pr-create', forge: 'gitlab', slug: repoFlag(tk), head: cleanBranch(flag(tk, ['--source-branch', '-s'])), base: cleanBranch(flag(tk, ['--target-branch', '-b'])), failed, label: s.slice(0, 120) });
    } else if ((m = /\b(gh|glab)(?:\.exe)?\s+(pr|mr)\s+merge\b(.*)$/i.exec(s))) {
      const tk = tokens(m[3]);
      const pos = positional(tk, MERGE_VALUE_FLAGS);
      const n = pos[0] && /^!?#?\d{1,7}$/.test(pos[0]) ? Number(pos[0].replace(/[!#]/g, '')) : undefined;
      out.push({ kind: 'pr-merge', forge: m[1].toLowerCase() === 'gh' ? 'github' : 'gitlab', number: n, slug: repoFlag(tk), head: n === undefined ? cleanBranch(pos[0]) : undefined, failed, label: s.slice(0, 120) });
    } else if (/\bgh(?:\.exe)?\s+(pr\s+checks|run\s+(watch|view))\b|\bglab(?:\.exe)?\s+(ci\s+(status|view|list)|mr\s+view)\b/i.test(s)) {
      out.push({ kind: 'ci-watch', failed, label: s.slice(0, 120) });
    }
  }
  return out;
}

/** Marks per session key, oldest first. */
export function commandMarks(events: TimelineEvent[]): Map<string, CmdMark[]> {
  const by = new Map<string, CmdMark[]>();
  for (const e of events) {
    if (e.type !== 'PROCESS_ACTIVITY' && e.type !== 'GIT_CHANGE') continue;
    if (!/\b(push|pr|mr|run|ci)\b/.test(e.label)) continue;
    for (const m of parseCommand(e.label)) {
      const arr = by.get(e.sessionKey) ?? [];
      arr.push({ ...m, at: e.at, sessionKey: e.sessionKey });
      by.set(e.sessionKey, arr);
    }
  }
  for (const arr of by.values()) arr.sort((a, b) => a.at - b.at);
  return by;
}

// ---------------------------------------------------------------- items

export type StepState = 'done' | 'fail' | 'live' | 'none';
export interface Step {
  id: 'edit' | 'test' | 'commit' | 'push' | 'pr' | 'ci' | 'review' | 'merge';
  label: string;
  state: StepState;
  detail: string;
  kind: EvidenceKind;
}

export interface ReviewItem {
  s: AgentSessionSnapshot;
  lane: Lane;
  reason: string;
  basis: string;
  kind: EvidenceKind;
  branch?: string;
  pr?: PrInfo;
  /** Other PRs matched on the same branch (older, other remote). */
  otherPrs: PrInfo[];
  marks: CmdMark[];
  workers: number;
  liveWorkers: number;
  files: number;
  commits: number;
  /** Last activity of the session and its rolled-up workers. */
  at: number;
  steps: Step[];
}

export interface ReviewOpts {
  idleAlertMinutes?: number;
  /** undefined: PR state not loaded (opt-in off, untrusted, or not loaded yet). */
  prs?: PrInfo[];
}

const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'HEAD']);

function branchesOf(s: AgentSessionSnapshot, marks: CmdMark[]): string[] {
  const out = new Set<string>();
  // Newest command first: the branch the session worked on last leads.
  for (const m of [...marks].reverse()) if (m.head && (m.kind === 'pr-create' || m.kind === 'push') && !m.failed && !BASE_BRANCHES.has(m.head)) out.add(m.head);
  for (const b of [s.branch, s.facts?.recordedBranch]) if (b && !BASE_BRANCHES.has(b)) out.add(b);
  return [...out];
}

/**
 * PRs whose head is one of the session's branches, in the session's repository or in a repo named by its own
 * `gh pr create --repo` / `glab mr create -R`; newest first. Merge commands do not link PRs (a PM merging
 * other sessions' PRs does not own them).
 */
export function matchPrs(s: AgentSessionSnapshot, marks: CmdMark[], prs: PrInfo[]): PrInfo[] {
  const repo = s.repository ? normalizeCase(s.repository) : undefined;
  const slugs = new Set(marks.filter(m => m.kind === 'pr-create' && m.slug).map(m => m.slug!.toLowerCase()));
  if (!repo && !slugs.size) return [];
  const br = new Set(branchesOf(s, marks));
  const startedAt = s.startedAt ?? 0;
  return prs
    .filter(p => br.has(p.head) && ((repo !== undefined && normalizeCase(p.repo) === repo) || slugs.has(p.slug.toLowerCase())))
    // A branch name reused long before this session is someone else's PR.
    .filter(p => p.state === 'open' || p.state === 'draft' || (p.updatedAt ?? Infinity) >= startedAt - 3600_000)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function steps(files: number, commits: number, lastTest: AgentSessionSnapshot['tests'][number] | undefined, marks: CmdMark[], pr: PrInfo | undefined, prsLoaded: boolean): Step[] {
  const push = [...marks].reverse().find(m => m.kind === 'push');
  const create = [...marks].reverse().find(m => m.kind === 'pr-create');
  const merge = [...marks].reverse().find(m => m.kind === 'pr-merge');
  const tm = (t: number) => new Date(t).toLocaleString();
  const prDetail = pr ? `${pr.forge === 'gitlab' ? 'MR !' : 'PR #'}${pr.number} ${pr.state} on ${pr.remote} (${pr.slug})` : '';
  const out: Step[] = [
    { id: 'edit', label: 'Edit', state: files ? 'done' : 'none', detail: files ? `${files} file(s) edited` : 'no file edit observed', kind: files ? 'OBSERVED' : 'UNKNOWN' },
    {
      id: 'test', label: 'Test', state: !lastTest ? 'none' : lastTest.outcome === 'PASS' ? 'done' : lastTest.outcome === 'FAIL' ? 'fail' : 'none',
      detail: lastTest ? `last: ${lastTest.command} → ${lastTest.outcome}` : 'no test / build command observed', kind: lastTest ? 'OBSERVED' : 'UNKNOWN',
    },
    { id: 'commit', label: 'Commit', state: commits ? 'done' : 'none', detail: commits ? `${commits} commit(s) in the session window (git log)` : 'no commit observed', kind: commits ? 'DERIVED' : 'UNKNOWN' },
    {
      id: 'push', label: 'Push', state: push ? (push.failed ? 'fail' : 'done') : pr ? 'done' : 'none',
      detail: push ? `${push.label} · ${tm(push.at)}${push.failed ? ' · command failed' : ''}` : pr ? `branch on ${pr.remote} (PR exists)` : 'no push command observed',
      kind: push ? 'OBSERVED' : pr ? 'DERIVED' : 'UNKNOWN',
    },
    {
      id: 'pr', label: 'PR', state: pr ? (pr.state === 'merged' ? 'done' : pr.state === 'closed' ? 'fail' : 'live') : create ? (create.failed ? 'fail' : 'done') : 'none',
      detail: pr ? `${prDetail}: ${pr.title}` : create ? `${create.label} · ${tm(create.at)}${create.failed ? ' · command failed' : prsLoaded ? ' · no matching PR found on the forge' : ' · PR state not loaded'}` : 'no PR / MR found or created',
      kind: pr ? 'OBSERVED' : create ? 'OBSERVED' : 'UNKNOWN',
    },
    {
      id: 'ci', label: 'CI', state: !pr ? 'none' : pr.ci === 'pass' ? 'done' : pr.ci === 'fail' ? 'fail' : pr.ci === 'pending' ? 'live' : 'none',
      detail: !pr ? 'no PR state' : pr.ci === 'none' ? 'no check reported' : `${pr.ci}${pr.failing.length ? ` · failing: ${pr.failing.join(', ')}` : ''}${pr.pending.length ? ` · pending: ${pr.pending.join(', ')}` : ''}`,
      kind: pr ? 'OBSERVED' : 'UNKNOWN',
    },
    {
      id: 'review', label: 'Review', state: !pr ? 'none' : pr.review === 'approved' ? 'done' : pr.review === 'changes' ? 'fail' : pr.review === 'required' ? 'live' : 'none',
      detail: !pr ? 'no PR state' : pr.review === 'none' ? 'no review decision recorded' : `review ${pr.review}`, kind: pr ? 'OBSERVED' : 'UNKNOWN',
    },
    {
      id: 'merge', label: 'Merge', state: pr?.state === 'merged' || (merge && !merge.failed && !pr) ? 'done' : pr && pr.mergeable === 'conflict' ? 'fail' : 'none',
      detail: pr?.state === 'merged' ? `merged${pr.mergedAt ? ' ' + tm(pr.mergedAt) : ''}` : merge && !pr ? `${merge.label} · ${tm(merge.at)}` : pr ? `mergeable: ${pr.mergeDetail ?? pr.mergeable}` : 'not merged',
      kind: pr ? 'OBSERVED' : merge ? 'OBSERVED' : 'UNKNOWN',
    },
  ];
  return out;
}

function laneOf(it: Omit<ReviewItem, 'lane' | 'reason' | 'basis' | 'kind'>, s: AgentSessionSnapshot, lastTest: AgentSessionSnapshot['tests'][number] | undefined, now: number, opts: ReviewOpts): { lane: Lane; reason: string; basis: string; kind: EvidenceKind } {
  const pr = it.pr;
  if (s.status === 'NEEDS_INPUT') return { lane: 'needs', reason: 'Waiting for your input', basis: s.statusReason, kind: 'INFERRED' };
  if (s.status === 'RUNNING' || it.liveWorkers > 0) {
    const cur = s.facts?.currentTool;
    const what = cur ? `${cur.name}${cur.detail ? ': ' + cur.detail : ''}` : s.lastAction ?? 'running';
    return { lane: 'working', reason: it.liveWorkers && s.status !== 'RUNNING' ? `${it.liveWorkers} worker(s) running · ${what}` : what, basis: s.statusReason, kind: cur ? 'OBSERVED' : 'INFERRED' };
  }
  if (pr && pr.state !== 'closed') {
    const ref = `${pr.forge === 'gitlab' ? 'MR !' : 'PR #'}${pr.number}`;
    const basis = `${pr.forge === 'gitlab' ? 'glab mr' : 'gh pr'} state of ${pr.slug} · head ${pr.head}`;
    if (pr.state === 'merged') return { lane: 'merged', reason: `${ref} merged into ${pr.base}`, basis, kind: 'OBSERVED' };
    if (pr.ci === 'fail') return { lane: 'cifail', reason: `${ref}: ${pr.failing.length ? pr.failing.join(', ') : 'checks'} failed`, basis, kind: 'OBSERVED' };
    if (pr.state === 'draft') return { lane: 'review', reason: `${ref} is a draft`, basis, kind: 'OBSERVED' };
    if (pr.mergeable === 'conflict') return { lane: 'review', reason: `${ref} has a merge conflict`, basis, kind: 'OBSERVED' };
    if (pr.review === 'changes') return { lane: 'review', reason: `${ref}: changes requested`, basis, kind: 'OBSERVED' };
    if (pr.ci === 'pending') return { lane: 'review', reason: `${ref}: CI running (${pr.pending.join(', ') || 'checks'})`, basis, kind: 'OBSERVED' };
    if (pr.review === 'required') return { lane: 'review', reason: `${ref}: review required`, basis, kind: 'OBSERVED' };
    if (pr.mergeable === 'yes') return { lane: 'ready', reason: `${ref}: ${pr.ci === 'pass' ? 'checks passed' : 'no checks'} · mergeable`, basis, kind: 'OBSERVED' };
    return { lane: 'review', reason: `${ref} open · mergeable ${pr.mergeDetail ?? 'unknown'}`, basis, kind: 'OBSERVED' };
  }
  const idleAlert = (opts.idleAlertMinutes ?? 30) * 60_000;
  const merge = [...it.marks].reverse().find(m => m.kind === 'pr-merge' && !m.failed);
  const create = [...it.marks].reverse().find(m => m.kind === 'pr-create' && !m.failed);
  if (s.status === 'IDLE') {
    const gap = now - it.at;
    if (!create) return { lane: 'needs', reason: `Turn ended ${duration(gap)} ago, waiting for your next prompt${gap >= idleAlert ? ' (over the idle alert)' : ''}`, basis: s.statusReason, kind: 'INFERRED' };
  }
  if (s.status === 'UNKNOWN' && !s.isWorker && now - it.at < 86400_000) return { lane: 'needs', reason: 'Open turn, no recent activity', basis: s.statusReason, kind: 'INFERRED' };
  if (merge && (!create || merge.at >= create.at)) return { lane: 'merged', reason: `Merge command observed${merge.number !== undefined ? ` (#${merge.number})` : ''}`, basis: merge.label, kind: 'OBSERVED' };
  if (create) return { lane: 'review', reason: `${create.forge === 'gitlab' ? 'MR' : 'PR'} created${create.head ? ` from ${create.head}` : ''}${opts.prs ? ', not found on the forge' : '; state not loaded'}`, basis: create.label, kind: 'OBSERVED' };
  if (lastTest?.outcome === 'FAIL') return { lane: 'needs', reason: `Last test failed: ${lastTest.command}`, basis: lastTest.exitCode !== undefined ? `exit code ${lastTest.exitCode}` : 'provider tool error flag', kind: 'OBSERVED' };
  const pushed = it.marks.some(m => m.kind === 'push' && !m.failed);
  if (it.commits) return { lane: 'local', reason: `${it.commits} commit(s)${pushed ? ', pushed' : ''}, no PR / MR${opts.prs ? ' on the forge' : ' observed'}${pr ? ` (PR #${pr.number} closed)` : ''}`, basis: pushed ? 'git log in session window + push command' : 'git log in session window', kind: 'DERIVED' };
  if (it.files) return { lane: 'local', reason: `${it.files} file(s) edited, no commit observed`, basis: 'provider file edits; git log over session window', kind: 'OBSERVED' };
  if (isLive(s)) return { lane: 'working', reason: s.lastAction ?? 'live', basis: s.statusReason, kind: 'INFERRED' };
  return { lane: 'quiet', reason: 'No file change observed', basis: 'provider file edits; git log', kind: 'OBSERVED' };
}

/**
 * One item per top-level session, plus workers that carry their own deliverable (own branch with a PR, or
 * their own push / PR command). Other workers roll up into their lead (files, tests, live state).
 */
export function reviewItems(sessions: AgentSessionSnapshot[], events: TimelineEvent[], now: number, opts: ReviewOpts = {}): ReviewItem[] {
  const marks = commandMarks(events);
  const byKey = new Map(sessions.map(s => [s.key, s]));
  const prs = opts.prs ?? [];
  const own = (s: AgentSessionSnapshot): boolean => {
    if (!s.isWorker) return true;
    const parent = s.parentSessionId ? byKey.get(s.parentSessionId) : undefined;
    if (!parent) return s.changedFiles.length > 0 || s.commits.length > 0 || (marks.get(s.key)?.length ?? 0) > 0;
    const m = marks.get(s.key) ?? [];
    if (m.some(x => x.kind === 'pr-create' || x.kind === 'push' || x.kind === 'pr-merge')) return true;
    return !!s.branch && s.branch !== parent.branch && matchPrs(s, m, prs).length > 0;
  };
  const roots = sessions.filter(own);
  const rootSet = new Set(roots.map(s => s.key));
  const kids = new Map<string, AgentSessionSnapshot[]>();
  for (const s of sessions) {
    if (rootSet.has(s.key)) continue;
    // Walk up to the nearest item (nested workers).
    let p = s.parentSessionId ? byKey.get(s.parentSessionId) : undefined;
    let guard = 0;
    while (p && !rootSet.has(p.key) && guard++ < 10) p = p.parentSessionId ? byKey.get(p.parentSessionId) : undefined;
    if (!p) continue;
    kids.set(p.key, [...(kids.get(p.key) ?? []), s]);
  }
  const out: ReviewItem[] = [];
  for (const s of roots) {
    const ks = kids.get(s.key) ?? [];
    const all = [s, ...ks];
    const m = all.flatMap(x => marks.get(x.key) ?? []).sort((a, b) => a.at - b.at);
    const matched = matchPrs(s, m, prs);
    // Prefer an open PR over an older merged one on the same branch.
    const pr = matched.find(p => p.state === 'open' || p.state === 'draft') ?? matched[0];
    const files = new Set(all.flatMap(x => x.changedFiles)).size;
    const commits = new Set(all.flatMap(x => x.commits.map(c => c.sha))).size;
    const tests = all.flatMap(x => x.tests).sort((a, b) => a.at - b.at);
    const lastTest = tests[tests.length - 1];
    const at = Math.max(...all.map(x => x.lastActivityAt ?? x.startedAt ?? 0));
    const base = {
      s, branch: branchesOf(s, m)[0] ?? s.branch, pr, otherPrs: matched.filter(p => p !== pr), marks: m,
      workers: ks.length, liveWorkers: ks.filter(k => k.status === 'RUNNING').length, files, commits, at,
      steps: steps(files, commits, lastTest, m, pr, opts.prs !== undefined),
    };
    out.push({ ...base, ...laneOf(base, s, lastTest, now, opts) });
  }
  const rank = new Map(LANES.map((l, i) => [l, i]));
  return out.sort((a, b) => rank.get(a.lane)! - rank.get(b.lane)! || b.at - a.at);
}

/** Open PRs / MRs no listed item points at (other worktrees, humans, sessions outside the window). */
export function unlinkedPrs(items: ReviewItem[], prs: PrInfo[]): PrInfo[] {
  const used = new Set(items.flatMap(i => [i.pr, ...i.otherPrs]).filter(Boolean).map(p => `${p!.forge}:${p!.slug}#${p!.number}`));
  return prs.filter(p => (p.state === 'open' || p.state === 'draft') && !used.has(`${p.forge}:${p.slug}#${p.number}`)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
