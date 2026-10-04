import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

export function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-test-${tag}-`));
}

export function git(cwd: string, args: string[], date?: string): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' } as NodeJS.ProcessEnv;
  if (date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = date;
  return execFileSync('git', args, { cwd, env, windowsHide: true }).toString().trim();
}

/** Repo with commits at 08:00 (before), 09:25 (Claude window), 10:10 (Codex window) on 2026-10-04 UTC. */
export function makeRepo(): { repo: string; shas: string[] } {
  const repo = tmpDir('repo');
  git(repo, ['init', '-q', '-b', 'main']);
  const shas: string[] = [];
  for (const [i, when] of ['2026-10-04T08:00:00Z', '2026-10-04T09:25:00Z', '2026-10-04T10:10:00Z'].entries()) {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', `f${i}.ts`), `export const v = ${i};\n`.repeat(i + 1));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', `commit ${i}`], when);
    shas.push(git(repo, ['rev-parse', 'HEAD']));
  }
  return { repo, shas };
}

/** Copy a fixture tree, substituting placeholders. */
export function materialize(src: string, dst: string, vars: Record<string, string>): void {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      materialize(s, d, vars);
    } else {
      let txt = fs.readFileSync(s, 'utf8');
      for (const [k, v] of Object.entries(vars)) txt = txt.split(k).join(v);
      fs.writeFileSync(d, txt);
    }
  }
}

/** JSON-string-escaped path (backslashes doubled) for substitution inside JSON fixtures. */
export function jpath(p: string): string {
  return JSON.stringify(p).slice(1, -1);
}

export function snapshotTree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        m.set(p, `${st.size}:${st.mtimeMs}:${require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
      }
    }
  };
  walk(root);
  return m;
}

export const T = (iso: string) => Date.parse(iso);
