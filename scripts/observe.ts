// Headless observation of the real providers on this machine (no VS Code). Prints bounded, redacted facts only.
// Usage: node out-test/scripts/observe.js [historyDays] [--json out.json]
import * as fs from 'fs';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { summarize, duration } from '../src/activity/activity';
import { gitStats } from '../src/git/git';

async function main() {
  const days = Number(process.argv[2] ?? 1);
  const jsonOut = process.argv.indexOf('--json') > 0 ? process.argv[process.argv.indexOf('--json') + 1] : undefined;
  const mem0 = process.memoryUsage().rss;
  const store = new SessionStore([new ClaudeAdapter(), new CodexAdapter()], { historyDays: days, maxSessions: 300, idleMinutes: 10, git: true });
  const cold = await store.refresh();
  const coldGit = JSON.stringify({ calls: gitStats.calls, ms: Math.round(gitStats.ms), byCmd: gitStats.byCmd });
  const warm = await store.refresh();
  console.log('git', coldGit);
  const now = Date.now();
  const all = store.all();
  console.log('providers', JSON.stringify(store.providerStates.map(p => ({ p: p.provider, detected: p.detected, version: p.version, n: p.artifactsScanned }))));
  console.log('cold', JSON.stringify(cold), 'warm', JSON.stringify(warm), 'rssMB', Math.round((process.memoryUsage().rss - mem0) / 1e6));
  console.log('summary', JSON.stringify(summarize(all, now)), 'sessions', all.length, 'workers', all.filter(s => s.isWorker).length);
  for (const s of all.filter(s => !s.isWorker).slice(0, 12)) {
    const kids = store.children(s.key).length;
    console.log(`${s.provider.padEnd(6)} ${s.status.padEnd(11)} ${s.sessionId.slice(0, 8)} v${s.providerVersion ?? '?'} ${s.model ?? '?'}/${s.effort ?? '?'} repo=${s.repository?.split(/[\\/]/).pop() ?? '-'} wt=${s.isLinkedWorktree ? 'linked' : 'main'} br=${s.branch ?? '-'} dur=${duration((s.lastActivityAt ?? 0) - (s.startedAt ?? 0))} files=${s.changedFiles.length} commits=${s.commits.length} tests=${s.tests.map(t => t.outcome[0]).join('')} workers=${kids} reason="${s.statusReason}"`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ cold, warm, providers: store.providerStates, summary: summarize(all, now), sessions: all.length }, null, 2));
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
