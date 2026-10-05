import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { tmpDir } from './helpers';

export const PERF: Record<string, number> = {};

function claudeLine(sid: string, i: number, t0: number): string {
  return JSON.stringify({ type: 'assistant', uuid: `${sid}-${i}`, timestamp: new Date(t0 + i * 1000).toISOString(), sessionId: sid, version: '2.1.289', cwd: 'C:\\nowhere', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }, { type: 'text', text: 'x'.repeat(200) }] } });
}

test('perf: 100-session history load and large-file incremental refresh', async () => {
  const home = tmpDir('perf');
  const proj = path.join(home, 'claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const t0 = Date.now() - 3600_000;
  for (let s = 0; s < 100; s++) {
    const sid = `00000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), Array.from({ length: 200 }, (_, i) => claudeLine(sid, i, t0)).join('\n') + '\n');
  }
  // One large ~12 MB log.
  const bigSid = '99999999-0000-4000-8000-000000000000';
  const big = path.join(proj, `${bigSid}.jsonl`);
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 25_000; i++) fs.writeSync(fd, claudeLine(bigSid, i, t0) + '\n');
  fs.closeSync(fd);
  const store = new SessionStore([new ClaudeAdapter(path.join(home, 'claude')), new CodexAdapter(path.join(home, 'codex'))], { historyDays: 2, maxSessions: 500, idleMinutes: 10, git: false });
  const cold = await store.refresh();
  assert.equal(store.all().length, 101);
  PERF.history100_ms = cold.ms;
  PERF.history100_bytes = cold.bytesRead;
  fs.appendFileSync(big, claudeLine(bigSid, 25_001, t0) + '\n');
  const inc = await store.refresh();
  PERF.incremental_ms = inc.ms;
  PERF.incremental_bytes = inc.bytesRead;
  PERF.big_file_bytes = fs.statSync(big).size;
  assert.ok(inc.bytesRead < 2000, `incremental read ${inc.bytesRead} bytes, not the whole ${PERF.big_file_bytes}`);
  assert.equal(inc.ingested, 1);
  assert.ok(cold.ms < 20_000, `cold load ${cold.ms}ms`);
  const idle = await store.refresh();
  PERF.idle_refresh_ms = idle.ms;
  assert.equal(idle.bytesRead, 0, 'idle refresh reads nothing');
  if (process.env.AGENT_PERF_OUT) fs.writeFileSync(process.env.AGENT_PERF_OUT, JSON.stringify(PERF, null, 2));
});
