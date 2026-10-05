import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { clearTranscriptCache, clean, Entry, parseText, readTranscript, toolInput } from '../src/providers/transcript';
import { counts, pageOf, strip, visible, workerLinks } from '../src/activity/transcript';
import { setTranscriptSettings, toMarkdown, transcriptView } from '../src/render/extra/transcript';
import { FIXTURES, tmpDir } from './helpers';

const CLAUDE = path.join(FIXTURES, 'facts', 'claude', 'projects', 'D--facts-repo', '55555555-5555-4555-8555-555555555555.jsonl');
const CODEX = path.join(FIXTURES, 'facts', 'codex', 'sessions', '2026', '10', '05', 'rollout-2026-10-05T10-00-00-66666666-6666-7666-8666-666666666666.jsonl');

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}
const data = (sessions: AgentSessionSnapshot[]): WsData => ({ sessions, providers: [], events: [], now: Date.parse('2026-10-05T12:00:00Z'), ternAvailable: false });
const kinds = (es: Entry[]) => es.map(e => e.kind);

test('Claude transcript → prompts, replies, tools with results, spawn, compaction; meta and tool results are not prompts', () => {
  const { entries, bad } = parseText('claude', fs.readFileSync(CLAUDE, 'utf8'));
  assert.equal(bad, 0);
  const prompts = entries.filter(e => e.kind === 'prompt').map(e => e.text);
  assert.deepEqual(prompts, ['Run the tests and fix the parser', 'Next please']);
  assert.ok(!entries.some(e => e.text.includes('meta note')), 'isMeta records are skipped');
  const cmd = entries.find(e => e.kind === 'command');
  assert.equal(cmd?.name, '/clear');
  const bash = entries.find(e => e.kind === 'tool' && e.name === 'Bash')!;
  assert.ok(!bash.text.includes('abc123secretvalue'), 'secret redacted');
  assert.equal(bash.result?.error, true);
  assert.equal(bash.result?.text, '1 failing');
  const spawn = entries.find(e => e.kind === 'spawn')!;
  assert.deepEqual(spawn.spawn, { type: 'Explore', description: 'Scan repo' });
  assert.equal(spawn.result?.text, 'found');
  assert.ok(entries.some(e => e.kind === 'tool' && e.name === 'mcp__github__search_code'));
  assert.equal(entries.find(e => e.name === 'WebFetch')?.text, 'https://example.com/docs?…', 'query strings dropped');
  assert.equal(entries.filter(e => e.kind === 'compact').length, 1);
  const lastBash = entries.filter(e => e.name === 'Bash').pop()!;
  assert.equal(lastBash.result, undefined, 'open call has no result');
  const reply = entries.find(e => e.kind === 'reply')!;
  assert.equal(reply.model, 'claude-opus-5-5');
  const c = counts(entries);
  assert.equal(c.prompts, 2);
  assert.equal(c.spawns, 1);
  assert.equal(c.errors, 1);
});

test('Codex rollout → prompts (no injected context), tool calls with outputs, spawn, web search, one reply per message', () => {
  const { entries } = parseText('codex', fs.readFileSync(CODEX, 'utf8'));
  assert.deepEqual(entries.filter(e => e.kind === 'prompt').map(e => e.text), ['Fix the build', 'Now the build']);
  assert.ok(entries.some(e => e.kind === 'meta' && e.name === 'environment_context'));
  const exec = entries.find(e => e.kind === 'tool' && e.name === 'exec')!;
  assert.equal(exec.text, 'npm test');
  assert.equal(exec.result?.text, 'failed');
  const cmd = entries.find(e => e.name === 'command')!;
  assert.equal(cmd.sub, true);
  assert.equal(cmd.result?.exitCode, 1);
  assert.equal(cmd.result?.error, true);
  assert.equal(cmd.result?.durationMs, 15000);
  assert.match(entries.find(e => e.name === 'apply_patch')!.text, /^update .*b\.ts$/);
  const sp = entries.find(e => e.kind === 'spawn')!;
  assert.deepEqual(sp.spawn, { type: 'explorer', description: 'audit' });
  assert.ok(entries.some(e => e.name === 'web_search' && e.text === 'codex docs'));
  assert.ok(entries.some(e => e.name === 'mcp node_repl.js'));
  assert.equal(entries.filter(e => e.kind === 'reply').length, 1);
  assert.equal(entries.filter(e => e.kind === 'compact').length, 1, 'compacted record only, ContextCompaction item not doubled');
  assert.ok(entries.some(e => e.kind === 'meta' && /gpt-6\.1-sol · effort high · approval on-request · sandbox workspace-write/.test(e.text)));
  assert.ok(entries.some(e => e.kind === 'turn'));
});

test('Codex assistant text recorded twice (response_item + AgentMessage) shows once; thinking keeps its length only', () => {
  const lines = [
    { timestamp: '2026-10-05T10:00:00Z', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } },
    { timestamp: '2026-10-05T10:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'Hello' }] } } },
    { timestamp: '2026-10-05T10:00:01Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'x'.repeat(50) } },
    { timestamp: '2026-10-05T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>secret-ish</environment_context>' }] } },
  ].map(o => JSON.stringify(o)).join('\n');
  const { entries } = parseText('codex', lines);
  assert.deepEqual(kinds(entries), ['reply', 'thinking']);
  assert.equal(entries[1].chars, 50);
  assert.equal(entries[1].text, 'encrypted');
});

test('clean() redacts keys, drops base64 and data urls; images never kept', () => {
  const t = clean(`key sk-ant-abcdefghijklmnop1234 and data:image/png;base64,${'A'.repeat(400)} and ${'Qk'.repeat(150)}`);
  assert.ok(!t.includes('sk-ant-abcdefghijklmnop1234'));
  assert.match(t, /\[data url \d+ chars omitted\]/);
  assert.match(t, /chars of encoded data omitted/);
  const line = JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:00Z', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'iVBOR'.repeat(100) } }, { type: 'text', text: 'look' }] } });
  const { entries } = parseText('claude', line);
  assert.equal(entries[0].kind, 'prompt');
  assert.ok(!entries[0].text.includes('iVBOR'));
  assert.match(entries[0].text, /1 image\(s\) omitted/);
});

test('toolInput gives a short human summary', () => {
  assert.equal(toolInput('Read', { file_path: 'D:\\x\\a.ts' }), 'D:\\x\\a.ts');
  assert.equal(toolInput('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(toolInput('TodoWrite', { todos: [1, 2, 3] }), '3 todo item(s)');
  assert.equal(toolInput('exec_command', '{"cmd":"cargo build"}'), 'cargo build');
  assert.equal(toolInput('exec', 'await tools.exec_command({cmd: "git status", workdir: "x"})'), 'git status');
  assert.equal(toolInput('Agent', { subagent_type: 'Explore', description: 'Scan' }), 'Explore: Scan');
});

test('readTranscript is incremental, keeps ids stable, waits for complete lines, and tail-reads big files', () => {
  clearTranscriptCache();
  const dir = tmpDir('tx');
  const f = path.join(dir, 's.jsonl');
  const rec = (i: number, text = `prompt ${i}`) => JSON.stringify({ type: 'user', timestamp: new Date(Date.UTC(2026, 9, 5, 10, 0, i)).toISOString(), message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(f, rec(1) + rec(2));
  const a = readTranscript(f, 'claude');
  assert.equal(a.entries.length, 2);
  const ids = a.entries.map(e => e.id);
  const half = rec(3);
  fs.appendFileSync(f, half.slice(0, 20));
  const b = readTranscript(f, 'claude');
  assert.equal(b.entries.length, 2, 'partial line not parsed yet');
  assert.equal(b.bad, 0);
  fs.appendFileSync(f, half.slice(20));
  const c = readTranscript(f, 'claude');
  assert.deepEqual(c.entries.map(e => e.text), ['prompt 1', 'prompt 2', 'prompt 3']);
  assert.deepEqual(c.entries.slice(0, 2).map(e => e.id), ids);
  assert.equal(c.records, 3);
  // Rewritten (shrunk) file is re-read from scratch.
  fs.writeFileSync(f, rec(9));
  assert.deepEqual(readTranscript(f, 'claude').entries.map(e => e.text), ['prompt 9']);
  // Tail window: only the last maxBytes are read and the first partial line is skipped.
  const big = path.join(dir, 'big.jsonl');
  let s = '';
  for (let i = 0; i < 3000; i++) s += rec(i % 60, `p${i} ${'x'.repeat(60)}`);
  fs.writeFileSync(big, s);
  const t = readTranscript(big, 'claude', { maxBytes: 64 * 1024, maxEntries: 200 });
  assert.ok(t.from > 0);
  assert.equal(t.bad, 0, 'partial first line skipped, not counted as bad');
  assert.equal(t.entries.length, 200);
  assert.ok(t.dropped > 0);
  assert.match(t.entries[t.entries.length - 1].text, /^p2999 /);
  assert.equal(readTranscript(path.join(dir, 'missing.jsonl'), 'claude').error?.includes('not found'), true);
  assert.ok(readTranscript(path.join(dir, 'x.json'), 'claude').error);
});

test('page window follows the latest, jumps to a time, and links older / newer', () => {
  const es: Entry[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, at: 1000 * i, kind: 'prompt', text: `p${i}` }));
  const f = pageOf(es, 10);
  assert.deepEqual([f.start, f.end, f.following], [15, 25, true]);
  assert.equal(f.older, 5000);
  assert.equal(f.newer, undefined);
  const j = pageOf(es, 10, 3500);
  assert.deepEqual([j.start, j.end, j.following], [4, 14, false]);
  assert.equal(j.newer, 14000);
  assert.equal(j.older, 0);
  assert.equal(pageOf(es, 10, 999_999).start, 15, 'anchor after the end falls back to latest');
  const b = strip(es, 5);
  assert.equal(b.length, 5);
  assert.equal(b.reduce((a, x) => a + x.n, 0), 25);
});

test('filters: tools mode, errors, thinking toggle, tool name', () => {
  const es: Entry[] = [
    { id: 1, at: 1, kind: 'prompt', text: 'p' },
    { id: 2, at: 2, kind: 'thinking', text: '', chars: 10 },
    { id: 3, at: 3, kind: 'tool', name: 'Bash', text: 'ls', result: { at: 4, text: 'x', error: true, chars: 1 } },
    { id: 4, at: 5, kind: 'tool', name: 'Read', text: 'a' },
    { id: 5, at: 6, kind: 'meta', text: 'm' },
  ];
  const base = { mode: 'chat' as const, only: 'all' as const, tool: '', thinking: true, meta: false };
  assert.deepEqual(es.filter(e => visible(e, base)).map(e => e.id), [1, 2, 3, 4]);
  assert.deepEqual(es.filter(e => visible(e, { ...base, thinking: false })).map(e => e.id), [1, 3, 4]);
  assert.deepEqual(es.filter(e => visible(e, { ...base, mode: 'tools' })).map(e => e.id), [3, 4]);
  assert.deepEqual(es.filter(e => visible(e, { ...base, only: 'errors' })).map(e => e.id), [3]);
  assert.deepEqual(es.filter(e => visible(e, { ...base, tool: 'read' })).map(e => e.id), [4]);
  assert.deepEqual(es.filter(e => visible(e, { ...base, only: 'talk' })).map(e => e.id), [1]);
});

test('spawn → worker links: description match is OBSERVED, start-time match INFERRED', () => {
  const sp = (id: number, at: number, description: string): Entry => ({ id, at, kind: 'spawn', text: '', spawn: { type: 't', description } });
  const kids = [snap({ key: 'claude:w1', title: 'Scan repo', startedAt: 50_000, isWorker: true }), snap({ key: 'claude:w2', title: 'other', startedAt: 10_500, isWorker: true })];
  const l = workerLinks([sp(1, 10_000, 'something'), sp(2, 40_000, 'Scan repo')], kids);
  assert.deepEqual(l.get(2), { key: 'claude:w1', kind: 'OBSERVED', basis: 'worker description equals the spawn description' });
  assert.equal(l.get(1)?.key, 'claude:w2');
  assert.equal(l.get(1)?.kind, 'INFERRED');
});

test('screen renders a real fixture in chat / log / tools, escaped and redacted; chooser without selection', () => {
  clearTranscriptCache();
  setTranscriptSettings({ pageSize: 150 });
  const s = snap({ key: 'claude:55555555-5555-4555-8555-555555555555', sessionId: '55555555-5555-4555-8555-555555555555', artifactPath: CLAUDE, title: 'Fix <parser>', status: 'RUNNING', lastActivityAt: Date.now() });
  const w = snap({ key: 'claude:w', sessionId: 'w', isWorker: true, parentSessionId: s.key, title: 'Scan repo', startedAt: Date.parse('2026-10-05T10:03:01Z'), artifactPath: 'none.jsonl' });
  const d = data([s, w]);
  assert.equal(transcriptView.ready, true);
  const chat = transcriptView.render(d, { view: 'transcript', selected: s.key });
  assert.ok(chat.includes('Run the tests and fix the parser'));
  assert.ok(chat.includes('Fix &lt;parser&gt;'));
  assert.ok(!chat.includes('Fix <parser>'));
  assert.ok(!chat.includes('abc123secretvalue'));
  assert.ok(chat.includes('data-select="claude:w"'), 'spawn links to the worker');
  assert.ok(chat.includes('following live'));
  assert.ok(chat.includes('data-opt="transcript.at"'));
  assert.ok(chat.includes('thinking') || chat.includes('Thinking'));
  for (const mode of ['log', 'tools']) {
    const h = transcriptView.render(d, { view: 'transcript', selected: s.key, opts: { 'transcript.mode': mode, 'transcript.order': 'new', 'transcript.results': 'full' } });
    assert.ok(h.includes('Bash'), mode);
    assert.ok(h.includes('1 failing'), mode);
    assert.ok(!h.includes('abc123secretvalue'), mode);
  }
  const errs = transcriptView.render(d, { view: 'transcript', selected: s.key, opts: { 'transcript.only': 'errors' } });
  assert.ok(errs.includes('1 failing') && !errs.includes('Next please'));
  const none = transcriptView.render(d, { view: 'transcript' });
  assert.ok(none.includes('Pick a session'));
  assert.ok(none.includes(`data-select="${s.key}"`));
  const missing = transcriptView.render(d, { view: 'transcript', selected: w.key });
  assert.ok(missing.includes('Not a JSONL') || missing.includes('not found'));
  const md = toMarkdown(s, readTranscript(CLAUDE, 'claude'));
  assert.ok(md.includes('## You'));
  assert.ok(!md.includes('abc123secretvalue'));
  assert.ok(transcriptView.css!.split('}').filter(r => r.trim()).every(r => r.trim().startsWith('.tx')), 'every selector scoped to .tx');
});
