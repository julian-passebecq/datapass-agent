import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { ChangesData, clearChangesCache, collectChanges, parseNumstatZ, parseStatusZ } from '../src/git/changes';
import { factPath, fileRows, folderOf, groupRows, heat, lineSources, sessionRows } from '../src/activity/changes';
import { allowedPath, changesView } from '../src/render/extra/changes';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { git, makeRepo, T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const H = 3600_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

test('changes: numstat and status parsers (-z records, binary, renames, conflicts)', () => {
  assert.deepEqual(parseNumstatZ('3\t1\tsrc/a.ts\x00-\t-\timg/x.png\x00\n10\t0\tdir with space/b c.md\x00'), [
    { path: 'src/a.ts', added: 3, removed: 1 },
    { path: 'img/x.png', added: 0, removed: 0, binary: true },
    { path: 'dir with space/b c.md', added: 10, removed: 0 },
  ]);
  const st = parseStatusZ(' M src/a.ts\x00?? new.txt\x00R  to.ts\x00from.ts\x00UU both.ts\x00?? n2/\x00');
  assert.deepEqual(st.untracked, ['new.txt', 'n2/']);
  assert.deepEqual(st.conflicts, ['both.ts']);
  assert.deepEqual(st.staged, ['to.ts']);
  assert.deepEqual(st.unstaged, ['src/a.ts']);
});

test('changes: collect from a real repo (commit window, staged, unstaged, untracked); untrusted runs nothing', async () => {
  clearChangesCache();
  const { repo, shas } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'f0.ts'), 'export const v = 0;\nexport const w = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'f1.ts'), 'changed\n');
  git(repo, ['add', 'src/f1.ts']);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  const s = mk({ key: 'claude:a', worktree: repo, repository: repo, cwd: repo, headBefore: shas[0], headAfter: shas[2], status: 'RUNNING', lastActivityAt: Date.now() });
  const calls: string[][] = [];
  const off = await collectChanges([s], { now: Date.now(), trusted: false, run: async (_c, a) => (calls.push(a), '') });
  assert.ok(off.off);
  assert.equal(calls.length, 0);
  const d = await collectChanges([s], { now: Date.now(), trusted: true });
  assert.deepEqual(d.diffs['claude:a'].files.map(f => [f.path, f.added, f.removed]), [['src/f1.ts', 2, 0], ['src/f2.ts', 3, 0]]);
  const w = d.worktrees[0];
  assert.deepEqual(w.unstaged.map(f => f.path), ['src/f0.ts']);
  assert.deepEqual(w.staged.map(f => [f.path, f.added, f.removed]), [['src/f1.ts', 1, 2]]);
  assert.deepEqual(w.untracked, ['new.txt']);
  assert.deepEqual(w.sessions, ['claude:a']);
  assert.equal(d.failed, 0);
  // HEAD and index untouched (read-only)
  assert.equal(git(repo, ['rev-parse', 'HEAD']), shas[2]);
  // second pass: commit-window diff comes from the cache
  const n = d.calls;
  const d2 = await collectChanges([s], { now: Date.now(), trusted: true });
  assert.equal(d2.calls, n - 1);
});

test('changes: windows inside another window of the same worktree count once; overlap is flagged', () => {
  const diff = (key: string, from: string, to: string, files: [string, number, number][]) => ({ key, worktree: 'D:/r', from, to, files: files.map(([p, a, r]) => ({ path: p, added: a, removed: r })) });
  const lead = mk({ key: 'claude:lead', repository: 'D:/r', worktree: 'D:/r', startedAt: NOW - 5 * H, lastActivityAt: NOW - H });
  const worker = mk({ key: 'claude:w', repository: 'D:/r', worktree: 'D:/r', isWorker: true, parentSessionId: 'claude:lead', startedAt: NOW - 4 * H, lastActivityAt: NOW - 2 * H });
  const other = mk({ key: 'codex:o', repository: 'D:/r', worktree: 'D:/r', startedAt: NOW - 2 * H, lastActivityAt: NOW - 0.5 * H });
  const data: ChangesData = {
    diffs: {
      'claude:lead': diff('claude:lead', 'aaaaaaa', 'bbbbbbb', [['a.ts', 10, 2]]),
      'claude:w': diff('claude:w', 'aaaaaaa', 'ccccccc', [['a.ts', 4, 0]]),
      'codex:o': diff('codex:o', 'ccccccc', 'ddddddd', [['a.ts', 1, 1], ['b.ts', 5, 0]]),
    },
    worktrees: [{ worktree: 'D:/r', repository: 'D:/r', staged: [], unstaged: [{ path: 'b.ts', added: 2, removed: 0 }], untracked: ['c.ts'], conflicts: [], sessions: ['codex:o'], at: NOW }],
    calls: 0, ms: 0, skipped: 0, failed: 0,
  };
  const ls = lineSources([lead, worker, other], data.diffs);
  assert.deepEqual([...ls.include].sort(), ['claude:lead', 'codex:o']);
  assert.ok(ls.overlapping.has('codex:o'));
  const rows = fileRows([lead, worker, other], data, 0);
  const a = rows.find(r => r.path === 'a.ts')!;
  assert.deepEqual([a.added, a.removed, a.sessions.length, a.overlap], [11, 3, 3, true]);
  const b = rows.find(r => r.path === 'b.ts')!;
  assert.equal(b.wt?.state, 'unstaged');
  assert.equal(rows.find(r => r.path === 'c.ts')!.wt?.state, 'untracked');
  const byRepo = groupRows(rows, 'repo');
  assert.equal(byRepo.length, 1);
  assert.equal(byRepo[0].added, 16);
  assert.equal(byRepo[0].files, 3);
  assert.equal(folderOf('src/render/extra/x.ts', 2), 'src/render');
  assert.equal(folderOf('x.ts', 2), '.');
  const sr = sessionRows([lead, worker, other], data, 0);
  assert.equal(sr.find(r => r.s.key === 'codex:o')!.wt?.untracked[0], 'c.ts');
});

test('changes: edit calls from facts map to repo paths; heat buckets by hour', () => {
  const s = mk({ key: 'claude:e', repository: 'D:/r', worktree: 'D:/r', cwd: 'D:/r/pkg', facts: { files: [{ path: 'src/x.ts', edits: 3, lastAt: NOW - 2 * H }, { path: 'README.md', edits: 1, lastAt: NOW - H }] } });
  assert.equal(factPath(s, 'src/x.ts'), 'pkg/src/x.ts');
  const rows = fileRows([s], undefined, NOW - 24 * H);
  assert.deepEqual(rows.map(r => [r.path, r.edits, r.git]).sort(), [['pkg/README.md', 1, false], ['pkg/src/x.ts', 3, false]]);
  const ev = (at: number, label: string): TimelineEvent => ({ at, type: 'FILE_CHANGE', label, provider: 'claude', sessionKey: 'claude:e', kind: 'OBSERVED' });
  const h = heat([s], [ev(NOW - 2 * H, 'edited x.ts'), ev(NOW - 2 * H + 60_000, 'edited x.ts'), ev(NOW - H, 'wrote README.md'), ev(NOW - H, '3 files changed')], { from: NOW - 24 * H, now: NOW, gran: 'hour', top: 10 });
  assert.equal(h.rows[0].path, 'pkg/src/x.ts');
  assert.equal(h.rows[0].total, 2);
  assert.equal(h.unmatched, 1);
  assert.equal(h.rows[0].cells.reduce((a, b) => a + b, 0), 2);
  assert.equal(h.max, 2);
});

test('changes: screen renders every tab escaped, from cached feed data', () => {
  clearFeeds();
  const evil = '<img src=x onerror=alert(1)>.ts';
  const s = mk({ key: 'claude:z', title: '<b>t</b>', repository: 'D:/r', worktree: 'D:/r', status: 'RUNNING', lastActivityAt: NOW - 60_000, facts: { files: [{ path: evil, edits: 2, lastAt: NOW - 60_000 }] } });
  setFeedValue<ChangesData>('changes.git', { diffs: { 'claude:z': { key: 'claude:z', worktree: 'D:/r', from: 'aaaaaaa', to: 'bbbbbbb', files: [{ path: evil, added: 5, removed: 1 }] } }, worktrees: [{ worktree: 'D:/r', repository: 'D:/r', branch: 'main', staged: [], unstaged: [{ path: evil, added: 1, removed: 0 }], untracked: [], conflicts: [], sessions: ['claude:z'], at: NOW }], calls: 4, ms: 12, skipped: 0, failed: 0 });
  const d: WsData = { sessions: [s], providers: [], events: [{ at: NOW - 60_000, type: 'FILE_CHANGE', label: `edited ${evil}`, provider: 'claude', sessionKey: 'claude:z', kind: 'OBSERVED' }], now: NOW, ternAvailable: false };
  assert.equal(changesView.ready, true);
  for (const tab of ['files', 'sessions', 'worktrees', 'heat']) {
    for (const chart of ['table', 'bars', 'treemap']) {
      const html = renderWorkspace(d, { view: 'changes', selected: 'claude:z', opts: { 'changes.tab': tab, 'changes.chart': chart, 'changes.orient': 'cols', 'changes.pick': '' } });
      assert.ok(!html.includes('<img'), `${tab}/${chart} escapes`);
      assert.ok(html.includes('chg'), tab);
    }
  }
  const files = renderWorkspace(d, { view: 'changes', opts: { 'changes.tab': 'files' } });
  assert.match(files, /\+5/);
  assert.match(files, /dirty worktrees/);
  assert.equal(changesView.badge!(d), '1');
  clearFeeds();
});

test('changes: actions accept only paths inside a session worktree, never auth files', () => {
  const root = path.resolve('/tmp/agent-wt');
  const ss = [mk({ key: 'claude:p', worktree: root })];
  assert.equal(allowedPath(path.join(root, 'src', 'a.ts'), ss), true);
  assert.equal(allowedPath(root, ss), true);
  assert.equal(allowedPath(path.join(root, '..', 'other', 'a.ts'), ss), false);
  assert.equal(allowedPath(root + '/../x', ss), false);
  assert.equal(allowedPath(path.resolve('/tmp/elsewhere/a.ts'), ss), false);
  assert.equal(allowedPath(path.join(root, '.env'), ss), false);
  assert.equal(allowedPath(path.join(root, 'auth.json'), ss), false);
  assert.equal(allowedPath('relative/a.ts', ss), false);
});
