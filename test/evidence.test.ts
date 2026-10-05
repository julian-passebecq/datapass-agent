// Evidence follow-ups (audit A3): test kind, chained / piped outcomes, testVerdict in views, status evidence in the audit.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, TestObservation } from '../src/model';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { attention, stages, verification } from '../src/activity/insights';
import { signals } from '../src/activity/signals';
import { statusEvidence, transitions } from '../src/activity/audit';
import { CHAIN_MARK, PIPE_MARK, REGISTRY_GONE } from '../src/sessions/classify';
import { tmpDir } from './helpers';

const SID = 'bbbbbbbb-2222-4222-8222-222222222222';
const iso = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m)).toISOString();
const jl = (recs: object[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const M = 60_000;

let u = 0;
const user = (m: number, content: unknown, extra: object = {}) => ({ type: 'user', uuid: `e-${++u}`, timestamp: iso(m), sessionId: SID, message: { role: 'user', content }, ...extra });
const bash = (m: number, id: string, command: string) => ({ type: 'assistant', uuid: `e-${++u}`, timestamp: iso(m), sessionId: SID, message: { id: `m-${id}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const res = (m: number, id: string, isError: boolean) => user(m, [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: isError }], { toolUseResult: { stdout: '', stderr: '', interrupted: false } });

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', title: 't', repository: 'D:/PROJ/app', status: 'RUNNING', statusReason: 'live registry entry: busy', startedAt: NOW - 60 * M, lastActivityAt: NOW - M, commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

const flagTest = (command: string, outcome: TestObservation['outcome']): TestObservation => ({ command, at: NOW - 5 * M, outcome, source: 'provider-tool-error-flag' });

test('claude: tests carry their check kind; chained / piped with only the error flag get UNKNOWN', () => {
  const root = tmpDir('claude-evidence');
  const dir = path.join(root, 'projects', 'D--fake');
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(main, jl([
    user(0, 'go'),
    bash(1, 't1', 'npm test'), res(2, 't1', true),
    bash(3, 't2', 'npm test | tail -n 40'), res(4, 't2', false),
    bash(5, 't3', 'npm run build && npm test'), res(6, 't3', true),
    bash(7, 't4', 'cd D:/x && npm test'), res(8, 't4', false),
  ]));
  const st = fs.statSync(main);
  const acc = new ClaudeAdapter(root).ingest({ path: main, mtimeMs: st.mtimeMs, size: st.size })!;
  const s = acc.toSnapshot();
  assert.deepEqual(s.tests.map(t => t.kind), ['test', 'test', 'test', 'test']);
  assert.deepEqual(s.tests.map(t => t.outcome), ['FAIL', 'UNKNOWN', 'UNKNOWN', 'PASS'], 'piped / chained: the flag is not the test status; a leading cd is not a chain');
  const labels = acc.timeline().filter(e => e.type === 'TEST').map(e => e.label);
  assert.ok(labels[1].startsWith('UNKNOWN ') && labels[2].startsWith('UNKNOWN '));
});

test('insights: attention, stages and verification use testVerdict', () => {
  const chained = snap({ tests: [flagTest(`npm run build && npm test${CHAIN_MARK}`, 'FAIL')] });
  assert.equal(attention([chained], NOW).filter(a => /Last test failed/.test(a.reason)).length, 0);
  assert.equal(verification(chained), 'none');
  const v = stages(chained).find(x => x.id === 'verify')!;
  assert.equal(v.state, 'none');
  assert.match(v.detail, /last UNKNOWN \(command chain/);

  const plain = snap({ tests: [flagTest('npm test', 'FAIL')] });
  assert.equal(attention([plain], NOW).filter(a => /Last test failed/.test(a.reason)).length, 1);
  assert.equal(verification(plain), 'fail');
  assert.equal(stages(plain).find(x => x.id === 'verify')!.state, 'fail');

  const exit = snap({ tests: [{ ...flagTest(`npm test${PIPE_MARK}`, 'PASS'), source: 'provider-exit-code', exitCode: 0 }] });
  assert.equal(verification(exit), 'pass', 'an exit code of the whole pipeline is kept');
});

test('signals: a piped test with only the error flag is not an unsolved failing test', () => {
  const ended = { status: 'ENDED' as const, statusReason: 'provider recorded the end', endedAt: NOW - 2 * M };
  const piped = snap({ ...ended, tests: [flagTest(`npm test${PIPE_MARK}`, 'FAIL')] });
  assert.ok(!signals(piped, [], { now: NOW }).some(x => x.kind === 'unsolved' && /last test failing/.test(x.reason)));
  const plain = snap({ ...ended, tests: [flagTest('npm test', 'FAIL')] });
  assert.ok(signals(plain, [], { now: NOW }).some(x => x.kind === 'unsolved' && /last test failing/.test(x.reason)));
});

test('audit: status evidence kind comes from statusEvidenceOf, never stronger than the provider recorded', () => {
  const gone = snap({ status: 'ENDED', statusReason: REGISTRY_GONE, endedAt: NOW - M, evidence: [] });
  assert.equal(statusEvidence(gone).kind, 'INFERRED');
  const ended = transitions([gone], [], { now: NOW }).find(t => t.kind === 'ended')!;
  assert.equal(ended.evidence, 'INFERRED');

  const live = snap({ status: 'RUNNING', statusReason: 'live registry entry: busy' });
  assert.equal(statusEvidence(live).kind, 'OBSERVED');
  const guessed = snap({ status: 'IDLE', statusReason: 'last turn completed recently; thread still open' });
  assert.equal(statusEvidence(guessed).kind, 'INFERRED');

  const weaker = snap({ status: 'ENDED', statusReason: 'subagent final reply', endedAt: NOW - M, evidence: [{ field: 'status', kind: 'INFERRED', source: 'subagent transcript ends on a final reply' }] });
  const e = statusEvidence(weaker);
  assert.equal(e.kind, 'INFERRED');
  assert.match(e.source, /final reply/);
  const recorded = snap({ status: 'ENDED', statusReason: 'provider marked the session ended', endedAt: NOW - M, evidence: [{ field: 'status', kind: 'OBSERVED', source: 'rollout archived' }] });
  assert.equal(statusEvidence(recorded).kind, 'OBSERVED');
});
