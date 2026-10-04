// Live qualification observer: polls the real providers and records every status transition of sessions whose cwd is
// under <root>, then writes a redacted snapshot. Usage: node out-test/scripts/qualify.js <root> <out.json> [timeoutSec]
import * as fs from 'fs';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';

async function main() {
  const [root, out, timeoutArg] = process.argv.slice(2);
  const deadline = Date.now() + Number(timeoutArg ?? 900) * 1000;
  const store = new SessionStore([new ClaudeAdapter(), new CodexAdapter()], { historyDays: 1, maxSessions: 400, idleMinutes: 10, git: true });
  const norm = (p?: string) => (p ?? '').replace(/\//g, '\\').toLowerCase();
  const mine = () => store.all().filter(s => norm(s.cwd).startsWith(norm(root)));
  const last = new Map<string, string>();
  const transitions: { at: string; key: string; provider: string; status: string; reason: string; ms?: number }[] = [];
  const seenAt = new Map<string, number>();
  const t0 = Date.now();
  let quietSince = 0;
  while (Date.now() < deadline) {
    const st = await store.refresh();
    for (const s of mine()) {
      if (!seenAt.has(s.key)) seenAt.set(s.key, Date.now());
      const sig = s.status;
      if (last.get(s.key) !== sig) {
        last.set(s.key, sig);
        transitions.push({ at: new Date().toISOString(), key: s.key, provider: s.provider, status: s.status, reason: s.statusReason, ms: st.ms });
        console.log(`${new Date().toISOString().slice(11, 19)} ${s.provider} ${s.sessionId.slice(0, 8)} → ${s.status} (${s.statusReason}) refresh=${st.ms}ms`);
      }
    }
    const sessions = mine().filter(s => !s.isWorker);
    const done = sessions.length >= 2 && sessions.every(s => s.status === 'ENDED');
    if (done) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince > 5000) break;
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  const sessions = mine();
  const snap = sessions.map(s => ({
    provider: s.provider, sessionId: s.sessionId, providerVersion: s.providerVersion, model: s.model, effort: s.effort, title: s.title,
    status: s.status, statusReason: s.statusReason, startedAt: s.startedAt && new Date(s.startedAt).toISOString(), endedAt: s.endedAt && new Date(s.endedAt).toISOString(),
    cwd: s.cwd, repository: s.repository, worktree: s.worktree, isLinkedWorktree: s.isLinkedWorktree, branch: s.branch, headBefore: s.headBefore, headAfter: s.headAfter,
    commits: s.commits, changedFiles: s.changedFiles, linesAdded: s.linesAdded, linesRemoved: s.linesRemoved, tests: s.tests, isWorker: s.isWorker, parentSessionId: s.parentSessionId,
    counts: s.counts, evidence: s.evidence, firstSeenAfterMs: (seenAt.get(s.key) ?? t0) - t0,
    timeline: store.timeline(s.key).map(e => ({ at: new Date(e.at).toISOString(), type: e.type, label: e.label, kind: e.kind })),
  }));
  fs.writeFileSync(out, JSON.stringify({ root, transitions, sessions: snap, providers: store.providerStates }, null, 2));
  console.log(`wrote ${out}: ${snap.length} sessions`);
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
