import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { readNewLines } from '../src/util/jsonl';
import { bounded, redact, safeEnv } from '../src/util/redact';
import { deriveStatus, isVerificationCommand, commandText, commandLabel, isGitCommit, testLabel } from '../src/sessions/classify';
import { isInside, isPlausibleLocalPath } from '../src/util/paths';
import { tmpDir } from './helpers';

test('jsonl: incremental reads only new complete lines', () => {
  const d = tmpDir('jsonl');
  const f = path.join(d, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
  const r1 = readNewLines(f);
  assert.deepEqual(r1.lines, ['{"a":1}', '{"b":2}']);
  fs.appendFileSync(f, '3}\n');
  const r2 = readNewLines(f, r1.cursor);
  assert.deepEqual(r2.lines, ['{"c":3}']);
  assert.equal(r2.reset, false);
  const r3 = readNewLines(f, r2.cursor);
  assert.equal(r3.lines.length, 0);
  assert.equal(r3.bytesRead, 0);
});

test('jsonl: truncated or replaced file restarts from 0', () => {
  const d = tmpDir('jsonl');
  const f = path.join(d, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
  const r1 = readNewLines(f);
  fs.writeFileSync(f, '{"z":9}\n');
  const r2 = readNewLines(f, r1.cursor);
  assert.equal(r2.reset, true);
  assert.deepEqual(r2.lines, ['{"z":9}']);
});

test('jsonl: multibyte UTF-8 split across chunk boundary survives', () => {
  const d = tmpDir('jsonl');
  const f = path.join(d, 'u.jsonl');
  const big = 'é'.repeat((1 << 20) / 2 + 3);
  fs.writeFileSync(f, JSON.stringify({ s: big }) + '\n');
  const r = readNewLines(f);
  assert.equal(JSON.parse(r.lines[0]).s, big);
});

test('redact: tokens, auth headers, env assignments, URL credentials', () => {
  const s = redact('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123 curl -H "Authorization: Bearer abcdefghijklmnop123456" https://user:pa55w0rd@host/x sk-ant-api03-ABCDEFGHIJKLMNOP AWS AKIAABCDEFGHIJKLMNOP --password hunter2');
  for (const leak of ['ghp_abcdefghijklmnopqrstuvwxyz123', 'abcdefghijklmnop123456', 'pa55w0rd', 'sk-ant-api03-ABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP', 'hunter2']) assert.ok(!s.includes(leak), `leaked ${leak} in ${s}`);
  assert.ok(bounded('x'.repeat(500), 50).length <= 50);
});

test('safeEnv: only allow-listed variables, never a full snapshot', () => {
  const env = { USERPROFILE: 'C:\\u', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 'ghp', PATH: '/bin' };
  const out = safeEnv(env);
  assert.deepEqual(Object.keys(out), ['USERPROFILE']);
});

test('classify: verification commands by what runs, not by output text', () => {
  for (const c of ['npm test', 'npm run test:unit', 'pnpm build', 'pytest -q', 'python -m pytest', 'cargo test', 'go test ./...', 'node --test out/', 'npx tsc --noEmit', 'dotnet test']) assert.ok(isVerificationCommand(c), c);
  for (const c of ['echo tests passed', 'git status', 'cat test.txt', 'ls tests']) assert.ok(!isVerificationCommand(c), c);
  assert.equal(commandText(['powershell.exe', '-Command', 'npm test']), 'npm test');
  assert.equal(commandText(['bash', '-lc', 'pytest']), 'pytest');
  assert.ok(isGitCommit('git commit -m x') && isGitCommit('git -C repo commit') && !isGitCommit('git log'));
  assert.ok(!isVerificationCommand("python - <<'EOF'\nsubprocess.run('npm test')\nEOF"), 'heredoc body mentioning a runner is not a test');
  assert.ok(isVerificationCommand("printf 'x' > a.js\nnpm test && git commit -m x"), 'multi-line script running a test');
  assert.ok(isVerificationCommand('npm.cmd test'), 'Windows npm shim');
  assert.equal(testLabel("printf 'x' > a.js && npm test && git commit -m x"), 'npm test · in command chain');
  assert.equal(testLabel('cd "D:/x" && pytest -q'), 'pytest -q');
  assert.equal(testLabel('npm test 2>&1 | tail -n 5'), 'npm test 2>&1 | tail -n 5 · in command chain');
  assert.ok(isGitCommit('git -c safe.directory=C:/x add -A; git -c safe.directory=C:/x commit -m y'));
  assert.equal(commandLabel('cd "D:/PROJ/x" && npm test'), 'npm test');
  assert.equal(commandLabel('Set-Location D:\\x; pytest'), 'pytest');
});

test('status derivation is conservative', () => {
  const now = 1_000_000_000_000, idle = 600_000;
  assert.equal(deriveStatus({ registryAlive: true, registryStatus: 'busy', providerHasRegistry: true }, now, idle).status, 'RUNNING');
  assert.equal(deriveStatus({ registryAlive: true, registryStatus: 'idle', providerHasRegistry: true }, now, idle).status, 'IDLE');
  assert.equal(deriveStatus({ registryAlive: true, registryStatus: 'waiting_for_permission', providerHasRegistry: true }, now, idle).status, 'NEEDS_INPUT');
  assert.equal(deriveStatus({ registryAlive: true, registryStatus: 'weird', providerHasRegistry: true }, now, idle).status, 'UNKNOWN');
  assert.equal(deriveStatus({ providerHasRegistry: true, lastActivityAt: now - 3600_000 }, now, idle).status, 'ENDED');
  assert.equal(deriveStatus({ providerHasRegistry: true, lastActivityAt: now - 30_000 }, now, idle).status, 'UNKNOWN');
  assert.equal(deriveStatus({ openTurn: true, lastActivityAt: now - 60_000 }, now, idle).status, 'RUNNING');
  assert.equal(deriveStatus({ openTurn: true, lastActivityAt: now - 3600_000 }, now, idle).status, 'UNKNOWN');
  assert.equal(deriveStatus({ lastActivityAt: now - 60_000 }, now, idle).status, 'IDLE');
  assert.equal(deriveStatus({ lastActivityAt: now - 7200_000 }, now, idle).status, 'UNKNOWN', 'no end event → not ENDED');
  assert.equal(deriveStatus({ explicitEnded: true }, now, idle).status, 'ENDED');
});

test('paths: traversal and injected artifact paths are rejected', () => {
  const root = tmpDir('root');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'x.jsonl'), '{}\n');
  fs.mkdirSync(path.join(root, 'projects'));
  assert.equal(isInside(root, path.join(root, 'projects', '..', '..', path.basename(outside), 'x.jsonl')), false);
  assert.equal(isInside(root, path.join(outside, 'x.jsonl')), false);
  assert.equal(isInside(root, path.join(root, 'projects')), true);
  assert.equal(isPlausibleLocalPath('\\\\?\\C:\\x'), false);
  assert.equal(isPlausibleLocalPath('file:///etc/passwd'), false);
  assert.equal(isPlausibleLocalPath('relative/path'), false);
  assert.equal(isPlausibleLocalPath('a\0b'), false);
});
