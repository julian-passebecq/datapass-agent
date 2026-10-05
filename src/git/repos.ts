// Multi-repository Git overview for the "Repositories" screen: branches with ahead / behind, worktrees with
// dirty counts, recent commits and stash counts for every repository agents touched.
// Read-only: only rev-parse, worktree list, for-each-ref, status, log and rev-list run, hardened (HARDEN),
// with a minimal environment and a 5 s timeout each. Nothing fetches, checks out or writes.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../model';
import { HARDEN, resolveExe } from './git';
import { bounded } from '../util/redact';
import { isPlausibleLocalPath } from '../util/paths';

export interface DirtyCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  /** The repository's main worktree (first entry of `git worktree list`). */
  main: boolean;
  exists: boolean;
  /** Undefined when status was not read (cap reached, missing on disk, or git failed). */
  dirty?: DirtyCounts;
}

export interface BranchInfo {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Upstream configured but deleted on the remote. */
  gone: boolean;
  sha: string;
  at: number;
  subject: string;
  /** Worktree path that has this branch checked out. */
  worktree?: string;
}

export interface CommitInfo {
  sha: string;
  at: number;
  refs: string[];
  subject: string;
}

export interface RepoInfo {
  repository: string;
  name: string;
  worktrees: WorktreeInfo[];
  branches: BranchInfo[];
  commits: CommitInfo[];
  stashes: number;
  ms: number;
  error?: string;
}

export interface ReposSnapshot {
  at: number;
  repos: RepoInfo[];
  /** Why nothing was read ('untrusted'), if so. */
  off?: string;
  /** Repositories left out by the agent.repos.maxRepos cap. */
  skipped: number;
  gitCalls: number;
}

export interface ReposOptions {
  maxRepos: number;
  maxWorktrees: number;
  commits: number;
  untracked: boolean;
  extra: string[];
  timeoutMs: number;
}

export const REPOS_DEFAULTS: ReposOptions = { maxRepos: 20, maxWorktrees: 24, commits: 8, untracked: true, extra: [], timeoutMs: 5_000 };

export type GitRunner = (cwd: string, args: string[]) => Promise<string | undefined>;

function minimalEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[k]) e[k] = process.env[k];
  e.GIT_TERMINAL_PROMPT = '0';
  e.GIT_OPTIONAL_LOCKS = '0';
  return e;
}

const READ_ONLY = new Set(['rev-parse', 'worktree', 'for-each-ref', 'status', 'log', 'rev-list']);

/** Hardened, read-only git runner. Refuses any sub-command outside the read-only list and `worktree list`. */
export function hardenedGit(timeoutMs = 5_000, counter?: { calls: number }): GitRunner {
  return (cwd, args) => {
    if (!READ_ONLY.has(args[0]) || (args[0] === 'worktree' && args[1] !== 'list')) return Promise.resolve(undefined);
    if (counter) counter.calls++;
    return new Promise(resolve => {
      const exe = resolveExe('git');
      if (!exe) return resolve(undefined);
      execFile(exe, [...HARDEN, ...args], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20, env: minimalEnv() }, (err, stdout) => resolve(err ? undefined : stdout.toString()));
    });
  };
}

// ---------------------------------------------------------------- parsers (pure, tested)

/** `git worktree list --porcelain` */
export function parseWorktrees(out: string): WorktreeInfo[] {
  const res: WorktreeInfo[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('worktree ')) continue;
    const w: WorktreeInfo = { path: path.resolve(lines[0].slice(9)), detached: false, bare: false, locked: false, prunable: false, main: res.length === 0, exists: true };
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) w.head = l.slice(5);
      else if (l.startsWith('branch ')) w.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'detached') w.detached = true;
      else if (l === 'bare') w.bare = true;
      else if (l === 'locked' || l.startsWith('locked ')) w.locked = true;
      else if (l === 'prunable' || l.startsWith('prunable ')) w.prunable = true;
    }
    res.push(w);
  }
  return res;
}

export const BRANCH_FORMAT = '%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(objectname:short)%09%(committerdate:unix)%09%(contents:subject)';

/** `git for-each-ref refs/heads --format=BRANCH_FORMAT` */
export function parseBranches(out: string): BranchInfo[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [name, upstream, track, sha, ct, ...subj] = l.split('\t');
      const ahead = /ahead (\d+)/.exec(track ?? '');
      const behind = /behind (\d+)/.exec(track ?? '');
      const gone = /gone/.test(track ?? '');
      const b: BranchInfo = { name, sha: sha ?? '', at: Number(ct) * 1000 || 0, subject: bounded(subj.join('\t'), 80), gone };
      if (upstream) {
        b.upstream = upstream;
        if (!gone) {
          b.ahead = ahead ? Number(ahead[1]) : 0;
          b.behind = behind ? Number(behind[1]) : 0;
        }
      }
      return b;
    })
    .filter(b => b.name);
}

/** `git status --porcelain=v1 -z` */
export function parseStatus(out: string): DirtyCounts {
  const c: DirtyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 3) continue;
    const x = e[0], y = e[1];
    if (x === 'R' || x === 'C') i++; // rename / copy: the next entry is the source path
    if (x === '?' && y === '?') c.untracked++;
    else if (x === '!') continue;
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) c.conflicts++;
    else {
      if (x !== ' ') c.staged++;
      if (y !== ' ') c.unstaged++;
    }
  }
  return c;
}

/** `git log --format=%h%x09%ct%x09%D%x09%s` */
export function parseCommits(out: string): CommitInfo[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [sha, ct, refs, ...subj] = l.split('\t');
      return { sha, at: Number(ct) * 1000 || 0, refs: (refs ?? '').split(',').map(r => r.trim().replace(/^HEAD -> /, '')).filter(r => r && r !== 'HEAD' && !r.startsWith('tag: ') && r !== 'refs/stash'), subject: bounded(subj.join('\t'), 80) };
    });
}

export const isDirty = (d?: DirtyCounts) => !!d && d.staged + d.unstaged + d.untracked + d.conflicts > 0;

// Canonical form of an existing path: Windows 8.3 short names (C:\Users\RUNNER~1), junctions and symlinks are
// expanded, so a session cwd under %TEMP% and the long path Git records for a linked worktree compare equal.
const canonCache = new Map<string, string>();
function canonical(p: string): string {
  const abs = path.resolve(p);
  let c = canonCache.get(abs);
  if (c === undefined) {
    try {
      c = fs.realpathSync.native(abs);
    } catch {
      c = abs;
    }
    if (canonCache.size > 500) canonCache.clear();
    canonCache.set(abs, c);
  }
  return c;
}

const norm = (p: string) => canonical(p).replace(/[\\/]+$/, '').toLowerCase();

/** Worktree (longest path prefix) a session works in, or undefined. */
export function worktreeOf(s: AgentSessionSnapshot, worktrees: { path: string }[]): string | undefined {
  const cands = [s.worktree, s.cwd].filter((p): p is string => !!p).map(norm);
  let best: string | undefined;
  let len = -1;
  for (const w of worktrees) {
    const wp = norm(w.path);
    if (cands.some(c => c === wp || c.startsWith(wp + path.sep) || c.startsWith(wp + '/')) && wp.length > len) {
      best = w.path;
      len = wp.length;
    }
  }
  return best;
}

// ---------------------------------------------------------------- loader

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Repository root (parent of the common .git dir) for a path inside a repository. */
async function rootOf(run: GitRunner, cwd: string): Promise<string | undefined> {
  const out = await run(cwd, ['rev-parse', '--git-common-dir']);
  if (!out) return undefined;
  const common = canonical(path.resolve(cwd, out.trim()));
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

/** Repositories ordered by most recent session activity (live first), then extra paths from settings. */
export async function discoverRepos(sessions: AgentSessionSnapshot[], run: GitRunner, extra: string[] = []): Promise<string[]> {
  const score = new Map<string, number>();
  const label = new Map<string, string>();
  const add = (p: string, s: number) => {
    const k = norm(p);
    if (!label.has(k)) label.set(k, path.resolve(p));
    score.set(k, Math.max(score.get(k) ?? -Infinity, s));
  };
  const unresolved = new Map<string, number>();
  for (const s of sessions) {
    const sc = (s.status !== 'ENDED' && s.status !== 'UNKNOWN' ? 1e15 : 0) + (s.lastActivityAt ?? 0);
    if (s.repository) add(s.repository, sc);
    else if (s.cwd && isPlausibleLocalPath(s.cwd)) unresolved.set(s.cwd, Math.max(unresolved.get(s.cwd) ?? 0, sc));
  }
  const cwds = [...unresolved].filter(([c]) => fs.existsSync(c)).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const roots = await pool(cwds, 4, ([c]) => rootOf(run, c));
  roots.forEach((r, i) => r && add(r, cwds[i][1]));
  const ordered = [...score].sort((a, b) => b[1] - a[1]).map(([k]) => label.get(k)!);
  for (const e of extra) {
    if (!isPlausibleLocalPath(e) || !fs.existsSync(e)) continue;
    const r = await rootOf(run, e);
    if (r && !score.has(norm(r))) {
      score.set(norm(r), -1);
      ordered.push(r);
    }
  }
  return ordered;
}

export async function readRepo(repository: string, run: GitRunner, o: ReposOptions, priority: (wt: string) => number = () => 0): Promise<RepoInfo> {
  const t0 = Date.now();
  const info: RepoInfo = { repository, name: path.basename(repository), worktrees: [], branches: [], commits: [], stashes: 0, ms: 0 };
  if (!fs.existsSync(repository)) {
    info.error = 'repository folder no longer exists';
    return info;
  }
  const [wl, br, lg, st] = await Promise.all([
    run(repository, ['worktree', 'list', '--porcelain']),
    run(repository, ['for-each-ref', 'refs/heads', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate']),
    o.commits > 0 ? run(repository, ['log', '--branches', `-n`, String(o.commits), '--format=%h%x09%ct%x09%D%x09%s']) : Promise.resolve(''),
    run(repository, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']),
  ]);
  if (wl === undefined && br === undefined) {
    info.error = 'git could not read this repository (timeout or not a repository)';
    info.ms = Date.now() - t0;
    return info;
  }
  info.worktrees = parseWorktrees(wl ?? '').filter(w => !w.bare);
  info.branches = parseBranches(br ?? '');
  info.commits = parseCommits(lg ?? '');
  info.stashes = Number(st?.trim()) || 0;
  for (const w of info.worktrees) w.exists = fs.existsSync(w.path);
  const byBranch = new Map(info.worktrees.filter(w => w.branch).map(w => [w.branch!, w.path]));
  for (const b of info.branches) b.worktree = byBranch.get(b.name);
  // Status for the most relevant worktrees first (live sessions, main), capped.
  const order = info.worktrees.filter(w => w.exists && !w.prunable).sort((a, b) => priority(b.path) - priority(a.path) || Number(b.main) - Number(a.main));
  const pick = order.slice(0, Math.max(0, o.maxWorktrees));
  const statuses = await pool(pick, 4, w => run(w.path, ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=dirty', o.untracked ? '-unormal' : '-uno']));
  pick.forEach((w, i) => {
    const s = statuses[i];
    if (s !== undefined) w.dirty = parseStatus(s);
  });
  info.ms = Date.now() - t0;
  return info;
}

export async function loadRepos(sessions: AgentSessionSnapshot[], o: ReposOptions, run?: GitRunner, now = Date.now()): Promise<ReposSnapshot> {
  const counter = { calls: 0 };
  const git = run ?? hardenedGit(o.timeoutMs, counter);
  const all = await discoverRepos(sessions, git, o.extra);
  const keep = all.slice(0, Math.max(1, o.maxRepos));
  const live = sessions.filter(s => s.status !== 'ENDED' && s.status !== 'UNKNOWN');
  const repos = await pool(keep, 4, r =>
    readRepo(r, git, o, wt => {
      const k = norm(wt);
      return live.filter(s => [s.worktree, s.cwd].some(p => p && norm(p).startsWith(k))).length;
    }),
  );
  return { at: now, repos, skipped: all.length - keep.length, gitCalls: counter.calls };
}
