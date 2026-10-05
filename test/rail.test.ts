import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { allViews, RAIL_GROUP_HINT, RAIL_GROUPS, RAIL_ORDER, renderWorkspace, WsData } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const data: WsData = { sessions: [], providers: [], events: [], now: NOW, ternAvailable: false };

/** Screen ids in rail order, read from the rendered rail. */
function railIds(html: string): string[] {
  const rail = html.slice(html.indexOf('<nav class="rail">'), html.indexOf('</nav>'));
  return [...rail.matchAll(/data-nav="([^"]+)"/g)].map(m => m[1]);
}

test('RAIL_ORDER lists every registered screen (no screen falls back to rank 999)', () => {
  const missing = allViews().filter(v => !RAIL_ORDER.includes(v));
  assert.deepEqual(missing, []);
  for (const v of ['hud', 'ctxcost', 'dispatch', 'lifecycle', 'scope']) assert.ok(RAIL_ORDER.includes(v), v);
  assert.equal(new Set(RAIL_ORDER).size, RAIL_ORDER.length, 'no duplicate ids');
});

test('rail keeps every screen: each registered screen appears exactly once', () => {
  const ids = railIds(renderWorkspace(data, { view: 'overview' }));
  assert.equal(ids.length, allViews().length);
  assert.deepEqual([...ids].sort(), [...allViews()].sort());
});

test('unknown ids in RAIL_ORDER (a planned "benchmarks") are ignored, never rendered', () => {
  assert.ok(RAIL_ORDER.includes('benchmarks'));
  const ids = railIds(renderWorkspace(data, { view: 'overview' }));
  if (!allViews().includes('benchmarks')) assert.ok(!ids.includes('benchmarks'));
});

test('new screens sit where the reading order puts them inside their group', () => {
  const ids = railIds(renderWorkspace(data, { view: 'overview' }));
  const before = (a: string, b: string) => assert.ok(ids.indexOf(a) < ids.indexOf(b), `${a} before ${b}`);
  before('live', 'hud');
  before('hud', 'workflows');
  before('replay', 'lifecycle');
  before('tokens', 'ctxcost');
  before('backlog', 'scope');
});

test('every rail group header carries its question as a tooltip', () => {
  for (const g of RAIL_GROUPS) assert.ok(RAIL_GROUP_HINT[g], g);
  const html = renderWorkspace(data, { view: 'overview' });
  for (const g of RAIL_GROUPS) assert.ok(html.includes(`Collapse ${g} · `), g);
  assert.ok(html.includes('first ten screens'), 'keyboard hint says 1-0 covers only the first ten screens');
});
