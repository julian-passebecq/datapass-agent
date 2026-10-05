import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, EventType, TimelineEvent } from '../src/model';
import { allSignals, exitOf, normalizeCommand, signals } from '../src/activity/signals';
import { signalsView } from '../src/render/extra/signals';
import { WsData } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const M = 60_000;

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  // repository set: git correlation could see commits.
  return { key: 'codex:a', provider: 'codex', sessionId: 'a', repository: 'D:/PROJ/app', status: 'ENDED', statusReason: 'provider marked the session ended', startedAt: NOW - 60 * M, lastActivityAt: NOW - 10 * M, endedAt: NOW - 10 * M, commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

function ev(at: number, type: EventType, label: string, key = 'codex:a'): TimelineEvent {
  return { at, type, label, provider: 'codex', sessionKey: key, kind: 'OBSERVED' };
}

const commit = { sha: 'a'.repeat(40), at: NOW - 15 * M, subject: 'feat', attribution: 'during-session' as const };

test('helpers: command normalisation and exit parsing', () => {
  assert.equal(normalizeCommand('$ npm   Test  → exit 1'), 'npm test');
  assert.equal(normalizeCommand('npm test · in command chain'), 'npm test');
  assert.equal(exitOf('$ foo  → exit 127'), 127);
  assert.equal(exitOf('$ foo'), undefined);
});

test('clean session raises no signal', () => {
  const s = snap({ changedFiles: ['a.ts'], commits: [commit], tests: [{ command: 'npm test', at: NOW - 30 * M, outcome: 'FAIL', exitCode: 1, source: 'provider-exit-code' }, { command: 'npm test', at: NOW - 20 * M, outcome: 'PASS', exitCode: 0, source: 'provider-exit-code' }] });
  const events = [
    ev(NOW - 59 * M, 'SESSION_STARTED', 'session started'),
    ev(NOW - 50 * M, 'PROCESS_ACTIVITY', '$ git status'),
    ev(NOW - 45 * M, 'PROCESS_ACTIVITY', '$ rg foo  → exit 1'),
    ev(NOW - 40 * M, 'FILE_CHANGE', 'edited a.ts'),
    ev(NOW - 35 * M, 'PROCESS_ACTIVITY', '$ git status'),
    ev(NOW - 25 * M, 'FILE_CHANGE', 'edited a.ts'),
    ev(NOW - 18 * M, 'PROCESS_ACTIVITY', '$ git status'),
  ];
  assert.deepEqual(signals(s, events, { now: NOW }), []);
  // A live session with the same history: nothing either.
  assert.deepEqual(signals(snap({ ...s, status: 'RUNNING' }), events, { now: NOW }), []);
});

test('unsolved: last test failing, or edits without commit; never for live sessions or workers', () => {
  const failing = snap({ tests: [{ command: 'npm test', at: NOW - 20 * M, outcome: 'FAIL', exitCode: 1, source: 'provider-exit-code' }] });
  const a = signals(failing, [], { now: NOW });
  assert.equal(a.length, 1, JSON.stringify(a));
  assert.equal(a[0].kind, 'unsolved');
  assert.match(a[0].basis, /exit code 1/);
  assert.deepEqual(a[0].times, [NOW - 20 * M, NOW - 10 * M]);
  const edits = signals(snap({ changedFiles: ['a.ts', 'b.ts'] }), [], { now: NOW });
  assert.equal(edits[0].kind, 'unsolved');
  assert.equal(edits[0].evidence, 'DERIVED');
  assert.match(edits[0].reason, /2 file\(s\) edited, no commit/);
  assert.deepEqual(signals(snap({ changedFiles: ['a.ts'], status: 'RUNNING' }), [], { now: NOW }), []);
  // Scratch / temp / agent-home edits, no git repository, or a recorded commit command: no claim.
  assert.deepEqual(signals(snap({ changedFiles: ['C:\\Users\\j\\AppData\\Local\\Temp\\x\\scratchpad\\a.py', 'C:/Users/j/.claude/effort-board/b.md'] }), [], { now: NOW }), []);
  assert.equal(signals(snap({ changedFiles: ['C:/Users/j/.claude/worktrees/x/src/a.ts'] }), [], { now: NOW }).length, 1, 'worktrees under .claude are repo work');
  assert.deepEqual(signals(snap({ changedFiles: ['a.ts'], repository: undefined }), [], { now: NOW }), []);
  assert.deepEqual(signals(snap({ changedFiles: ['a.ts'], evidence: [{ field: 'commit-command', kind: 'OBSERVED', source: 'x' }] }), [], { now: NOW }), []);
  assert.deepEqual(signals(snap({ changedFiles: ['a.ts'], isWorker: true }), [], { now: NOW }), []);
  // No end event, inactive for a day: INFERRED.
  const inf = signals(snap({ changedFiles: ['a.ts'], status: 'UNKNOWN', endedAt: undefined, lastActivityAt: NOW - 24 * 3600_000 }), [], { now: NOW });
  assert.equal(inf[0].evidence, 'INFERRED');
  // Inactive only 1 h: not yet.
  assert.deepEqual(signals(snap({ changedFiles: ['a.ts'], status: 'UNKNOWN', endedAt: undefined, lastActivityAt: NOW - 3600_000 }), [], { now: NOW }), []);
});

test('blocked: exit 127 grouped per command, and provider API errors', () => {
  const s = snap({ status: 'RUNNING' });
  const out = signals(s, [ev(NOW - 30 * M, 'PROCESS_ACTIVITY', '$ glab ci list  → exit 127'), ev(NOW - 29 * M, 'PROCESS_ACTIVITY', '$ glab ci list  → exit 127'), ev(NOW - 5 * M, 'SESSION_ACTIVITY', 'provider API error (retrying)')], { now: NOW });
  const blocked = out.filter(x => x.kind === 'blocked');
  assert.equal(blocked.length, 2);
  const nf = blocked.find(x => /not found/.test(x.reason))!;
  assert.match(nf.reason, /×2: glab ci list/);
  assert.deepEqual(nf.times, [NOW - 30 * M, NOW - 29 * M]);
  assert.ok(blocked.some(x => /API error/.test(x.reason)));
});

test('permissions: exit 126, approval abort, waiting on approval', () => {
  const s = snap({ status: 'NEEDS_INPUT', statusReason: 'live registry: waiting_for_permission' });
  const out = signals(s, [ev(NOW - 30 * M, 'PROCESS_ACTIVITY', '$ ./run.sh  → exit 126'), ev(NOW - 20 * M, 'SESSION_ACTIVITY', 'turn aborted (approval_denied)'), ev(NOW - 19 * M, 'SESSION_ACTIVITY', 'turn aborted (interrupted)')], { now: NOW });
  const p = out.filter(x => x.kind === 'permissions');
  assert.equal(p.length, 3, JSON.stringify(p));
  assert.equal(out.length, 3, 'no other signal');
  // NEEDS_INPUT without a permission word is not a permissions signal.
  assert.deepEqual(signals(snap({ status: 'NEEDS_INPUT', statusReason: 'live registry: waiting' }), [], { now: NOW }), []);
});

test('swallowed: failure never re-run before the end; re-run clears it', () => {
  const tests = [
    { command: 'npm run lint', at: NOW - 40 * M, outcome: 'FAIL' as const, exitCode: 1, source: 'provider-exit-code' as const },
    { command: 'npm test', at: NOW - 30 * M, outcome: 'PASS' as const, exitCode: 0, source: 'provider-exit-code' as const },
  ];
  const events = [ev(NOW - 50 * M, 'PROCESS_ACTIVITY', '$ make dist  → exit 2'), ev(NOW - 35 * M, 'PROCESS_ACTIVITY', '$ rg x  → exit 1')];
  const out = signals(snap({ tests, commits: [commit] }), events, { now: NOW });
  const sw = out.filter(x => x.kind === 'swallowed');
  assert.equal(sw.length, 2, JSON.stringify(out));
  assert.ok(sw.some(x => /npm run lint/.test(x.reason)) && sw.some(x => /Exit 2.*make dist/.test(x.reason)));
  // Retried later with extra args: not swallowed.
  const retried = signals(snap({ tests: [...tests, { command: 'npm run lint -- --fix', at: NOW - 20 * M, outcome: 'PASS', exitCode: 0, source: 'provider-exit-code' }], commits: [commit] }), [], { now: NOW });
  assert.equal(retried.filter(x => x.kind === 'swallowed').length, 0);
  // Live: it may still retry.
  assert.equal(signals(snap({ tests, status: 'RUNNING' }), events, { now: NOW }).filter(x => x.kind === 'swallowed').length, 0);
  // The last failing test of an ended session is "unsolved", not also "swallowed".
  const last = signals(snap({ tests: [tests[1], { ...tests[0], at: NOW - 15 * M }] }), [], { now: NOW });
  assert.deepEqual(last.map(x => x.kind), ['unsolved']);
});

test('looping: same command N times without a file change; a file change resets', () => {
  const s = snap({ status: 'RUNNING' });
  const runs = (n: number, from: number) => Array.from({ length: n }, (_, i) => ev(from + i * M, 'PROCESS_ACTIVITY', '$ gh run view 42  → exit 1'));
  const loop = signals(s, runs(5, NOW - 30 * M), { now: NOW });
  assert.equal(loop.length, 1);
  assert.equal(loop[0].kind, 'looping');
  assert.match(loop[0].reason, /×5/);
  assert.equal(loop[0].times.length, 5);
  const broken = signals(s, [...runs(3, NOW - 30 * M), ev(NOW - 26 * M - 30_000, 'FILE_CHANGE', 'edited a.ts'), ...runs(3, NOW - 20 * M)], { now: NOW });
  assert.deepEqual(broken, []);
  assert.equal(signals(s, runs(3, NOW - 30 * M), { now: NOW, loopMin: 3 }).length, 1, 'threshold option');
  // Waits are not loops.
  // Runs 20 min apart are polling, not a loop.
  assert.deepEqual(signals(s, Array.from({ length: 6 }, (_, i) => ev(NOW - 200 * M + i * 20 * M, 'PROCESS_ACTIVITY', '$ gh pr checks 35')), { now: NOW }), []);
  assert.deepEqual(signals(s, Array.from({ length: 6 }, (_, i) => ev(NOW - 30 * M + i * M, 'PROCESS_ACTIVITY', '$ sleep 30')), { now: NOW }), []);
});

test('allSignals routes events to their session', () => {
  const a = snap({ key: 'codex:a', status: 'RUNNING' });
  const b = snap({ key: 'codex:b', sessionId: 'b', status: 'RUNNING' });
  const out = allSignals([a, b], [ev(NOW - M, 'PROCESS_ACTIVITY', '$ nope  → exit 127', 'codex:b')], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'codex:b');
});

test('signals screen renders every view escaped, with data-select rows', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = snap({ title: evil, repository: 'D:\\PROJ\\<b>repo', changedFiles: ['a.ts'], status: 'RUNNING' });
  const events = [ev(NOW - 5 * M, 'PROCESS_ACTIVITY', `$ ${evil}  → exit 127`)];
  const d: WsData = { sessions: [s, snap({ key: 'codex:c', sessionId: 'c', changedFiles: ['x'] })], providers: [], events: [], now: NOW, ternAvailable: false, timeline: () => events };
  for (const [view, group, orient] of [['table', 'none', 'h'], ['table', 'repo', 'h'], ['table', 'day', 'h'], ['matrix', 'provider', 'h'], ['chart', 'session', 'h'], ['chart', 'day', 'v']]) {
    const html = signalsView.render(d, { view: 'signals', opts: { 'signals.view': view, 'signals.group': group, 'signals.orient': orient } });
    assert.ok(!html.includes('<img') && !html.includes('<b>repo'), `${view}/${group} escapes`);
    if (view === 'table' || group === 'session') assert.ok(html.includes('data-select="codex:'), `${view}/${group} rows select`);
    assert.ok(html.includes('sg-'), `${view}/${group} renders`);
  }
  const kindOnly = signalsView.render(d, { view: 'signals', opts: { 'signals.kind': 'looping' } });
  assert.ok(kindOnly.includes('No looping signal'));
  assert.equal(signalsView.badge!(d), '1', 'badge counts live sessions only');
});
