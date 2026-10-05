// Synthetic Claude Code / Codex home for the installed-VSIX smoke on machines without any agent history (CI runners).
// Copies test/fixtures/claude and test/fixtures/codex into <dir>/.claude and <dir>/.codex, fills the fixture
// placeholders, shifts every recorded time so the newest record is `newestAgoMin` minutes old (the open Codex turn
// then reads as live), renames the dated Codex day folders / rollout files to match, and sets each file's mtime to its
// last record. Token-shaped strings from the redaction fixtures are replaced: the synthetic home holds no secrets.
// Usage (standalone): node scripts/smoke-fixture.mjs <dir>  — prints the env the smoke passes to VS Code.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const here = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const root = path.resolve(path.dirname(here), '..');
const FIXTURES = path.join(root, 'test', 'fixtures');
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const EPOCH = /("[a-z_]*_at"\s*:\s*)(\d{10})\b/g;
const FILE_STAMP = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;
const SECRETS = [/sk-ant-[A-Za-z0-9_-]+/g, /gh[pousr]_[A-Za-z0-9]+/g, /(?<=Bearer )[A-Za-z0-9._~+/-]+=*/g];

const jpath = p => JSON.stringify(p).slice(1, -1);
const pad = n => String(n).padStart(2, '0');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

function stamps(txt) {
  const all = [...txt.matchAll(ISO)].map(m => Date.parse(m[0]));
  for (const m of txt.matchAll(EPOCH)) all.push(+m[2] * 1000);
  return all.filter(Number.isFinite);
}

/**
 * Builds (or rebuilds) the synthetic home under `dir` and returns the env overrides for the VS Code process.
 * Only <dir>/.claude and <dir>/.codex are replaced, so the extension's own ~/.agent state survives a rebuild.
 */
export function buildFixtureHome(dir, { cwd = root, newestAgoMin = 1, now = Date.now() } = {}) {
  let head = '0'.repeat(40);
  try { head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || head; } catch { /* not a repo */ }
  const vars = { __CWD__: jpath(cwd), __HEAD__: head, __MISSING__: jpath(path.join(dir, 'deleted-worktree')) };
  const sources = [['claude', '.claude'], ['codex', '.codex']].map(([src, dst]) => ({ src: path.join(FIXTURES, src), dst: path.join(dir, dst) }));
  let newest = 0;
  for (const { src } of sources) for (const f of files(src)) newest = Math.max(newest, ...stamps(fs.readFileSync(f, 'utf8')));
  if (!newest) throw new Error('fixture has no timestamps');
  const shift = now - newestAgoMin * 60_000 - newest;
  const shiftIso = s => new Date(Date.parse(s) + shift).toISOString().replace(/\.\d{3}Z$/, m => (s.includes('.') ? m : 'Z'));
  const written = [];
  for (const { src, dst } of sources) {
    fs.rmSync(dst, { recursive: true, force: true });
    for (const f of files(src)) {
      let txt = fs.readFileSync(f, 'utf8');
      for (const [k, v] of Object.entries(vars)) txt = txt.split(k).join(v);
      for (const re of SECRETS) txt = txt.replace(re, 'FIXTURE-PLACEHOLDER');
      txt = txt.replace(ISO, shiftIso).replace(EPOCH, (_, k, n) => k + Math.round(+n + shift / 1000));
      // Dated names: sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<id>.jsonl follow the shifted start time.
      let rel = path.relative(src, f);
      const m = FILE_STAMP.exec(path.basename(rel));
      if (m) {
        const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + shift);
        const stamp = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}-${pad(t.getUTCMinutes())}-${pad(t.getUTCSeconds())}`;
        const name = path.basename(rel).replace(FILE_STAMP, stamp);
        const parts = path.dirname(rel).split(path.sep);
        rel = parts[0] === 'sessions' && parts.length === 4
          ? path.join('sessions', String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()), name)
          : path.join(path.dirname(rel), name);
      }
      const out = path.join(dst, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, txt);
      written.push([out, Math.max(0, ...stamps(txt)) || now - newestAgoMin * 60_000]);
    }
  }
  for (const [p, ms] of written) fs.utimesSync(p, new Date(ms), new Date(ms));
  return {
    USERPROFILE: dir,
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
    CODEX_HOME: path.join(dir, '.codex'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here)) {
  const dir = path.resolve(process.argv[2] ?? path.join(root, '.smoke', 'fixture-home'));
  fs.mkdirSync(dir, { recursive: true });
  console.log(JSON.stringify(buildFixtureHome(dir), null, 2));
}
