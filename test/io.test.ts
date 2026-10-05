// Provider IO: folder listings cached by directory mtime, large files read from the last offset in bounded chunks.
// Fixtures are synthetic (temp dirs, generated lines, no secrets).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { DirCache } from '../src/providers/discover';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { clearTranscriptCache, readTranscript } from '../src/providers/transcript';
import { LARGE_FILE_BYTES, readNewLines, readStats, resetReadStats } from '../src/util/jsonl';
import { tmpDir } from './helpers';

/** Moves a directory's mtime into the past (outside the "recently changed" window), distinct per call. */
let tick = 0;
function age(...dirs: string[]): void {
  const t = new Date(Date.now() - 3600_000 + ++tick * 1000);
  for (const d of dirs) fs.utimesSync(d, t, t);
}

function claudeLine(sid: string, i: number): string {
  return JSON.stringify({ type: 'assistant', uuid: `${sid}-${i}`, timestamp: new Date(Date.UTC(2026, 9, 5, 10) + i * 1000).toISOString(), sessionId: sid, cwd: '/tmp/x', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `line ${i} ${'x'.repeat(400)}` }] } });
}

/** Writes lines until the file passes `bytes`; returns the line count. */
function bigFile(f: string, sid: string, bytes: number): number {
  const fd = fs.openSync(f, 'w');
  let n = 0, size = 0;
  try {
    while (size <= bytes) {
      const l = claudeLine(sid, n++) + '\n';
      fs.writeSync(fd, l);
      size += Buffer.byteLength(l);
    }
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

test('DirCache: unchanged folder is served from cache, an added entry re-lists it', () => {
  const d = tmpDir('io-dir');
  fs.writeFileSync(path.join(d, 'a.jsonl'), '{}\n');
  age(d);
  const c = new DirCache();
  c.begin();
  assert.deepEqual(c.names(d), ['a.jsonl']);
  assert.equal(c.stats.reads, 1);
  c.begin();
  assert.deepEqual(c.names(d), ['a.jsonl']);
  assert.equal(c.stats.reads, 1, 'second pass: no readdir');
  assert.equal(c.stats.hits, 1);
  fs.writeFileSync(path.join(d, 'b.jsonl'), '{}\n');
  age(d);
  c.begin();
  assert.deepEqual(c.names(d).sort(), ['a.jsonl', 'b.jsonl']);
  assert.equal(c.stats.reads, 2);
  assert.equal(c.list(path.join(d, 'missing')), undefined);
  assert.deepEqual(c.names(path.join(d, 'a.jsonl')), [], 'a file is not a folder');
});

test('DirCache: a recently changed folder is always re-listed; unused listings are pruned', () => {
  const d = tmpDir('io-dir');
  const c = new DirCache();
  c.begin();
  c.names(d);
  c.names(d);
  assert.equal(c.stats.reads, 2, 'mtime within the last 2 s: no cache');
  age(d);
  c.begin();
  c.names(d);
  assert.equal(c.size, 1);
  c.begin(); // pass that does not touch d
  c.begin();
  assert.equal(c.size, 0);
});

test('Claude discovery: unchanged project folders are not re-listed, file growth is still seen', () => {
  const root = tmpDir('io-claude');
  const proj = path.join(root, 'projects', 'p');
  const sid = '00000000-0000-4000-8000-000000000001';
  const sdir = path.join(proj, sid);
  const subs = path.join(sdir, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.mkdirSync(path.join(proj, '00000000-0000-4000-8000-000000000002')); // session folder without subagents
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), claudeLine(sid, 0) + '\n');
  fs.writeFileSync(path.join(subs, 'agent-a.jsonl'), claudeLine(sid, 1) + '\n');
  age(subs, sdir, path.join(proj, '00000000-0000-4000-8000-000000000002'), proj, path.join(root, 'projects'));
  const a = new ClaudeAdapter(root);
  const r1 = a.listArtifacts(0, 50);
  assert.equal(r1.length, 2);
  const reads = a.dirCache.stats.reads;
  assert.equal(reads, 5, 'projects, p, two session folders, subagents');
  fs.appendFileSync(path.join(proj, `${sid}.jsonl`), claudeLine(sid, 2) + '\n');
  const r2 = a.listArtifacts(0, 50);
  assert.equal(a.dirCache.stats.reads, reads, 'nothing re-listed');
  const main = r2.find(r => r.path.endsWith(`${sid}.jsonl`));
  assert.ok(main && main.size > r1.find(r => r.path === main.path)!.size, 'appended bytes seen through stat');
  fs.writeFileSync(path.join(subs, 'agent-b.jsonl'), claudeLine(sid, 3) + '\n');
  age(subs);
  const r3 = a.listArtifacts(0, 50);
  assert.equal(r3.length, 3, 'new worker transcript found');
  assert.equal(a.dirCache.stats.reads, reads + 1, 'only subagents/ re-listed');
});

test('Codex discovery: day folders cached; session_index.jsonl read from its last offset', () => {
  const root = tmpDir('io-codex');
  const day = path.join(root, 'sessions', '2026', '10', '05');
  fs.mkdirSync(day, { recursive: true });
  const id = '22222222-2222-7222-8222-000000000001';
  fs.writeFileSync(path.join(day, `rollout-2026-10-05T10-00-00-${id}.jsonl`), JSON.stringify({ timestamp: '2026-10-05T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/tmp/x' } }) + '\n');
  const idx = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(idx, JSON.stringify({ id, thread_name: 'First title' }) + '\n');
  age(day, path.join(root, 'sessions', '2026', '10'), path.join(root, 'sessions', '2026'), path.join(root, 'sessions'));
  const a = new CodexAdapter(root);
  assert.equal(a.listArtifacts(0, 50).length, 1);
  const reads = a.dirCache.stats.reads;
  assert.equal(a.listArtifacts(0, 50).length, 1);
  assert.equal(a.dirCache.stats.reads, reads, 'unchanged day folders not re-listed');
  const titles = (a as any).titles as Map<string, string>;
  a.refreshLive([], Date.now());
  assert.equal(titles.get(id), 'First title');
  const before = fs.statSync(idx).size;
  resetReadStats();
  fs.appendFileSync(idx, JSON.stringify({ id, thread_name: 'Renamed' }) + '\n');
  a.refreshLive([], Date.now());
  assert.equal(titles.get(id), 'Renamed');
  assert.equal(readStats.bytes, fs.statSync(idx).size - before, 'only the appended line was read');
  resetReadStats();
  a.refreshLive([], Date.now());
  assert.equal(readStats.calls, 0, 'unchanged index: not opened');
});

test('jsonl: a file over 4 MB is read once, then only from the last offset in bounded chunks', () => {
  const d = tmpDir('io-big');
  const f = path.join(d, 'big.jsonl');
  const sid = '00000000-0000-4000-8000-0000000000bb';
  const n = bigFile(f, sid, LARGE_FILE_BYTES + 512 * 1024);
  assert.ok(fs.statSync(f).size > LARGE_FILE_BYTES);
  resetReadStats();
  let count = 0;
  const r1 = readNewLines(f, undefined, () => count++);
  assert.equal(count, n);
  assert.equal(readStats.largeFull, 1);
  assert.ok(readStats.maxChunk <= 1 << 20, 'reads are at most 1 MB at a time');
  const add = claudeLine(sid, n) + '\n' + claudeLine(sid, n + 1) + '\n';
  fs.appendFileSync(f, add);
  const seen: string[] = [];
  const r2 = readNewLines(f, r1.cursor, l => seen.push(l));
  assert.equal(r2.reset, false);
  assert.equal(r2.bytesRead, Buffer.byteLength(add), 'only the appended bytes');
  assert.equal(seen.length, 2);
  assert.equal(readStats.largeFull, 1, 'never fully re-read');
  assert.equal(readStats.largeTail, 1);
  const r3 = readNewLines(f, r2.cursor, () => assert.fail('nothing new'));
  assert.equal(r3.bytesRead, 0);
});

test('Claude ingest of a > 4 MB transcript: appends are parsed from the cursor, heap stays bounded', () => {
  const root = tmpDir('io-claude-big');
  const proj = path.join(root, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '00000000-0000-4000-8000-0000000000cc';
  const f = path.join(proj, `${sid}.jsonl`);
  const n = bigFile(f, sid, LARGE_FILE_BYTES + 256 * 1024);
  const a = new ClaudeAdapter(root);
  const [ref] = a.listArtifacts(0, 10);
  const acc = a.ingest(ref)!;
  assert.equal(acc.cursor!.offset, ref.size);
  const heap0 = process.memoryUsage().heapUsed;
  resetReadStats();
  let added = 0;
  for (let k = 0; k < 5; k++) {
    const add = claudeLine(sid, n + k) + '\n';
    added += Buffer.byteLength(add);
    fs.appendFileSync(f, add);
    const prev = acc.cursor!.offset;
    const [r] = a.listArtifacts(0, 10);
    a.ingest(r);
    assert.equal(acc.cursor!.offset - prev, Buffer.byteLength(add));
  }
  assert.equal(readStats.largeFull, 0);
  assert.equal(readStats.largeTail, 5);
  assert.equal(readStats.bytes, added, 'only appended bytes read');
  assert.ok(process.memoryUsage().heapUsed - heap0 < 16 << 20, 'five appends do not grow the heap by the file size');
});

test('transcript reader: a window over 1 MB is read in chunks with the same result', () => {
  clearTranscriptCache();
  const d = tmpDir('io-tr');
  const f = path.join(d, 'big.jsonl');
  const sid = '00000000-0000-4000-8000-0000000000dd';
  bigFile(f, sid, LARGE_FILE_BYTES + 128 * 1024);
  const size = fs.statSync(f).size;
  const t = readTranscript(f, 'claude', { maxBytes: 3 << 20, maxEntries: 100_000 });
  assert.equal(t.error, undefined);
  assert.equal(t.from, size - (3 << 20));
  // Every whole line inside the window, minus the partial first one.
  const text = fs.readFileSync(f).subarray(t.from).toString('utf8');
  const whole = text.slice(text.indexOf('\n') + 1).split('\n').filter(Boolean).length;
  assert.equal(t.records, whole);
  assert.equal(t.bad, 0);
  fs.appendFileSync(f, claudeLine(sid, 999_999) + '\n');
  const t2 = readTranscript(f, 'claude', { maxBytes: 3 << 20, maxEntries: 100_000 });
  assert.equal(t2.records, whole + 1);
  assert.equal(t2.from, t.from, 'incremental: same window start');
});
