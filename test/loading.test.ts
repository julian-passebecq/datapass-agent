import { test } from 'node:test';
import * as assert from 'node:assert/strict';
// Load the workspace before screen modules (screens import workspace helpers; workspace imports the registry).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { clearFeeds, Feed, FeedCtx, feedTimedOut, feedValue, FEED_TIMEOUT_MS, pump } from '../src/render/extra/feeds';
import { backlogView } from '../src/render/extra/backlog';
import { scopeView } from '../src/render/extra/scope';
import { pipelinesView } from '../src/render/extra/pipelines';
import { reposView } from '../src/render/extra/repos';
import { historyView } from '../src/render/extra/history';
import { codexView } from '../src/render/extra/codex';
import { reviewView } from '../src/render/extra/review';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const data = (): WsData => ({ sessions: [], providers: [], events: [], now: NOW, ternAvailable: false, config: <T>(_k: string, f: T) => f });
const ctx = (now = NOW): FeedCtx => ({ sessions: [], trusted: true, config: <T>(_k: string, f: T) => f, now });
const SCREENS = [backlogView, scopeView, pipelinesView, reposView, historyView, codexView, reviewView];

/** A feed whose load never settles until the test resolves it by hand. */
function slowFeed(id: string, timeoutMs?: number) {
  const calls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const feed: Feed = { id, intervalMs: 1000, timeoutMs, load: () => new Promise((resolve, reject) => calls.push({ resolve, reject })) };
  return { feed, calls };
}
const tick = () => new Promise(r => setImmediate(r));

test('loading: a feed records its start time while running', () => {
  clearFeeds();
  const { feed } = slowFeed('t.slow');
  pump([feed], ctx(), () => {});
  const st = feedValue('t.slow');
  assert.equal(st.running, true);
  assert.equal(st.startedAt, NOW);
  assert.equal(feedTimedOut(feed, st, NOW + FEED_TIMEOUT_MS), false);
  assert.equal(feedTimedOut(feed, st, NOW + FEED_TIMEOUT_MS + 1), true);
  clearFeeds();
});

test('loading: a plain pump never restarts a running feed; a forced one only after its timeout', async () => {
  clearFeeds();
  const { feed, calls } = slowFeed('t.stuck', 5000);
  let updates = 0;
  pump([feed], ctx(), () => updates++);
  pump([feed], ctx(NOW + 10_000), () => updates++); // not forced: wait
  assert.equal(calls.length, 1);
  pump([feed], ctx(NOW + 4000), () => updates++, true); // forced, within timeout: wait
  assert.equal(calls.length, 1);
  pump([feed], ctx(NOW + 6000), () => updates++, true); // forced, past timeout: restart
  assert.equal(calls.length, 2);
  assert.equal(feedValue('t.stuck').startedAt, NOW + 6000);
  // The abandoned first load lands late: dropped, no update.
  calls[0].resolve('stale');
  await tick();
  assert.equal(feedValue('t.stuck').value, undefined);
  assert.equal(feedValue('t.stuck').running, true);
  assert.equal(updates, 0);
  calls[1].resolve('fresh');
  await tick();
  const st = feedValue('t.stuck');
  assert.equal(st.value, 'fresh');
  assert.ok(!st.running && st.startedAt === undefined);
  assert.equal(updates, 1);
  clearFeeds();
});

test('loading: a failing feed records the error and keeps the last value; a throwing load is caught', async () => {
  clearFeeds();
  const ok: Feed = { id: 't.fail', intervalMs: 0, load: async () => 'v1' };
  pump([ok], ctx(), () => {});
  await tick();
  const bad: Feed = { id: 't.fail', intervalMs: 0, load: async () => { throw new Error('EACCES'); } };
  pump([bad], ctx(), () => {}, true);
  await tick();
  assert.equal(feedValue('t.fail').value, 'v1');
  assert.equal(feedValue('t.fail').error, 'EACCES');
  assert.ok(!feedValue('t.fail').running);
  const sync: Feed = { id: 't.sync', intervalMs: 0, load: () => { throw new Error('sync boom'); } };
  pump([sync], ctx(), () => {});
  await tick();
  assert.equal(feedValue('t.sync').error, 'sync boom');
  clearFeeds();
});

test('loading: the 7 screens show kit.loading() while their feeds load, with a Retry action', () => {
  clearFeeds();
  for (const v of SCREENS) {
    // Slow fakes under the screen's own feed ids: running, no value yet.
    pump((v.feeds ?? []).map(f => slowFeed(f.id).feed), ctx(), () => {});
    const h = v.render(data(), { view: v.id, opts: {} });
    assert.ok(h.includes('data-loading="'), `${v.id}: loading marker`);
    assert.ok(h.includes('data-act="refresh"'), `${v.id}: Retry wired to the screen's refresh action`);
    assert.equal(typeof v.actions?.refresh, 'function', `${v.id}: refresh action`);
    assert.ok(!h.includes('ld-err'), `${v.id}: not an error while loading`);
    clearFeeds();
  }
});

test('loading: the 7 screens show kit.loadError() with Retry when their feeds fail', async () => {
  clearFeeds();
  for (const v of SCREENS) {
    const fails: Feed[] = (v.feeds ?? []).map(f => ({ id: f.id, intervalMs: f.intervalMs, load: async () => { throw new Error('fake <failure>'); } }));
    pump(fails, ctx(), () => {});
    await tick();
    const h = v.render(data(), { view: v.id, opts: {} });
    assert.ok(h.includes('ld-err'), `${v.id}: error state`);
    assert.ok(h.includes('fake &lt;failure&gt;'), `${v.id}: escaped message`);
    assert.ok(!h.includes('data-loading="'), `${v.id}: an error is not shown as still loading`);
    assert.ok(/ld-err[\s\S]*data-act="refresh"[^>]*>Retry/.test(h), `${v.id}: Retry button`);
    clearFeeds();
  }
});
