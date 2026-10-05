import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, EventType, TimelineEvent } from '../src/model';
import { autoGran, bucketStart, histogram, toJsonl, transitions } from '../src/activity/audit';
import { auditView } from '../src/render/extra/audit';
import { WsData, WsState } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const M = 60_000;

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'codex:a', provider: 'codex', sessionId: 'a', title: 'fix <b>login</b>', repository: 'D:/PROJ/app', status: 'ENDED', statusReason: 'provider marked the session ended', startedAt: NOW - 60 * M, lastActivityAt: NOW - 10 * M, endedAt: NOW - 10 * M, commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [{ field: 'status', kind: 'OBSERVED', source: 'rollout moved to archived_sessions/' }], artifactPath: 'x', diagnostics: [], ...p };
}

function ev(at: number, type: EventType, label: string, key = 'codex:a', kind: TimelineEvent['kind'] = 'OBSERVED'): TimelineEvent {
  return { at, type, label, provider: 'codex', sessionKey: key, kind };
}

const tests = [
  { command: 'npm test', at: NOW - 50 * M, outcome: 'FAIL' as const, exitCode: 1, source: 'provider-exit-code' as const },
  { command: 'npm test', at: NOW - 40 * M, outcome: 'FAIL' as const, exitCode: 1, source: 'provider-exit-code' as const },
  { command: 'npm test', at: NOW - 30 * M, outcome: 'PASS' as const, exitCode: 0, source: 'provider-exit-code' as const },
];

test('transitions: lifecycle, commits, tests with outcome changes, events', () => {
  const s = snap({ tests, commits: [{ sha: 'b'.repeat(40), at: NOW - 20 * M, subject: 'fix login', attribution: 'during-session' }] });
  const events = [
    ev(NOW - 59 * M, 'SESSION_STARTED', 'session started'),
    ev(NOW - 58 * M, 'SESSION_STARTED', 'first recorded activity', 'other:x'),
    ev(NOW - 55 * M, 'PROCESS_ACTIVITY', '$ rg foo  → exit 1'),
    ev(NOW - 54 * M, 'PROCESS_ACTIVITY', '$ cargo build  → exit 101'),
    ev(NOW - 53 * M, 'WORKER_STARTED', 'spawn_agent'),
    ev(NOW - 45 * M, 'SESSION_ACTIVITY', 'context compacted'),
    ev(NOW - 44 * M, 'SESSION_ACTIVITY', 'user turn'),
    ev(NOW - 21 * M, 'GIT_CHANGE', 'git commit command run'),
    ev(NOW - 20 * M, 'TEST', 'PASS npm test'), // ignored: tests come from the snapshot
  ];
  const r = transitions([s], events, { now: NOW });
  const kinds = r.map(x => x.kind);
  assert.deepEqual(kinds, ['ended', 'commit', 'commit-run', 'test-pass', 'test-fail', 'compacted', 'test-fail', 'spawn', 'cmd-fail', 'started']);
  assert.equal(r[0].evidence, 'OBSERVED');
  const started = r.find(x => x.kind === 'started')!;
  assert.equal(started.at, NOW - 59 * M);
  assert.equal(started.evidence, 'OBSERVED');
  const t = r.filter(x => x.cat === 'tests').reverse();
  assert.deepEqual(t.map(x => x.change), ['first', undefined, 'fixed']);
  assert.equal(r.find(x => x.kind === 'commit')!.evidence, 'DERIVED');
  assert.match(r.find(x => x.kind === 'cmd-fail')!.source, /exit code 101/);
  // exit 1 shown when not quiet
  assert.equal(transitions([s], events, { quietExits: [] }).filter(x => x.kind === 'cmd-fail').length, 2);
});

test('transitions: status now, inferred end, workers, redaction', () => {
  const live = snap({ key: 'claude:l', provider: 'claude', status: 'NEEDS_INPUT', statusReason: 'live registry: waiting', endedAt: undefined, lastActivityAt: NOW - 2 * M, title: 'deploy OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv' });
  const gone = snap({ key: 'codex:g', status: 'ENDED', endedAt: undefined, lastActivityAt: NOW - 5 * M, evidence: [] });
  const w = snap({ key: 'claude:w', provider: 'claude', isWorker: true, workerLabel: 'Explore', status: 'RUNNING', statusReason: 'x', endedAt: undefined, startedAt: NOW - 3 * M });
  const r = transitions([live, gone, w], [], { now: NOW });
  const need = r.find(x => x.kind === 'needs-input')!;
  assert.equal(need.at, NOW - 2 * M);
  assert.doesNotMatch(need.title, /sk-abc/);
  const end = r.find(x => x.key === 'codex:g' && x.kind === 'ended')!;
  assert.equal(end.evidence, 'INFERRED');
  assert.ok(r.some(x => x.kind === 'worker-started' && x.key === 'claude:w' && x.evidence === 'DERIVED'));
  assert.ok(!r.some(x => x.key === 'claude:w' && x.kind === 'worker-ended'));
});

test('jsonl export: one object per line, oldest first', () => {
  const r = transitions([snap({ tests })], []);
  const lines = toJsonl(r).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, r.length);
  assert.ok(lines[0].ts <= lines[lines.length - 1].ts);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 4), ['at', 'ts', 'session', 'provider']);
  assert.equal(toJsonl([]), '');
});

test('histogram buckets and auto granularity', () => {
  const r = transitions([snap({ tests })], []);
  const h = histogram(r, NOW - 2 * 3_600_000, NOW, 'hour');
  assert.equal(h.reduce((n, b) => n + b.total, 0), r.length);
  assert.ok(h.every((b, i) => i === 0 || b.at > h[i - 1].at));
  assert.equal(bucketStart(NOW + 59_999, 'minute'), bucketStart(NOW, 'minute'));
  assert.equal(new Date(bucketStart(NOW, 'week')).getDay(), 1);
  assert.equal(autoGran(3_600_000), 'minute');
  assert.equal(autoGran(86_400_000), 'hour');
  assert.equal(autoGran(7 * 86_400_000), 'day');
  // capped
  assert.ok(histogram(r, 0, NOW, 'minute', 50).length <= 50);
});

test('audit screen renders every view escaped, export uses the shown filter', async () => {
  const s = snap({ tests, lastActivityAt: NOW - 30 * 1000, endedAt: NOW - 30 * 1000, title: '<script>x</script>' });
  const events = [ev(NOW - 54 * M, 'PROCESS_ACTIVITY', '$ make "<img>"  → exit 2')];
  const d: WsData = { sessions: [s], providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
  for (const view of ['log', 'session', 'lanes', 'counts']) {
    for (const orient of ['h', 'v']) {
      const st: WsState = { view: 'audit', selected: s.key, opts: { 'audit.view': view, 'audit.orient': orient, 'audit.period': '24h' } };
      const html = auditView.render(d, st);
      assert.ok(html.length > 500, view);
      assert.doesNotMatch(html, /<script>|<img>/, view);
      assert.match(html, /data-select="codex:a"/, view);
    }
  }
  const log = auditView.render(d, { view: 'audit', opts: {} });
  assert.match(log, /au-new/); // ended 30 s ago flashes
  assert.match(log, /Test fail/);
  assert.match(log, /fixed/);
  // category filter
  const git = auditView.render(d, { view: 'audit', opts: { 'audit.cat': 'git' } });
  assert.match(git, /No transition in this period for git/);
  // export
  const m = /data-act="jsonl" data-arg="([^"]*)"/.exec(log)!;
  let saved = '';
  const ctx = { saveText: async (_n: string, c: string) => ((saved = c), 'x.jsonl'), info: () => undefined, sessions: () => [s] } as unknown as Parameters<NonNullable<typeof auditView.actions>['jsonl']>[1];
  await auditView.actions!.jsonl(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'), ctx);
  const lines = saved.trim().split('\n');
  assert.ok(lines.length >= 5);
  assert.ok(lines.some(l => JSON.parse(l).kind === 'cmd-fail'));
});
