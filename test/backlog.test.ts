import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES } from './helpers';
import { isoWeek, linkSessions, markerOf, mentions, parsePlan, splitId, stateOf, weekly, weekStart } from '../src/activity/backlog';
import { scanBacklog } from '../src/feeds/backlog';
// workspace first: it loads the screen registry (screens import helpers from workspace).
import '../src/render/workspace';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { backlogView } from '../src/render/extra/backlog';
import type { WsData } from '../src/render/workspace';
import type { AgentSessionSnapshot } from '../src/model';

const REPO = path.join(FIXTURES, 'backlog', 'repo');
const PLAN = fs.readFileSync(path.join(REPO, 'handoff', 'PLAN.md'), 'utf8');

function sess(over: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return {
    key: 'claude:x', provider: 'claude', sessionId: 'x', status: 'ENDED', statusReason: '', commits: [], changedFiles: [], tests: [], isWorker: false,
    counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], ...over,
  };
}

test('backlog: ids, states and markers', () => {
  assert.deepEqual(splitId('P1 · Week calendar'), { id: 'P1', title: 'Week calendar' });
  assert.deepEqual(splitId('V1.0.x-QATMP — cleanup'), { id: 'V1.0.x-QATMP', title: 'cleanup' });
  assert.equal(splitId('Ready for gate').id, undefined);
  assert.equal(splitId('QA-1/2/3 merged').id, undefined, 'id must end the token');
  assert.equal(splitId('2026-10-05 notes').id, undefined, 'a date is not an id');
  assert.equal(stateOf('✓ #100')?.state, 'done');
  assert.equal(stateOf('blocked on Julian')?.state, 'blocked');
  assert.equal(stateOf('queued')?.state, 'open');
  assert.equal(markerOf('badges on cards, In review / Ready to merge columns'), undefined, 'prose words are not markers');
  assert.equal(markerOf('step through events — running')?.state, 'active');
  assert.equal(markerOf('view `week`. done (#5)'), undefined, 'needs a separator before the keyword');
  assert.equal(markerOf('view week — done (#5)')?.state, 'done');
});

test('backlog: parsePlan reads checklists, state tables, bold leads; skips fences and stateless tables', () => {
  const its = parsePlan(PLAN);
  const by = (id: string) => its.find(i => i.id === id);
  assert.equal(by('P1')?.shape, 'bold');
  assert.equal(by('P1')?.state, 'open', '"done" glued to a sentence is not a marker');
  assert.equal(by('P2')?.state, 'open');
  assert.equal(by('P3')?.state, 'active');
  assert.equal(by('P4')?.state, 'dropped');
  assert.equal(by('M0')?.state, 'done');
  assert.equal(by('M0')?.title, 'Baseline');
  assert.equal(by('M1')?.state, 'open');
  assert.equal(by('M1')?.stateBasis, 'empty state cell');
  assert.equal(by('HUB-1')?.state, 'blocked');
  assert.equal(by('QA-2')?.state, 'active');
  assert.equal(by('V1-REF')?.state, 'done');
  assert.equal(by('data')?.shape, 'bold', 'lowercase id under a packages / wave heading');
  assert.equal(by('week')?.title, '(P1): calendar');
  assert.ok(!its.some(i => i.title.includes('not an item')), 'fenced code is ignored');
  assert.ok(!its.some(i => i.title.includes('PM 1') || i.title.includes('everything')), 'table without a state column is ignored');
  assert.equal(its.filter(i => i.id === 'P3').length, 1, 'spec heading of a listed id is not a second item');
  assert.equal(by('V9'), undefined, 'heading without a separator after the id');
  assert.equal(by('P6')?.shape, 'heading');
  assert.equal(by('P6')?.state, 'blocked');
  const checks = its.filter(i => i.shape === 'check');
  assert.deepEqual(checks.map(i => i.state), ['done', 'open', 'open', 'blocked']);
  assert.equal(checks[1].id, 'P5');
  assert.equal(checks[2].depth, 1);
  assert.equal(checks[0].section, 'Demo — plan › Checklist');
  // dates: inherited from the nearest dated heading
  assert.equal(new Date(by('P1')!.dated!).getDate(), 1);
  assert.equal(new Date(by('HUB-1')!.dated!).getDate(), 5);
  assert.equal(by('HUB-1')!.datedOwn, false);
});

test('backlog: scan finds plan, TODO and archive files with a size cap', async () => {
  const r = await scanBacklog({ roots: [REPO, path.join(FIXTURES, 'backlog', 'missing')], now: 1 });
  assert.deepEqual(r.files.map(f => f.rel), ['handoff/PLAN.md', 'TODO.md', 'handoff/archive/2026-09-plan.md']);
  assert.equal(r.files[2].archive, true);
  const small = await scanBacklog({ roots: [REPO], now: 1, maxBytes: 100 });
  assert.match(small.files[0].skipped ?? '', /larger than/);
  assert.equal(small.files[0].items.length, 0);
});

test('backlog: sessions are linked by branch or id text, same repository only', async () => {
  assert.equal(mentions('data', { text: 'fix the data layer', branches: [] }), undefined, 'lowercase id needs a branch');
  assert.equal(mentions('data', { text: '', branches: ['night/data'] }), 'branch');
  assert.equal(mentions('P1', { text: 'build P10 screen', branches: [] }), undefined);
  assert.equal(mentions('V1', { text: 'V1-SURF work', branches: [] }), undefined, 'V1 is not V1-SURF');
  assert.equal(mentions('HUB-1', { text: 'coder on hub-1 seeds', branches: [] }), 'text');
  const r = await scanBacklog({ roots: [REPO], now: 1 });
  const ss = [
    sess({ key: 'claude:a', cwd: path.join(REPO, '.claude', 'worktrees', 'night-data'), branch: 'night/data', lastActivityAt: Date.now() }),
    sess({ key: 'codex:b', provider: 'codex', repository: REPO, title: 'HUB-1 seeds and QA-2', lastActivityAt: Date.now() }),
    sess({ key: 'claude:c', repository: path.join(FIXTURES, 'other'), title: 'HUB-1 elsewhere' }),
  ];
  const lk = linkSessions(r.files, ss);
  const plan = r.files[0];
  const key = (id: string) => `${plan.file}#${plan.items.find(i => i.id === id)!.line}`;
  assert.deepEqual(lk.get(key('data'))?.map(l => l.key), ['claude:a']);
  assert.deepEqual(lk.get(key('HUB-1'))?.map(l => l.key), ['codex:b'], 'other repository is not linked');
  assert.equal(lk.get(key('P2')), undefined);
});

test('backlog: weekly archive buckets done items', async () => {
  assert.equal(isoWeek(new Date(2026, 9, 5).getTime()), '2026-W41');
  assert.equal(isoWeek(new Date(2026, 0, 1).getTime()), '2026-W01');
  assert.equal(new Date(weekStart(new Date(2026, 9, 11, 15).getTime())).getDate(), 5, 'Sunday belongs to the week starting Monday');
  const r = await scanBacklog({ roots: [REPO], now: 1 });
  const now = new Date(2026, 9, 6, 12).getTime();
  const ended = sess({ key: 'codex:v', repository: REPO, title: 'V1-REF progressive', status: 'ENDED', endedAt: new Date(2026, 8, 30, 10).getTime() });
  const lk = linkSessions(r.files, [ended]);
  const b = weekly(r.files, lk, new Map([[ended.key, ended]]), now, 4);
  assert.equal(b[0].label, '2026-W41');
  const w40 = b.find(x => x.label === '2026-W40')!;
  const vref = w40.done.find(x => x.it.id === 'V1-REF')!;
  assert.equal(vref.basis, 'session', 'closed when the linked session ended');
  assert.ok(w40.sessions.has('codex:v'));
  const w39 = b.find(x => x.label === '2026-W39')!;
  assert.deepEqual(w39.done.filter(x => x.f.archive).map(x => x.it.id).sort(), ['OLD-1', 'OLD-2'], 'archive items dated by their heading');
});

test('backlog: screen renders escaped board, table, files and weeks', async () => {
  clearFeeds();
  const evil = path.join(REPO);
  const r = await scanBacklog({ roots: [evil], now: Date.now() });
  r.files[0].items.push({ id: 'X-1', title: '<img src=x onerror=alert(1)>', state: 'open', stateBasis: 'x', shape: 'check', section: '<b>s</b>', line: 999, depth: 0 });
  setFeedValue('backlog.plans', { report: r, extra: [] });
  const d: WsData = {
    sessions: [sess({ key: 'claude:a', repository: REPO, branch: 'night/data', title: '<script>t</script>', status: 'RUNNING', lastActivityAt: Date.now() })],
    providers: [], events: [], now: Date.now(), ternAvailable: false,
  };
  for (const view of ['board', 'table', 'files', 'weeks']) {
    for (const orient of ['columns', 'rows']) {
      const html = backlogView.render(d, { view: 'backlog', opts: { 'backlog.view': view, 'backlog.orient': orient, 'backlog.state': 'all', 'backlog.archive': 'show' } });
      assert.ok(html.length > 500, view);
      assert.ok(!html.includes('<img src=x') && !html.includes('<script>t') && !html.includes('<b>s</b>'), `${view} escapes`);
    }
  }
  const board = backlogView.render(d, { view: 'backlog', opts: { 'backlog.view': 'board' } });
  assert.match(board, /data-select="claude:a"/);
  assert.ok(!/class="bl-c bl-c-done/.test(board), 'pending filter hides done cards');
  const none = backlogView.render({ ...d, sessions: [] }, { view: 'backlog' });
  assert.match(none, /No plan file found/, 'out of scope repositories are hidden');
  clearFeeds();
});
