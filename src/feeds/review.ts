// PR / MR state for the Review screen. Opt-in (agent.review.prState, default off), trusted workspaces only.
// Read-only commands with fixed arguments and a 5 s timeout: `git remote -v` (hardened), `gh pr list`,
// `glab mr list`, `glab mr view` (head pipeline of open MRs). Output is parsed into a small, bounded shape;
// titles pass bounded() (redaction), URLs are kept only when they are https links on the remote's own host.
import { execFile } from 'child_process';
import * as fs from 'fs';
import { HARDEN } from '../git/git';
import { bounded } from '../util/redact';
import { isPlausibleLocalPath, normalizeCase } from '../util/paths';
import type { AgentSessionSnapshot } from '../model';

export type Forge = 'github' | 'gitlab';
export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type CiState = 'pass' | 'fail' | 'pending' | 'none';
export type ReviewDecision = 'approved' | 'changes' | 'required' | 'none';
export type Mergeable = 'yes' | 'no' | 'conflict' | 'unknown';

export interface Remote {
  name: string;
  forge: Forge;
  host: string;
  /** owner/name (GitHub) or group/…/project (GitLab). */
  slug: string;
}

export interface PrInfo {
  forge: Forge;
  /** Local repository root the remote belongs to. */
  repo: string;
  remote: string;
  slug: string;
  number: number;
  title: string;
  head: string;
  base: string;
  state: PrState;
  url?: string;
  updatedAt?: number;
  mergedAt?: number;
  ci: CiState;
  /** Names of failing / pending checks (bounded, ≤ 6). */
  failing: string[];
  pending: string[];
  review: ReviewDecision;
  mergeable: Mergeable;
  /** Raw merge status word from the forge (GitLab detailed_merge_status / GitHub mergeable), for tooltips. */
  mergeDetail?: string;
}

export interface RepoPrs {
  repo: string;
  remotes: Remote[];
  prs: PrInfo[];
  errors: string[];
  ms: number;
}

export interface PrReport {
  /** 'off': setting disabled; 'untrusted': workspace not trusted; 'ok': loaded. */
  state: 'off' | 'untrusted' | 'ok';
  at: number;
  repos: RepoPrs[];
}

// ---------------------------------------------------------------- parsing (pure)

const SLUG = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,5}$/;
const HOST = /^[A-Za-z0-9.-]{1,100}$/;

/** Remote URL → forge, host and slug. https, ssh (git@host:path) and ssh:// forms; credentials are dropped. */
export function parseRemoteUrl(url: string): { forge: Forge; host: string; slug: string } | undefined {
  let host: string | undefined, p: string | undefined;
  const m1 = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url.trim());
  const m2 = /^[^@\s]+@([^:\s]+):(.+)$/.exec(url.trim());
  if (m1) [host, p] = [m1[1], m1[2]];
  else if (m2) [host, p] = [m2[1], m2[2]];
  if (!host || !p) return undefined;
  const slug = p.replace(/\.git$/i, '').replace(/\/+$/, '');
  host = host.toLowerCase();
  if (!HOST.test(host) || !SLUG.test(slug)) return undefined;
  if (host === 'github.com' || host.startsWith('github.')) return { forge: 'github', host, slug };
  if (host.includes('gitlab')) return { forge: 'gitlab', host, slug };
  return undefined;
}

/** `git remote -v` output → recognised forge remotes (fetch lines, unique by forge + slug). */
export function parseRemotes(out: string): Remote[] {
  const seen = new Set<string>();
  const res: Remote[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (!m) continue;
    const r = parseRemoteUrl(m[2]);
    if (!r) continue;
    const k = `${r.forge}:${r.host}/${r.slug}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    res.push({ name: bounded(m[1], 40), ...r });
  }
  // origin first, then by name, so a cap keeps the canonical remote.
  return res.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name)));
}

const t = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) || undefined : undefined);
const str = (s: unknown, n = 120) => (typeof s === 'string' ? bounded(s, n) : '');
const branch = (s: unknown) => (typeof s === 'string' ? s.trim().slice(0, 200) : '');

/** Keeps a link only when it is https on the remote's host. */
export function safeUrl(u: unknown, host: string): string | undefined {
  if (typeof u !== 'string' || u.length > 500) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname.toLowerCase() === host.toLowerCase() && !x.username && !x.password ? x.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** GitHub statusCheckRollup → CI state plus failing / pending check names. */
export function ghChecks(rollup: unknown): { ci: CiState; failing: string[]; pending: string[] } {
  if (!Array.isArray(rollup) || !rollup.length) return { ci: 'none', failing: [], pending: [] };
  const failing: string[] = [], pending: string[] = [];
  let any = false;
  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue;
    any = true;
    const name = str(c.name ?? c.context ?? c.workflowName, 60) || 'check';
    const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) failing.push(name);
    else if ((status && status !== 'COMPLETED') || concl === 'PENDING' || concl === 'EXPECTED' || (!concl && !status)) pending.push(name);
  }
  if (!any) return { ci: 'none', failing, pending };
  return { ci: failing.length ? 'fail' : pending.length ? 'pending' : 'pass', failing: failing.slice(0, 6), pending: pending.slice(0, 6) };
}

/** `gh pr list --json …` → PrInfo[]. */
export function parseGhPrs(json: string, repo: string, r: Remote): PrInfo[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: PrInfo[] = [];
  for (const p of arr.slice(0, 200)) {
    if (!p || typeof p !== 'object' || typeof p.number !== 'number') continue;
    const st = String(p.state ?? '').toUpperCase();
    const state: PrState = st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open';
    const ch = ghChecks(p.statusCheckRollup);
    const rd = String(p.reviewDecision ?? '').toUpperCase();
    const mg = String(p.mergeable ?? '').toUpperCase();
    out.push({
      forge: 'github', repo, remote: r.name, slug: r.slug, number: p.number,
      title: str(p.title, 120), head: branch(p.headRefName), base: branch(p.baseRefName), state,
      url: safeUrl(p.url, r.host), updatedAt: t(p.updatedAt), mergedAt: t(p.mergedAt),
      ...ch,
      review: rd === 'APPROVED' ? 'approved' : rd === 'CHANGES_REQUESTED' ? 'changes' : rd === 'REVIEW_REQUIRED' ? 'required' : 'none',
      mergeable: mg === 'MERGEABLE' ? 'yes' : mg === 'CONFLICTING' ? 'conflict' : 'unknown',
      mergeDetail: mg ? mg.toLowerCase() : undefined,
    });
  }
  return out;
}

const GL_PIPE: Record<string, CiState> = { success: 'pass', failed: 'fail', canceled: 'fail', running: 'pending', pending: 'pending', created: 'pending', preparing: 'pending', waiting_for_resource: 'pending', scheduled: 'pending', manual: 'pending', skipped: 'none' };

/** GitLab detailed_merge_status → mergeable / review / CI hints. */
export function glMergeStatus(s: string): { mergeable: Mergeable; review?: ReviewDecision; ci?: CiState } {
  switch (s) {
    case 'mergeable': return { mergeable: 'yes' };
    case 'conflict': case 'need_rebase': return { mergeable: 'conflict' };
    case 'not_approved': case 'requested_changes': return { mergeable: 'no', review: s === 'requested_changes' ? 'changes' : 'required' };
    case 'ci_still_running': return { mergeable: 'no', ci: 'pending' };
    case 'ci_must_pass': return { mergeable: 'no' };
    case 'checking': case 'unchecked': case 'preparing': case '': return { mergeable: 'unknown' };
    default: return { mergeable: 'no' };
  }
}

/** `glab mr list -F json` → PrInfo[] (CI filled later from `glab mr view` for open MRs). */
export function parseGlabMrs(json: string, repo: string, r: Remote): PrInfo[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: PrInfo[] = [];
  for (const m of arr.slice(0, 200)) {
    if (!m || typeof m !== 'object' || typeof m.iid !== 'number') continue;
    const st = String(m.state ?? '').toLowerCase();
    const state: PrState = st === 'merged' ? 'merged' : st === 'closed' ? 'closed' : m.draft || m.work_in_progress ? 'draft' : 'open';
    const dms = String(m.detailed_merge_status ?? m.merge_status ?? '').toLowerCase();
    const ms = glMergeStatus(dms);
    const pipe = m.head_pipeline ?? m.pipeline;
    const ci = pipe && typeof pipe.status === 'string' ? GL_PIPE[pipe.status] ?? 'none' : ms.ci ?? 'none';
    out.push({
      forge: 'gitlab', repo, remote: r.name, slug: r.slug, number: m.iid,
      title: str(m.title, 120), head: branch(m.source_branch), base: branch(m.target_branch), state,
      url: safeUrl(m.web_url, r.host), updatedAt: t(m.updated_at), mergedAt: t(m.merged_at),
      ci, failing: ci === 'fail' ? ['pipeline'] : [], pending: ci === 'pending' ? ['pipeline'] : [],
      review: ms.review ?? 'none', mergeable: state === 'merged' || state === 'closed' ? 'unknown' : ms.mergeable,
      mergeDetail: dms || undefined,
    });
  }
  return out;
}

/** Applies `glab mr view -F json` head_pipeline to a parsed MR. */
export function applyGlabView(pr: PrInfo, json: string): void {
  try {
    const v = JSON.parse(json);
    const p = v?.head_pipeline ?? v?.pipeline;
    if (p && typeof p.status === 'string') {
      pr.ci = GL_PIPE[p.status] ?? 'none';
      pr.failing = pr.ci === 'fail' ? [`pipeline ${str(p.status, 20)}`] : [];
      pr.pending = pr.ci === 'pending' ? [`pipeline ${str(p.status, 20)}`] : [];
    }
    if (typeof v?.detailed_merge_status === 'string') {
      const ms = glMergeStatus(v.detailed_merge_status);
      pr.mergeable = ms.mergeable;
      pr.mergeDetail = v.detailed_merge_status;
      if (ms.review) pr.review = ms.review;
    }
  } catch {
    /* keep list data */
  }
}

// ---------------------------------------------------------------- processes

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ ok: boolean; out: string; err: string }>;

function childEnv(): NodeJS.ProcessEnv {
  // Profile and CLI config locations only (gh / glab read their own stored login); no token is forwarded.
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR']) if (process.env[k]) e[k] = process.env[k];
  Object.assign(e, { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', PAGER: 'cat' });
  return e;
}

export const execRunner: Runner = (cmd, args, cwd) =>
  new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: 5_000, windowsHide: true, maxBuffer: 8 << 20, env: childEnv() }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: err ? bounded(String(stderr || (err as Error).message || err), 160) : '' });
    });
  });

const GH_FIELDS = 'number,title,state,isDraft,headRefName,baseRefName,url,updatedAt,mergedAt,reviewDecision,mergeable,statusCheckRollup';

/** One repository: remotes, then PRs / MRs of each recognised remote (≤ 2 remotes). */
export async function loadRepo(repo: string, run: Runner, limit: number): Promise<RepoPrs> {
  const t0 = Date.now();
  const res: RepoPrs = { repo, remotes: [], prs: [], errors: [], ms: 0 };
  const rv = await run('git', [...HARDEN, 'remote', '-v'], repo);
  if (!rv.ok) {
    res.errors.push(`git remote: ${rv.err || 'failed'}`);
    res.ms = Date.now() - t0;
    return res;
  }
  res.remotes = parseRemotes(rv.out).slice(0, 2);
  for (const r of res.remotes) {
    if (r.forge === 'github') {
      const x = await run('gh', ['pr', 'list', '--repo', `${r.host === 'github.com' ? '' : r.host + '/'}${r.slug}`, '--state', 'all', '--limit', String(limit), '--json', GH_FIELDS], repo);
      if (x.ok) res.prs.push(...parseGhPrs(x.out, repo, r));
      else res.errors.push(`gh (${r.name}): ${x.err || 'failed'}`);
    } else {
      const R = `${r.host}/${r.slug}`;
      const x = await run('glab', ['mr', 'list', '-R', R, '--all', '-F', 'json', '-P', String(limit)], repo);
      if (!x.ok) {
        res.errors.push(`glab (${r.name}): ${x.err || 'failed'}`);
        continue;
      }
      const mrs = parseGlabMrs(x.out, repo, r);
      // Pipeline state needs one view per MR: only the newest open ones.
      for (const m of mrs.filter(m => m.state === 'open' || m.state === 'draft').slice(0, 3)) {
        const v = await run('glab', ['mr', 'view', String(m.number), '-R', R, '-F', 'json'], repo);
        if (v.ok) applyGlabView(m, v.out);
      }
      res.prs.push(...mrs);
    }
  }
  res.ms = Date.now() - t0;
  return res;
}

/** Repositories agents used, most recent first, unique and existing. */
export function reposOf(sessions: AgentSessionSnapshot[], max: number): string[] {
  const seen = new Map<string, { p: string; at: number }>();
  for (const s of sessions) {
    const p = s.repository;
    if (!p || !isPlausibleLocalPath(p)) continue;
    const k = normalizeCase(p);
    const at = s.lastActivityAt ?? s.startedAt ?? 0;
    const cur = seen.get(k);
    if (!cur || at > cur.at) seen.set(k, { p, at });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).map(x => x.p).filter(p => fs.existsSync(p)).slice(0, max);
}

/** Loads every repo with at most 3 in parallel. */
export async function loadPrs(repos: string[], run: Runner, limit: number, now: number): Promise<PrReport> {
  const out: RepoPrs[] = new Array(repos.length);
  let i = 0;
  const worker = async () => {
    while (i < repos.length) {
      const k = i++;
      out[k] = await loadRepo(repos[k], run, limit);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { state: 'ok', at: now, repos: out };
}
