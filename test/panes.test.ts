import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { allViews, renderView, renderWorkspace, WsData } from '../src/render/workspace';
import { layoutOf, paneCount, paneViews, visibleViews } from '../src/activity/panes';
import { renderPanes } from '../src/render/extra/panes';
import { page, validateMessage } from '../src/render/html';

const NOW = Date.parse('2026-10-05T12:00:00Z');

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'RUNNING', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], startedAt: NOW - 600_000, lastActivityAt: NOW - 1000, cwd: 'D:\\PROJ\\demo', ...p };
}

const data = (): WsData => ({ sessions: [snap({}), snap({ key: 'codex:b', provider: 'codex', sessionId: 'b', title: '<b>evil</b>' })], providers: [], events: [], now: NOW, ternAvailable: false, config: <T>(_k: string, f: T) => f });

test('panes: layout and cell choice are validated, never recursive', () => {
  const av = ['overview', 'live', 'workflows', 'limits', 'backlog', 'panes'];
  assert.equal(layoutOf(undefined), '2x2');
  assert.equal(layoutOf({ 'panes.layout': 'bogus' }), '2x2');
  assert.deepEqual([paneCount('2col'), paneCount('2row'), paneCount('2x2'), paneCount('1p2')], [2, 2, 4, 3]);
  assert.deepEqual(paneViews({}, av), ['live', 'workflows', 'limits', 'backlog']);
  assert.deepEqual(paneViews({ 'panes.layout': '2col', 'panes.p0': 'panes', 'panes.p1': 'overview' }, av), ['live', 'overview']);
  assert.deepEqual(paneViews({ 'panes.layout': '1p2', 'panes.p2': 'gone' }, av), ['live', 'workflows', 'limits']);
  assert.deepEqual(paneViews({}, ['overview', 'panes']), ['overview', 'overview', 'overview', 'overview'], 'falls back without recursion');
  assert.deepEqual(visibleViews('limits', {}, av), ['limits']);
  assert.deepEqual(visibleViews('panes', { 'panes.p1': 'live' }, av), ['live', 'limits', 'backlog']);
});

test('panes: 2x2 renders four headers with their screens and no nested panes', () => {
  const d = data();
  const st = { view: 'panes', opts: { 'panes.layout': '2x2', 'panes.p0': 'overview', 'panes.p1': 'board', 'panes.p2': 'limits', 'panes.p3': 'live' } };
  const html = renderWorkspace(d, st);
  assert.ok(allViews().includes('panes'));
  assert.equal((html.match(/<header class="pn-h">/g) ?? []).length, 4);
  assert.equal((html.match(/class="pn /g) ?? []).length, 1, 'one grid, no nested panes');
  for (const [i, v] of ['overview', 'board', 'limits', 'live'].entries()) {
    assert.ok(html.includes(`data-opt="panes.p${i}"`), `picker ${i}`);
    assert.ok(new RegExp(`<option value="${v}" selected>`).test(html), `selected ${v}`);
    assert.ok(html.includes(`data-nav="${v}" title="Open this screen full size"`), `open full ${v}`);
  }
  assert.ok(!/<option value="panes"/.test(html), 'panes is not offered in a pane');
  assert.ok(html.includes(renderView(d, st, 'limits')), 'cell holds the screen renderer output');
  assert.ok(!html.includes('<b>evil</b>'), 'escaped');
  const two = renderPanes(d, { view: 'panes', opts: { 'panes.layout': '2col' } });
  assert.equal((two.match(/<header class="pn-h">/g) ?? []).length, 2);
});

test('panes: select posts through the existing opt validation', () => {
  const html = page('x', '');
  assert.ok(html.includes("addEventListener('change'"));
  assert.ok(validateMessage({ type: 'opt', name: 'panes.p0', value: 'workflows', key: '' }, () => false));
  assert.ok(validateMessage({ type: 'opt', name: 'panes.layout', value: '1+2', key: '' }, () => false) === undefined, '+ is not an accepted opt value');
});
