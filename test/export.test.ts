import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { sanitize, exportConversations, discoverConversations, parseCsv, projectMatches } from '../src/export/conversations';
import { execFileSync } from 'node:child_process';

test('exports the whole selected file with provenance, tools and malformed counts; source unchanged', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'datapass-export-'));
  try {
    const dir = path.join(home, 'codex', 'sessions'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout.jsonl');
    const lines = [JSON.stringify({ type: 'session_meta', payload: { id: 'session-test', cwd: home } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01', payload: { role: 'user', content: [{ text: 'Implement feature' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{"api_key":"test-secret-value"}' } }),
      'not json', ...Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ text: `message ${i}` }] } }))].join('\n');
    await fs.writeFile(file, lines);
    const discovered = await discoverConversations({ codexHome: path.join(home, 'codex'), provider: 'codex' });
    assert.equal(discovered[0].id, 'session-test');
    const result = await exportConversations(discovered, path.join(home, 'output'));
    assert.equal(result.sessions[0].records, 33); assert.equal(result.sessions[0].malformed, 1);
    assert.equal(result.sessions[0].excerpts.length, 12); assert.equal(result.sessions[0].changedDuringExport, false);
    const output = await fs.readFile(path.join(result.directory, result.sessions[0].file), 'utf8');
    assert.equal(output.includes('test-secret-value'), false); assert.match(output, /function_call/); assert.match(output, /sourceModifiedAt/);
    assert.equal(await fs.readFile(file, 'utf8'), lines);
    const again = await exportConversations(discovered, path.join(home, 'output'));
    assert.equal(again.sessions[0].contentHash, result.sessions[0].contentHash);
    assert.notEqual(again.directory, result.directory);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('scrubs complete Mongo URI, keys, query credentials and binary data; keeps native session identity and counts', () => {
  const safe = JSON.stringify(sanitize({ sessionId: 'session-test', token_count: 42, password: 'private-value',
    text: 'mongodb+srv://reader:dummy-password@example.invalid/db?token=secret data:image/png;base64,AAAA' }));
  assert.doesNotMatch(safe, /dummy-password|example.invalid|private-value|AAAA/);
  assert.match(safe, /session-test/); assert.match(safe, /42/);
});
test('CSV supports multiline, escaped quotes and rejects malformed or duplicate headers', () => {
  assert.deepEqual(parseCsv('name,detail\r\nfeature,"line1\nline2 ""quote"""\r\n'), [{ name: 'feature', detail: 'line1\nline2 "quote"' }]);
  assert.throws(() => parseCsv('x,x\na,b')); assert.throws(() => parseCsv('x\n"open')); assert.throws(() => parseCsv('x,y\na'));
});
test('project selection respects path boundaries', () => {
  const root = path.resolve('project'); assert.equal(projectMatches(path.join(root, 'sub'), root), true);
  assert.equal(projectMatches(root + '-other', root), false); assert.equal(projectMatches(undefined, root), false);
});
test('credential input files are rejected without reading them', async () => {
  await assert.rejects(exportConversations([{ provider: 'mongo', file: path.resolve('auth.json'), id: 'auth' }], os.tmpdir()), /Credential files/);
});
test('full-event fallback searches tool records and returns bounded redacted citations', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'datapass-query-'));
  try {
    const file = path.join(home, 'records.json');
    await fs.writeFile(file, JSON.stringify([{ tool: 'query', text: 'architecture architecture decision', password: 'dummy-private-value' }, { text: 'unrelated' }]));
    const exported = await exportConversations([{ provider: 'mongo', file, id: 'fixture' }], path.join(home, 'output'));
    const raw = execFileSync(process.execPath, [path.resolve('out-test/scripts/search-knowledge.js'), '--bundle', exported.directory, '--query', 'architecture decision', '--limit', '1', '--max-chars', '200'], { encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(raw) as { scanned: number; results: Array<{ snippet: string; source: { line: number } }> };
    assert.equal(result.scanned, 2); assert.equal(result.results.length, 1);
    assert.equal(result.results[0].source.line, 1); assert.ok(result.results[0].snippet.length <= 200);
    assert.doesNotMatch(raw, /dummy-private-value/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
test('ChatGPT import retains alternate branches and parent linkage; CSV and Mongo retain source rows', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'datapass-input-'));
  try {
    const file = path.join(home, 'chat.json'); await fs.writeFile(file, JSON.stringify([{ id: 'chat', title: 'design', mapping: {
      a: { parent: null, children: ['b', 'c'], message: { author: { role: 'user' }, content: { parts: ['question'] } } },
      b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['answer 1'] } } },
      c: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['answer 2'] } } },
    } }]));
    const output = await exportConversations([{ provider: 'chatgpt', file, id: 'chat' }], path.join(home, 'exports'));
    assert.equal(output.sessions[0].records, 3);
    const events = await fs.readFile(path.join(output.directory, output.sessions[0].file), 'utf8');
    assert.match(events, /answer 1/); assert.match(events, /answer 2/); assert.match(events, /"parent":"a"/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
