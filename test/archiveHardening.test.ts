// Archive hardening: raw copies are owner-only (POSIX), and the artifact scan cap never drops the parent
// transcript of a kept subagent transcript. Fixtures are synthetic (temp dirs, generated lines, no secrets).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { copyRaw, ownerOnly, RAW_FILE_MODE } from '../src/archive/archive';
import { capArtifacts, ClaudeAdapter, parentTranscriptOf } from '../src/providers/claude/claude';
import { ArtifactRef } from '../src/providers/types';
import { tmpDir } from './helpers';

const posix = process.platform !== 'win32';

test('raw copies and the raw manifest are written owner-only (0600) on POSIX', async () => {
  const home = tmpDir('rawperm');
  const root = path.join(home, '.claude');
  const dir = path.join(home, 'archive');
  const f = path.join(root, 'projects', 'p', 's.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"type":"user"}\n');
  const r = await copyRaw(dir, [{ provider: 'claude', root, file: f }], 1024 ** 3);
  assert.equal(r.copied, 1);
  const gz = path.join(dir, 'raw', 'claude', 'projects', 'p', 's.jsonl.gz');
  assert.ok(fs.existsSync(gz));
  if (posix) {
    assert.equal(fs.statSync(gz).mode & 0o777, RAW_FILE_MODE);
    assert.equal(fs.statSync(path.join(dir, 'raw', 'manifest.json')).mode & 0o777, RAW_FILE_MODE);
  }
});

test('ownerOnly tightens an existing file on POSIX and is a no-op on Windows', () => {
  const d = tmpDir('owneronly');
  const f = path.join(d, 'x.gz');
  fs.writeFileSync(f, 'x', { mode: 0o644 });
  const before = fs.statSync(f).mode;
  ownerOnly(f);
  if (posix) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  else assert.equal(fs.statSync(f).mode, before);
  ownerOnly(path.join(d, 'missing.gz')); // never throws
});

function ref(p: string, mtimeMs: number): ArtifactRef {
  return { path: p, mtimeMs, size: 1 };
}

test('parentTranscriptOf maps <session>/subagents/agent-*.jsonl to <session>.jsonl', () => {
  const s = path.join('r', 'projects', 'p', 'sid');
  assert.equal(parentTranscriptOf(path.join(s, 'subagents', 'agent-a.jsonl')), `${s}.jsonl`);
  assert.equal(parentTranscriptOf(`${s}.jsonl`), undefined);
});

test('scan cap keeps the parent of every kept subagent, parent first', () => {
  const s1 = path.join('r', 'projects', 'p', 's1');
  const s2 = path.join('r', 'projects', 'p', 's2');
  const a = path.join(s1, 'subagents', 'agent-a.jsonl');
  const b = path.join(s1, 'subagents', 'agent-b.jsonl');
  // newest first: two fresh children of s1, then s2, then the old parent s1
  const list = [ref(a, 100), ref(b, 90), ref(`${s2}.jsonl`, 80), ref(`${s1}.jsonl`, 10)];
  assert.deepEqual(capArtifacts(list, 2).map(r => r.path), [`${s1}.jsonl`, a]);
  assert.deepEqual(capArtifacts(list, 3).map(r => r.path), [`${s1}.jsonl`, a, b]);
  // cap 1: the child does not fit with its parent, so the next parent-less transcript is kept instead
  assert.deepEqual(capArtifacts(list, 1).map(r => r.path), [`${s2}.jsonl`]);
  // under the cap nothing is dropped, parents still come first
  const all = capArtifacts(list, 10).map(r => r.path);
  assert.equal(all.length, 4);
  assert.ok(all.indexOf(`${s1}.jsonl`) < all.indexOf(a));
  for (const n of [1, 2, 3, 4]) {
    const kept = new Set(capArtifacts(list, n).map(r => r.path));
    assert.ok(kept.size <= n);
    for (const k of kept) {
      const p = parentTranscriptOf(k);
      if (p) assert.ok(kept.has(p), `cap ${n}: parent of ${k} kept`);
    }
  }
});

test('ClaudeAdapter.listArtifacts applies the parent-preserving cap on disk', () => {
  const root = tmpDir('capdisk');
  const proj = path.join(root, 'projects', 'p');
  const subs = path.join(proj, 'sid1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const parent = path.join(proj, 'sid1.jsonl');
  const other = path.join(proj, 'sid2.jsonl');
  const child = path.join(subs, 'agent-a.jsonl');
  for (const f of [parent, other, child]) fs.writeFileSync(f, '{}\n');
  const t = (s: number) => new Date(Date.now() - s * 1000);
  fs.utimesSync(parent, t(3000), t(3000));
  fs.utimesSync(other, t(2000), t(2000));
  fs.utimesSync(child, t(1000), t(1000));
  const out = new ClaudeAdapter(root).listArtifacts(0, 2).map(r => r.path);
  assert.deepEqual(out, [parent, child]);
});
