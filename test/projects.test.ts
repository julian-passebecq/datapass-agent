import { test } from 'node:test';
import * as assert from 'node:assert/strict';
// Load the workspace first: screens import it and it imports the screen registry (cycle).
import '../src/render/workspace';
import { AgentSessionSnapshot } from '../src/model';
import { buildProjects, inferPlace, parseRules, placeOf, repoPath, ruleMatches, squarify } from '../src/activity/projects';
import { projectsView } from '../src/render/extra/projects';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { WsData } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], lastActivityAt: NOW - 3600_000, ...p };
}

test('parseRules drops malformed entries', () => {
  const r = parseRules([{ match: 'D:/PROJ/a', company: 'A' }, { match: '', company: 'x' }, { match: 'b' }, 'str', null, { match: 'c', project: 'P' }]);
  assert.deepEqual(r, [{ match: 'D:/PROJ/a', company: 'A', project: undefined }, { match: 'c', company: undefined, project: 'P' }]);
  assert.deepEqual(parseRules({}), []);
});

test('rule matching: prefix, glob, bare name, case and slash insensitive', () => {
  assert.ok(ruleMatches({ match: 'D:\\PROJ\\datapass-vscode' }, 'd:/proj/datapass-vscode', 'datapass-vscode'));
  assert.ok(ruleMatches({ match: 'D:/PROJ' }, 'D:\\PROJ\\foo', 'foo'));
  assert.ok(!ruleMatches({ match: 'D:/PRO' }, 'D:\\PROJ\\foo', 'foo'), 'prefix stops at folder boundary');
  assert.ok(ruleMatches({ match: 'D:/PROJ/datapass-*' }, 'D:\\PROJ\\datapass-agent', 'datapass-agent'));
  assert.ok(!ruleMatches({ match: 'D:/PROJ/datapass-*' }, 'D:\\PROJ\\foil', 'foil'));
  assert.ok(ruleMatches({ match: '**/clients' }, 'C:/work/clients/acme', 'acme'));
  assert.ok(ruleMatches({ match: 'foil-*' }, undefined, 'foil-study'));
  assert.ok(ruleMatches({ match: 'Atlasnote' }, 'D:/x/atlasnote', 'atlasnote'));
});

test('inference: parent folder or drive is the company, folder or prefix is the project', () => {
  assert.deepEqual(inferPlace('D:\\PROJ\\datapass-vscode', 'datapass-vscode', 'folder'), { company: 'PROJ', project: 'datapass-vscode', repo: 'datapass-vscode', path: 'D:\\PROJ\\datapass-vscode' });
  assert.equal(inferPlace('D:\\PROJ\\datapass-vscode', 'datapass-vscode', 'prefix').project, 'datapass');
  assert.equal(inferPlace('d:\\solo', 'solo', 'folder').company, 'D:');
  assert.equal(inferPlace('C:/Users/me/code/app', 'app', 'folder').company, 'me', 'generic container is skipped');
  assert.equal(inferPlace(undefined, '(no repo)', 'folder').company, '(unknown)');
});

test('repoPath strips linked worktree suffix from cwd when git is unknown', () => {
  assert.equal(repoPath(snap({ cwd: 'D:\\PROJ\\agent\\.claude\\worktrees\\wf-1' })), 'D:\\PROJ\\agent');
  assert.equal(repoPath(snap({ cwd: 'D:\\x\\.claude\\worktrees\\wf-1', repository: 'D:\\real' })), 'D:\\real');
});

test('most specific rule wins, rule fills only what it names', () => {
  const rules = parseRules([{ match: 'D:/PROJ', company: 'Julian' }, { match: 'D:/PROJ/datapass-*', company: 'DataPass', project: 'Platform' }]);
  const a = placeOf(snap({ repository: 'D:\\PROJ\\datapass-agent' }), rules);
  assert.deepEqual([a.company, a.project, a.repo, a.source, a.rule], ['DataPass', 'Platform', 'datapass-agent', 'rule', 1]);
  const b = placeOf(snap({ repository: 'D:\\PROJ\\atlasnote' }), rules);
  assert.deepEqual([b.company, b.project, b.source], ['Julian', 'atlasnote', 'rule']);
  const c = placeOf(snap({ cwd: 'E:\\other\\thing' }), rules);
  assert.deepEqual([c.company, c.source], ['other', 'inferred']);
});

test('buildProjects rolls up counts, filters by period, reports unused rules', () => {
  const ss = [
    snap({ key: 'claude:1', repository: 'D:\\PROJ\\datapass-agent', status: 'RUNNING', usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }, commits: [{ sha: 'a', at: NOW, subject: 's', attribution: 'during-session' }] }),
    snap({ key: 'codex:2', provider: 'codex', repository: 'D:\\PROJ\\datapass-vscode', usage: { totalTokens: 500, outputTokens: 50, cachedInputTokens: 0 } }),
    snap({ key: 'claude:3', repository: 'D:\\PROJ\\datapass-agent', isWorker: true, status: 'RUNNING' }),
    snap({ key: 'claude:old', repository: 'D:\\PROJ\\old', lastActivityAt: NOW - 30 * 86400_000 }),
  ];
  const rules = parseRules([{ match: 'datapass-*', company: 'DataPass', project: 'DP' }, { match: 'nothing-*', company: 'X' }]);
  const r = buildProjects(ss, rules, { now: NOW, since: NOW - 7 * 86400_000 });
  assert.equal(r.companies.length, 1);
  const c = r.companies[0];
  assert.equal(c.name, 'DataPass');
  assert.equal(c.children.length, 1);
  assert.equal(c.children[0].children.length, 2);
  assert.deepEqual([c.stats.sessions, c.stats.workers, c.stats.live, c.stats.liveWorkers, c.stats.tokens, c.stats.commits, c.stats.claude, c.stats.codex], [2, 1, 1, 1, 1500, 1, 2, 1]);
  assert.deepEqual(r.unusedRules, [1]);
  assert.equal(r.total.tokens, 1500);
  assert.equal(buildProjects(ss, [], { now: NOW }).companies[0].children.length, 3, 'all loaded keeps old repo');
});

test('squarify fills the box and keeps order', () => {
  const rs = squarify([6, 6, 4, 3, 2, 2, 1, 0], { x: 0, y: 0, w: 60, h: 40 });
  const area = rs.reduce((a, r) => a + r.w * r.h, 0);
  assert.ok(Math.abs(area - 2400) < 1e-6);
  assert.ok(Math.abs(rs[0].w * rs[0].h - 600) < 1e-6);
  assert.equal(rs[7].w * rs[7].h, 0);
  for (const r of rs) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 60 + 1e-6 && r.y + r.h <= 40 + 1e-6);
  assert.deepEqual(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }).map(r => r.w), [0, 0]);
});

test('projects screen renders every layout, escapes names, scopes by repo key', () => {
  clearFeeds();
  setFeedValue('projects.rules', parseRules([{ match: 'D:/PROJ/<b>evil', company: '<script>x</script>', project: 'P"q' }]));
  const ss = [
    snap({ key: 'claude:1', repository: 'D:\\PROJ\\<b>evil', title: '<img src=x>', status: 'RUNNING', usage: { totalTokens: 1234, outputTokens: 1, cachedInputTokens: 0 } }),
    snap({ key: 'codex:2', provider: 'codex', repository: 'D:\\PROJ\\datapass-vscode', usage: { totalTokens: 99, outputTokens: 1, cachedInputTokens: 0 } }),
  ];
  const d: WsData = { sessions: ss, providers: [], events: [], now: NOW, ternAvailable: false };
  for (const view of ['tree', 'cards', 'treemap']) {
    for (const depth of ['1', '2', '3', '4']) {
      const html = projectsView.render(d, { view: 'projects', opts: { 'projects.view': view, 'projects.depth': depth } });
      assert.ok(html.length > 200, `${view} renders`);
      assert.ok(!html.includes('<script>') && !html.includes('<img src=x>') && !html.includes('<b>evil'), `${view} escapes`);
    }
  }
  const tree = projectsView.render(d, { view: 'projects', opts: { 'projects.depth': '4' } });
  assert.ok(tree.includes('data-val="datapass-vscode"'), 'repo scope button');
  assert.ok(tree.includes('data-select="claude:1"'), 'session rows selectable');
  assert.ok(!tree.includes('data-val="&lt;b&gt;evil"'), 'invalid scope keys are not offered');
  assert.equal(projectsView.badge?.(d), '1');
  const empty = projectsView.render({ ...d, sessions: [] }, { view: 'projects' });
  assert.ok(empty.includes('No sessions'));
  clearFeeds();
});

test('projects actions only touch paths of known sessions', async () => {
  const calls: string[] = [];
  const ctx = { sessions: () => [snap({ repository: 'D:\\PROJ\\a' })], revealInOs: async (p: string) => void calls.push(`reveal ${p}`), copy: async (p: string) => void calls.push(`copy ${p}`), info: () => undefined, runCommand: async (id: string, a: unknown) => void calls.push(`${id} ${JSON.stringify(a)}`) } as any;
  await projectsView.actions!.reveal('C:\\Windows', ctx);
  await projectsView.actions!.reveal('d:\\proj\\a', ctx);
  await projectsView.actions!.copy('D:\\PROJ\\a', ctx);
  await projectsView.actions!.newtab('bad key!', ctx);
  await projectsView.actions!.newtab('a', ctx);
  assert.deepEqual(calls, ['reveal D:\\PROJ\\a', 'copy D:\\PROJ\\a', 'agent.openWorkspaceNewTab {"scope":"a"}']);
});
