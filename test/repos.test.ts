import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
import { hardenedGit, isDirty, loadRepos, parseBranches, parseCommits, parseStatus, parseWorktrees, REPOS_DEFAULTS, worktreeOf } from '../src/git/repos';
import '../src/render/workspace'; // load the registry first (workspace ↔ extra screens import cycle)
import { reposView } from '../src/render/extra/repos';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { git, makeRepo, tmpDir } from './helpers';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

test('parseWorktrees reads porcelain blocks', () => {
  const out = 'worktree /r\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /r/wt/x\nHEAD bbbb\ndetached\nlocked reason\n\nworktree /r/wt/y\nHEAD cccc\nbranch refs/heads/feat/y\nprunable gitdir file points to non-existent location\n';
  const w = parseWorktrees(out);
  assert.equal(w.length, 3);
  assert.equal(w[0].main, true);
  assert.equal(w[0].branch, 'main');
  assert.equal(w[1].detached, true);
  assert.equal(w[1].locked, true);
  assert.equal(w[2].branch, 'feat/y');
  assert.equal(w[2].prunable, true);
  assert.equal(w[2].main, false);
});

test('parseBranches reads ahead / behind / gone / local', () => {
  const b = parseBranches(['main\torigin/main\tahead 2, behind 3\tabc123\t1700000000\tfix: x', 'feat\t\t\tdef456\t1700000100\tlocal', 'old\torigin/old\tgone\t999999\t1600000000\tgone one', 'same\torigin/same\t\t111111\t1700000000\tin sync'].join('\n'));
  assert.deepEqual([b[0].ahead, b[0].behind, b[0].gone], [2, 3, false]);
  assert.equal(b[1].upstream, undefined);
  assert.equal(b[1].ahead, undefined);
  assert.equal(b[2].gone, true);
  assert.equal(b[2].ahead, undefined);
  assert.deepEqual([b[3].ahead, b[3].behind], [0, 0]);
  assert.equal(b[0].at, 1700000000_000);
});

test('parseStatus counts staged, unstaged, untracked, conflicts (with -z renames)', () => {
  const out = ['M  a.ts', ' M b.ts', 'MM c.ts', '?? new/', 'UU d.ts', 'R  new.ts', 'old.ts', 'AA e.ts', ''].join('\0');
  assert.deepEqual(parseStatus(out), { staged: 3, unstaged: 2, untracked: 1, conflicts: 2 });
  assert.equal(isDirty(parseStatus('')), false);
});

test('parseCommits strips HEAD, tags and stash refs', () => {
  const c = parseCommits('abc1234\t1700000000\tHEAD -> main, origin/main, tag: v1\tfeat: one\ndef5678\t1699999000\t\tsecond');
  assert.deepEqual(c[0].refs, ['main', 'origin/main']);
  assert.equal(c[1].refs.length, 0);
  assert.equal(c[1].subject, 'second');
});

test('worktreeOf picks the longest containing worktree', () => {
  const ws = [{ path: path.resolve('/r') }, { path: path.resolve('/r/.claude/worktrees/x') }];
  assert.equal(worktreeOf(snap({ cwd: path.resolve('/r/.claude/worktrees/x/src') }), ws), ws[1].path);
  assert.equal(worktreeOf(snap({ cwd: path.resolve('/r/src') }), ws), ws[0].path);
  assert.equal(worktreeOf(snap({ cwd: path.resolve('/rx') }), ws), undefined);
});

test('hardened runner refuses write commands', async () => {
  const run = hardenedGit();
  assert.equal(await run(process.cwd(), ['checkout', 'main']), undefined);
  assert.equal(await run(process.cwd(), ['worktree', 'add', 'x']), undefined);
  assert.equal(await run(process.cwd(), ['fetch']), undefined);
});

test('loadRepos reads a real repo with a linked worktree, dirty state and upstream', async () => {
  const { repo } = makeRepo();
  const remote = tmpDir('remote');
  git(remote, ['init', '-q', '--bare']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  fs.writeFileSync(path.join(repo, 'src', 'f0.ts'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'loose.txt'), 'x');
  git(repo, ['commit', '-q', '-am', 'ahead one']);
  fs.writeFileSync(path.join(repo, 'src', 'f1.ts'), 'unstaged\n');
  const wt = path.join(tmpDir('wt'), 'feat');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt]);
  fs.writeFileSync(path.join(wt, 'staged.ts'), 'x');
  git(wt, ['add', 'staged.ts']);
  git(repo, ['stash', 'push', '-q', '-m', 'one']);
  const live = snap({ key: 'claude:live', status: 'RUNNING', cwd: wt, lastActivityAt: Date.now() });
  const snapR = await loadRepos([live, snap({ key: 'codex:b', provider: 'codex', cwd: repo, lastActivityAt: Date.now() - 1000 })], { ...REPOS_DEFAULTS, timeoutMs: 15_000 });
  const seen = JSON.stringify(snapR.repos.map(x => ({ repository: x.repository, error: x.error, worktrees: x.worktrees.map(w => w.path) })));
  assert.equal(snapR.repos.length, 1, `one repository for the main checkout and its worktree: ${seen}`);
  const r = snapR.repos[0];
  assert.equal(r.error, undefined, seen);
  assert.equal(r.worktrees.length, 2, seen);
  const main = r.worktrees.find(w => w.main)!;
  const feat = r.worktrees.find(w => !w.main)!;
  assert.equal(feat.branch, 'feat');
  assert.deepEqual(feat.dirty && [feat.dirty.staged, feat.dirty.unstaged], [1, 0]);
  assert.ok(main.dirty && main.dirty.untracked >= 1, 'loose.txt untracked');
  assert.equal(main.dirty?.unstaged, 0, 'stashed');
  const mb = r.branches.find(b => b.name === 'main')!;
  assert.deepEqual([mb.upstream, mb.ahead, mb.behind], ['origin/main', 1, 0]);
  assert.equal(r.branches.find(b => b.name === 'feat')!.upstream, undefined);
  assert.equal(r.stashes, 1);
  assert.ok(r.commits.length >= 3);

  // Render with this snapshot.
  clearFeeds();
  setFeedValue('repos.git', snapR);
  const d = { sessions: [live], providers: [], events: [], now: Date.now(), ternAvailable: true };
  for (const opts of <Record<string, string>[]>[{}, { 'repos.by': 'worktree' }, { 'repos.by': 'branch', 'repos.show': 'all' }, { 'repos.view': 'spine' }, { 'repos.view': 'spine', 'repos.orient': 'vertical' }]) {
    const html = reposView.render(d, { view: 'repos', opts });
    assert.ok(html.includes('feat'), JSON.stringify(opts));
    assert.ok(html.includes('data-select="claude:live"'), `live session chip ${JSON.stringify(opts)}`);
  }
  assert.equal(reposView.badge!(d as never), '2');
  clearFeeds();
});

/** Windows 8.3 short form of an existing path (as os.tmpdir() returns on CI runners), or the path itself. */
function shortPath(p: string): string {
  if (process.platform !== 'win32') return p;
  try {
    return execSync(`for %I in ("${p}") do @echo %~sI`, { windowsHide: true, shell: 'cmd.exe' }).toString().trim() || p;
  } catch {
    return p;
  }
}

test('loadRepos groups a checkout and its worktree when session paths use 8.3 short names', { skip: process.platform !== 'win32' }, async () => {
  const { repo } = makeRepo();
  const wt = path.join(tmpDir('wt'), 'long-worktree-name');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat', wt]);
  const sRepo = shortPath(repo);
  const sWt = shortPath(wt);
  if (sRepo === repo && sWt === wt) return; // 8.3 names disabled on this volume
  const live = snap({ key: 'claude:live', status: 'RUNNING', cwd: sWt, lastActivityAt: Date.now() });
  const snapR = await loadRepos([live, snap({ key: 'codex:b', provider: 'codex', cwd: sRepo, lastActivityAt: 1 })], { ...REPOS_DEFAULTS, timeoutMs: 15_000 });
  assert.equal(snapR.repos.length, 1, JSON.stringify(snapR.repos.map(x => x.repository)));
  const feat = snapR.repos[0].worktrees.find(w => !w.main)!;
  assert.equal(worktreeOf(live, snapR.repos[0].worktrees), feat.path);
});

test('repos screen escapes branch names and handles empty / untrusted states', () => {
  clearFeeds();
  const d = { sessions: [], providers: [], events: [], now: Date.now(), ternAvailable: false };
  assert.ok(reposView.render(d, { view: 'repos' }).includes('Waiting'));
  setFeedValue('repos.git', { at: Date.now(), repos: [], off: 'untrusted', skipped: 0, gitCalls: 0 });
  assert.ok(reposView.render(d, { view: 'repos' }).includes('untrusted'));
  const evil = '<img src=x onerror=alert(1)>';
  setFeedValue('repos.git', { at: Date.now(), skipped: 0, gitCalls: 1, repos: [{ repository: '/r', name: evil, ms: 1, stashes: 0, commits: [{ sha: 'abc', at: 1, refs: [evil], subject: evil }], worktrees: [{ path: '/r', branch: evil, detached: false, bare: false, locked: false, prunable: false, main: true, exists: true, dirty: { staged: 1, unstaged: 0, untracked: 0, conflicts: 0 } }], branches: [{ name: evil, sha: 'abc', at: Date.now(), subject: evil, gone: false, worktree: '/r' }] }] });
  for (const opts of <Record<string, string>[]>[{ 'repos.show': 'all' }, { 'repos.by': 'branch', 'repos.show': 'all' }, { 'repos.view': 'spine', 'repos.show': 'all' }]) {
    const html = reposView.render(d, { view: 'repos', opts });
    assert.ok(!html.includes('<img'), JSON.stringify(opts));
    assert.ok(html.includes('&lt;img'));
  }
  clearFeeds();
});
