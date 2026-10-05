import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveExe } from '../git/git';

export interface InstalledVersion {
  version?: string;
  binary?: string;
  source: string;
}

/** The only executables the versions probe may start (basename, case-insensitive, optional .exe). */
export const PROBE_ALLOW = new Set(['claude', 'codex', 'git', 'gh', 'glab', 'node']);

/** True when `bin` (bare name or absolute path) names an allow-listed executable. Shims (.cmd / .bat / .ps1) are refused. */
export function probeAllowed(bin: string): boolean {
  const base = path.basename(bin.replace(/\\/g, '/')).toLowerCase();
  const name = base.endsWith('.exe') ? base.slice(0, -4) : base;
  return PROBE_ALLOW.has(name);
}

function run(bin: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    if (!probeAllowed(bin)) return resolve(undefined);
    // Minimal env: no tokens forwarded to the provider binary.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
    // No shell; a bare name is resolved on absolute PATH entries only, never in the current directory.
    const exe = path.isAbsolute(bin) ? bin : resolveExe(bin);
    if (!exe || !probeAllowed(exe)) return resolve(undefined);
    execFile(exe, args, { timeout: 8000, windowsHide: true, env }, (err, out) => resolve(err ? undefined : String(out).trim()));
  });
}

/** `claude --version` → "2.1.289 (Claude Code)". */
export async function claudeInstalled(): Promise<InstalledVersion> {
  const out = await run('claude', ['--version']);
  const v = out && /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  return v ? { version: v, binary: 'claude (PATH)', source: 'claude --version' } : { source: 'claude CLI not found on PATH' };
}

/** Codex CLI on PATH, else the binary bundled with Codex Desktop (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe). */
export async function codexInstalled(): Promise<InstalledVersion> {
  const candidates: string[] = ['codex'];
  const bundle = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const exes = fs.readdirSync(bundle).map(d => path.join(bundle, d, process.platform === 'win32' ? 'codex.exe' : 'codex')).filter(p => fs.existsSync(p));
    exes.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...exes);
  } catch {
    /* no desktop bundle */
  }
  for (const c of candidates) {
    const out = await run(c, ['--version']);
    const v = out && /(\d+\.\d+\.\d+[\w.\-]*)/.exec(out)?.[1];
    if (v) return { version: v, binary: c === 'codex' ? 'codex (PATH)' : 'Codex Desktop bundled CLI', source: 'codex --version' };
  }
  return { source: 'codex CLI not found (PATH or Codex Desktop bundle)' };
}
