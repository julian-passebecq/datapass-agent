import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
import { RAIL_ORDER, renderView, renderWorkspace, WsData } from '../src/render/workspace';
import { renderCockpit, renderGraph, renderInspector } from '../src/render/views';

// Every provider-recorded string is attacker-controlled (a prompt, a branch name, a tool output).
// Screens must escape them: no tag, no attribute breakout, no javascript: link survives.
const NOW = Date.parse('2026-10-04T12:00:00Z');
const PAYLOADS = ['<img src=x onerror=alert(1)>', '"><script>alert(2)</script>', "'><svg onload=alert(3)>", 'javascript:alert(4)', ' JaVaScRiPt:alert(5)'];

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'RUNNING', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 1, commands: 1, fileEdits: 1, turns: 1 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

function evilSessions(payload: string): AgentSessionSnapshot[] {
  const f = (p: Partial<AgentSessionSnapshot>) => snap({
    title: payload,
    statusReason: payload,
    model: payload,
    effort: payload,
    cwd: `D:\\PROJ\\${payload}`,
    repository: payload,
    worktree: payload,
    branch: payload,
    workerLabel: payload,
    lastAction: payload,
    lastActionAt: NOW - 1000,
    startedAt: NOW - 3600_000,
    lastActivityAt: NOW - 1000,
    changedFiles: [payload],
    commits: [{ sha: 'a'.repeat(40), at: NOW - 2000, subject: payload, attribution: 'during-session' }],
    tests: [{ command: payload, at: NOW - 1500, outcome: 'FAIL', source: 'provider-exit-code' }],
    diagnostics: [payload],
    ...p,
  });
  return [
    f({}),
    f({ key: 'codex:b', provider: 'codex', sessionId: 'b', status: 'ENDED', endedAt: NOW - 600_000 }),
    f({ key: 'claude:w', sessionId: 'w', isWorker: true, parentSessionId: 'claude:a' }),
  ];
}

function evilEvents(payload: string): TimelineEvent[] {
  return [{ sessionKey: 'claude:a', at: NOW - 1000, kind: 'TOOL', label: payload, detail: payload } as unknown as TimelineEvent];
}

function assertSafe(html: string, where: string): void {
  const attrsBlanked = html.replace(/=\s*"[^"]*"/g, '=""').replace(/=\s*'[^']*'/g, "=''");
  const checks: [RegExp, string][] = [
    [/<\s*(img|script|iframe|object|embed)\b/i, html],
    [/<svg\b[^>]*\son\w+\s*=/i, html],
    [/(href|src|action|formaction)\s*=\s*["']?\s*javascript:/i, html],
    [/<[a-z][^>]*\son(error|load)\s*=/i, attrsBlanked],
  ];
  for (const [re, text] of checks) {
    const m = re.exec(text);
    if (m) assert.fail(`${where}: unescaped payload near ...${text.slice(Math.max(0, m.index - 80), m.index + 80)}...`);
  }
}

const data = (payload: string): WsData => ({ sessions: evilSessions(payload), providers: [{ provider: 'claude', detected: true, note: payload, artifactsScanned: 1, diagnostics: [payload] }], events: evilEvents(payload), now: NOW, ternAvailable: false, config: <T>(_k: string, f: T) => f });

test('workspace screens escape hostile session fields', () => {
  for (const payload of PAYLOADS) {
    const d = data(payload);
    for (const view of ['overview', 'board', 'team', 'flow', 'gantt', 'verify', 'attention']) assertSafe(renderWorkspace(d, { view: view as never, opts: {} }), `workspace/${view}`);
    let rendered = 0;
    for (const view of RAIL_ORDER) {
      let html: string;
      try {
        html = renderView(d, { view: view as never, opts: {} }, view);
      } catch {
        continue; // a screen that needs a feed snapshot it does not have; not an escaping question
      }
      rendered++;
      assertSafe(html, `view/${view} payload ${payload}`);
    }
    assert.ok(rendered >= 20, `rendered ${rendered} screens`);
  }
});

test('session cards, graph and inspector escape hostile fields', () => {
  for (const payload of PAYLOADS) {
    const [s, c, w] = evilSessions(payload);
    assertSafe(renderCockpit([s, c, w], [{ provider: 'claude', detected: true, note: payload, artifactsScanned: 1, diagnostics: [payload] }], NOW), 'cockpit');
    assertSafe(renderGraph([s, c, w]), 'graph');
    assertSafe(renderInspector(s, [w], undefined, evilEvents(payload), false, NOW), 'inspector');
  }
});

test('assertSafe catches the payloads it is meant to catch', () => {
  assert.throws(() => assertSafe('<p><img src=x onerror=alert(1)></p>', 't'));
  assert.throws(() => assertSafe('<a href="x"><script>alert(2)</script></a>', 't'));
  assert.throws(() => assertSafe('<a href="javascript:alert(4)">x</a>', 't'));
  assert.throws(() => assertSafe('<a href= JaVaScRiPt:alert(5)>x</a>', 't'));
  assertSafe('<p>&lt;img src=x onerror=alert(1)&gt; javascript:alert(4)</p><svg viewBox="0 0 1 1"></svg>', 't');
});
