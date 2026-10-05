import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { pipelinesFeed, pipelinesView } from '../src/render/extra/pipelines';
import type { ActCtx } from '../src/render/extra/kit';
import { blockers, CiReport, Exec, ghStatus, glRef, glStatus, linkSessions, loadPipelines, parseRemote, parseRemotes, pickJobRuns, pipelineRoots, providerOf, runnerUse, safeUrl } from '../src/feeds/pipelines';
import { FIXTURES, T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const FX = path.join(FIXTURES, 'pipelines');
const read = (f: string) => fs.readFileSync(path.join(FX, f), 'utf8');
const ROOT_GH = path.resolve('pl-fixture-gh');
const ROOT_GL = path.resolve('pl-fixture-gl');
const ROOT_NONE = path.resolve('pl-fixture-none');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 60_000, ...p };
}

const S_BRANCH = mk({ key: 'claude:br', repository: ROOT_GH, branch: 'night/pipelines', title: 'pipelines coder' });
const S_COMMIT = mk({ key: 'codex:co', repository: ROOT_GH, branch: 'main', commits: [{ sha: 'bbbbbbbbbb', at: NOW - 2 * 3600_000, subject: 'fix', attribution: 'session-ran-git-commit' }] });
const S_GL = mk({ key: 'claude:gl', repository: ROOT_GL, lastActivityAt: NOW - 120_000 });
const SESSIONS = [S_BRANCH, S_COMMIT, S_GL];

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
}

function fakeExec(calls: Call[]): Exec {
  return async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    if (cmd === 'git') {
      if (cwd === ROOT_GH) return 'origin\thttps://user:secret@github.com/acme/app.git (fetch)\norigin\thttps://user:secret@github.com/acme/app.git (push)\nmirror\tgit@github.com:acme/app.git (fetch)\n';
      if (cwd === ROOT_GL) return 'gitlab\tgit@gitlab.com:group/sub/proj.git (fetch)\n';
      if (cwd === ROOT_NONE) return 'origin\thttps://example.org/x/y.git (fetch)\n';
      throw new Error('not a git repository');
    }
    const p = args[args.length - 1];
    if (cmd === 'gh') {
      if (/actions\/runs\?/.test(p)) return read('gh-runs.json');
      if (/runs\/103\/jobs/.test(p)) return read('gh-jobs-103.json');
      if (/runs\/104\/jobs/.test(p)) return '{"jobs":[]}';
      throw new Error('gh timed out (5 s)');
    }
    if (/pipelines\?/.test(p)) return read('gl-pipelines.json');
    if (/pipelines\/5002\/jobs/.test(p)) return read('gl-jobs-5002.json');
    if (/pipelines\/5001\/jobs/.test(p)) return read('gl-jobs-5001.json');
    throw new Error('unexpected');
  };
}

async function report(calls: Call[] = []): Promise<CiReport> {
  return loadPipelines({ roots: [ROOT_GH, ROOT_GL, ROOT_NONE, path.resolve('pl-missing'), 'relative/x'], runsPerRepo: 20, jobRuns: 3, gitlabHosts: [], now: NOW, exec: fakeExec(calls) });
}

test('pipelines: remotes parse https / scp / ssh, drop credentials, detect provider', () => {
  assert.deepEqual(parseRemote('https://user:tok@github.com/acme/app.git'), { host: 'github.com', slug: 'acme/app' });
  assert.deepEqual(parseRemote('git@gitlab.com:group/sub/proj.git'), { host: 'gitlab.com', slug: 'group/sub/proj' });
  assert.deepEqual(parseRemote('ssh://git@ssh.github.com:443/acme/app.git'), { host: 'github.com', slug: 'acme/app' });
  assert.equal(parseRemote('C:\\repos\\local'), undefined);
  assert.equal(parseRemote('https://github.com/acme'), undefined);
  assert.equal(providerOf('gitlab.example.org'), 'gitlab');
  assert.equal(providerOf('git.corp.example', ['git.corp.example']), 'gitlab');
  assert.equal(providerOf('bitbucket.org'), undefined);
  const rs = parseRemotes('upstream\thttps://github.com/acme/app (fetch)\norigin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\nx\thttps://bitbucket.org/a/b (fetch)\n');
  assert.deepEqual(rs.map(r => [r.name, r.provider, r.slug]), [['upstream', 'github', 'acme/app']], 'deduped by host + slug, unknown hosts skipped');
});

test('pipelines: status mapping, MR refs and safe urls', () => {
  assert.equal(ghStatus('completed', 'failure'), 'failed');
  assert.equal(ghStatus('completed', 'timed_out'), 'failed');
  assert.equal(ghStatus('completed', 'cancelled'), 'canceled');
  assert.equal(ghStatus('waiting', null), 'blocked');
  assert.equal(ghStatus('queued', null), 'pending');
  assert.equal(ghStatus('in_progress', null), 'running');
  assert.equal(glStatus('manual'), 'blocked');
  assert.equal(glStatus('waiting_for_resource'), 'pending');
  assert.equal(glStatus('weird'), 'unknown');
  assert.equal(glRef('refs/merge-requests/42/head'), '!42');
  assert.equal(glRef('main'), 'main');
  assert.equal(safeUrl('https://github.com/a/b', 'github.com'), 'https://github.com/a/b');
  assert.equal(safeUrl('http://github.com/a/b', 'github.com'), undefined);
  assert.equal(safeUrl('https://evil.example/a', 'github.com'), undefined);
  assert.equal(safeUrl('https://u:p@github.com/a', 'github.com'), undefined);
  assert.equal(safeUrl('javascript:alert(1)', 'github.com'), undefined);
});

test('pipelines: load runs read-only API GETs, parses runs and jobs, records errors', async () => {
  const calls: Call[] = [];
  const r = await report(calls);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.repos.map(x => x.name), ['pl-fixture-gh', 'pl-fixture-gl']);
  assert.equal(r.noRemote, 1);
  for (const c of calls.filter(c => c.cmd !== 'git')) {
    assert.equal(c.args[0], 'api');
    assert.deepEqual(c.args.slice(1, 3), ['--method', 'GET']);
  }
  assert.ok(calls.filter(c => c.cmd === 'git').every(c => c.args.join(' ') === 'remote -v'));
  assert.ok(calls.some(c => c.cmd === 'glab' && c.args.includes('--hostname') && c.args.some(a => a.startsWith('projects/group%2Fsub%2Fproj/pipelines?'))));

  const gh = r.repos[0];
  assert.equal(gh.remotes.length, 1, 'origin and mirror point at the same project');
  assert.equal(gh.runs.length, 4, 'the malformed run is skipped');
  const r104 = gh.runs.find(x => x.id === '104')!;
  assert.equal(r104.status, 'pending');
  assert.ok(!r104.title.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'titles are redacted');
  assert.equal(gh.runs.find(x => x.id === '102')!.url, undefined, 'non-https / foreign host links dropped');
  const r103 = gh.runs.find(x => x.id === '103')!;
  assert.equal(r103.attempt, 2);
  assert.equal(r103.jobs?.length, 2);
  const tj = r103.jobs!.find(j => j.name === 'test')!;
  assert.equal(tj.runnerKind, 'local');
  assert.equal(tj.failedStep, 'step Run npm test');
  const bj = r103.jobs!.find(j => j.name === 'build')!;
  assert.equal(bj.runnerKind, 'cloud');
  assert.equal(bj.runner, 'GitHub-hosted windows-latest', 'hosted runners pooled by image label');
  assert.equal(gh.runs.find(x => x.id === '101')!.jobsError, 'gh timed out (5 s)');
  assert.equal(gh.runs.find(x => x.id === '102')!.jobs, undefined, 'only jobRuns runs get jobs');

  const gl = r.repos[1];
  const p5002 = gl.runs.find(x => x.id === '5002')!;
  assert.equal(p5002.status, 'running');
  assert.deepEqual(p5002.jobs!.map(j => j.name), ['lint', 'unit', 'e2e'], 'pipeline order');
  assert.equal(p5002.startedAt, T('2026-10-04T11:31:00Z'), 'run start derived from its jobs');
  const unit = p5002.jobs!.find(j => j.name === 'unit')!;
  assert.equal(unit.runner, 'Julian local Windows runner');
  assert.equal(unit.runnerKind, 'local');
  assert.equal(p5002.jobs!.find(j => j.name === 'lint')!.runner, 'GitLab shared (SaaS)');
  assert.ok(!JSON.stringify(r).includes('10.0.0.1'), 'runner IPs are not kept');
  assert.ok(!JSON.stringify(r).includes('secret'), 'remote credentials are not kept');
  assert.equal(gl.runs.find(x => x.id === '5001')!.ref, '!7');
});

test('pipelines: job run picking puts active, newest and latest failures first', async () => {
  const r = await report();
  assert.deepEqual(pickJobRuns(r.repos[0].runs, 3).map(x => x.id), ['104', '103', '101']);
  assert.deepEqual(pickJobRuns(r.repos[0].runs, 0), []);
});

test('pipelines: what blocks uses the latest run per ref and infers runner contention', async () => {
  const r = await report();
  const bl = blockers(r.repos.flatMap(x => x.runs), NOW);
  const sum = bl.map(b => `${b.kind}:${b.run.id}:${b.job?.name ?? '-'}`);
  assert.deepEqual(sum, ['failed:103:test', 'blocked:5001:deploy', 'pending:5002:e2e', 'pending:104:-', 'running:5002:unit']);
  assert.ok(!sum.some(s => s.includes(':102:')), 'older topic failure superseded by a later green run');
  const e2e = bl.find(b => b.job?.name === 'e2e')!;
  assert.equal(e2e.evidence, 'INFERRED');
  assert.match(e2e.detail, /Julian local Windows runner/);
  assert.equal(bl[0].detail, 'failed · step Run npm test');
});

test('pipelines: runner use buckets busy time per runner', async () => {
  const r = await report();
  const u = runnerUse(r.repos.flatMap(x => x.runs), NOW - 3600_000, NOW, 1800_000);
  assert.equal(u.buckets.length, 2);
  const by = new Map(u.runners.map(x => [x.name, x]));
  assert.equal(by.get('julian-box')!.perBucket[0], 9 * 60_000);
  assert.equal(by.get('julian-box')!.failed, 1);
  const local = by.get('Julian local Windows runner')!;
  assert.deepEqual(local.perBucket, [0, 20 * 60_000]);
  assert.equal(local.current?.job.name, 'unit');
  assert.equal(local.jobs, 1, 'jobs outside the window are not counted');
  assert.equal(by.get('GitHub-hosted windows-latest')!.busyMs, 210_000);
  assert.equal(by.get('GitLab shared (SaaS)')!.kind, 'cloud');
});

test('pipelines: sessions link by commit (observed) or branch (inferred), never by main', async () => {
  const r = await report();
  const l = linkSessions(r.repos.flatMap(x => x.runs), SESSIONS);
  const key = (id: string) => r.repos.flatMap(x => x.runs).find(x => x.id === id)!.key;
  assert.deepEqual(l.get(key('104')), [['claude:br', 'branch']]);
  assert.deepEqual(l.get(key('103')), [['codex:co', 'commit']]);
  assert.equal(l.get(key('5002')), undefined);
  assert.deepEqual(pipelineRoots(SESSIONS, [ROOT_NONE, ROOT_GH, 'rel'], 5), [ROOT_GH, ROOT_GL, ROOT_NONE]);
});

test('pipelines: feed stays off by default and in untrusted workspaces', async () => {
  const off = await pipelinesFeed.load({ sessions: SESSIONS, trusted: true, config: (_k, f) => f, now: NOW });
  assert.equal(off.state, 'off');
  const cfg = (k: string, f: unknown) => (k === 'agent.pipelines.enabled' ? true : f);
  const un = await pipelinesFeed.load({ sessions: SESSIONS, trusted: false, config: cfg as never, now: NOW });
  assert.equal(un.state, 'untrusted');
});

function data(): WsData {
  return { sessions: SESSIONS, providers: [], events: [], now: NOW, ternAvailable: false };
}

test('pipelines: screen renders every tab escaped, with session chips and evidence', async () => {
  clearFeeds();
  setFeedValue('pipelines.ci', { state: 'off', at: NOW, repos: [], calls: 0, noRemote: 0 } satisfies CiReport);
  const off = renderWorkspace(data(), { view: 'pipelines' });
  assert.match(off, /agent\.pipelines\.enabled/);
  assert.match(off, /data-act="settings"/);

  setFeedValue('pipelines.ci', await report());
  const variants: Record<string, string>[] = [
    {},
    { 'pipelines.show': 'all', 'pipelines.age': 'all' },
    { 'pipelines.tab': 'runs' },
    { 'pipelines.tab': 'runs', 'pipelines.runs': 'strip', 'pipelines.group': 'branch' },
    { 'pipelines.tab': 'runs', 'pipelines.runs': 'bars', 'pipelines.orient': 'h', 'pipelines.group': 'workflow' },
    { 'pipelines.tab': 'runs', 'pipelines.runs': 'bars' },
    { 'pipelines.tab': 'gantt' },
    { 'pipelines.tab': 'gantt', 'pipelines.run': 'gl-5001', 'pipelines.jgroup': 'runner' },
    { 'pipelines.tab': 'gantt', 'pipelines.level': 'runs', 'pipelines.win': '24h' },
    { 'pipelines.tab': 'runners' },
    { 'pipelines.tab': 'runners', 'pipelines.rchart': 'heat', 'pipelines.gran': '15m' },
    { 'pipelines.tab': 'runners', 'pipelines.rchart': 'table', 'pipelines.gran': 'day' },
    { 'pipelines.prov': 'gitlab', 'pipelines.tab': 'runs', 'pipelines.period': 'all' },
  ];
  for (const opts of variants) {
    const h = renderWorkspace(data(), { view: 'pipelines', opts });
    const label = JSON.stringify(opts);
    assert.ok(h.includes('class="pl"'), label);
    assert.ok(!h.includes('<script>alert'), `escaped: ${label}`);
    assert.ok(!h.includes('ghp_abcdef'), `redacted: ${label}`);
    assert.ok(!h.includes('evil.example'), `no foreign links: ${label}`);
    assert.ok(!/NaN|undefined/.test(h.replace(/<style[\s\S]*?<\/style>/g, '')), `no NaN / undefined: ${label}`);
  }
  const blocks = renderWorkspace(data(), { view: 'pipelines', opts: { 'pipelines.age': 'all' } });
  assert.match(blocks, /data-select="codex:co"/, 'failing run links the session that made the commit');
  assert.match(blocks, /INFERRED/);
  assert.match(blocks, /Needs a person/);
  const runs = renderWorkspace(data(), { view: 'pipelines', opts: { 'pipelines.tab': 'runs', 'pipelines.period': 'all' } });
  assert.match(runs, /&lt;script&gt;/);
  assert.match(runs, /data-opt="pipelines.run" data-val="gh-103"/);
  const gantt = renderWorkspace(data(), { view: 'pipelines', opts: { 'pipelines.tab': 'gantt', 'pipelines.run': 'gl-5002' } });
  assert.match(gantt, /e2e/);
  assert.match(gantt, /pl-q/, 'queued segment drawn');
  assert.equal(pipelinesView.badge?.(data()), '2', 'badge counts failing + needs-a-person');
});

test('pipelines: open action only follows links the feed listed', async () => {
  setFeedValue('pipelines.ci', await report());
  const opened: string[] = [];
  const ctx = { openUrl: async (u: string) => void opened.push(u) } as unknown as ActCtx;
  await pipelinesView.actions!.open('https://github.com/acme/app/actions/runs/103/job/9002', ctx);
  assert.deepEqual(opened, ['https://github.com/acme/app/actions/runs/103/job/9002']);
  assert.throws(() => pipelinesView.actions!.open('https://github.com/other/repo', ctx));
  assert.throws(() => pipelinesView.actions!.open('http://evil.example/actions/runs/102', ctx));
  clearFeeds();
});
