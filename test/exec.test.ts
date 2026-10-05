import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearExeCache, findExe, resolveExe } from '../src/git/git';

const win = process.platform === 'win32';

function mk(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exec-'));
}

/** A fake tool file; executable on POSIX. */
function plant(dir: string, file: string): string {
  const f = path.join(dir, file);
  fs.writeFileSync(f, win ? 'MZ' : '#!/bin/sh\necho planted\n');
  if (!win) fs.chmodSync(f, 0o755);
  return f;
}

test('findExe never picks a tool planted in the current directory', t => {
  const cwd = mk();
  const bin = mk();
  const prev = process.cwd();
  t.after(() => {
    process.chdir(prev);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  for (const f of win ? ['git.exe', 'git.cmd', 'git.com', 'git'] : ['git']) plant(cwd, f);
  process.chdir(cwd);
  const sep = win ? ';' : ':';
  // Empty, '.', relative and (Windows) drive-relative entries are all ignored, even though they reach the planted file.
  const rel = path.relative(path.dirname(cwd), cwd);
  const junk = ['', '.', rel, `.${path.sep}`, ...(win ? [cwd.slice(2), cwd.slice(0, 2) + rel] : [])];
  assert.equal(findExe('git', junk.join(sep)), undefined);
  // The absolute PATH entry wins and the planted cwd copy is never returned.
  const real = plant(bin, win ? 'git.exe' : 'git');
  assert.equal(findExe('git', [...junk, bin].join(sep)), real);
  assert.equal(findExe('git', ''), undefined);
  assert.equal(findExe('git', undefined), undefined);
});

test('findExe on Windows skips .cmd / .bat (execFile cannot run them without a shell)', { skip: !win }, t => {
  const bin = mk();
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  plant(bin, 'gh.cmd');
  plant(bin, 'gh.bat');
  assert.equal(findExe('gh', bin), undefined);
  const exe = plant(bin, 'gh.exe');
  assert.equal(findExe('gh', `"${bin}"`), exe);
});

test('findExe rejects names that are paths or carry separators', () => {
  for (const n of ['', '../git', 'a/git', 'a\\git', '.git', 'C:git']) assert.equal(findExe(n, os.tmpdir()), undefined, n);
});

test('resolveExe returns an absolute path for git and caches it', () => {
  clearExeCache();
  const g = resolveExe('git');
  assert.ok(g && path.isAbsolute(g), String(g));
  assert.equal(resolveExe('git'), g);
  assert.equal(resolveExe('definitely-not-a-tool-xyz'), undefined);
});

test('findExe resolves an npm .cmd shim to the native exe of a known package (Windows)', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-npm-'));
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\n');
  assert.equal(findExe('codex', bin, 'win32'), undefined, 'shim alone is never run');
  const dir = path.join(bin, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  assert.equal(findExe('codex', bin, 'win32'), path.win32.join(bin, 'node_modules', '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'));
  assert.equal(findExe('gh', bin, 'win32'), undefined, 'only listed packages');
});
