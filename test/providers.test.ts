import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { clearGitCache } from '../src/git/git';
import { canonical } from '../src/util/paths';
import { FIXTURES, git, jpath, makeRepo, materialize, snapshotTree, T, tmpDir } from './helpers';

function setup(clockIso: string) {
  clearGitCache();
  const { repo, shas } = makeRepo();
  const home = tmpDir('home');
  const vars = { __CWD__: jpath(repo), __HEAD__: shas[1], __MISSING__: jpath(path.join(home, 'deleted-worktree')) };
  materialize(path.join(FIXTURES, 'claude'), path.join(home, 'claude'), vars);
  materialize(path.join(FIXTURES, 'codex'), path.join(home, 'codex'), vars);
  const claude = new ClaudeAdapter(path.join(home, 'claude'));
  const codex = new CodexAdapter(path.join(home, 'codex'));
  const store = new SessionStore([claude, codex], { historyDays: 30, maxSessions: 100, idleMinutes: 10, git: true }, () => T(clockIso));
  return { repo, shas, home, store, claude, codex };
}

test('claude adapter: session, location, model/effort, tests, files, worker tree, evidence', async () => {
  const { store, repo, shas } = setup('2026-10-04T12:00:00Z');
  await store.refresh();
  const s = store.get('claude:11111111-1111-4111-8111-111111111111');
  assert.ok(s, 'session present');
  assert.equal(s.title, 'Parser work');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'high', 'last observed effort');
  assert.equal(s.providerVersion, '2.1.289', 'version evolution: newest record wins');
  assert.equal(s.cwd, repo);
  assert.equal(s.branch, 'feat/x', 'branch from provider record (OBSERVED) wins over git');
  assert.equal(s.status, 'ENDED', 'no live registry, old activity');
  assert.equal(s.startedAt, T('2026-10-04T09:12:00Z'));
  assert.equal(s.lastActivityAt, T('2026-10-04T09:28:00Z'), 'unknown record types still count as activity');
  assert.deepEqual(s.tests.map(t => t.outcome), ['PASS', 'FAIL']);
  assert.equal(s.tests[0].source, 'provider-tool-error-flag');
  assert.deepEqual(s.changedFiles, ['src/foo.ts', 'src/f1.ts'].filter(f => s.changedFiles.includes(f)));
  assert.ok(s.changedFiles.includes('src/foo.ts'));
  assert.equal(s.counts.fileEdits, 1, 'duplicated record ignored');
  assert.equal(s.linesAdded !== undefined, true);
  assert.equal(s.headBefore, shas[0], 'HEAD before = last commit before start');
  assert.equal(s.commits.length, 1);
  assert.equal(s.commits[0].sha, shas[1]);
  assert.equal(s.commits[0].attribution, 'session-ran-git-commit');
  assert.ok(s.diagnostics.some(d => d.includes('malformed')), 'malformed line reported');
  const ev = (f: string) => s.evidence.find(e => e.field === f)?.kind;
  assert.equal(ev('cwd'), 'OBSERVED');
  assert.equal(ev('repository'), 'DERIVED');
  // Worker tree from subagents/ transcripts
  const kids = store.children(s.key);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].isWorker, true);
  assert.equal(kids[0].workerLabel, 'Explore · Research parser');
  assert.equal(kids[0].status, 'ENDED', 'parent recorded the Agent tool result');
  const tl = store.timeline(s.key);
  const types = tl.map(e => e.type);
  for (const t of ['SESSION_STARTED', 'TEST', 'FILE_CHANGE', 'WORKER_STARTED', 'WORKER_ENDED', 'COMMIT', 'SESSION_ENDED']) assert.ok(types.includes(t as any), `timeline has ${t}`);
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i].at >= tl[i - 1].at, 'timeline sorted despite out-of-order records');
});

test('claude adapter: live registry → RUNNING; secrets never copied', async () => {
  const { store, home } = setup('2026-10-04T09:30:00Z');
  fs.mkdirSync(path.join(home, 'claude', 'sessions'));
  fs.writeFileSync(path.join(home, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: '11111111-1111-4111-8111-111111111111', status: 'busy', version: '2.1.289', messagingSocketPath: '\\\\.\\pipe\\secret', name: 'Parser work' }));
  await store.refresh();
  const s = store.get('claude:11111111-1111-4111-8111-111111111111')!;
  assert.equal(s.status, 'RUNNING');
  const dump = JSON.stringify([store.all(), store.timeline(), store.providerStates]);
  for (const leak of ['sk-ant-FAKEFAKEFAKEFAKE0000', 'ghp_FAKEFAKEFAKEFAKEFAKE1234', 'abcdefghijklmnopqrstuvwxyz0123', 'pipe\\\\secret']) assert.ok(!dump.includes(leak), `leaked ${leak}`);
  assert.ok(dump.includes('[REDACTED]'), 'redaction marker present');
});

test('codex adapter: meta, turn state, exit-code tests, file changes, subagent parent, archive', async () => {
  const { store, shas, repo } = setup('2026-10-04T10:19:00Z');
  await store.refresh();
  const s = store.get('codex:22222222-2222-7222-8222-222222222222');
  assert.ok(s);
  assert.equal(s.title, 'Tern panel', 'title from session_index');
  assert.equal(s.model, 'gpt-6.1-sol');
  assert.equal(s.effort, 'high');
  assert.equal(s.providerVersion, '0.160.0');
  assert.equal(s.headBefore, shas[1], 'OBSERVED session_meta.git.commit_hash');
  assert.equal(s.evidence.find(e => e.field === 'headBefore')?.kind, 'OBSERVED');
  assert.equal(s.status, 'RUNNING', 'turn t2 open with recent activity');
  assert.deepEqual(s.tests.map(t => [t.command, t.outcome, t.exitCode]), [['pytest -q', 'PASS', 0], ['npm test', 'FAIL', 1]], 'dedupe + exit codes');
  assert.ok(s.changedFiles.includes('src/panel.ts') && s.changedFiles.includes('README.md'));
  assert.equal(canonical(s.worktree!).toLowerCase(), canonical(repo).toLowerCase());
  const kids = store.children(s.key);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].workerLabel, 'Euclid · /root/tests');
  assert.equal(kids[0].evidence.find(e => e.field === 'parentSessionId')?.kind, 'OBSERVED');
  const old = store.get('codex:44444444-4444-7444-8444-444444444444')!;
  assert.equal(old.status, 'ENDED', 'archived');
  assert.equal(old.repository, undefined, 'missing repo stays unknown');
  assert.ok(old.diagnostics.some(d => d.includes('no longer exists')), 'deleted worktree diagnosed');
  assert.deepEqual(old.tests.map(t => t.outcome), ['PASS'], 'older function_call format still parsed');
  const st = store.providerStates.find(p => p.provider === 'codex')!;
  assert.equal(st.version, '0.160.0');
});

test('collectors: each source reports ready / partial / missing explicitly', async () => {
  const { store } = setup('2026-10-04T12:00:00Z');
  await store.refresh();
  const src = new Map(store.providerStates.flatMap(p => p.sources ?? []).map(s => [s.id, s]));
  assert.equal(src.get('claude.transcripts')?.status, 'ready');
  assert.equal(src.get('claude.subagents')?.count, 1);
  assert.equal(src.get('claude.registry')?.status, 'missing', 'fixture has no ~/.claude/sessions');
  assert.match(src.get('claude.registry')!.detail, /falls back/);
  assert.equal(src.get('codex.archive')?.status, 'ready');
  assert.equal(src.get('codex.archive')?.count, 1);
  assert.equal(src.get('codex.live')?.status, 'partial', 'Codex exposes no live registry');
  const s = store.get('claude:11111111-1111-4111-8111-111111111111')!;
  assert.ok((s.artifactBytes ?? 0) > 0, 'artifact size recorded for Storage');
});

test('codex: open turn without recent activity is UNKNOWN, never RUNNING or FAILED', async () => {
  const { store } = setup('2026-10-04T13:00:00Z');
  await store.refresh();
  const s = store.get('codex:22222222-2222-7222-8222-222222222222')!;
  assert.equal(s.status, 'UNKNOWN');
});

test('git: linked worktree and detached HEAD are reported', async () => {
  const { store, repo, home } = setup('2026-10-04T12:00:00Z');
  const wt = path.join(path.dirname(repo), path.basename(repo) + '-wt');
  git(repo, ['worktree', 'add', '-q', '--detach', wt, 'HEAD~1']);
  const f = path.join(home, 'claude', 'projects', 'D--fixture-repo', '11111111-1111-4111-8111-111111111111.jsonl');
  // A second Claude session located in the detached linked worktree.
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'z1', timestamp: '2026-10-04T11:00:00.000Z', cwd: wt, sessionId: '55555555-5555-4555-8555-555555555555', version: '2.1.289' });
  fs.writeFileSync(path.join(path.dirname(f), '55555555-5555-4555-8555-555555555555.jsonl'), line + '\n');
  await store.refresh();
  const s = store.get('claude:55555555-5555-4555-8555-555555555555')!;
  assert.equal(s.isLinkedWorktree, true);
  assert.equal(s.detachedHead, true);
  assert.equal(s.branch, undefined);
  assert.equal(canonical(s.repository!).toLowerCase(), canonical(repo).toLowerCase());
});

test('security: provider artifacts are never mutated by ingestion', async () => {
  const { store, home } = setup('2026-10-04T12:00:00Z');
  const before = snapshotTree(home);
  await store.refresh();
  await store.refresh();
  const after = snapshotTree(home);
  assert.deepEqual([...after], [...before]);
});

test('security: artifact reached through a junction/symlink outside the provider root is rejected', async () => {
  const { home, claude } = setup('2026-10-04T12:00:00Z');
  const outside = tmpDir('evil');
  fs.writeFileSync(path.join(outside, 'x.jsonl'), '{"type":"user","sessionId":"x","timestamp":"2026-10-04T09:00:00Z"}\n');
  const link = path.join(home, 'claude', 'projects', 'D--evil');
  fs.symlinkSync(outside, link, 'junction'); // junctions need no admin rights on Windows
  const p = path.join(link, 'x.jsonl');
  const st = fs.statSync(p);
  assert.equal(claude.ingest({ path: p, mtimeMs: st.mtimeMs, size: st.size }), undefined);
  assert.ok(claude.diagnostics.some(d => d.includes('rejected')));
});

test('incremental refresh reads only appended bytes', async () => {
  const { store, home } = setup('2026-10-04T12:00:00Z');
  const first = await store.refresh();
  assert.ok(first.bytesRead > 0);
  const f = path.join(home, 'codex', 'sessions', '2026', '10', '04', 'rollout-2026-10-04T10-20-00-33333333-3333-7333-8333-333333333333.jsonl');
  const add = JSON.stringify({ timestamp: '2026-10-04T10:23:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 's2' } }) + '\n';
  fs.appendFileSync(f, add);
  const second = await store.refresh();
  assert.equal(second.ingested, 1);
  assert.equal(second.bytesRead, Buffer.byteLength(add));
});
