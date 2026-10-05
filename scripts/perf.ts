// Performance probe of the session store (no VS Code). Read-only on provider files: it never writes under ~/.claude or ~/.codex.
// Usage: npm run perf [-- --synthetic] [--days N] [--no-git] [--git-only] [--json out.json]
//   default     : the real local history (ClaudeAdapter/CodexAdapter default roots), git off then git on
//   --synthetic : a generated fixture in the temp dir (100 sessions + one ~12 MB log, 4 git repos)
// Passes: cold = first refresh; idle = immediate second refresh; idle+1m = refresh with the store clock moved 61 s
// (nothing changed on disk); incr = refresh after one appended line (synthetic fixture) or after a 3 s wait (real history).
// longest = longest event-loop block during the pass (perf_hooks event-loop delay max): how long the extension host
// could not answer a click. firstEmit = time until the store first notified views (sessions visible).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { monitorEventLoopDelay } from 'perf_hooks';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore, RefreshStats } from '../src/sessions/store';
import { clearGitCache, gitStats } from '../src/git/git';

interface Row {
  label: string;
  ms: number;
  gitMs: number;
  spawns: number;
  bytes: number;
  ingested: number;
  longestMs: number;
  firstEmitMs?: number;
  emits: number;
  rssMB: number;
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);

async function pass(store: SessionStore, label: string): Promise<Row> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  const spawns0 = gitStats.calls;
  let emits = 0;
  let firstEmitMs: number | undefined;
  const t0 = performance.now();
  const sub = store.onDidChange(() => {
    emits++;
    if (firstEmitMs === undefined) firstEmitMs = Math.round(performance.now() - t0);
  });
  h.enable();
  const st: RefreshStats = await store.refresh();
  h.disable();
  sub.dispose();
  return {
    label,
    ms: st.ms,
    gitMs: st.gitMs,
    spawns: gitStats.calls - spawns0,
    bytes: st.bytesRead,
    ingested: st.ingested,
    longestMs: Math.round(h.max / 1e6),
    firstEmitMs,
    emits,
    rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
}

function claudeLine(sid: string, i: number, t0: number, cwd: string): string {
  return JSON.stringify({ type: 'assistant', uuid: `${sid}-${i}`, timestamp: new Date(t0 + i * 1000).toISOString(), sessionId: sid, version: '2.1.289', cwd, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }, { type: 'text', text: 'x'.repeat(200) }] } });
}

function gitFixture(cwd: string, a: string[], at: number): void {
  const d = new Date(at).toISOString();
  execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
}

/** Generated history in the temp dir, with the provider roots and an `append` for the incremental pass. */
function synthetic(): { claude: string; codex: string; append: () => void; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-perf-'));
  const proj = path.join(home, 'claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const t0 = Date.now() - 3600_000;
  const repos: string[] = [];
  for (let r = 0; r < 4; r++) {
    const repo = path.join(home, `repo${r}`);
    fs.mkdirSync(repo);
    try {
      gitFixture(repo, ['init', '-q', '-b', 'main'], t0 - 7200_000);
      for (let c = 0; c < 5; c++) {
        fs.writeFileSync(path.join(repo, `f${c}.txt`), `v${c}\n`);
        gitFixture(repo, ['add', '-A'], t0 + c * 600_000);
        gitFixture(repo, ['commit', '-q', '-m', `c${c}`], t0 + c * 600_000);
      }
    } catch {
      /* git missing: sessions keep a plain cwd */
    }
    repos.push(repo);
  }
  for (let s = 0; s < 100; s++) {
    const sid = `00000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), Array.from({ length: 200 }, (_, i) => claudeLine(sid, i, t0, repos[s % repos.length])).join('\n') + '\n');
  }
  const bigSid = '99999999-0000-4000-8000-000000000000';
  const big = path.join(proj, `${bigSid}.jsonl`);
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 25_000; i++) fs.writeSync(fd, claudeLine(bigSid, i, t0, repos[0]) + '\n');
  fs.closeSync(fd);
  let n = 25_000;
  return {
    claude: path.join(home, 'claude'),
    codex: path.join(home, 'codex'),
    append: () => fs.appendFileSync(big, claudeLine(bigSid, ++n, t0, repos[0]) + '\n'),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

async function run(git: boolean, fx: ReturnType<typeof synthetic> | undefined, days: number): Promise<Row[]> {
  clearGitCache();
  let offset = 0;
  const adapters = fx ? [new ClaudeAdapter(fx.claude), new CodexAdapter(fx.codex)] : [new ClaudeAdapter(), new CodexAdapter()];
  const store = new SessionStore(adapters, { historyDays: days, maxSessions: 500, idleMinutes: 10, git }, () => Date.now() + offset);
  const tag = git ? 'git on ' : 'git off';
  const rows = [await pass(store, `${tag} cold`), await pass(store, `${tag} idle`)];
  offset += 61_000;
  rows.push(await pass(store, `${tag} idle+1m`));
  if (fx) fx.append();
  else await new Promise(r => setTimeout(r, 3000));
  rows.push(await pass(store, `${tag} incr${fx ? '' : ' (3 s)'}`));
  rows[0].label += ` (${store.all().length} sessions)`;
  store.dispose();
  return rows;
}

function table(rows: Row[]): string {
  const cols: [string, (r: Row) => string | number][] = [
    ['pass', r => r.label],
    ['ms', r => r.ms],
    ['firstEmit', r => r.firstEmitMs ?? '-'],
    ['gitMs', r => r.gitMs],
    ['spawns', r => r.spawns],
    ['ingested', r => r.ingested],
    ['read', r => (r.bytes > 1e6 ? `${(r.bytes / 1e6).toFixed(1)} MB` : `${r.bytes} B`)],
    ['longest', r => `${r.longestMs} ms`],
    ['emits', r => r.emits],
    ['rss', r => `${r.rssMB} MB`],
  ];
  const cells = [cols.map(c => c[0]), ...rows.map(r => cols.map(c => String(c[1](r))))];
  const w = cols.map((_, i) => Math.max(...cells.map(r => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(cells[0]), w.map(n => '-'.repeat(n)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

async function main(): Promise<void> {
  const days = Number(opt('--days') ?? 3);
  const fx = flag('--synthetic') ? synthetic() : undefined;
  const rows: Row[] = [];
  try {
    if (!flag('--git-only')) rows.push(...(await run(false, fx, days)));
    if (!flag('--no-git')) rows.push(...(await run(true, fx, days)));
  } finally {
    fx?.cleanup();
  }
  console.log(`agent perf · ${fx ? 'synthetic fixture' : 'real local history'} · ${days} day(s) · node ${process.version}`);
  console.log(table(rows));
  const out = opt('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
