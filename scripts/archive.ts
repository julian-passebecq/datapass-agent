// Daily durable archive: reads all local Claude Code and Codex history still on disk (subagents, Codex archived
// sessions, workflow runs) plus the plan files of the repositories agents used, and writes Agent's own archive
// (~/.agent/archive by default) so nothing disappears when the providers clean up their transcripts.
// No prompt or reply text is archived. Provider files are only read; writes go under the archive folder only.
//
// Run by hand:   npm run archive
// Options:       --out <dir>         archive folder (default: setting agent.archive.dir, else ~/.agent/archive)
//                --days <n>          days of provider history to scan (default 3650 = everything still on disk)
//                --max <n>           most session artifacts per provider (default 100000)
//                --no-git            skip git correlation (faster; commits are then not recorded)
//                --no-backlog        skip the plan-file snapshot
//                --raw               also gzip-copy transcripts / rollouts into raw/ (setting agent.archive.rawTranscripts)
//                --raw-max-gb <n>    cap for raw/ (setting agent.archive.rawMaxGB, default 5)
//                --settings <file>   VS Code settings.json to read agent.archive.* from (default: the user's Code settings)
//                --dry               compute and print, write nothing
// Daily at 03:17 with Windows Task Scheduler: scripts/install-archive-task.ps1 (see README).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, archiveDir, collectForArchive, copyRaw, rawSources, writeArchiveDay } from '../src/archive/archive';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** JSON with comments and trailing commas (VS Code settings.json), comments stripped outside strings. */
export function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function userSettings(): Record<string, unknown> {
  const explicit = arg('--settings');
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')]
      : process.platform === 'darwin'
        ? [path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')]
        : [path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json')];
  for (const f of candidates) {
    try {
      const o = parseJsonc(fs.readFileSync(f, 'utf8'));
      // Only agent.archive.* keys are kept: nothing else from the settings is read.
      return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k.startsWith('agent.archive.')));
    } catch {
      /* missing or unreadable: defaults */
    }
  }
  return {};
}

async function main() {
  const st = userSettings();
  const dir = archiveDir(arg('--out') ?? st['agent.archive.dir']);
  const days = Math.max(1, Number(arg('--days') ?? 3650) || 3650);
  const max = Math.max(10, Number(arg('--max') ?? 100_000) || 100_000);
  const git = !process.argv.includes('--no-git');
  const backlog = !process.argv.includes('--no-backlog');
  const dry = process.argv.includes('--dry');
  const raw = process.argv.includes('--raw') || st['agent.archive.rawTranscripts'] === true;
  const gb = Math.max(0.01, Number(arg('--raw-max-gb') ?? st['agent.archive.rawMaxGB'] ?? 5) || 5);
  const now = Date.now();
  console.log(`agent archive: scanning ${days} day(s) of local history${git ? ' with git' : ' without git'} → ${dir}${dry ? ' (dry run)' : ''}`);
  const release = dry ? () => undefined : acquireLock(dir, now);
  try {
    const c = await collectForArchive({ days, maxSessions: max, git, backlog, now });
    const r = writeArchiveDay(dir, { sessions: c.sessions, events: c.events, workflows: c.workflows, backlog: c.backlog, now }, dry);
    console.log(`agent archive: ${c.sessions.length} sessions read in ${(c.ms / 1000).toFixed(1)} s · day ${r.day}: ${r.written} written, ${r.unchanged} unchanged, ${r.kept} kept from earlier days (no longer on disk or outside the scan) · ${r.totalArchived} sessions archived in total`);
    console.log(`agent archive: ${r.workflows} workflow run(s) written · ${c.backlog ? `${r.backlogItems} backlog item(s) in ${c.backlog.files.length} plan file(s)` : 'backlog skipped'}`);
    if (raw && !dry) {
      const rr = await copyRaw(dir, rawSources(c), gb * 1024 ** 3, now);
      console.log(`agent archive: raw ${rr.copied} copied (${(rr.bytes / 1024 ** 2).toFixed(1)} MB gz), ${rr.skipped} unchanged, ${rr.refused} refused · raw/ holds ${(rr.totalBytes / 1024 ** 3).toFixed(2)} GB of ${gb} GB${rr.capped ? ' · CAP REACHED: raise agent.archive.rawMaxGB' : ''}`);
    } else if (raw) console.log('agent archive: raw copy skipped (dry run)');
    for (const d of c.diagnostics.slice(0, 5)) console.log(`agent archive: note: ${d}`);
  } finally {
    release();
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`agent archive: ${e?.message ?? e}`);
    process.exit(1);
  });
}
