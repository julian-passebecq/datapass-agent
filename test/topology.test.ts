import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { buildTree, leads, matchSpawns, orphans, orphanTree, pathTo, shortId } from '../src/activity/topology';
import { topologyView } from '../src/render/extra/topology';
import { T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 600_000, ...p };
}

const lead = mk({
  key: 'claude:lead', title: 'Lead <b>', status: 'RUNNING', usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0, costUSD: 1.5 },
  facts: { spawns: [{ at: NOW - 3000_000, type: 'Explore', description: 'map the repo' }, { at: NOW - 2000_000, type: 'Explore', description: 'find tests' }] },
});
const w1 = mk({ key: 'claude:w1', parentSessionId: 'claude:lead', isWorker: true, workerLabel: 'Explore', startedAt: NOW - 2990_000, usage: { totalTokens: 200, outputTokens: 20, cachedInputTokens: 0 }, changedFiles: ['a.ts'] });
const w2 = mk({ key: 'claude:w2', parentSessionId: 'claude:lead', isWorker: true, workerLabel: 'Explore', startedAt: NOW - 1990_000, status: 'RUNNING', usage: { totalTokens: 300, outputTokens: 30, cachedInputTokens: 0 } });
const n1 = mk({ key: 'claude:n1', parentSessionId: 'claude:w2', isWorker: true, workerLabel: 'general', usage: { totalTokens: 50, outputTokens: 5, cachedInputTokens: 0, costUSD: 0.25 }, commits: [{ sha: 'abc', at: NOW - 100_000, subject: 'fix', attribution: 'during-session' }] });
const solo = mk({ key: 'codex:solo' });
const orphan = mk({ key: 'codex:o1', parentSessionId: 'codex:gone', isWorker: true, workerLabel: 'Ada' });
const all = [lead, w1, w2, n1, solo, orphan];

test('topology: tree rollups sum the subtree and count depth', () => {
  const t = buildTree(all, lead, { now: NOW });
  assert.equal(t.children.length, 2);
  assert.equal(t.roll.sessions, 4);
  assert.equal(t.roll.tokens, 1550);
  assert.equal(t.roll.costSessions, 2);
  assert.equal(t.roll.costUSD, 1.75);
  assert.equal(t.roll.depth, 2);
  assert.equal(t.roll.live, 2);
  assert.equal(t.roll.files, 1);
  assert.equal(t.roll.commits, 1);
  assert.deepEqual(pathTo(t, 'claude:n1'), ['claude:lead', 'claude:w2', 'claude:n1']);
});

test('topology: spawn descriptions pair by type and time, each used once', () => {
  const m = matchSpawns(lead, [w2, w1]);
  assert.equal(m.get('claude:w1'), 'map the repo');
  assert.equal(m.get('claude:w2'), 'find tests');
  assert.equal(matchSpawns(w2, [n1]).size, 0, 'no spawns recorded → nothing inferred');
});

test('topology: leads, orphans, grouping and cycles', () => {
  assert.deepEqual(leads(all).map(s => s.key), ['claude:lead']);
  assert.deepEqual([...orphans(all).keys()], ['codex:gone']);
  const o = orphanTree(all, 'codex:gone', [orphan], { now: NOW });
  assert.equal(o.roll.sessions, 1);
  const g = buildTree(all, lead, { now: NOW, groupAbove: 1 });
  assert.equal(g.children.length, 1, 'two Explore siblings grouped');
  assert.equal(g.children[0].label, 'Explore ×2');
  assert.equal(g.roll.sessions, 4, 'group node not counted as a session');
  assert.equal(g.roll.depth, 2);
  const a = mk({ key: 'claude:a', parentSessionId: 'claude:b' });
  const b = mk({ key: 'claude:b', parentSessionId: 'claude:a' });
  assert.equal(buildTree([a, b], a, { now: NOW }).roll.sessions, 2, 'cycle terminates');
  assert.match(shortId('claude:lead'), /^[a-z0-9]+$/);
});

const data: WsData = { sessions: all, providers: [], events: [], now: NOW, ternAvailable: false };

test('topology screen: every layout renders escaped, selectable rows', () => {
  for (const layout of ['tree', 'list', 'org']) {
    for (const orient of ['vertical', 'horizontal']) {
      const html = topologyView.render(data, { view: 'topology', opts: { 'topology.layout': layout, 'topology.orient': orient } });
      assert.ok(!html.includes('Lead <b>'), 'title escaped');
      assert.ok(html.includes('Lead &lt;b&gt;'));
      assert.ok(html.includes('data-select="claude:n1"'), `${layout}/${orient} shows nested worker`);
      assert.ok(html.includes('“map the repo”'));
    }
  }
});

test('topology screen: depth 1 collapses workers; a node toggle tagged with the depth re-opens it', () => {
  const st = { view: 'topology', opts: { 'topology.depth': '1' } as Record<string, string> };
  let html = topologyView.render(data, st);
  assert.ok(html.includes('data-select="claude:w2"'));
  assert.ok(!html.includes('data-select="claude:n1"'), 'nested hidden at depth 1');
  st.opts[`topology.c.${shortId('claude:w2')}`] = 'd1';
  html = topologyView.render(data, st);
  assert.ok(html.includes('data-select="claude:n1"'), 'toggle opens the node');
  st.opts['topology.depth'] = '2';
  st.opts['topology.c.' + shortId('claude:w2')] = 'd1';
  html = topologyView.render(data, st);
  assert.ok(html.includes('data-select="claude:n1"'), 'stale toggle ignored after depth change; depth 2 shows level 2');
  html = topologyView.render(data, { view: 'topology', selected: 'claude:n1', opts: { 'topology.depth': '1' } });
  assert.ok(html.includes('data-select="claude:n1"'), 'path to the selection is forced open');
});

test('topology screen: all leads includes orphan groups; empty state without workers', () => {
  const html = topologyView.render(data, { view: 'topology', opts: { 'topology.roots': 'all' } });
  assert.ok(html.includes('parent not loaded'));
  const empty = topologyView.render({ ...data, sessions: [solo] }, { view: 'topology' });
  assert.ok(empty.includes('No session with recorded workers'));
});

test('topology screen: registered in the workspace rail and rendered through it', () => {
  const html = renderWorkspace(data, { view: 'topology' });
  assert.ok(html.includes('data-nav="topology"'));
  assert.ok(html.includes('tp-tree'));
});
