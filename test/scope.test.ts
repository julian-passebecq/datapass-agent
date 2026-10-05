import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FIXTURES } from './helpers';
import { linkSessions, parsePlan } from '../src/activity/backlog';
import { buildMaps, milestoneOf, pickBaseline, progress, UNSORTED } from '../src/activity/scope';
import { scanBacklog } from '../src/feeds/backlog';
import { readBaseline } from '../src/feeds/scope';
import { itemKey } from '../src/archive/reader';
// workspace first: it loads the screen registry (screens import helpers from workspace).
import '../src/render/workspace';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { checkTarget, scopeView } from '../src/render/extra/scope';
import { extraViews } from '../src/render/extra';
import type { WsData } from '../src/render/workspace';
import type { AgentSessionSnapshot } from '../src/model';

const REPO = path.join(FIXTURES, 'backlog', 'repo');

function sess(over: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return {
    key: 'claude:x', provider: 'claude', sessionId: 'x', status: 'ENDED', statusReason: '', commits: [], changedFiles: [], tests: [], isWorker: false,
    counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], ...over,
  };
}

test('scope: milestones come from the heading trail', () => {
  const its = parsePlan('# Plan\n\n## Packages\n### Wave 3 (2026-10-01)\n- [x] **A-1** one\n#### sub\n- [ ] **A-2** two\n## Notes\n- [ ] **N-1** note\n');
  assert.deepEqual(its.find(i => i.id === 'A-2')?.trail, ['Packages', 'Wave 3 (2026-10-01)', 'sub'], 'h1 is left out');
  assert.deepEqual(milestoneOf(its.find(i => i.id === 'A-1')!), { milestone: 'Wave 3 (2026-10-01)', group: '' });
  assert.deepEqual(milestoneOf(its.find(i => i.id === 'A-2')!), { milestone: 'Wave 3 (2026-10-01)', group: 'sub' });
  assert.deepEqual(milestoneOf(its.find(i => i.id === 'N-1')!), { milestone: 'Notes', group: '' }, 'no milestone word: outermost heading');
  assert.equal(milestoneOf(parsePlan('- [ ] loose item\n')[0]).milestone, UNSORTED);
  assert.equal(milestoneOf({ section: 'x', trail: ['Roadmap', 'V1.2 polish'] }).milestone, 'V1.2 polish');
});

test('scope: buildMaps groups the fixture per project and milestone with counts and changes', async () => {
  const r = await scanBacklog({ roots: [REPO], now: 1 });
  const ss = [sess({ key: 'codex:b', provider: 'codex', repository: REPO, title: 'HUB-1 seeds', lastActivityAt: Date.now() })];
  const lk = linkSessions(r.files, ss);
  const plan = r.files[0];
  const p1 = plan.items.find(i => i.id === 'P1')!;
  const hub = plan.items.find(i => i.id === 'HUB-1')!;
  const states = new Map([[itemKey(plan.root, plan.rel, p1), 'open' as const], [itemKey(plan.root, plan.rel, hub), 'active' as const]]);
  const maps = buildMaps(r.files, lk, { states, keyOf: (f, it) => itemKey(f.root, f.rel, it) });
  assert.equal(maps.length, 1);
  const p = maps[0];
  assert.equal(p.files.length, 2, 'archive files are left out');
  const names = p.milestones.map(m => m.name);
  assert.ok(names.includes('Wave 2 (2026-10-05)'), names.join(' | '));
  assert.ok(names.includes('Milestones'));
  const w2 = p.milestones.find(m => m.name === 'Wave 2 (2026-10-05)')!;
  assert.equal(w2.counts.blocked, 1);
  assert.equal(w2.counts.done, 1);
  assert.equal(w2.total, w2.counts.done + w2.left);
  const hubItem = w2.groups.flatMap(g => g.items).find(x => x.it.id === 'HUB-1')!;
  assert.deepEqual(hubItem.change, { from: 'active', to: 'blocked' });
  assert.deepEqual(hubItem.links.map(l => l.key), ['codex:b']);
  assert.ok(p.sessions.has('codex:b'));
  const pk = p.milestones.flatMap(m => m.groups.flatMap(g => g.items)).find(x => x.it.id === 'P1')!;
  assert.equal(pk.change, undefined, 'same state: no change');
  assert.ok(p.changed >= 2, 'items missing from the baseline are new');
  const dropped = p.milestones.flatMap(m => m.groups.flatMap(g => g.items)).find(x => x.it.id === 'P4')!;
  assert.equal(dropped.state, 'dropped');
  assert.equal(p.total, p.counts.done + p.counts.active + p.counts.blocked + p.counts.pending);
  assert.ok(progress(p.counts) > 0 && progress(p.counts) < 1);
  assert.equal(buildMaps(r.files, lk)[0].changed, 0, 'no baseline: no changes');
});

test('scope: baseline is the previous weekly snapshot', async () => {
  assert.equal(pickBaseline(['2026-09-20', '2026-09-28', '2026-10-01', '2026-10-05'], '2026-10-05'), '2026-09-28');
  assert.equal(pickBaseline(['2026-10-02', '2026-10-04'], '2026-10-05'), '2026-10-02', 'no week-old snapshot: the oldest one');
  assert.equal(pickBaseline(['2026-10-05'], '2026-10-05'), undefined, 'today only');
  assert.equal(pickBaseline([], '2026-10-05'), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'));
  try {
    assert.equal(await readBaseline(dir, Date.now()), undefined, 'no backlog folder');
    fs.mkdirSync(path.join(dir, 'backlog'));
    const now = new Date(2026, 9, 5, 12).getTime();
    const snap = { v: 1, day: '2026-09-28', at: 0, roots: [REPO], files: [{ root: REPO, repo: 'repo', rel: 'handoff/PLAN.md', items: [{ id: 'HUB-1', title: 'hub seeds', state: 'active' }, { id: 'BAD', title: 'x', state: 'weird' }] }] };
    fs.writeFileSync(path.join(dir, 'backlog', '2026-09-28.json'), JSON.stringify(snap));
    fs.writeFileSync(path.join(dir, 'backlog', '2026-10-05.json'), '{}');
    const b = await readBaseline(dir, now);
    assert.equal(b?.day, '2026-09-28');
    assert.equal(b?.days, 2);
    assert.equal(b?.states.get(itemKey(REPO, 'handoff/PLAN.md', { id: 'HUB-1', title: '' })), 'active');
    assert.equal(b?.states.size, 1, 'unknown states are skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scope: screen renders escaped overview, grid and tree; open targets are checked', async () => {
  clearFeeds();
  assert.ok(extraViews().some(v => v.id === 'scope'), 'registered and ready');
  const r = await scanBacklog({ roots: [REPO], now: Date.now() });
  r.files[0].items.push({ id: 'X-1', title: '<img src=x onerror=alert(1)>', state: 'open', stateBasis: 'x', shape: 'check', section: 's', line: 999, depth: 0, trail: ['<b>ms</b>'] });
  setFeedValue('backlog.plans', { report: r, extra: [] });
  const plan = r.files[0];
  setFeedValue('scope.baseline', { day: '2026-09-28', days: 3, states: new Map([[itemKey(plan.root, plan.rel, { id: 'HUB-1', title: '' }), 'active']]) });
  const d: WsData = {
    sessions: [sess({ key: 'claude:a', repository: REPO, branch: 'night/data', title: '<script>t</script>', status: 'RUNNING', lastActivityAt: Date.now() })],
    providers: [], events: [], now: Date.now(), ternAvailable: false,
  };
  const all = scopeView.render(d, { view: 'scope' });
  assert.match(all, /data-opt="scope\.proj"/);
  assert.match(all, /Changed since 2026-09-28/);
  const pk = /class="sc-r" data-opt="scope\.proj" data-val="([a-z0-9]+)"/.exec(all)![1];
  for (const layout of ['grid', 'tree']) {
    for (const show of ['all', 'left']) {
      for (const changes of ['off', 'on']) {
        const html = scopeView.render(d, { view: 'scope', opts: { 'scope.proj': pk, 'scope.layout': layout, 'scope.show': show, 'scope.changes': changes } });
        assert.ok(html.length > 500, `${layout} ${show} ${changes}`);
        assert.ok(!html.includes('<img src=x') && !html.includes('<script>t') && !html.includes('<b>ms</b>'), `${layout} escapes`);
      }
    }
  }
  const grid = scopeView.render(d, { view: 'scope', opts: { 'scope.proj': pk } });
  assert.match(grid, /data-select="claude:a"/, 'linked session (night/data branch)');
  assert.match(grid, /data-act="open"/);
  assert.match(grid, /was Active/);
  const left = scopeView.render(d, { view: 'scope', opts: { 'scope.proj': pk, 'scope.show': 'left' } });
  assert.ok(!/class="sc-ch sc-done/.test(left), "what's left hides done items");
  assert.deepEqual(checkTarget(`${plan.file}#12`), { file: plan.file, line: 12 });
  assert.throws(() => checkTarget('C:/elsewhere/x.md#1'));
  assert.throws(() => checkTarget(plan.file));
  setFeedValue('scope.baseline', undefined);
  assert.ok(!scopeView.render(d, { view: 'scope' }).includes('scope.changes'), 'no archive: no changes toggle');
  assert.match(scopeView.render({ ...d, sessions: [] }, { view: 'scope' }), /No plan items found/);
  clearFeeds();
});
