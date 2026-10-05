// CI pipelines for the repositories agents touch: GitHub Actions (gh) and GitLab CI (glab).
// Read-only: `git remote -v` (hardened) to find the hosting, then `gh api --method GET` / `glab api --method GET`
// for runs and jobs. Opt-in (agent.pipelines.enabled), trusted workspaces only, 5 s per process.
// Everything kept is bounded and redacted; URLs are kept only when https and on the remote's own host.
import { execFile } from 'child_process';
import { HARDEN } from '../git/git';
import type { AgentSessionSnapshot } from '../model';
import { bounded } from '../util/redact';
import { isPlausibleLocalPath, normalizeCase } from '../util/paths';
import { rootsOf } from './settings';

export type CiProvider = 'github' | 'gitlab';
export type CiStatus = 'success' | 'failed' | 'running' | 'pending' | 'blocked' | 'canceled' | 'skipped' | 'unknown';
export type RunnerKind = 'local' | 'cloud' | 'unknown';

export interface CiRemote {
  name: string;
  host: string;
  slug: string;
  provider: CiProvider;
}

export interface CiJob {
  id: string;
  name: string;
  stage?: string;
  status: CiStatus;
  raw: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  runner?: string;
  runnerKind: RunnerKind;
  /** Why runnerKind was chosen (INFERRED basis). */
  runnerBasis?: string;
  labels?: string[];
  url?: string;
  allowFailure?: boolean;
  /** First failed step (GitHub) or failure reason (GitLab). */
  failedStep?: string;
}

export interface CiRun {
  /** `<provider>:<host>/<slug>#<id>`, unique across repos. */
  key: string;
  id: string;
  provider: CiProvider;
  host: string;
  slug: string;
  root: string;
  repo: string;
  title: string;
  workflow?: string;
  ref: string;
  sha?: string;
  event?: string;
  status: CiStatus;
  raw: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  url?: string;
  number?: number;
  attempt?: number;
  jobs?: CiJob[];
  jobsError?: string;
}

export interface CiRepo {
  root: string;
  name: string;
  remotes: CiRemote[];
  runs: CiRun[];
  errors: string[];
  ms: number;
}

export interface CiReport {
  state: 'off' | 'untrusted' | 'ok';
  at: number;
  repos: CiRepo[];
  calls: number;
  /** Repos skipped because they have no GitHub / GitLab remote. */
  noRemote: number;
}

export type Exec = (cmd: 'git' | 'gh' | 'glab', args: string[], cwd: string) => Promise<string>;

export interface PipelineOptions {
  roots: string[];
  runsPerRepo: number;
  jobRuns: number;
  gitlabHosts: string[];
  now: number;
  exec?: Exec;
}

// ---------------------------------------------------------------- remotes

const SLUG = /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+){1,5}$/;
const HOST = /^[A-Za-z0-9.\-]+(:\d+)?$/;

/** Host and owner/name from a git remote URL (https, ssh, scp-like). Credentials are dropped. */
export function parseRemote(url: string): { host: string; slug: string } | undefined {
  const u = url.trim();
  let host: string | undefined, p: string | undefined;
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(u);
  if (m) [host, p] = [m[1], m[2]];
  else if ((m = /^(?:[^@\s]+@)?([A-Za-z0-9.\-]+):(?!\/)(.+)$/.exec(u))) [host, p] = [m[1], m[2]];
  if (!host || !p) return undefined;
  host = host.toLowerCase().replace(/:22$/, '');
  if (/^ssh\./.test(host)) host = host.slice(4); // ssh.github.com
  if (/:\d+$/.test(host) && /^ssh:/i.test(u)) host = host.replace(/:\d+$/, ''); // ssh port is not the web port
  const slug = p.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!HOST.test(host) || !SLUG.test(slug)) return undefined;
  return { host, slug };
}

export function providerOf(host: string, gitlabHosts: string[] = []): CiProvider | undefined {
  const h = host.toLowerCase();
  if (gitlabHosts.some(g => g.toLowerCase() === h) || /(^|\.)gitlab\./.test(h) || h === 'gitlab.com') return 'gitlab';
  if (h === 'github.com' || /(^|\.)github\./.test(h)) return 'github';
  return undefined;
}

/** Recognised remotes from `git remote -v` output, deduped by host + slug, `origin` first. */
export function parseRemotes(out: string, gitlabHosts: string[] = []): CiRemote[] {
  const seen = new Set<string>();
  const res: CiRemote[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const r = parseRemote(m[2]);
    if (!r) continue;
    const provider = providerOf(r.host, gitlabHosts);
    if (!provider) continue;
    const k = `${r.host}/${r.slug}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    res.push({ name: bounded(m[1], 40), host: r.host, slug: r.slug, provider });
  }
  return res.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0)).slice(0, 3);
}

// ---------------------------------------------------------------- status

export function ghStatus(status?: string, conclusion?: string | null): CiStatus {
  switch (status) {
    case 'completed':
      switch (conclusion) {
        case 'success':
          return 'success';
        case 'failure':
        case 'timed_out':
        case 'startup_failure':
          return 'failed';
        case 'cancelled':
          return 'canceled';
        case 'skipped':
        case 'neutral':
          return 'skipped';
        case 'action_required':
          return 'blocked';
        default:
          return 'unknown';
      }
    case 'in_progress':
      return 'running';
    case 'waiting':
    case 'action_required':
      return 'blocked';
    case 'queued':
    case 'pending':
    case 'requested':
      return 'pending';
    default:
      return 'unknown';
  }
}

export function glStatus(status?: string): CiStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'waiting_for_callback':
      return 'pending';
    case 'manual':
      return 'blocked';
    case 'canceled':
    case 'canceling':
      return 'canceled';
    case 'skipped':
      return 'skipped';
    default:
      return 'unknown';
  }
}

export const ACTIVE: ReadonlySet<CiStatus> = new Set(['running', 'pending', 'blocked']);

// ---------------------------------------------------------------- parsing

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const idOf = (v: unknown): string | undefined => (typeof v === 'number' || (typeof v === 'string' && /^\d{1,20}$/.test(v)) ? String(v) : undefined);

/** Only https links on the remote's own host survive. */
export function safeUrl(v: unknown, host: string): string | undefined {
  const u = str(v);
  if (!u || u.length > 500) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && p.host.toLowerCase() === host.toLowerCase() && !p.username && !p.password ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface RepoRef {
  root: string;
  repo: string;
  remote: CiRemote;
}

export function parseGithubRuns(text: string, r: RepoRef): CiRun[] {
  const out: CiRun[] = [];
  for (const x of arr(obj(parseJson(text)).workflow_runs).map(obj)) {
    const id = idOf(x.id);
    const createdAt = time(x.created_at);
    if (!id || createdAt === undefined) continue;
    const status = ghStatus(str(x.status), str(x.conclusion) ?? null);
    const updatedAt = time(x.updated_at);
    out.push({
      key: `github:${r.remote.host}/${r.remote.slug}#${id}`,
      id,
      provider: 'github',
      host: r.remote.host,
      slug: r.remote.slug,
      root: r.root,
      repo: r.repo,
      title: bounded(str(x.display_title) ?? str(x.name) ?? `run ${id}`, 120),
      workflow: bounded(str(x.name), 60) || undefined,
      ref: bounded(str(x.head_branch) ?? '', 80),
      sha: str(x.head_sha)?.slice(0, 40),
      event: bounded(str(x.event), 30) || undefined,
      status,
      raw: bounded(str(x.conclusion) ?? str(x.status) ?? '', 30),
      createdAt,
      startedAt: time(x.run_started_at) ?? createdAt,
      endedAt: str(x.status) === 'completed' ? updatedAt : undefined,
      updatedAt,
      url: safeUrl(x.html_url, r.remote.host),
      number: num(x.run_number),
      attempt: num(x.run_attempt),
    });
  }
  return out;
}

export function githubRunnerKind(runnerName?: string, group?: string, labels: string[] = []): [RunnerKind, string] {
  if (labels.some(l => l.toLowerCase() === 'self-hosted')) return ['local', 'label "self-hosted"'];
  if (group === 'GitHub Actions' || /^GitHub Actions \d+/.test(runnerName ?? '')) return ['cloud', 'GitHub-hosted runner group'];
  if (runnerName) return ['local', 'runner outside the GitHub-hosted group'];
  return ['unknown', 'no runner assigned yet'];
}

export function parseGithubJobs(text: string, host: string): CiJob[] {
  return arr(obj(parseJson(text)).jobs)
    .map(obj)
    .flatMap(x => {
      const id = idOf(x.id);
      if (!id) return [];
      const labels = arr(x.labels).filter((l): l is string => typeof l === 'string').map(l => bounded(l, 40)).slice(0, 8);
      const named = bounded(str(x.runner_name), 80) || undefined;
      const [runnerKind, runnerBasis] = githubRunnerKind(named, str(x.runner_group_name), labels);
      // GitHub-hosted runners get a fresh name per job: pool them by image label instead.
      const runner = runnerKind === 'cloud' ? `GitHub-hosted ${labels[0] ?? ''}`.trim() : named;
      const failed = arr(x.steps).map(obj).find(s => s.conclusion === 'failure');
      const job: CiJob = {
        id,
        name: bounded(str(x.name) ?? `job ${id}`, 100),
        stage: bounded(str(x.workflow_name), 60) || undefined,
        status: ghStatus(str(x.status), str(x.conclusion) ?? null),
        raw: bounded(str(x.conclusion) ?? str(x.status) ?? '', 30),
        createdAt: time(x.created_at),
        startedAt: str(x.status) === 'queued' ? undefined : time(x.started_at),
        endedAt: time(x.completed_at),
        runner,
        runnerKind,
        runnerBasis,
        labels,
        url: safeUrl(x.html_url, host),
        failedStep: failed ? `step ${bounded(str(failed.name), 80)}` : undefined,
      };
      return [job];
    });
}

/** `refs/merge-requests/12/head` → `!12`; other refs unchanged. */
export function glRef(ref: string): string {
  const m = /^refs\/merge-requests\/(\d+)\/(head|merge|train)$/.exec(ref);
  return m ? `!${m[1]}` : ref;
}

export function parseGitlabPipelines(text: string, r: RepoRef): CiRun[] {
  const out: CiRun[] = [];
  for (const x of arr(parseJson(text)).map(obj)) {
    const id = idOf(x.id);
    const createdAt = time(x.created_at);
    if (!id || createdAt === undefined) continue;
    const status = glStatus(str(x.status));
    const updatedAt = time(x.updated_at);
    const ref = glRef(bounded(str(x.ref) ?? '', 80));
    const source = bounded(str(x.source), 30) || undefined;
    out.push({
      key: `gitlab:${r.remote.host}/${r.remote.slug}#${id}`,
      id,
      provider: 'gitlab',
      host: r.remote.host,
      slug: r.remote.slug,
      root: r.root,
      repo: r.repo,
      title: bounded(str(x.name) ?? `${ref}${source ? ` · ${source.replace(/_/g, ' ')}` : ''}`, 120),
      workflow: undefined,
      ref,
      sha: str(x.sha)?.slice(0, 40),
      event: source,
      status,
      raw: bounded(str(x.status) ?? '', 30),
      createdAt,
      startedAt: time(x.started_at),
      endedAt: ACTIVE.has(status) ? undefined : (time(x.finished_at) ?? updatedAt),
      updatedAt,
      url: safeUrl(x.web_url, r.remote.host),
      number: num(x.iid),
    });
  }
  return out;
}

export function gitlabRunnerKind(runner: J, host: string): [RunnerKind, string] {
  if (!Object.keys(runner).length) return ['unknown', 'no runner assigned yet'];
  if (runner.is_shared === true) return host === 'gitlab.com' ? ['cloud', 'GitLab.com shared (instance) runner'] : ['cloud', 'instance-wide shared runner'];
  if (runner.is_shared === false) return ['local', `${str(runner.runner_type)?.replace('_type', '') ?? 'project'} runner (not shared)`];
  return ['unknown', 'runner type not exposed'];
}

export function parseGitlabJobs(text: string, host: string): CiJob[] {
  return arr(parseJson(text))
    .map(obj)
    .flatMap(x => {
      const id = idOf(x.id);
      if (!id) return [];
      const runner = obj(x.runner);
      const [runnerKind, runnerBasis] = gitlabRunnerKind(runner, host);
      const desc = runnerKind === 'cloud' ? `GitLab shared${host === 'gitlab.com' ? ' (SaaS)' : ''}` : (str(runner.description) ?? str(runner.name));
      const job: CiJob = {
        id,
        name: bounded(str(x.name) ?? `job ${id}`, 100),
        stage: bounded(str(x.stage), 60) || undefined,
        status: glStatus(str(x.status)),
        raw: bounded(str(x.status) ?? '', 30),
        createdAt: time(x.created_at),
        startedAt: time(x.started_at),
        endedAt: time(x.finished_at),
        runner: desc ? bounded(desc.replace(/^Description:\s*/i, ''), 80) : undefined,
        runnerKind,
        runnerBasis,
        labels: arr(x.tag_list).filter((l): l is string => typeof l === 'string').map(l => bounded(l, 40)).slice(0, 8),
        url: safeUrl(x.web_url, host),
        allowFailure: x.allow_failure === true,
        failedStep: x.status === 'failed' ? bounded(str(x.failure_reason)?.replace(/_/g, ' '), 80) || undefined : undefined,
      };
      return [job];
    })
    .reverse(); // API lists newest job first; keep pipeline order
}

/** Fills run start / end from its jobs when the list API did not give them (GitLab). DERIVED. */
export function settleTimes(run: CiRun): CiRun {
  const js = run.jobs ?? [];
  const starts = js.map(j => j.startedAt).filter((t): t is number => t !== undefined);
  const ends = js.map(j => j.endedAt).filter((t): t is number => t !== undefined);
  if (run.startedAt === undefined && starts.length) run.startedAt = Math.min(...starts);
  if (!ACTIVE.has(run.status) && ends.length) run.endedAt = Math.max(...ends);
  return run;
}

// ---------------------------------------------------------------- loading

function env(): NodeJS.ProcessEnv {
  // The CLIs need their own config dirs to find their stored login; Agent never reads or prints it.
  return { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GLAB_NO_PROMPT: '1', NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0', GLAB_CHECK_UPDATE: 'false' };
}

export const defaultExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const full = cmd === 'git' ? [...HARDEN, ...args] : args;
    execFile(cmd, full, { cwd, timeout: 5_000, windowsHide: true, maxBuffer: 8 << 20, env: env() }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.toString());
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reject(new Error(`${cmd} not found on PATH`));
      if ((err as { killed?: boolean }).killed) return reject(new Error(`${cmd} timed out (5 s)`));
      reject(new Error(bounded(stderr?.toString().split(/\r?\n/).find(l => l.trim()) || err.message, 160)));
    });
  });

const enc = (slug: string) => encodeURIComponent(slug);

function apiArgs(remote: CiRemote, path: string): string[] {
  const host = ['--hostname', remote.host];
  return remote.provider === 'github'
    ? ['api', '--method', 'GET', ...(remote.host === 'github.com' ? [] : host), path]
    : ['api', '--method', 'GET', ...host, path];
}

/** Which runs get their jobs loaded: active ones, the newest, then failed runs that are still the latest of their ref, then by recency; up to `n`. */
export function pickJobRuns(runs: CiRun[], n: number): CiRun[] {
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const latestFailed: CiRun[] = [];
  for (const r of sorted) {
    const k = `${r.ref}|${r.workflow ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.status === 'failed') latestFailed.push(r);
  }
  const order = new Set([...sorted.filter(r => ACTIVE.has(r.status)), ...sorted.slice(0, 1), ...latestFailed, ...sorted]);
  return [...order].slice(0, Math.max(0, n));
}

async function limitAll<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
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

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export async function loadPipelines(o: PipelineOptions): Promise<CiReport> {
  const exec = o.exec ?? defaultExec;
  let calls = 0;
  const run = (cmd: 'git' | 'gh' | 'glab', args: string[], cwd: string) => {
    calls++;
    return exec(cmd, args, cwd);
  };
  let noRemote = 0;
  const roots = o.roots.filter(isPlausibleLocalPath);
  const repos = await limitAll(roots, 3, async (root): Promise<CiRepo | undefined> => {
    const t0 = Date.now();
    const repo: CiRepo = { root, name: base(root), remotes: [], runs: [], errors: [], ms: 0 };
    try {
      repo.remotes = parseRemotes(await run('git', ['remote', '-v'], root), o.gitlabHosts);
    } catch {
      return undefined; // not a git repository (any more)
    }
    if (!repo.remotes.length) {
      noRemote++;
      return undefined;
    }
    for (const remote of repo.remotes) {
      const ref: RepoRef = { root, repo: repo.name, remote };
      const tool = remote.provider === 'github' ? 'gh' : 'glab';
      let runs: CiRun[];
      try {
        const out = await run(tool, apiArgs(remote, remote.provider === 'github' ? `repos/${remote.slug}/actions/runs?per_page=${o.runsPerRepo}` : `projects/${enc(remote.slug)}/pipelines?per_page=${o.runsPerRepo}`), root);
        runs = remote.provider === 'github' ? parseGithubRuns(out, ref) : parseGitlabPipelines(out, ref);
      } catch (e) {
        repo.errors.push(`${remote.host}/${remote.slug}: ${bounded((e as Error).message, 160)}`);
        continue;
      }
      await limitAll(pickJobRuns(runs, o.jobRuns), 2, async r => {
        try {
          const out = await run(tool, apiArgs(remote, remote.provider === 'github' ? `repos/${remote.slug}/actions/runs/${r.id}/jobs?per_page=100` : `projects/${enc(remote.slug)}/pipelines/${r.id}/jobs?per_page=100&include_retried=false`), root);
          r.jobs = remote.provider === 'github' ? parseGithubJobs(out, remote.host) : parseGitlabJobs(out, remote.host);
          settleTimes(r);
        } catch (e) {
          r.jobsError = bounded((e as Error).message, 160);
        }
      });
      repo.runs.push(...runs);
    }
    repo.runs.sort((a, b) => b.createdAt - a.createdAt);
    repo.ms = Date.now() - t0;
    return repo;
  });
  return { state: 'ok', at: o.now, repos: repos.filter((r): r is CiRepo => !!r), calls, noRemote };
}

// ---------------------------------------------------------------- analysis (pure)

export const durationOf = (x: { startedAt?: number; endedAt?: number; createdAt?: number }, now: number): number | undefined => {
  const s = x.startedAt ?? x.createdAt;
  if (s === undefined) return undefined;
  return Math.max(0, (x.endedAt ?? now) - s);
};

export interface Blocker {
  run: CiRun;
  kind: 'failed' | 'blocked' | 'pending' | 'running';
  job?: CiJob;
  /** Since when this has been the case. */
  since: number;
  detail: string;
  evidence: 'OBSERVED' | 'INFERRED';
}

/** Latest run per repo + ref + workflow: what is failing, waiting for a person, queued or still running. */
export function blockers(runs: CiRun[], now: number): Blocker[] {
  const latest = new Map<string, CiRun>();
  for (const r of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
    const k = `${r.host}/${r.slug}|${r.ref}|${r.workflow ?? ''}`.toLowerCase();
    if (!latest.has(k)) latest.set(k, r);
  }
  const busyLocal = new Map<string, CiJob & { run: CiRun }>();
  for (const r of runs) for (const j of r.jobs ?? []) if (j.status === 'running' && j.runnerKind === 'local' && j.runner) busyLocal.set(j.runner, { ...j, run: r });
  const out: Blocker[] = [];
  for (const r of latest.values()) {
    if (r.status === 'success' || r.status === 'skipped' || r.status === 'canceled' || r.status === 'unknown') continue;
    const jobs = r.jobs ?? [];
    if (r.status === 'failed') {
      const bad = jobs.filter(j => j.status === 'failed' && !j.allowFailure);
      if (!bad.length) out.push({ run: r, kind: 'failed', since: r.endedAt ?? r.updatedAt ?? r.createdAt, detail: r.jobs ? 'run failed (no failing job listed)' : 'run failed (jobs not loaded)', evidence: 'OBSERVED' });
      for (const j of bad) out.push({ run: r, kind: 'failed', job: j, since: j.endedAt ?? r.endedAt ?? r.createdAt, detail: j.failedStep ? `failed · ${j.failedStep}` : 'job failed', evidence: 'OBSERVED' });
      continue;
    }
    const manual = jobs.filter(j => j.status === 'blocked');
    if (r.status === 'blocked' || manual.length) {
      if (!manual.length) out.push({ run: r, kind: 'blocked', since: r.updatedAt ?? r.createdAt, detail: r.provider === 'github' ? 'waiting for approval (environment / action required)' : 'manual action required', evidence: 'OBSERVED' });
      for (const j of manual) out.push({ run: r, kind: 'blocked', job: j, since: j.createdAt ?? r.createdAt, detail: 'manual job: waits for someone to start it', evidence: 'OBSERVED' });
    }
    const pending = jobs.filter(j => j.status === 'pending');
    for (const j of pending) {
      const busy = [...busyLocal.values()].find(b => b.id !== j.id);
      const wantsLocal = (j.labels ?? []).some(l => /self-hosted|local/i.test(l));
      const detail =
        wantsLocal && busy
          ? `queued; local runner "${busy.runner}" busy with ${busy.run.repo} · ${busy.name}`
          : wantsLocal
            ? `queued for a local runner (${(j.labels ?? []).join(', ')})`
            : 'queued, no runner yet';
      out.push({ run: r, kind: 'pending', job: j, since: j.createdAt ?? r.createdAt, detail, evidence: wantsLocal && busy ? 'INFERRED' : 'OBSERVED' });
    }
    if (!pending.length && !manual.length && r.status === 'pending') out.push({ run: r, kind: 'pending', since: r.createdAt, detail: r.jobs ? 'run queued' : 'run queued (jobs not loaded)', evidence: 'OBSERVED' });
    if (r.status === 'running') {
      const running = jobs.filter(j => j.status === 'running');
      for (const j of running) out.push({ run: r, kind: 'running', job: j, since: j.startedAt ?? r.startedAt ?? r.createdAt, detail: j.runner ? `on ${j.runner}` : 'running', evidence: 'OBSERVED' });
      if (!running.length && !pending.length) out.push({ run: r, kind: 'running', since: r.startedAt ?? r.createdAt, detail: 'running', evidence: 'OBSERVED' });
    }
  }
  const rank = { failed: 0, blocked: 1, pending: 2, running: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.since - b.since).map(b => ({ ...b, since: Math.min(b.since, now) }));
}

export interface RunnerUse {
  name: string;
  kind: RunnerKind;
  basis?: string;
  jobs: number;
  failed: number;
  busyMs: number;
  /** Busy ms per bucket, aligned with `buckets`. */
  perBucket: number[];
  current?: { job: CiJob; run: CiRun };
  lastAt?: number;
}

/** Busy time per runner over [from, to) in buckets of `step` ms (only jobs whose runs had their jobs loaded). DERIVED. */
export function runnerUse(runs: CiRun[], from: number, to: number, step: number): { buckets: number[]; runners: RunnerUse[] } {
  const n = Math.max(1, Math.ceil((to - from) / step));
  const buckets = Array.from({ length: n }, (_, i) => from + i * step);
  const by = new Map<string, RunnerUse>();
  for (const r of runs)
    for (const j of r.jobs ?? []) {
      if (j.startedAt === undefined) continue;
      const name = j.runner ?? (j.runnerKind === 'cloud' ? 'cloud (unnamed)' : '(unknown runner)');
      const u: RunnerUse = by.get(name) ?? { name, kind: j.runnerKind, basis: j.runnerBasis, jobs: 0, failed: 0, busyMs: 0, perBucket: new Array(n).fill(0) };
      const s = Math.max(from, j.startedAt);
      const e = Math.min(to, j.endedAt ?? to);
      if (e > s) {
        u.jobs++;
        if (j.status === 'failed') u.failed++;
        u.busyMs += e - s;
        for (let i = Math.floor((s - from) / step); i < n && buckets[i] < e; i++) u.perBucket[i] += Math.min(e, buckets[i] + step) - Math.max(s, buckets[i]);
        u.lastAt = Math.max(u.lastAt ?? 0, j.endedAt ?? to);
      }
      if (j.status === 'running') u.current = { job: j, run: r };
      by.set(name, u);
    }
  return { buckets, runners: [...by.values()].filter(u => u.jobs || u.current).sort((a, b) => b.busyMs - a.busyMs) };
}

/**
 * Sessions related to a run: same commit (OBSERVED: the session's repo saw that commit) or same repo and branch
 * (INFERRED). Returns run key → [session key, basis].
 */
export function linkSessions(runs: CiRun[], sessions: AgentSessionSnapshot[]): Map<string, [string, 'commit' | 'branch'][]> {
  const byRoot = new Map<string, AgentSessionSnapshot[]>();
  for (const s of sessions) {
    const p = s.repository ?? s.cwd;
    if (!p) continue;
    const k = normalizeCase(p);
    byRoot.set(k, [...(byRoot.get(k) ?? []), s]);
  }
  const out = new Map<string, [string, 'commit' | 'branch'][]>();
  for (const r of runs) {
    const list = byRoot.get(normalizeCase(r.root)) ?? [];
    const hits: [string, 'commit' | 'branch'][] = [];
    for (const s of list) {
      if (r.sha && s.commits.some(c => c.sha.length >= 7 && (r.sha!.startsWith(c.sha) || c.sha.startsWith(r.sha!)))) hits.push([s.key, 'commit']);
      else if (r.ref && (s.branch === r.ref || s.facts?.recordedBranch === r.ref) && r.ref !== 'main' && r.ref !== 'master') hits.push([s.key, 'branch']);
    }
    if (hits.length) out.set(r.key, hits.slice(0, 6));
  }
  return out;
}

/** Repo roots for the feed: sessions' repos, most recent first (capped), then extra roots; deduped. */
export function pipelineRoots(sessions: { repository?: string; cwd?: string; lastActivityAt?: number }[], extra: string[], max: number): string[] {
  const out = rootsOf(sessions).slice(0, max);
  for (const e of extra) if (isPlausibleLocalPath(e) && !out.some(p => normalizeCase(p) === normalizeCase(e))) out.push(e);
  return out;
}
