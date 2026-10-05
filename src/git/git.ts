import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, CommitObservation } from '../model';
import { bounded } from '../util/redact';
import { isPlausibleLocalPath, relTo } from '../util/paths';

/** Config overrides that stop a repository named by an artifact from running its own programs (fsmonitor hooks,
 *  external diff/textconv drivers, pagers, credential prompts). */
export const HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotepath=off', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'credential.helper=', '--no-optional-locks', '--no-pager'];

/** Resolved absolute paths of external tools, by name (cached for the process; `clearExeCache` resets it). */
const exeCache = new Map<string, string | undefined>();

/**
 * Absolute path of `name` found on PATH, or undefined. Never looks in the current directory: on Windows a bare
 * `execFile('git', …, { cwd })` would run a `git.exe` planted in that cwd (a session worktree) before PATH.
 * Only absolute PATH entries are scanned (empty, '.' and relative entries are skipped). On Windows only `.exe` / `.com`
 * are tried: `execFile` cannot start a `.cmd` / `.bat` without a shell, which Agent never uses.
 */
export function findExe(name: string, pathVar: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!/^[A-Za-z0-9][\w.\-]*$/.test(name)) return undefined;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win ? (/\.(exe|com)$/i.test(name) ? [''] : ['.exe', '.com']) : [''];
  for (const raw of (pathVar ?? '').split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // Drive-rooted or UNC on Windows (not "\x" or "C:x", which depend on the current drive / directory).
    if (!dir || (win ? !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(dir) : !p.isAbsolute(dir))) continue;
    for (const ext of exts) {
      const f = p.join(dir, name + ext);
      try {
        if (!fs.statSync(f).isFile()) continue;
        if (!win) fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** `findExe` on this process's PATH, cached per name. Callers report the tool as unavailable when it returns undefined. */
export function resolveExe(name: string): string | undefined {
  if (exeCache.has(name)) return exeCache.get(name);
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH');
  const exe = findExe(name, key ? process.env[key] : undefined);
  exeCache.set(name, exe);
  return exe;
}

export function clearExeCache(): void {
  exeCache.clear();
}

/** Read-only git invocations. Git is the authority for Git; Agent never writes to a repository. */
export const gitStats = { calls: 0, ms: 0, byCmd: {} as Record<string, number> };

function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string | undefined> {
  const t0 = performance.now();
  gitStats.calls++;
  gitStats.byCmd[args[0]] = (gitStats.byCmd[args[0]] ?? 0) + 1;
  return new Promise<string | undefined>(resolve => {
    const exe = resolveExe('git');
    if (!exe) return resolve(undefined);
    execFile(exe, [...HARDEN, ...args], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20, env: gitEnv() }, (err, stdout) => {
      resolve(err ? undefined : stdout.toString());
    });
  }).finally(() => (gitStats.ms += performance.now() - t0));
}

function gitEnv(): NodeJS.ProcessEnv {
  // Minimal env: PATH and profile vars only; never forward tokens.
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[k]) e[k] = process.env[k];
  e.GIT_TERMINAL_PROMPT = '0';
  return e;
}

export interface GitLocation {
  repository: string; // main repo root (common dir parent)
  worktree: string; // this worktree's root
  isLinkedWorktree: boolean;
  branch?: string;
  detachedHead: boolean;
  head?: string;
  dirty?: boolean;
}

const locCache = new Map<string, { at: number; loc?: GitLocation }>();
const inflight = new Map<string, Promise<unknown>>();

/** Concurrent callers for the same key share one promise (many sessions share a cwd). */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = inflight.get(key) as Promise<T> | undefined;
  if (p) return p;
  const q = fn().finally(() => inflight.delete(key));
  inflight.set(key, q);
  return q;
}

export async function locate(cwd: string, maxAgeMs = 30_000, withStatus = true): Promise<GitLocation | undefined> {
  if (!isPlausibleLocalPath(cwd) || !fs.existsSync(cwd)) return undefined;
  const c = locCache.get(cwd);
  if (c && Date.now() - c.at < maxAgeMs && (!withStatus || !c.loc || c.loc.dirty !== undefined)) return c.loc;
  return once(`loc:${cwd}:${withStatus}`, () => locateUncached(cwd, withStatus));
}

async function locateUncached(cwd: string, withStatus: boolean): Promise<GitLocation | undefined> {
  // --abbrev-ref applies to every following argument, so the full HEAD sha must come before it.
  const out = await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', 'HEAD', '--abbrev-ref', 'HEAD']);
  let loc: GitLocation | undefined;
  if (out) {
    const [top, common, head, abbrev] = out.trim().split(/\r?\n/);
    const worktree = path.resolve(top);
    const commonAbs = path.resolve(cwd, common);
    const repository = path.basename(commonAbs) === '.git' ? path.dirname(commonAbs) : commonAbs;
    const status = withStatus ? await git(cwd, ['status', '--porcelain', '-uno']) : undefined;
    loc = {
      repository,
      worktree,
      isLinkedWorktree: path.resolve(repository).toLowerCase() !== worktree.toLowerCase(),
      branch: abbrev && abbrev !== 'HEAD' ? abbrev : undefined,
      detachedHead: abbrev === 'HEAD',
      head: /^[0-9a-f]{40}$/.test(head || '') ? head : undefined,
      dirty: status === undefined ? undefined : status.trim().length > 0,
    };
  }
  locCache.set(cwd, { at: Date.now(), loc });
  return loc;
}

/** Commit HEAD pointed at, at time t (first-parent reflog-free approximation: last commit reachable from HEAD before t). */
export async function headAt(cwd: string, t: number): Promise<string | undefined> {
  const out = await git(cwd, ['rev-list', '-1', `--before=${Math.floor(t / 1000)}`, 'HEAD']);
  const s = out?.trim();
  return s && /^[0-9a-f]{40}$/.test(s) ? s : undefined;
}

function parseLog(out: string): CommitObservation[] {
  return out.trim().split(/\r?\n/).filter(Boolean).map(l => {
    const [sha, ct, ...subj] = l.split('\t');
    return { sha, at: Number(ct) * 1000, subject: bounded(subj.join('\t'), 80), attribution: 'during-session' as const };
  });
}

export async function diffStat(cwd: string, from: string, to: string): Promise<{ files: string[]; added: number; removed: number } | undefined> {
  if (!/^[0-9a-f]{7,40}$/.test(from) || !/^[0-9a-f]{7,40}$/.test(to)) return undefined;
  const out = await git(cwd, ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', `${from}..${to}`]);
  if (out === undefined) return undefined;
  let added = 0, removed = 0;
  const files: string[] = [];
  for (const l of out.trim().split(/\r?\n/).filter(Boolean)) {
    const [a, r, f] = l.split('\t');
    if (a !== '-') added += Number(a) || 0;
    if (r !== '-') removed += Number(r) || 0;
    if (f) files.push(f);
  }
  return { files, added, removed };
}

interface WorktreeLog {
  head: string;
  since: number;
  commits: CommitObservation[]; // newest first
  worktree: string;
  floor?: Promise<string | undefined>; // last commit before `since`, fetched only when needed
}

const logCache = new Map<string, WorktreeLog>();

/** One `git log` per worktree and HEAD over the whole history window, shared by every session in it (spawns are expensive on Windows). */
async function worktreeLog(worktree: string, head: string | undefined, since: number): Promise<WorktreeLog | undefined> {
  const key = worktree.toLowerCase();
  const c = logCache.get(key);
  if (c && c.head === (head ?? '') && c.since <= since) return c;
  return once(`log:${key}:${head}:${since}`, () => worktreeLogUncached(key, worktree, head, since, c));
}

async function worktreeLogUncached(key: string, worktree: string, head: string | undefined, since: number, c: WorktreeLog | undefined): Promise<WorktreeLog | undefined> {
  const from = Math.min(since, c?.since ?? since);
  const out = await git(worktree, ['log', 'HEAD', `--since=${Math.floor(from / 1000)}`, '-n', '2000', '--format=%H%x09%ct%x09%s']);
  if (out === undefined) return undefined;
  const v: WorktreeLog = { head: head ?? '', since: from, commits: parseLog(out), worktree };
  logCache.set(key, v);
  return v;
}

function headAtFromLog(log: WorktreeLog, t: number): Promise<string | undefined> {
  for (const c of log.commits) if (c.at <= t) return Promise.resolve(c.sha);
  return (log.floor ??= headAt(log.worktree, log.since));
}

/** Fill repository/worktree/branch/HEAD/commit fields with git evidence. Mutates and returns the snapshot. */
export async function correlate(s: AgentSessionSnapshot, now = Date.now(), windowStart = now - 4 * 86400_000): Promise<AgentSessionSnapshot> {
  if (!s.cwd) {
    s.evidence.push({ field: 'repository', kind: 'UNKNOWN', source: 'provider exposed no cwd' });
    return s;
  }
  const live = s.status !== 'ENDED' && s.status !== 'UNKNOWN';
  const loc = await locate(s.cwd, 30_000, live);
  if (!loc) {
    s.evidence.push({ field: 'repository', kind: 'UNKNOWN', source: fs.existsSync(s.cwd) ? 'cwd is not inside a git repository' : 'cwd no longer exists (deleted worktree?)' });
    if (!fs.existsSync(s.cwd)) s.diagnostics.push('worktree/cwd no longer exists on disk');
    return s;
  }
  s.repository = loc.repository;
  s.worktree = loc.worktree;
  s.isLinkedWorktree = loc.isLinkedWorktree;
  s.dirty = loc.dirty;
  s.detachedHead = loc.detachedHead;
  s.evidence.push({ field: 'repository', kind: 'DERIVED', source: 'git rev-parse --git-common-dir in session cwd' });
  s.evidence.push({ field: 'worktree', kind: 'DERIVED', source: 'git rev-parse --show-toplevel in session cwd' });
  if (!s.branch) {
    s.branch = loc.branch;
    s.evidence.push({ field: 'branch', kind: loc.branch ? 'DERIVED' : 'UNKNOWN', source: loc.branch ? 'git current branch in cwd (now)' : 'detached HEAD' });
  }
  if (!s.startedAt) return s;
  const end = (live ? now : s.lastActivityAt) ?? now;
  const log = await worktreeLog(loc.worktree, loc.head, Math.min(windowStart, s.startedAt));
  if (!log) return s;
  if (!s.headBefore) {
    s.headBefore = await headAtFromLog(log, s.startedAt);
    if (s.headBefore) s.evidence.push({ field: 'headBefore', kind: 'DERIVED', source: 'last commit on HEAD before session start (git log)' });
  }
  s.headAfter = live ? loc.head : await headAtFromLog(log, end + 60_000);
  if (s.headAfter) s.evidence.push({ field: 'headAfter', kind: 'DERIVED', source: live ? 'git HEAD now' : 'last commit on HEAD before last activity (git log)' });
  const ranCommit = s.evidence.some(e => e.field === 'commit-command');
  s.commits = log.commits
    .filter(c => c.at >= s.startedAt! && c.at <= end + 60_000)
    .slice(0, 50)
    .map(c => ({ ...c, attribution: ranCommit ? 'session-ran-git-commit' : 'during-session' }));
  s.evidence.push({ field: 'commits', kind: 'DERIVED', source: 'git log HEAD within session time window (observed during session, authorship not proven)' });
  // Diff stats only for recent sessions; older history keeps commits without line counts.
  const recent = now - (s.lastActivityAt ?? 0) < 86400_000;
  if (recent && s.commits.length && s.headBefore && s.headAfter && s.headBefore !== s.headAfter) {
    const d = await diffStat(loc.worktree, s.headBefore, s.headAfter);
    if (d) {
      // Provider line counts only cover its edit tools (a shell `printf > file` is invisible to them); git covers both.
      if (!s.linesAdded && !s.linesRemoved) {
        s.linesAdded = d.added;
        s.linesRemoved = d.removed;
        s.evidence.push({ field: 'linesAdded', kind: 'DERIVED', source: 'git diff --numstat headBefore..headAfter' });
      }
      for (const f of d.files) if (!s.changedFiles.includes(f)) s.changedFiles.push(f);
    }
  }
  s.changedFiles = [...new Set(s.changedFiles.map(f => relTo(loc.worktree, f)))];
  return s;
}

export function clearGitCache(): void {
  locCache.clear();
  logCache.clear();
}
