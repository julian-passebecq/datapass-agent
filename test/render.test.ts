import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
import { page, validateMessage, csp } from '../src/render/html';
import { renderActivity, renderCockpit, renderGraph, renderInspector, renderTimeline, statusText } from '../src/render/views';
import { weekly, summarize } from '../src/activity/activity';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

const NOW = Date.parse('2026-10-04T12:00:00Z');

test('webview page has strict CSP with nonce and no remote/eval sources', () => {
  const html = page('vscode-resource:', '<p>x</p>');
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.ok(policy.includes("default-src 'none'"));
  assert.ok(/script-src 'nonce-[A-Za-z0-9]{32}'/.test(policy));
  assert.ok(!policy.includes('unsafe-eval') && !policy.includes('http'));
  const n = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(policy)![1];
  assert.ok(html.includes(`<script nonce="${n}">`));
  assert.equal(csp('a', 'b').includes("'unsafe-inline'"), true, 'inline styles only');
});

test('webview messages are validated', () => {
  const known = (k: string) => k === 'claude:a';
  assert.deepEqual(validateMessage({ type: 'open', key: 'claude:a' }, known), { type: 'open', key: 'claude:a' });
  assert.equal(validateMessage({ type: 'open', key: 'claude:zzz' }, known), undefined, 'unknown session');
  assert.equal(validateMessage({ type: 'cmd', cmd: 'workbench.action.terminal.sendSequence', key: '' }, known), undefined, 'arbitrary command');
  assert.equal(validateMessage({ type: 'cmd', cmd: 'refresh', key: 'x'.repeat(500) }, known), undefined, 'oversize');
  assert.equal(validateMessage('open', known), undefined);
  assert.equal(validateMessage(null, known), undefined);
  assert.deepEqual(validateMessage({ type: 'ready', key: '' }, known), { type: 'ready', key: '' });
  assert.equal(validateMessage({ type: 'ready', key: 'claude:a' }, known), undefined);
  assert.deepEqual(validateMessage({ type: 'cmd', cmd: 'refresh', key: '' }, known), { type: 'cmd', cmd: 'refresh', key: '' });
});

test('rendered provider text is escaped (no HTML/script injection from titles or commands)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const s = snap({ title: evil, status: 'RUNNING', startedAt: NOW - 60_000, lastActivityAt: NOW, tests: [{ command: evil, at: NOW, outcome: 'PASS', source: 'provider-exit-code' }] });
  for (const html of [renderCockpit([s], [{ provider: 'claude', detected: true, note: '', artifactsScanned: 1, diagnostics: [] }], NOW), renderInspector(s, [], undefined, [], false), renderGraph([s])]) {
    assert.ok(!html.includes('<img') && !html.includes('<script'), html.slice(0, 200));
  }
});

test('ended without commit is not FAILED', () => {
  assert.equal(statusText(snap({ status: 'ENDED' })), 'Ended — no commit observed');
  assert.equal(statusText(snap({ status: 'ENDED', commits: [{ sha: 'a'.repeat(40), at: NOW, subject: 's', attribution: 'during-session' }] })), 'Ended');
});

test('cockpit: counts, provider not detected state, recent list', () => {
  const sessions = [
    snap({ key: 'claude:r', sessionId: 'r', status: 'RUNNING', startedAt: NOW - 18 * 60_000, branch: 'release/v51', repository: 'D:\\PROJ\\datapass-vscode' }),
    snap({ key: 'claude:e', sessionId: 'e', status: 'ENDED', endedAt: NOW - 3600_000, lastActivityAt: NOW - 3600_000 }),
    snap({ key: 'claude:w', sessionId: 'w', status: 'RUNNING', isWorker: true, parentSessionId: 'claude:r' }),
  ];
  const sum = summarize(sessions, NOW);
  assert.deepEqual([sum.active, sum.endedToday], [1, 1], 'workers are not counted as sessions');
  const html = renderCockpit(sessions, [{ provider: 'claude', detected: true, note: '', artifactsScanned: 3, diagnostics: [] }, { provider: 'codex', detected: false, note: '', artifactsScanned: 0, diagnostics: [] }], NOW);
  assert.ok(html.includes('release/v51') && html.includes('datapass-vscode') && html.includes('18m') && html.includes('1 worker'));
  assert.ok(html.includes('not detected'), 'codex not detected state');
  assert.ok(html.includes('Recent'));
});

test('graph: worker edges only where the provider exposed a parent', () => {
  const a = snap({ key: 'codex:p', provider: 'codex', sessionId: 'p', title: 'lead', status: 'RUNNING' });
  const b = snap({ key: 'codex:c', provider: 'codex', sessionId: 'c', workerLabel: 'Euclid', isWorker: true, parentSessionId: 'codex:p', status: 'RUNNING' });
  const c = snap({ key: 'codex:x', provider: 'codex', sessionId: 'x', title: 'independent', status: 'RUNNING' });
  const g = renderGraph([a, b, c]);
  const lines = g.split('\n');
  const leadIdx = lines.findIndex(l => l.includes('lead'));
  assert.ok(lines[leadIdx + 1].includes('Euclid'), 'child nested under parent');
  assert.ok(lines.find(l => l.includes('independent'))!.match(/^[│ ]*[├└]─ /), 'independent session is a sibling root');
  const insp = renderInspector(snap({}), [], undefined, [], false);
  assert.ok(insp.includes('No worker sessions observed'));
});

test('activity: weekly rollup, no productivity score', () => {
  const s = snap({ startedAt: NOW - 3600_000, lastActivityAt: NOW, commits: [{ sha: 'b'.repeat(40), at: NOW - 60_000, subject: 'x', attribution: 'during-session' }], tests: [{ command: 'npm test', at: NOW - 120_000, outcome: 'PASS', source: 'provider-exit-code' }], changedFiles: ['a', 'b'], repository: 'D:\\r\\repo' });
  const days = weekly([s], NOW);
  assert.equal(days.length, 7);
  const today = days[6];
  assert.deepEqual([today.sessions, today.commits, today.tests, today.filesChanged, today.repos[0]], [1, 1, 1, 2, 'repo']);
  const html = renderActivity(days, [s]);
  assert.ok(!/score/i.test(html.replace('not a productivity measure', '')));
});

test('timeline renders chronologically with day headers', () => {
  const s = snap({});
  const html = renderTimeline(
    [
      { at: NOW - 1000, type: 'SESSION_STARTED', label: 'session started', provider: 'claude', sessionKey: 'claude:a', kind: 'OBSERVED' },
      { at: NOW, type: 'COMMIT', label: 'a81c2 feat', provider: 'claude', sessionKey: 'claude:a', kind: 'DERIVED' },
    ],
    new Map([[s.key, s]]),
    {},
  );
  assert.ok(html.indexOf('session started') < html.indexOf('a81c2'));
});
