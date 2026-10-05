import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FIXTURES } from './helpers';
import '../src/render/workspace'; // load order as in the extension (workspace → extra/index → screens)
import { AgentSessionSnapshot } from '../src/model';
import { newTranscript, parseJournal, parseRunState, parseScriptMeta, summarizeResult, transcriptLine, WorkflowScanner } from '../src/providers/claude/workflows';
import { renderWorkflows, runKey } from '../src/render/extra/workflows';
import { WsData } from '../src/render/workspace';

const PROJECTS = path.join(FIXTURES, 'workflows', 'projects');
const SID = '11111111-2222-3333-4444-555555555555';
const RUN_DIR = path.join(PROJECTS, 'D--PROJ-demo', SID, 'subagents', 'workflows', 'wf_test0001-abc');
const mtimeOf = (f: string) => fs.statSync(path.join(RUN_DIR, f)).mtimeMs;

function scanAt(offsetMs: number) {
  const now = Math.max(mtimeOf('agent-a0001.jsonl'), mtimeOf('agent-a0002.jsonl')) + offsetMs;
  return { now, snap: new WorkflowScanner(PROJECTS).scan(now) };
}

test('scanner reads runs, agents, phases, tokens and tools from fixtures', () => {
  const { snap } = scanAt(60_000);
  assert.equal(snap.runs.length, 1);
  const run = snap.runs[0];
  assert.equal(run.runId, 'wf_test0001-abc');
  assert.equal(run.parentKey, `claude:${SID}`);
  assert.equal(run.name, 'demo-run');
  assert.equal(run.description, 'Demo workflow with a } brace in a string');
  assert.deepEqual(run.phases.map(p => p.title), ['Code', 'Verify', 'Ship']);
  assert.equal(run.status, 'running', 'a0002 has no result and was written 1 min ago');
  assert.deepEqual(run.agents.map(a => a.agentId), ['a0001', 'a0002', 'a0003'], 'journal order');
  const [one, two, three] = run.agents;
  assert.equal(one.status, 'done');
  assert.equal(one.model, 'claude-opus-5-5');
  // msg_1 counted once with its last usage (10+100+20), msg_2 = 1+200+50+9
  assert.equal(one.tokens, 130 + 260);
  assert.equal(one.outputTokens, 29);
  assert.equal(one.calls, 2);
  assert.equal(one.tools, 1);
  assert.equal(one.toolErrors, 1);
  assert.equal(one.lastTool, 'Bash · Run tests');
  assert.equal(one.currentTool, undefined);
  assert.equal(one.firstAt, Date.parse('2026-10-04T10:00:00.000Z'));
  assert.equal(one.lastAt, Date.parse('2026-10-04T10:02:00.000Z'));
  assert.equal(one.worktree, 'D:\\PROJ\\demo\\.worktrees\\one');
  assert.equal(one.agentType, 'workflow-subagent');
  assert.ok(one.result && !one.result.includes('sk-abcdefghijklmnopqrstuv'), 'result is redacted');
  assert.ok(one.result!.length <= 160);
  assert.equal(two.status, 'running');
  assert.equal(two.currentTool, 'Read · a.ts');
  assert.equal(three.status, 'failed');
  assert.equal(three.transcript, undefined);
  assert.equal(snap.background.length, 1);
  assert.equal(snap.background[0].agentType, 'Explore');
  assert.equal(snap.background[0].sessionKey, `claude:${SID}/agent-bg001`);
});

test('agent without result turns stale after 10 min of silence', () => {
  const { snap } = scanAt(11 * 60_000);
  const run = snap.runs[0];
  assert.equal(run.agents[1].status, 'stale');
  assert.equal(run.agents[1].currentTool, undefined);
  assert.equal(run.status, 'stale');
});

test('runs older than 7 days are not listed', () => {
  const { snap } = scanAt(8 * 86400_000);
  assert.equal(snap.runs.length, 0);
  assert.equal(snap.background.length, 0);
});

test('journal parsing and result summaries', () => {
  const r = parseJournal('{"type":"launched"}\nnot json\n{"type":"started","agentId":"x","label":"L","phase":"P"}\n{"type":"result","agentId":"x","result":"Error: boom\\nmore"}\n');
  assert.equal(r.launched, true);
  assert.deepEqual(r.started.get('x'), { label: 'L', phase: 'P' });
  assert.equal(r.results.get('x')!.failed, true);
  assert.equal(r.results.get('x')!.summary, 'Error: boom');
  assert.equal(summarizeResult({ mrs: [1, 2, 3], ok: true }).summary, 'mrs: 3 · ok: true');
  assert.equal(summarizeResult({ status: 'done', notes: 'fine' }).summary, 'done · fine');
  assert.equal(summarizeResult({ status: 'blocked' }).failed, true);
  assert.ok(summarizeResult('x'.repeat(500)).summary.length <= 160);
  assert.equal(summarizeResult(null).summary, '(no result)');
});

test('script meta is parsed without evaluation', () => {
  assert.equal(parseScriptMeta('const x = 1'), undefined);
  const m = parseScriptMeta("export const meta = { name: \"n\", phases: ['A', 'B'], description: `d` }\nprocess.exit(1)")!;
  assert.equal(m.name, 'n');
  assert.equal(m.description, 'd');
  assert.deepEqual(m.phases.map(p => p.title), ['A', 'B']);
});

test('final run state keeps only small fields', () => {
  const s = parseRunState(JSON.stringify({ workflowName: 'w', status: 'killed', startTime: '2026-10-04T10:00:00Z', durationMs: 5000, error: 'token=abcdefghijklmnop', result: 'big', logs: ['x'], script: "export const meta = { name: 'm', phases: [{ title: 'P' }] }" }))!;
  assert.equal(s.name, 'w');
  assert.equal(s.status, 'killed');
  assert.equal(s.startTime, Date.parse('2026-10-04T10:00:00Z'));
  assert.equal(s.durationMs, 5000);
  assert.ok(!s.error!.includes('abcdefghijklmnop'), 'error redacted');
  assert.deepEqual(s.meta!.phases.map(p => p.title), ['P']);
  assert.equal((s as any).result, undefined);
});

test('huge transcript lines still close tool calls', () => {
  const t = newTranscript();
  transcriptLine(t, JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:00:00Z', message: { id: 'm', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.equal(t.open.size, 1);
  transcriptLine(t, `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"${'y'.repeat(300_000)}"}]},"timestamp":"2026-10-04T10:05:00Z"}`);
  assert.equal(t.open.size, 0);
  assert.equal(t.lastAt, Date.parse('2026-10-04T10:05:00Z'));
});

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'codex:w', provider: 'codex', sessionId: 'w', status: 'RUNNING', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: true, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

test('screen renders runs, agents, timeline and Codex workers, escaped', () => {
  const { now, snap: ws } = scanAt(60_000);
  const d: WsData = { sessions: [snap({ workerLabel: 'Hume <b>', startedAt: now - 60_000, lastActivityAt: now, usage: { totalTokens: 1234, outputTokens: 1, cachedInputTokens: 0 } })], providers: [], events: [], now, ternAvailable: false };
  for (const mode of ['runs', 'agents', 'timeline']) {
    for (const group of ['run', 'phase', 'parent']) {
      const h = renderWorkflows(d, { view: 'workflows', opts: { 'workflows.mode': mode, 'workflows.group': group, 'workflows.agent': 'a0001' } }, ws);
      assert.ok(!h.includes('<img src=x'), `${mode}/${group} escapes labels`);
      assert.ok(h.includes('&lt;img src=x'), `${mode}/${group} shows the label`);
      assert.ok(h.includes('Codex workers') && h.includes('Hume &lt;b&gt;') && h.includes('data-select="codex:w"'));
      assert.ok(h.includes('Open transcript'), `${mode}/${group} shows the detail panel`);
    }
  }
  const runs = renderWorkflows(d, { view: 'workflows', opts: {} }, ws);
  assert.ok(runs.includes('demo-run') && runs.includes('Ship'), 'expanded newest running run with declared phases');
  assert.ok(runs.includes(`data-val="none"`), 'open run header collapses it');
  assert.equal(runKey('wf_test0001-abc'), 'wftest0001-abc');
  assert.ok(renderWorkflows(d, { view: 'workflows' }, undefined).includes('Scanning'));
});
