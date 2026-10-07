import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES } from './helpers';
import { AgentSessionSnapshot } from '../src/model';
// Load order as in the extension (workspace → extra/index → screens).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { WorkflowsSnapshot, WorkflowScanner } from '../src/providers/claude/workflows';
import { agentEffort, runCounts, runningWfAgents, runPhase, runsByLead, runStrip } from '../src/activity/wfLinks';
import { buildTree, leads } from '../src/activity/topology';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { topologyView } from '../src/render/extra/topology';
import { liveView } from '../src/render/extra/live';
import { hudView } from '../src/render/extra/hud';
import { renderWorkflows } from '../src/render/extra/workflows';
import { WF_FEED_ID } from '../src/render/extra/wfkit';

const PROJECTS = path.join(FIXTURES, 'workflows', 'projects');
const SID = '11111111-2222-3333-4444-555555555555';
const RUN_DIR = path.join(PROJECTS, 'D--PROJ-demo', SID, 'subagents', 'workflows', 'wf_test0001-abc');
const LEAD = `claude:${SID}`;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }, now: number): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'RUNNING', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: now - 3600_000, lastActivityAt: now - 10_000, ...p };
}

async function setup(withWorker = true): Promise<{ now: number; snap: WorkflowsSnapshot; d: WsData }> {
  const m = (f: string) => fs.statSync(path.join(RUN_DIR, f)).mtimeMs;
  const now = Math.max(m('agent-a0001.jsonl'), m('agent-a0002.jsonl')) + 60_000;
  const snap = await new WorkflowScanner(PROJECTS).scan(now);
  const lead = mk({ key: LEAD, title: 'DiagramCloud lead', model: 'claude-opus-5-5', effort: 'medium' }, now);
  const w1 = mk({ key: 'claude:w1', parentSessionId: LEAD, isWorker: true, workerLabel: 'Explore', title: 'explore worker' }, now);
  clearFeeds();
  setFeedValue(WF_FEED_ID, snap, now);
  return { now, snap, d: { sessions: withWorker ? [lead, w1] : [lead], providers: [], events: [], now, ternAvailable: false } };
}

test('wfLinks: runs join their lead by directory; counts, phase, strip, effort evidence', async () => {
  const { snap, d } = await setup();
  const runs = runsByLead(snap);
  const rs = runs.get(LEAD)!;
  assert.equal(rs.length, 1);
  const r = rs[0];
  assert.deepEqual(runCounts(r), { total: 3, done: 1, failed: 1, running: 1 });
  assert.equal(runPhase(r), 'Code', 'phase of the running agent');
  assert.equal(runStrip(r), 'workflow demo-run · Code · 2/3 done');
  assert.equal(runningWfAgents(runs), 1);
  const lead = d.sessions[0];
  const [one, two] = r.agents;
  assert.equal(two.effort, 'high', 'assistant record .effort read from the agent transcript');
  assert.deepEqual([agentEffort(two, lead).text, agentEffort(two, lead).kind], ['high', 'OBSERVED']);
  assert.deepEqual([agentEffort(one, lead).text, agentEffort(one, lead).kind], ['medium (inherited)', 'INFERRED']);
  assert.equal(agentEffort(one, undefined).kind, 'UNKNOWN');
  const known = runsByLead(snap, new Set([one.sessionKey]));
  assert.equal(known.get(LEAD)![0].agents.length, 2, 'an agent already loaded as a session is not counted twice');
});

test('topology: workflow run is a group node under its lead, agents as children', async () => {
  const { now, snap, d } = await setup();
  const runs = runsByLead(snap);
  const t = buildTree(d.sessions, d.sessions[0], { now, runs });
  assert.equal(t.children.length, 2, 'plain worker + run node');
  const wf = t.children.find(c => c.wf)!;
  assert.equal(wf.key, 'wf:wf_test0001-abc');
  assert.equal(wf.children.length, 3);
  assert.ok(wf.children.every(c => c.wa && !c.s));
  assert.equal(wf.roll.sessions, 3);
  assert.equal(wf.roll.live, 1);
  assert.equal(t.roll.sessions, 5, 'lead + worker + 3 workflow agents');
  assert.equal(t.roll.tokens, wf.roll.tokens);
  assert.equal(t.roll.depth, 1);
  const solo = await setup(false);
  assert.deepEqual(leads(solo.d.sessions).length, 0, 'without runs a session with no worker is not a lead');
  assert.deepEqual(leads(solo.d.sessions, runsByLead(solo.snap)).map(s => s.key), [LEAD], 'a run makes it a lead');
});

test('topology screen: workflow nodes in every layout, escaped, with model · effort and legend', async () => {
  const { d } = await setup();
  for (const layout of ['tree', 'list', 'org']) {
    const h = topologyView.render(d, { view: 'topology', selected: LEAD, opts: { 'topology.layout': layout } });
    assert.ok(h.includes('workflow demo-run'), layout);
    assert.ok(h.includes('code:ONE'), layout);
    assert.ok(!h.includes('<img src=x'), `${layout}: label escaped`);
    assert.ok(h.includes('Sonnet') && h.includes('high'), `${layout}: observed effort`);
    assert.ok(h.includes('medium (inherited)'), `${layout}: inherited effort`);
    assert.ok(h.includes('workflow agents'), `${layout}: KPI`);
  }
  const h = topologyView.render(d, { view: 'topology', opts: {} });
  assert.ok(h.includes('subagents/workflows/'), 'legend names the workflow edge');
  assert.ok(h.includes('1 workflow run(s) with 3 agent(s)'));
  assert.ok(topologyView.feeds?.some(f => f.id === WF_FEED_ID));
});

test('team, overview, live, hud and workflows screens show the run under the lead', async () => {
  const { d } = await setup();
  const team = renderWorkspace(d, { view: 'team', selected: LEAD });
  assert.ok(team.includes('wk-lane') && team.includes('workflow demo-run · Code · 2/3 done'));
  const ov = renderWorkspace(d, { view: 'overview' });
  assert.ok(ov.includes('workflow demo-run 2/3'), 'badge on the lead card');
  assert.ok(ov.includes('+ 1 workflow agent(s)'));
  assert.match(ov, /plus 1 running Claude workflow agent/);
  const lv = liveView.render(d, { view: 'live', opts: {} });
  assert.ok(lv.includes('lv-wf') && lv.includes('Read · a.ts'), 'running agent row with its current tool');
  assert.ok(!lv.includes('code:ONE'), 'only running agents get a row');
  assert.ok(liveView.render(d, { view: 'live', opts: { 'live.layout': 'cards' } }).includes('workflow demo-run'));
  const hud = hudView.render(d, { view: 'hud', opts: {} });
  assert.ok(hud.includes('<b>2</b>/4 running'), 'worker + 3 workflow agents, 2 running');
  assert.ok(hud.includes('workflow demo-run'));
  const wf = renderWorkflows(d, { view: 'workflows', opts: {} }, d.sessions.length ? (await setup()).snap : undefined);
  assert.ok(wf.includes('medium (inherited)') && wf.includes('Sonnet 5.5 · high'));
  clearFeeds();
  assert.ok(!renderWorkspace(d, { view: 'overview' }).includes('wk-badge'), 'no feed value → no badge');
});
