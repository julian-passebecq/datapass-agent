// Weekly model benchmarks snapshot: writes ~/.agent/benchmarks/YYYY-Www.json (current ISO week, local time) from
//  - "Local workload": Agent's own dispatch analytics over the last --local-days days (DERIVED; no network),
//  - manual files ~/.agent/benchmarks/manual/*.json (numbers you copied from a leaderboard yourself),
//  - public leaderboards, ONLY with --fetch (opt-in network, one HTTPS GET per source, parsers in src/activity/benchmarks.ts).
// Rerunning in the same week replaces the rows of the sources refreshed by that run and keeps the others; older
// weeks are never touched or deleted. Writes go to the benchmarks folder only (temp file + rename).
//
// Run by hand:   npm run benchmarks                (local + manual)
//                npm run benchmarks -- --fetch     (also the public sources)
// Options:       --out <dir>          folder (default: setting agent.benchmarks.dir, else ~/.agent/benchmarks)
//                --fetch              fetch public sources (all, or --source <id>[,<id>])
//                --local-days <n>     window of the local workload benchmark (default 7)
//                --no-local           skip the local workload benchmark
//                --no-git             skip git correlation (faster; commits then do not count as verification)
//                --settings <file>    VS Code settings.json to read agent.dispatch.pricePerMTok / agent.benchmarks.dir from
//                --dry                compute and print, write nothing
// Weekly with the existing archive task: see README "Model benchmarks".
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BenchRow, BenchSource, localRows, localSource, PARSERS } from '../src/activity/benchmarks';
import { buildDispatches } from '../src/activity/dispatch';
import { weekId } from '../src/activity/history';
import { benchDir, fetchText, readManual, writeWeek } from '../src/feeds/benchmarks';
import { parseJsonc } from './archive';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Only the two settings this script uses are kept from the user's VS Code settings. */
function userSettings(): Record<string, unknown> {
  const explicit = arg('--settings');
  const f = explicit
    ? explicit
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')
        : path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');
  try {
    const o = parseJsonc(fs.readFileSync(f, 'utf8')) ?? {};
    return Object.fromEntries(Object.entries(o).filter(([k]) => k === 'agent.dispatch.pricePerMTok' || k === 'agent.benchmarks.dir'));
  } catch {
    return {};
  }
}

async function main() {
  const st = userSettings();
  const dir = benchDir(arg('--out') ?? st['agent.benchmarks.dir']);
  const now = Date.now();
  const week = weekId(now);
  const dry = process.argv.includes('--dry');
  const updates: { source: BenchSource; rows: BenchRow[] }[] = [];
  const log = (s: string) => console.log(`agent benchmarks: ${s}`);
  log(`week ${week} → ${dir}${dry ? ' (dry run)' : ''}`);

  if (!process.argv.includes('--no-local')) {
    const days = Math.min(365, Math.max(1, Number(arg('--local-days') ?? 7) || 7));
    const git = !process.argv.includes('--no-git');
    const { collectForArchive } = await import('../src/archive/archive');
    const c = await collectForArchive({ days: days + 1, maxSessions: 100_000, git, backlog: false, now });
    const all = buildDispatches(c.sessions, { runs: c.workflows, background: [], scannedAt: now, scanMs: 0, diagnostics: [] }, now);
    const ds = all.filter(d => !d.live && (d.dispatchedAt ?? d.end ?? 0) >= now - days * 86400_000);
    const pr = st['agent.dispatch.pricePerMTok'];
    const prices = pr && typeof pr === 'object' && !Array.isArray(pr) ? (pr as Record<string, unknown>) : {};
    const rows = localRows(ds, prices);
    updates.push({ source: localSource(now, days, rows.some(r => r.costPerTask !== undefined)), rows });
    log(`local workload: ${ds.length} finished dispatch(es) in ${days} day(s) → ${rows.length} model row(s)${Object.keys(prices).length ? '' : ' (no agent.dispatch.pricePerMTok: no cost)'}`);
  }

  const manual = readManual(dir);
  updates.push(...manual.updates);
  log(`manual: ${manual.updates.length} file(s), ${manual.updates.reduce((n, u) => n + u.rows.length, 0)} row(s)`);
  for (const e of manual.errors) log(`manual ${e.file}: ${e.error}`);

  if (process.argv.includes('--fetch')) {
    const only = arg('--source')?.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of Object.values(PARSERS)) {
      if (only && !only.includes(p.id)) continue;
      try {
        const text = await fetchText(p.url);
        const rows = p.parse(text);
        updates.push({ source: { id: p.id, name: p.name, kind: 'public', url: p.url, license: p.license, fetchedAt: Date.now(), metric: p.metric, costBasis: p.costBasis }, rows });
        log(`${p.id}: ${rows.length} row(s) from ${p.url}`);
      } catch (e: any) {
        log(`${p.id}: fetch failed, earlier rows of this week kept (${String(e?.message ?? e).slice(0, 160)})`);
      }
    }
  } else log('public sources: skipped (add --fetch to download them)');

  // Manual sources removed from manual/ since the last run of this week are dropped from this week only.
  const r = writeWeek(dir, week, updates, now, ['manual'], dry);
  log(`${dry ? 'would write' : 'wrote'} ${r.file}: ${r.snapshot.sources.length} source(s), ${r.snapshot.rows.length} row(s)`);
}

if (require.main === module) {
  main().catch(e => {
    console.error(`agent benchmarks: ${e?.message ?? e}`);
    process.exit(1);
  });
}
