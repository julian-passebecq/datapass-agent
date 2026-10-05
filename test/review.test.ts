import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { applyGlabView, ghChecks, loadRepo, parseGhPrs, parseGlabMrs, parseRemotes, parseRemoteUrl, PrReport, Remote, Runner, safeUrl } from '../src/feeds/review';
import { commandMarks, matchPrs, parseCommand, reviewItems, unlinkedPrs } from '../src/activity/review';
import { reviewView } from '../src/render/extra/review';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import type { ActCtx } from '../src/render/extra/kit';
import { FIXTURES, T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const REPO = path.resolve('/work/agent');
const GH: Remote = { name: 'agent', forge: 'github', host: 'github.com', slug: 'acme/agent' };
const GL: Remote = { name: 'gitlab', forge: 'gitlab', host: 'gitlab.com', slug: 'group/proj' };
const fx = (f: string) => fs.readFileSync(path.join(FIXTURES, 'review', f), 'utf8');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 600_000, repository: REPO, cwd: REPO, ...p };
}
const ev = (key: string, label: string, at = NOW - 900_000): TimelineEvent => ({ at, type: 'PROCESS_ACTIVITY', label, provider: 'claude', sessionKey: key, kind: 'OBSERVED' });
const commit = (sha: string) => ({ sha, at: NOW - 1200_000, subject: 'feat', attribution: 'during-session' as const });

test('review: remote URLs and remotes', () => {
  assert.deepEqual(parseRemoteUrl('https://user:tok@github.com/acme/agent.git'), { forge: 'github', host: 'github.com', slug: 'acme/agent' });
  assert.deepEqual(parseRemoteUrl('git@gitlab.com:group/sub/proj.git'), { forge: 'gitlab', host: 'gitlab.com', slug: 'group/sub/proj' });
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.example.org:2222/team/app'), { forge: 'gitlab', host: 'gitlab.example.org', slug: 'team/app' });
  assert.equal(parseRemoteUrl('https://bitbucket.org/a/b.git'), undefined);
  assert.equal(parseRemoteUrl('https://github.com/a;rm -rf/b'), undefined);
  const rs = parseRemotes('agent\thttps://github.com/acme/agent.git (fetch)\nagent\thttps://github.com/acme/agent.git (push)\norigin\tgit@gitlab.com:group/proj.git (fetch)\nmirror\thttps://github.com/acme/agent (fetch)\nlocal\tD:/x (fetch)\n');
  assert.deepEqual(rs.map(r => `${r.name}:${r.forge}:${r.slug}`), ['origin:gitlab:group/proj', 'agent:github:acme/agent']);
  assert.equal(safeUrl('https://github.com/a/b/pull/1', 'github.com'), 'https://github.com/a/b/pull/1');
  assert.equal(safeUrl('https://evil.example/x', 'github.com'), undefined);
  assert.equal(safeUrl('javascript:alert(1)', 'github.com'), undefined);
});

test('review: gh pr list parsing (state, checks, review, mergeable, unsafe links)', () => {
  const prs = parseGhPrs(fx('gh-prs.json'), REPO, GH);
  assert.equal(prs.length, 5, 'entries without a number are dropped');
  const by = new Map(prs.map(p => [p.number, p]));
  assert.equal(by.get(12)!.ci, 'pass');
  assert.equal(by.get(12)!.mergeable, 'yes');
  assert.equal(by.get(11)!.ci, 'fail');
  assert.deepEqual(by.get(11)!.failing, ['build']);
  assert.equal(by.get(11)!.review, 'required');
  assert.equal(by.get(10)!.state, 'merged');
  assert.equal(by.get(10)!.ci, 'none');
  assert.equal(by.get(9)!.state, 'draft');
  assert.equal(by.get(9)!.ci, 'pending');
  assert.equal(by.get(9)!.mergeable, 'conflict');
  assert.equal(by.get(9)!.url, undefined, 'javascript: link dropped');
  assert.equal(by.get(8)!.url, undefined, 'link on another host dropped');
  assert.equal(parseGhPrs('not json', REPO, GH).length, 0);
  assert.deepEqual(ghChecks([{ name: 'a', status: 'QUEUED' }]).ci, 'pending');
});

test('review: glab mr list + view parsing', () => {
  const mrs = parseGlabMrs(fx('glab-mrs.json'), REPO, GL);
  assert.equal(mrs.length, 2);
  assert.equal(mrs[0].state, 'open');
  assert.equal(mrs[0].ci, 'pending', 'ci_still_running hints a running pipeline');
  assert.equal(mrs[0].mergeable, 'no');
  assert.equal(mrs[1].state, 'merged');
  applyGlabView(mrs[0], fx('glab-view.json'));
  assert.equal(mrs[0].ci, 'fail');
  assert.equal(mrs[0].mergeable, 'yes');
  assert.equal(mrs[0].url, 'https://gitlab.com/group/proj/-/merge_requests/288');
});

test('review: loadRepo runs only fixed read-only commands', async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push(`${cmd} ${args.filter(a => !a.startsWith('core.') && a !== '-c' && !a.includes('=')).join(' ')}`);
    if (cmd === 'git') return { ok: true, out: 'agent\thttps://github.com/acme/agent.git (fetch)\ngitlab\thttps://gitlab.com/group/proj.git (fetch)\n', err: '' };
    if (cmd === 'gh') return { ok: true, out: fx('gh-prs.json'), err: '' };
    if (args[1] === 'list') return { ok: true, out: fx('glab-mrs.json'), err: '' };
    return { ok: true, out: fx('glab-view.json'), err: '' };
  };
  const r = await loadRepo(REPO, run, 30);
  assert.equal(r.prs.length, 7);
  assert.equal(r.errors.length, 0);
  assert.ok(calls[0].startsWith('git '));
  assert.ok(calls.some(c => c.startsWith('gh pr list --repo acme/agent --state all')));
  assert.ok(calls.some(c => c.startsWith('glab mr list -R gitlab.com/group/proj --all -F json')));
  assert.equal(calls.filter(c => c.startsWith('glab mr view 288')).length, 1, 'one view per open MR only');
  for (const c of calls) assert.ok(!/\b(merge|create|approve|close|push|fetch|checkout)\b/.test(c.replace(/--json \S+/, '')), `read-only: ${c}`);
  const failing: Runner = async cmd => (cmd === 'git' ? { ok: true, out: 'agent\thttps://github.com/acme/agent.git (fetch)\n', err: '' } : { ok: false, out: '', err: 'gh: not logged in' });
  const r2 = await loadRepo(REPO, failing, 30);
  assert.deepEqual(r2.errors, ['gh (agent): gh: not logged in']);
});

test('review: recorded commands → push / PR create / merge marks', () => {
  const a = parseCommand('$ git push -u agent night/review && gh pr create --repo acme/agent --base main --head night/review --title "x"');
  assert.deepEqual(a.map(m => [m.kind, m.head, m.base ?? '', m.forge ?? '']), [['push', 'night/review', '', ''], ['pr-create', 'night/review', 'main', 'github']]);
  const b = parseCommand('$ glab mr create --source-branch=codex/release -b main --fill  → exit 1');
  assert.equal(b[0].kind, 'pr-create');
  assert.equal(b[0].head, 'codex/release');
  assert.equal(b[0].failed, true);
  assert.equal(parseCommand('$ gh pr merge 12 --squash')[0].number, 12);
  assert.equal(parseCommand('$ git push origin HEAD:refs/heads/feat/x')[0].head, 'feat/x');
  assert.equal(parseCommand('$ gh pr checks 12 --watch')[0].kind, 'ci-watch');
  assert.equal(parseCommand('$ npm test').length, 0);
  assert.equal(parseCommand('$ git push -q -o ci.skip gitlab HEAD:v4/nav 2>&1')[0].head, 'v4/nav', 'value flags and redirections skipped');
  assert.equal(parseCommand('$ gh pr create -R julian/agent-vscode --head x')[0].slug, 'julian/agent-vscode');
  const mg = parseCommand('$ gh pr merge 6 --repo acme/agent --squash --match-head-commit abc')[0];
  assert.deepEqual([mg.number, mg.slug], [6, 'acme/agent']);
  const marks = commandMarks([ev('claude:a', '$ git push origin feat'), ev('claude:a', '$ git status'), { ...ev('claude:a', 'Edit x'), type: 'FILE_CHANGE' }]);
  assert.equal(marks.get('claude:a')!.length, 1);
});

test('review: lanes from sessions, commands and PR state', () => {
  const prs = parseGhPrs(fx('gh-prs.json'), REPO, GH);
  const S = [
    mk({ key: 'claude:run', status: 'RUNNING', branch: 'night/run', facts: { currentTool: { name: 'Bash', detail: 'npm test', startedAt: NOW - 5000 } } }),
    mk({ key: 'claude:ask', status: 'NEEDS_INPUT', statusReason: 'permission prompt' }),
    mk({ key: 'claude:idle', status: 'IDLE', lastActivityAt: NOW - 120_000 }),
    mk({ key: 'claude:ready', branch: 'night/review', commits: [commit('a1')], changedFiles: ['x.ts'] }),
    mk({ key: 'claude:ci', branch: 'night/signals', commits: [commit('b1')] }),
    mk({ key: 'claude:merged', branch: 'night/repos', commits: [commit('c1')] }),
    mk({ key: 'claude:draft', branch: 'night/draft', commits: [commit('d1')] }),
    mk({ key: 'claude:created', branch: 'main', commits: [commit('e1')] }),
    mk({ key: 'claude:local', branch: 'feat/local', commits: [commit('f1')] }),
    mk({ key: 'claude:failtest', changedFiles: ['y.ts'], tests: [{ command: 'npm test', at: NOW - 700_000, outcome: 'FAIL', exitCode: 1, source: 'provider-exit-code' }] }),
    mk({ key: 'claude:quiet' }),
    mk({ key: 'claude:w-own', isWorker: true, parentSessionId: 'claude:lead', branch: 'night/own' }),
    mk({ key: 'claude:w-plain', isWorker: true, parentSessionId: 'claude:lead', changedFiles: ['z.ts'], status: 'RUNNING' }),
    mk({ key: 'claude:lead', status: 'IDLE', branch: 'main' }),
  ];
  const events = [ev('claude:created', '$ gh pr create --head night/created --base main'), ev('claude:w-own', '$ git push -u origin night/own')];
  const items = reviewItems(S, events, NOW, { prs });
  const lane = new Map(items.map(i => [i.s.key, i]));
  assert.equal(lane.get('claude:run')!.lane, 'working');
  assert.match(lane.get('claude:run')!.reason, /Bash: npm test/);
  assert.equal(lane.get('claude:ask')!.lane, 'needs');
  assert.equal(lane.get('claude:idle')!.lane, 'needs');
  assert.equal(lane.get('claude:ready')!.lane, 'ready');
  assert.equal(lane.get('claude:ready')!.pr!.number, 12);
  assert.equal(lane.get('claude:ci')!.lane, 'cifail');
  assert.equal(lane.get('claude:merged')!.lane, 'merged');
  assert.equal(lane.get('claude:draft')!.lane, 'review');
  assert.equal(lane.get('claude:created')!.lane, 'review', 'create observed, not on the forge');
  assert.match(lane.get('claude:created')!.reason, /not found on the forge/);
  assert.equal(lane.get('claude:local')!.lane, 'local');
  assert.equal(lane.get('claude:failtest')!.lane, 'needs');
  assert.equal(lane.get('claude:quiet')!.lane, 'quiet');
  assert.ok(lane.has('claude:w-own'), 'worker with its own push is an item');
  assert.ok(!lane.has('claude:w-plain'), 'plain worker rolls into its lead');
  assert.equal(lane.get('claude:lead')!.workers, 1);
  assert.equal(lane.get('claude:lead')!.lane, 'working', 'a running worker keeps the lead in Working');
  assert.equal(items[0].lane, 'needs', 'sorted by lane order');
  const steps = new Map(lane.get('claude:ready')!.steps.map(s => [s.id, s.state]));
  assert.deepEqual([steps.get('edit'), steps.get('commit'), steps.get('push'), steps.get('pr'), steps.get('ci')], ['done', 'done', 'done', 'live', 'done']);
  // Without PR state, the created PR still shows as In review from the command.
  const off = new Map(reviewItems(S, events, NOW).map(i => [i.s.key, i]));
  assert.equal(off.get('claude:created')!.lane, 'review');
  assert.match(off.get('claude:created')!.reason, /state not loaded/);
  assert.equal(off.get('claude:ready')!.lane, 'local');
  // Unlinked: #8 (no session) is listed; #12 is linked.
  const un = unlinkedPrs(items, prs).map(p => p.number);
  assert.ok(un.includes(8) && !un.includes(12));
  // A PR on a reused branch name long before the session is not matched.
  const old = mk({ key: 'claude:old', branch: 'night/repos', startedAt: NOW + 86400_000 });
  assert.equal(matchPrs(old, [], prs).length, 0);
  // A PR opened with --repo on another repository links by slug; merging other PRs links nothing.
  const other = mk({ key: 'claude:other', repository: path.resolve('/work/elsewhere'), branch: 'main' });
  const om = commandMarks([ev('claude:other', '$ gh pr create -R acme/agent --base main --head night/review'), ev('claude:other', '$ gh pr merge 11 --repo acme/agent --squash')]).get('claude:other')!;
  assert.deepEqual(matchPrs(other, om, prs).map(p => p.number), [12]);
  assert.deepEqual(matchPrs(other, om.filter(m => m.kind === 'pr-merge'), prs), []);
});

const ctxStub = (log: string[]): ActCtx => ({
  openFile: async () => {}, revealInOs: async () => {}, openUrl: async u => void log.push(`url ${u}`), copy: async t => void log.push(`copy ${t}`), info: m => void log.push(`info ${m}`),
  confirm: async () => false, saveText: async () => undefined, openTerminal: () => '', closeTerminal: () => {}, runCommand: async () => undefined, refreshFeeds: () => void log.push('refresh'), sessions: () => [],
});

test('review: screen renders lanes, layouts and escapes; actions validate', async () => {
  clearFeeds();
  const prs = parseGhPrs(fx('gh-prs.json'), REPO, GH);
  const S = [
    mk({ key: 'claude:ready', title: 'Ship <script>alert(1)</script>', branch: 'night/review', commits: [commit('a1')] }),
    mk({ key: 'claude:run', status: 'RUNNING', branch: 'night/run' }),
  ];
  const d: WsData = { sessions: S, providers: [], events: [], now: NOW, ternAvailable: false };
  let h = reviewView.render(d, { view: 'review' });
  assert.ok(!h.includes('<script>'), 'escaped');
  assert.match(h, /PR \/ MR state not loaded yet|state <b>off<\/b>/);
  assert.match(h, /data-select="claude:run"/);
  setFeedValue<PrReport>('review.prs', { state: 'off', at: NOW, repos: [] }, NOW);
  h = reviewView.render(d, { view: 'review' });
  assert.match(h, /agent\.review\.prState/);
  setFeedValue<PrReport>('review.prs', { state: 'ok', at: NOW, repos: [{ repo: REPO, remotes: [GH], prs, errors: ['gh (x): boom'], ms: 120 }] }, NOW);
  for (const layout of ['board', 'lanes', 'table']) {
    for (const group of ['none', 'repo', 'provider']) {
      h = reviewView.render(d, { view: 'review', opts: { 'review.layout': layout, 'review.group': group, 'review.show': 'all', 'review.prs': 'all' } });
      assert.ok(!h.includes('<script>') && !h.includes('<b>lanes</b>'), `escaped (${layout}/${group})`);
      assert.match(h, /Ready to merge/);
      assert.match(h, /data-act="open" data-arg="https:\/\/github\.com\/acme\/agent\/pull\/12"/);
    }
  }
  assert.match(h, /1 error\(s\)/);
  h = reviewView.render(d, { view: 'review', opts: { 'review.lane': 'working' } });
  assert.ok(h.includes('data-select="claude:run"') && !h.includes('data-select="claude:ready"'), 'lane filter');
  h = reviewView.render(d, { view: 'review' });
  assert.match(h, /Open PRs \/ MRs without a session/);
  assert.match(h, /#8/);

  const log: string[] = [];
  const ctx = ctxStub(log);
  await reviewView.actions!.open('https://github.com/acme/agent/pull/12', ctx);
  await reviewView.actions!.open('https://evil.example/pull/8', ctx);
  await reviewView.actions!.copy('night/review', ctx);
  await reviewView.actions!.copy('x; rm -rf /', ctx);
  await reviewView.actions!.refresh('', ctx);
  assert.deepEqual(log, ['url https://github.com/acme/agent/pull/12', 'info Review: unknown link.', 'copy night/review', 'info Review: copied night/review', 'refresh']);
  clearFeeds();
});

test('review: feed stays off by default and in untrusted workspaces', async () => {
  const f = reviewView.feeds![0];
  const base = { sessions: [], now: NOW, config: <T>(_k: string, fb: T) => fb };
  assert.equal(((await f.load({ ...base, trusted: true })) as PrReport).state, 'off');
  const on = { ...base, trusted: false, config: <T>(k: string, fb: T) => (k === 'review.prState' ? (true as unknown as T) : fb) };
  assert.equal(((await f.load(on)) as PrReport).state, 'untrusted');
});
