import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, EventType, TimelineEvent } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import { renderWorkspace } from '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { clock, findStep, gapText, indexAt, pause, plan, play, position, resetTransports, seek, setTransport, stepGap, transportOf, withSpeed } from '../src/activity/replay';
import { replayCursor, replayView } from '../src/render/extra/replay';
import type { ActCtx } from '../src/render/extra/kit';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:lead', provider: 'claude', sessionId: 'lead', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const S = 1000;
const ev = (key: string, at: number, type: EventType, label: string): TimelineEvent => ({ at, type, label, provider: 'claude', sessionKey: key, kind: 'OBSERVED' });

const lead = snap({ key: 'claude:lead', title: 'Fix <the> parser', startedAt: T0, lastActivityAt: T0 + 600 * S, repository: 'D:/r/agent-vscode', branch: 'night/x' });
const w1 = snap({ key: 'claude:w1', sessionId: 'w1', isWorker: true, parentSessionId: 'claude:lead', workerLabel: 'Explore · find tests', startedAt: T0 + 62 * S, lastActivityAt: T0 + 200 * S });
const events: TimelineEvent[] = [
  ev('claude:lead', T0, 'SESSION_STARTED', 'first recorded activity'),
  ev('claude:lead', T0 + 10 * S, 'SESSION_ACTIVITY', 'assistant reply'),
  ev('claude:lead', T0 + 30 * S, 'TOOL_ACTIVITY', 'Read'),
  ev('claude:lead', T0 + 60 * S, 'WORKER_STARTED', 'Task Explore'),
  ev('claude:w1', T0 + 90 * S, 'TOOL_ACTIVITY', 'Grep'),
  ev('claude:lead', T0 + 120 * S, 'FILE_CHANGE', 'edited parser.ts'),
  ev('claude:lead', T0 + 300 * S, 'TEST', 'FAIL npm test'),
  ev('claude:lead', T0 + 400 * S, 'TEST', 'PASS npm test'),
  ev('claude:lead', T0 + 400 * S, 'GIT_CHANGE', 'git commit command run'),
  ev('codex:other', T0 + 50 * S, 'TOOL_ACTIVITY', 'not mine'),
];
const sessions = [lead, w1, snap({ key: 'codex:other', provider: 'codex', sessionId: 'other' })];
const data = (now: number): WsData => ({ sessions, providers: [], events, now, ternAvailable: false, timeline: () => events });

test('plan keeps the session and its workers, filters, windows and maps actors, categories and spawns', () => {
  const pl = plan(lead, events, sessions, { timing: 'even', show: 'work', workers: true, limit: 300 });
  assert.equal(pl.available, 9, 'other session excluded');
  assert.equal(pl.steps.length, 8, 'SESSION_ACTIVITY dropped in work view');
  assert.deepEqual(pl.actors.map(a => a.label), ['this session', 'Explore']);
  const grep = pl.steps.find(s => s.label === 'Grep')!;
  assert.equal(grep.actor, 1);
  assert.equal(grep.cat, 'tools');
  assert.equal(pl.steps.find(s => s.type === 'WORKER_STARTED')!.spawn, 1, 'nearest worker start after the call (INFERRED)');
  assert.deepEqual(pl.steps.filter(s => s.type === 'TEST').map(s => s.outcome), ['FAIL', 'PASS']);
  assert.equal(pl.steps[7].ord, 1, 'same timestamp ordinal');
  assert.equal(pl.steps[1].p, 0.6);
  assert.ok(Math.abs(pl.total - (7 * 0.6 + 1.5)) < 1e-9);
  const lead1 = plan(lead, events, sessions, { timing: 'gaps', show: 'milestones', workers: false, limit: 300 });
  assert.ok(lead1.steps.every(s => s.actor === 0 && s.type !== 'TOOL_ACTIVITY'));
  assert.equal(plan(lead, events, sessions, { timing: 'even', show: 'all', workers: true, limit: 3 }).steps.length, 3, 'latest n events');
});

test('timing rules are monotonic and capped; helpers format and search', () => {
  assert.equal(stepGap(10 * 60_000, 'real'), 5, 'real time caps idle gaps');
  assert.equal(stepGap(60_000, 'real'), 1);
  assert.ok(stepGap(1000, 'gaps') < stepGap(60_000, 'gaps') && stepGap(1e9, 'gaps') === 3);
  const pl = plan(lead, events, sessions, { timing: 'real', show: 'all', workers: true, limit: 300 });
  assert.equal(pl.skipped, 0);
  assert.equal(indexAt(pl.steps, -1), -1);
  assert.equal(indexAt(pl.steps, pl.total), pl.steps.length - 1);
  assert.equal(findStep(pl.steps, T0 + 400 * S, 1), pl.steps.length - 1);
  assert.equal(findStep(pl.steps, T0 + 31 * S, 0), 3, 'missing anchor: next step');
  assert.equal(clock(3_725_000), '1:02:05');
  assert.equal(clock(65_000), '1:05');
  assert.equal(gapText(400), '');
  assert.equal(gapText(90_000), '2m');
});

test('transport: play advances with wall time and speed, pause freezes, seek and speed re-anchor', () => {
  const pl = plan(lead, events, sessions, { timing: 'even', show: 'work', workers: true, limit: 300 });
  assert.deepEqual(position(undefined, pl, 0), { pos: pl.total, paused: true, speed: 4, ended: true });
  let t = play(undefined, pl.steps[0].at, 1000, 2);
  assert.equal(position(t, pl, 1000).pos, 0);
  assert.equal(position(t, pl, 1600).pos, 1.2, '0.6 s wall at 2× = 1.2 s of playback');
  assert.equal(indexAt(pl.steps, position(t, pl, 1600).pos), 2);
  t = pause(t, 1600)!;
  assert.equal(position(t, pl, 99_000).pos, 1.2, 'paused');
  t = withSpeed(t, 16, 2000, 0);
  t = play(t, 0, 3000);
  assert.ok(Math.abs(position(t, pl, 3100).pos - 2.8) < 1e-9);
  assert.equal(position(t, pl, 1e7).ended, true);
  t = seek(t, pl.steps[5].at, 0, 4000);
  assert.equal(position(t, pl, 9000).pos, pl.steps[5].p, 'seek pauses on the step');
  assert.equal(seek({ ...t, paused: false }, pl.steps[2].at, 0, 0, true).paused, false, 'seek keeps playing when asked');
});

test('screen renders escaped, lights in step mode and continues playback across renders', () => {
  resetTransports();
  const st = { view: 'replay', selected: 'claude:lead' };
  const html = renderWorkspace(data(T0 + 3600_000), st);
  assert.ok(replayView.ready);
  assert.match(html, /class="rp paused"/);
  assert.match(html, /Fix &lt;the&gt; parser/);
  assert.doesNotMatch(html, /Fix <the>/);
  assert.match(html, /data-act="rp-play"/);
  assert.match(html, /rp-follow/);
  assert.match(html, /Explore/);
  assert.match(html, /data-select="claude:lead"/);
  assert.doesNotMatch(html, /not mine/);
  // Paused at step 3: counts "so far / total" and the static current row.
  const pl = plan(lead, events, sessions, { timing: 'gaps', show: 'work', workers: true, limit: 300 });
  setTransport('claude:lead', seek(undefined, pl.steps[3].at, 0, 0));
  const h2 = renderWorkspace(data(T0), st);
  assert.match(h2, /1 \/ 1 · 0 pass · 0 fail|0 \/ 2 · 0 pass · 0 fail/);
  assert.match(h2, /class="rp-r past cur"/);
  assert.deepEqual(replayCursor(data(T0), st), { key: 'claude:lead', index: 3, paused: true });
  // Playing: a later render shows the same animation shifted by elapsed time (negative delays), not a restart.
  setTransport('claude:lead', play(undefined, pl.steps[0].at, 10_000, 1));
  const a = renderWorkspace(data(10_000), st);
  const b = renderWorkspace(data(12_000), st);
  assert.match(a, /class="rp" style="--T:[\d.]+s;--d0:0s"/);
  assert.match(b, /--d0:-2s/);
  assert.equal(replayCursor(data(12_000), st)?.paused, false);
  // Lanes + vertical diagram + all toggles render.
  for (const opts of [{ 'replay.chart': 'lanes' } as Record<string, string>,{ 'replay.orient': 'vertical', 'replay.layout': 'stacked', 'replay.follow': 'off', 'replay.timing': 'real' }]) {
    const h = renderWorkspace(data(13_000), { ...st, opts });
    assert.match(h, opts['replay.chart'] === 'lanes' ? /rp-lanes/ : /viewBox="0 0 760 290"/);
  }
  resetTransports();
});

test('empty states and actions validate their arguments', async () => {
  resetTransports();
  const none = renderWorkspace({ sessions: [], providers: [], events: [], now: 0, ternAvailable: false }, { view: 'replay' });
  assert.match(none, /No session in the loaded history/);
  const ctx = { sessions: () => sessions } as unknown as ActCtx;
  const acts = replayView.actions!;
  await acts['rp-play']('claude:nope|1|1', ctx);
  await acts['rp-play']('claude:lead|x|1', ctx);
  await acts['rp-speed']('claude:lead|3', ctx);
  assert.equal(transportOf('claude:lead'), undefined, 'unknown key, bad number and unlisted speed are ignored');
  await acts['rp-play'](`claude:lead|${T0}|1`, ctx);
  assert.equal(transportOf('claude:lead')?.paused, false);
  await acts['rp-pause']('claude:lead', ctx);
  assert.equal(transportOf('claude:lead')?.paused, true);
  await acts['rp-speed']('claude:lead|16', ctx);
  assert.equal(transportOf('claude:lead')?.speed, 16);
  await acts['rp-step'](`claude:lead|${T0 + 120 * S}|0`, ctx);
  assert.equal(transportOf('claude:lead')?.at, T0 + 120 * S);
  resetTransports();
});
