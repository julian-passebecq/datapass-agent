// Weekly history rollups: reads all local Claude Code and Codex history (Codex archived sessions included)
// and merges it into ~/.agent/history/YYYY-Www.json plus a markdown audit report YYYY-Www.md per week.
// Counts, tokens, repositories, models and outcomes only: no prompt, title or command text. Local only.
//
// Run by hand:   npm run compile-tests && node out-test/scripts/weekly.js
// Options:       --out <dir>   archive folder (default ~/.agent/history)
//                --days <n>    days of provider history to scan (default 3650 = everything still on disk)
//                --no-git      skip git correlation (faster; commits are then not counted)
//                --max <n>     most session artifacts per provider (default 100000)
//                --dry         compute and print, write nothing
// Windows Task Scheduler (every Monday 08:00, from this checkout):
//   schtasks /Create /SC WEEKLY /D MON /ST 08:00 /TN "Agent weekly history" /TR "node <checkout>\out-test\scripts\weekly.js"
import { collectAll, defaultHistoryDir, historyDir, writeArchive } from '../src/feeds/history';
import { weekId } from '../src/activity/history';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = historyDir(arg('--out') ?? defaultHistoryDir());
  const days = Math.max(1, Number(arg('--days') ?? 3650) || 3650);
  const max = Math.max(10, Number(arg('--max') ?? 100_000) || 100_000);
  const git = !process.argv.includes('--no-git');
  const dry = process.argv.includes('--dry');
  console.log(`agent weekly: scanning ${days} day(s) of local history${git ? ' with git' : ' without git'}…`);
  const { sessions, ms } = await collectAll({ days, maxSessions: max, git });
  const now = Date.now();
  const r = writeArchive(dir, sessions, { by: 'script', git, days }, now, dry);
  console.log(`agent weekly: ${sessions.length} sessions read in ${(ms / 1000).toFixed(1)} s → ${r.weeks.length} week(s), ${r.rows} rows (${r.kept} kept from earlier runs)`);
  console.log(`agent weekly: ${dry ? 'dry run, nothing written' : `wrote ${dir}`} · weeks ${r.weeks[0] ?? '-'} … ${r.weeks[r.weeks.length - 1] ?? '-'} · current ${weekId(now)}`);
}

main().catch(e => {
  console.error(`agent weekly: ${e?.message ?? e}`);
  process.exit(1);
});
