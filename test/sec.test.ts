import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { acquireLock } from '../src/archive/archive';
import { maybeWarnRaw, RAW_WARNED_KEY } from '../src/archive/rawWarning';
import { probeAllowed } from '../src/providers/versions';
import { DbCopies, sweepCodexCopies } from '../src/providers/codex/state';
import { tmpDir } from './helpers';

test('raw archive warning shows once, only when the setting is on', () => {
  const mem = new Map<string, unknown>();
  const state = { get: <T>(k: string) => mem.get(k) as T | undefined, update: (k: string, v: unknown) => void mem.set(k, v) };
  const shown: string[] = [];
  let on = false;
  const d = { enabled: () => on, state, show: (m: string) => void shown.push(m) };
  assert.equal(maybeWarnRaw(d), false);
  on = true;
  assert.equal(maybeWarnRaw(d), true);
  assert.equal(maybeWarnRaw(d), false, 'second time: silent');
  assert.equal(shown.length, 1);
  assert.match(shown[0], /NOT redacted/);
  assert.equal(mem.get(RAW_WARNED_KEY), true);
});

test('archive lock: atomic create, stale takeover by mtime, token-checked release', () => {
  const dir = tmpDir('lock');
  const lock = path.join(dir, '.lock');
  const release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /another archive run/);
  // A stale lock (mtime 31 min ago) is taken over.
  const old = new Date(Date.now() - 31 * 60_000);
  fs.utimesSync(lock, old, old);
  const r2 = acquireLock(dir);
  // The first run's release must not delete the second run's lock.
  release();
  assert.ok(fs.existsSync(lock), 'foreign lock kept');
  assert.throws(() => acquireLock(dir), /another archive run/);
  r2();
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('stale')), [], 'no renamed leftovers');
  // Two runs that both judged the lock stale: the second one finds a fresh lock after the first took over.
  fs.writeFileSync(lock, 'x');
  fs.utimesSync(lock, old, old);
  const a = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /another archive run/);
  a();
});

test('versions probe runs only allow-listed executables', () => {
  for (const ok of ['claude', 'codex', 'git', 'gh', 'glab', 'node', 'C:\\Program Files\\nodejs\\node.exe', '/usr/bin/git', 'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\abc\\codex.exe', 'Codex.EXE']) assert.ok(probeAllowed(ok), ok);
  for (const bad of ['powershell', 'cmd.exe', 'claude.cmd', 'codex.ps1', 'C:\\tmp\\evil.exe', 'C:\\tmp\\git.bat', 'nodex', 'sh']) assert.equal(probeAllowed(bad), false, bad);
});

test('codex sqlite copies: own folder removed on dispose, stale leftovers swept on start', () => {
  const tmp = tmpDir('codexsweep');
  const base = path.join(tmp, 'agent-codex');
  const mk = (dir: string, ageMs: number) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'state_5.sqlite');
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
    fs.utimesSync(dir, t, t);
  };
  const H = 3600_000;
  mk(path.join(base, '111'), 2 * H); // crashed run: swept
  mk(path.join(base, '222'), 60_000); // live other window: kept
  mk(path.join(base, '999'), 2 * H); // this process: kept
  mk(path.join(tmp, 'agent-codex-333'), 2 * H); // legacy layout: swept
  mk(path.join(tmp, 'other-tool-444'), 2 * H); // not Agent's: kept
  fs.writeFileSync(path.join(base, 'notes.txt'), 'x'); // not a pid folder: kept
  const removed = sweepCodexCopies({ base, tmp, pid: 999 }).map(p => path.basename(p)).sort();
  assert.deepEqual(removed, ['111', 'agent-codex-333']);
  for (const keep of [path.join(base, '222'), path.join(base, '999'), path.join(tmp, 'other-tool-444'), path.join(base, 'notes.txt')]) assert.ok(fs.existsSync(keep), keep);

  const c = new DbCopies(path.join(base, '555'));
  fs.mkdirSync(c.dir, { recursive: true });
  fs.writeFileSync(path.join(c.dir, 'state_5.sqlite'), 'x');
  c.dispose();
  assert.ok(!fs.existsSync(c.dir));
});
