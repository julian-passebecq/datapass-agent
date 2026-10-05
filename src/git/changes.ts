// Read-only git collection for the "Changes" screen: per-file +/- over each session's commit window
// (git diff --numstat headBefore..headAfter) and uncommitted work per worktree (staged, unstaged, untracked).
// Hardened like src/git/git.ts (HARDEN, minimal env, no prompts), 5 s timeout per call, never writes.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../model';
import { HARDEN } from './git';
import { isPlausibleLocalPath } from '../util/paths';

export interface NumstatRow {
  /** Repo-relative path, forward slashes. */
  path: string;
  added: number;
  removed: number;
  /** git reports "-" for binary files: no line counts. */
  binary?: boolean;
}

export interface SessionDiff {
  key: string;
  worktree: string;
  from: string;
  to: string;
  files: NumstatRow[];
}

export type WtFileState = 'staged' | 'unstaged' | 'both' | 'untracked' | 'conflict';

export interface WorktreeChanges {
  worktree: string;
  repository?: string;
  branch?: string;
  staged: NumstatRow[];
  unstaged: NumstatRow[];
  untracked: string[];
  conflicts: string[];
  /** Session keys whose worktree this is (live first). */
  sessions: string[];
  at: number;
  error?: string;
}

export interface ChangesData {
  /** Set when nothing was collected, with the reason (untrusted workspace …). */
  off?: string;
  /** Session key → its commit-window diff. */
  diffs: Record<string, SessionDiff>;
  worktrees: WorktreeChanges[];
  calls: number;
  ms: number;
  /** Sessions with a commit window that were not diffed because of the cap. */
  skipped: number;
  /** git calls that failed or timed out. */
  failed: number;
}

export interface CollectOpts {
  now: number;
  trusted: boolean;
  /** Most recent sessions to diff (commit window). */
  maxSessions?: number;
  /** Worktrees to inspect for uncommitted work. */
  maxWorktrees?: number;
  /** Sessions active within this many ms (or live) contribute their worktree. */
  worktreeWindowMs?: number;
  /** Count untracked files (git status -u). */
  untracked?: boolean;
  timeoutMs?: number;
  /** Test seam. */
  run?: GitRun;
}

export type GitRun = (cwd: string, args: string[], timeoutMs: number) => Promise<string | undefined>;

const SHA = /^[0-9a-f]{7,40}$/;
const MAX_ROWS = 2000;
const LIVE = new Set(['RUNNING', 'IDLE', 'NEEDS_INPUT']);

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[k]) e[k] = process.env[k];
  e.GIT_TERMINAL_PROMPT = '0';
  e.GIT_OPTIONAL_LOCKS = '0';
  return e;
}

export const runGit: GitRun = (cwd, args, timeoutMs) =>
  new Promise(resolve => {
    execFile('git', [...HARDEN, ...args], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20, env: env() }, (err, stdout) => resolve(err ? undefined : stdout.toString()));
  });

/** Parses `git diff --numstat -z --no-renames` output: "added\tremoved\tpath\0" records. */
export function parseNumstatZ(out: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n+/, ''));
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    rows.push({ path: m[3].replace(/\\/g, '/'), added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), ...(binary ? { binary: true } : {}) });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

/** Parses `git status --porcelain=v1 -z` into staged / unstaged / untracked / conflicted paths. */
export function parseStatusZ(out: string): { staged: string[]; unstaged: string[]; untracked: string[]; conflicts: string[] } {
  const r0 = { staged: [] as string[], unstaged: [] as string[], untracked: [] as string[], conflicts: [] as string[] };
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.length < 4) continue;
    const xy = r.slice(0, 2);
    const p = r.slice(3).replace(/\\/g, '/');
    if (xy === '??') r0.untracked.push(p);
    else if (xy !== '!!') {
      if (/U/.test(xy) || xy === 'AA' || xy === 'DD') r0.conflicts.push(p);
      else {
        if (/[MADRCT]/.test(xy[0])) r0.staged.push(p);
        if (/[MDT]/.test(xy[1])) r0.unstaged.push(p);
      }
    }
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename / copy: next record is the source path
    if (r0.untracked.length + r0.staged.length + r0.unstaged.length >= MAX_ROWS) break;
  }
  return r0;
}

/** Tiny concurrency pool: git spawns are expensive on Windows and the machine is shared. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const diffCache = new Map<string, NumstatRow[]>();

export function clearChangesCache(): void {
  diffCache.clear();
}

const exists = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const end = (s: AgentSessionSnapshot) => s.lastActivityAt ?? s.startedAt ?? 0;

/** Collects commit-window diffs and uncommitted state. Never throws; returns `off` when untrusted. */
export async function collectChanges(sessions: AgentSessionSnapshot[], o: CollectOpts): Promise<ChangesData> {
  const out: ChangesData = { diffs: {}, worktrees: [], calls: 0, ms: 0, skipped: 0, failed: 0 };
  if (!o.trusted) return { ...out, off: 'Workspace is not trusted: Agent runs no git process.' };
  const t0 = Date.now();
  const run = o.run ?? runGit;
  const timeout = o.timeoutMs ?? 5000;
  const git = async (cwd: string, args: string[]) => {
    out.calls++;
    const r = await run(cwd, args, timeout);
    if (r === undefined) out.failed++;
    return r;
  };

  // 1. Commit windows: sessions whose HEAD moved while they ran.
  const withWindow = sessions
    .filter(s => s.worktree && isPlausibleLocalPath(s.worktree) && s.headBefore && s.headAfter && s.headBefore !== s.headAfter && SHA.test(s.headBefore) && SHA.test(s.headAfter))
    .sort((a, b) => end(b) - end(a));
  const maxS = Math.max(0, o.maxSessions ?? 60);
  out.skipped = Math.max(0, withWindow.length - maxS);
  const picked = withWindow.slice(0, maxS).filter(s => exists(s.worktree!));
  const todo = new Map<string, AgentSessionSnapshot[]>();
  for (const s of picked) {
    const k = `${s.worktree!.toLowerCase()}|${s.headBefore}|${s.headAfter}`;
    todo.set(k, [...(todo.get(k) ?? []), s]);
  }
  await pool([...todo.keys()], 3, async k => {
    const ss = todo.get(k)!;
    const s0 = ss[0];
    let rows = diffCache.get(k);
    if (!rows) {
      const r = await git(s0.worktree!, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', `${s0.headBefore}..${s0.headAfter}`, '--']);
      if (r === undefined) return;
      rows = parseNumstatZ(r);
      if (diffCache.size > 500) diffCache.clear();
      diffCache.set(k, rows);
    }
    for (const s of ss) out.diffs[s.key] = { key: s.key, worktree: s0.worktree!, from: s0.headBefore!, to: s0.headAfter!, files: rows };
  });

  // 2. Uncommitted work in worktrees of live or recently active sessions.
  const winMs = o.worktreeWindowMs ?? 24 * 3600_000;
  const byWt = new Map<string, { wt: string; ss: AgentSessionSnapshot[] }>();
  for (const s of sessions) {
    if (!s.worktree || !isPlausibleLocalPath(s.worktree)) continue;
    if (!LIVE.has(s.status) && o.now - end(s) > winMs) continue;
    const k = s.worktree.toLowerCase();
    const e = byWt.get(k) ?? { wt: s.worktree, ss: [] };
    e.ss.push(s);
    byWt.set(k, e);
  }
  const wts = [...byWt.values()]
    .map(e => ({ ...e, live: e.ss.some(s => LIVE.has(s.status)), last: Math.max(...e.ss.map(end)) }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.last - a.last)
    .slice(0, Math.max(0, o.maxWorktrees ?? 24))
    .filter(e => exists(e.wt));
  await pool(wts, 3, async e => {
    const s0 = e.ss[0];
    const keys = [...e.ss].sort((a, b) => Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) || end(b) - end(a)).map(s => s.key);
    const base: WorktreeChanges = { worktree: e.wt, repository: s0.repository, branch: e.ss.find(s => s.branch)?.branch, staged: [], unstaged: [], untracked: [], conflicts: [], sessions: keys, at: Date.now() };
    // One status, then (only when tracked files changed) one diff against HEAD for line counts: 1–2 spawns per worktree.
    const sts = await git(e.wt, ['status', '--porcelain=v1', '-z', o.untracked === false ? '--untracked-files=no' : '--untracked-files=normal']);
    if (sts === undefined) {
      out.worktrees.push({ ...base, error: 'git status did not answer (timeout or not a repository)' });
      return;
    }
    const st = parseStatusZ(sts);
    const lines = new Map<string, NumstatRow>();
    if (st.staged.length || st.unstaged.length) {
      const d = await git(e.wt, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
      for (const r of d ? parseNumstatZ(d) : []) lines.set(r.path, r);
    }
    const row = (p: string, withLines: boolean): NumstatRow => {
      const r = lines.get(p);
      return withLines && r ? { ...r } : { path: p, added: 0, removed: 0, ...(r?.binary ? { binary: true } : {}) };
    };
    const stagedSet = new Set(st.staged);
    // Lines are the combined HEAD → working tree diff; a file both staged and modified carries them on its staged row.
    out.worktrees.push({ ...base, staged: st.staged.map(p => row(p, true)), unstaged: st.unstaged.map(p => row(p, !stagedSet.has(p))), untracked: st.untracked, conflicts: st.conflicts });
  });
  out.worktrees.sort((a, b) => wts.findIndex(w => w.wt === a.worktree) - wts.findIndex(w => w.wt === b.worktree));
  out.ms = Date.now() - t0;
  return out;
}

/** Repo-relative prefix of a session's cwd inside its worktree ("" when cwd is the worktree root). Pure path math. */
export function cwdPrefix(s: AgentSessionSnapshot): string {
  if (!s.cwd || !s.worktree) return '';
  const rel = path.relative(s.worktree.toLowerCase(), s.cwd.toLowerCase());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  // keep the original casing of cwd
  const orig = s.cwd.slice(s.cwd.length - rel.length);
  return orig.replace(/\\/g, '/') + '/';
}
