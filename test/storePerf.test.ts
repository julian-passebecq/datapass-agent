import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore, viewNeedsRender, VIEW_STALE_MS, LIVE_GIT_MAX_AGE_MS } from '../src/sessions/store';
import { clearGitCache, diffStat, gitSignal, gitDirs, gitStats } from '../src/git/git';
import { git, makeRepo, tmpDir } from './helpers';

function line(sid: string, at: number, cwd: string, i: number): string {
  return JSON.stringify({ type: 'assistant', uuid: `${sid}-${i}`, timestamp: new Date(at).toISOString(), sessionId: sid, version: '2.1.289', cwd, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${sid}${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } });
}

function sid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Claude history with one session per cwd, last activity `ageMs` ago. */
function history(cwds: string[], ageMs = 10_000): { home: string; files: string[]; store: (clock?: () => number, wall?: () => number, gitOn?: boolean) => SessionStore } {
  const home = tmpDir('storeperf');
  const proj = path.join(home, 'claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const at = Date.now() - ageMs;
  const files = cwds.map((cwd, n) => {
    const f = path.join(proj, `${sid(n)}.jsonl`);
    fs.writeFileSync(f, [line(sid(n), at - 60_000, cwd, 0), line(sid(n), at, cwd, 1)].join('\n') + '\n');
    return f;
  });
  return {
    home,
    files,
    store: (clock = Date.now, wall = Date.now, gitOn = true) => new SessionStore([new ClaudeAdapter(path.join(home, 'claude')), new CodexAdapter(path.join(home, 'codex'))], { historyDays: 2, maxSessions: 500, idleMinutes: 10, git: gitOn }, clock, wall),
  };
}

test('gitSignal: stable without change, moves on commit and checkout, no spawn; linked worktree resolved', () => {
  clearGitCache();
  const { repo } = makeRepo();
  const calls = gitStats.calls;
  const a = gitSignal(repo);
  assert.equal(gitSignal(repo), a, 'nothing changed: same signal');
  assert.equal(gitStats.calls, calls, 'the signal never spawns git');
  fs.writeFileSync(path.join(repo, 'n.txt'), 'n\n');
  git(repo, ['add', '.']);
  const staged = gitSignal(repo);
  assert.notEqual(staged, a, 'staging moves the index');
  git(repo, ['commit', '-q', '-m', 'n']);
  const committed = gitSignal(repo);
  assert.notEqual(committed, staged, 'a commit moves HEAD reflog / ref');
  git(repo, ['checkout', '-q', '-b', 'other']);
  assert.notEqual(gitSignal(repo), committed, 'a checkout changes HEAD');
  const wt = path.join(tmpDir('wt'), 'linked');
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'side']);
  const dirs = gitDirs(path.join(wt));
  assert.ok(dirs && /worktrees/.test(dirs.gitDir), `linked worktree git dir ${dirs?.gitDir}`);
  assert.equal(path.resolve(dirs!.commonDir).toLowerCase(), path.join(repo, '.git').toLowerCase());
  const w1 = gitSignal(wt);
  assert.equal(gitSignal(wt), w1);
  fs.writeFileSync(path.join(wt, 'w.txt'), 'w\n');
  git(wt, ['add', '.']);
  git(wt, ['commit', '-q', '-m', 'w']);
  assert.notEqual(gitSignal(wt), w1, 'commit in the linked worktree');
  assert.equal(gitSignal(tmpDir('plain')), 'no-repo');
  assert.equal(gitSignal(path.join(repo, 'does-not-exist')), 'missing');
  assert.equal(gitSignal(undefined), 'none');
});

test('diffStat: a from..to result is cached (immutable commits) and handed out as a copy', async () => {
  clearGitCache();
  const { repo, shas } = makeRepo();
  const c0 = gitStats.calls;
  const d1 = await diffStat(repo, shas[0], shas[2]);
  assert.ok(d1 && d1.files.length === 2 && d1.added > 0);
  assert.equal(gitStats.calls, c0 + 1);
  d1!.files.push('mutated');
  const d2 = await diffStat(repo, shas[0], shas[2]);
  assert.equal(gitStats.calls, c0 + 1, 'second call served from the cache');
  assert.deepEqual(d2!.files.sort(), ['src/f1.ts', 'src/f2.ts']);
  await Promise.all([diffStat(repo, shas[1], shas[2]), diffStat(repo, shas[1], shas[2])]);
  assert.equal(gitStats.calls, c0 + 2, 'concurrent callers share one spawn');
});

test('store: no git re-correlation when only the clock moves; a commit or the max age re-correlates', async () => {
  clearGitCache();
  const { repo } = makeRepo();
  let offset = 0, wallOffset = 0;
  const h = history([repo]);
  const store = h.store(() => Date.now() + offset, () => Date.now() + wallOffset);
  const cold = await store.refresh();
  assert.equal(cold.gitCorrelated, 1);
  const s0 = store.all()[0];
  assert.notEqual(s0.status, 'ENDED', `fixture session must be non-ended (${s0.status}: ${s0.statusReason})`);
  assert.ok(s0.repository, 'correlated');
  const calls = gitStats.calls;
  offset += 61_000; // the old signature carried a minute bucket: this re-ran git every minute
  const idle = await store.refresh();
  assert.equal(idle.gitCorrelated, 0);
  assert.equal(gitStats.calls, calls, 'no git spawn on an idle refresh one minute later');
  assert.ok(store.all()[0].repository, 'git fields kept');
  fs.writeFileSync(path.join(repo, 'later.txt'), 'x\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'during session']);
  const moved = await store.refresh();
  assert.equal(moved.gitCorrelated, 1, 'HEAD moved: re-correlated');
  assert.ok(store.all()[0].commits.some(c => c.subject === 'during session'), 'new commit seen');
  assert.equal((await store.refresh()).gitCorrelated, 0);
  wallOffset += LIVE_GIT_MAX_AGE_MS + 1000;
  assert.equal((await store.refresh()).gitCorrelated, 1, 'a non-ended session is re-asked after the max age');
  // Evidence is not duplicated by carrying results over across passes.
  const ev = store.all()[0].evidence.filter(e => e.field === 'repository');
  assert.equal(ev.length, 1);
});

test('store: idle refresh keeps snapshots and version; a new line rebuilds that session only', async () => {
  clearGitCache();
  const h = history([tmpDir('a'), tmpDir('b')]);
  const store = h.store(Date.now, Date.now, false);
  let emits = 0;
  store.onDidChange(() => emits++);
  await store.refresh();
  const v = store.version;
  const [a, b] = store.all().sort((x, y) => x.key.localeCompare(y.key));
  emits = 0;
  const idle = await store.refresh();
  assert.equal(idle.ingested, 0);
  assert.equal(store.version, v, 'nothing changed: same version');
  assert.equal(emits, 1, 'one end-of-pass notification only');
  assert.equal(store.get(a.key), a, 'snapshot object kept');
  fs.appendFileSync(h.files[0], line(sid(0), Date.now(), a.cwd!, 2) + '\n');
  const inc = await store.refresh();
  assert.equal(inc.ingested, 1);
  assert.ok(store.version > v, 'version bumped');
  assert.notEqual(store.get(a.key), a, 'changed session rebuilt');
  assert.equal(store.get(b.key), b, 'unchanged session kept');
  assert.equal(store.get(a.key)!.counts.tools, a.counts.tools + 1);
});

test('store: ingest yields to the event loop and reports its longest synchronous stretch', async () => {
  const h = history(Array.from({ length: 150 }, () => 'C:\\nowhere'));
  // Make each artifact non-trivial so the pass spans several slices.
  for (const [n, f] of h.files.entries()) fs.appendFileSync(f, Array.from({ length: 300 }, (_, i) => line(sid(n), Date.now() - 5000, 'C:\\nowhere', i + 10)).join('\n') + '\n');
  const store = h.store(Date.now, Date.now, false);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  const st = await store.refresh();
  clearInterval(iv);
  assert.equal(store.all().length, 150);
  assert.ok(typeof st.longestSyncMs === 'number' && st.longestSyncMs >= 0);
  if (st.ms > 100) assert.ok(ticks > 0, `timers ran during a ${st.ms} ms refresh (longest stretch ${st.longestSyncMs} ms)`);
});

test('store: cold git phase is progressive (notifies per batch, progress counted)', async () => {
  clearGitCache();
  const { repo } = makeRepo();
  const cwds = Array.from({ length: 12 }, (_, i) => {
    const d = path.join(repo, `d${i}`);
    fs.mkdirSync(d);
    return d;
  });
  const store = history(cwds).store();
  const seen: { version: number; correlated: number; progress: string }[] = [];
  store.onDidChange(() => seen.push({ version: store.version, correlated: store.all().filter(s => s.repository).length, progress: `${store.gitProgress.done}/${store.gitProgress.total}` }));
  const st = await store.refresh();
  assert.equal(st.gitCorrelated, 12);
  assert.deepEqual(store.gitProgress, { done: 12, total: 12 });
  assert.ok(seen.length >= 3, `first paint, at least one batch, end (${JSON.stringify(seen)})`);
  assert.equal(seen[0].correlated, 0, 'sessions appear before git');
  assert.ok(seen.some(x => x.correlated > 0 && x.correlated < 12 && x.progress === '8/12'), `a partial batch was published (${JSON.stringify(seen)})`);
  assert.equal(seen[seen.length - 1].correlated, 12);
});

test('viewNeedsRender: idle store notification builds no page; version, feed or age does', () => {
  const base = { version: 3, renderedVersion: 3, renderedAt: 1000, feedPending: false, now: 1000 + 5000 };
  assert.equal(viewNeedsRender(base), false);
  assert.equal(viewNeedsRender({ ...base, version: 4 }), true);
  assert.equal(viewNeedsRender({ ...base, feedPending: true }), true);
  assert.equal(viewNeedsRender({ ...base, now: 1000 + VIEW_STALE_MS }), true);
});
