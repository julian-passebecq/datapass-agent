// Add-on screen "Repositories": every repository agents touched, read-only. Branches with ahead / behind
// their upstream, worktrees with staged / unstaged / untracked counts, recent commits, stashes, and which
// sessions work in which worktree right now. Data: one hardened git feed (src/git/repos.ts).
import * as fs from 'fs';
import type { AgentSessionSnapshot } from '../../model';
import { actBtn, ActCtx, ExtraView, loadError, loading, opt, seg, toolbar } from './kit';
import { Feed, FeedState, feedValue } from './feeds';
import { esc } from '../html';
import { ago, kpi, titleOf, WsData, WsState } from '../workspace';
import { base, identityColor, isLive } from '../../activity/insights';
import { BranchInfo, DirtyCounts, isDirty, loadRepos, RepoInfo, REPOS_DEFAULTS, ReposSnapshot, worktreeOf, WorktreeInfo } from '../../git/repos';

const FEED = 'repos.git';
const DAY = 86400_000;

export const reposFeed: Feed<ReposSnapshot> = {
  id: FEED,
  intervalMs: 90_000,
  async load(ctx) {
    if (!ctx.trusted) return { at: ctx.now, repos: [], off: 'untrusted', skipped: 0, gitCalls: 0 };
    const extra = ctx.config<unknown>('agent.repos.extra', []);
    return loadRepos(
      ctx.sessions,
      {
        maxRepos: clampInt(ctx.config('agent.repos.maxRepos', REPOS_DEFAULTS.maxRepos), 1, 100),
        maxWorktrees: clampInt(ctx.config('agent.repos.maxWorktrees', REPOS_DEFAULTS.maxWorktrees), 0, 200),
        commits: clampInt(ctx.config('agent.repos.commits', REPOS_DEFAULTS.commits), 0, 50),
        untracked: ctx.config('agent.repos.untracked', REPOS_DEFAULTS.untracked) !== false,
        extra: Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string').slice(0, 50) : [],
        timeoutMs: 5_000,
      },
      undefined,
      ctx.now,
    );
  },
};

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

// ---------------------------------------------------------------- shared bits

interface Ctx {
  d: WsData;
  st: WsState;
  snap: ReposSnapshot;
  /** worktree path → sessions (live first) seen there in the loaded history. */
  where: Map<string, AgentSessionSnapshot[]>;
  show: string;
}

const OBS = 'OBSERVED · git, read now (read-only, hardened)';

function sessionsByWorktree(d: WsData, repos: RepoInfo[]): Map<string, AgentSessionSnapshot[]> {
  const all = repos.flatMap(r => r.worktrees);
  const m = new Map<string, AgentSessionSnapshot[]>();
  for (const s of d.sessions) {
    const w = worktreeOf(s, all);
    if (w) m.set(w, [...(m.get(w) ?? []), s]);
  }
  for (const list of m.values()) list.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return m;
}

function dirtyCell(w: WorktreeInfo): string {
  if (!w.exists) return `<span class="rp-warn" title="OBSERVED · listed by git worktree list but missing on disk">missing on disk</span>`;
  if (w.prunable) return `<span class="rp-warn" title="OBSERVED · git worktree list marks it prunable">prunable</span>`;
  const c = w.dirty;
  if (!c) return `<span class="muted" title="UNKNOWN · status not read (agent.repos.maxWorktrees cap or git timeout)">—</span>`;
  return dirtyChips(c);
}

function dirtyChips(c: DirtyCounts): string {
  if (!isDirty(c)) return `<span class="rp-clean" title="${esc(OBS)} · git status: nothing to commit">clean</span>`;
  const parts: string[] = [];
  if (c.conflicts) parts.push(`<span class="rp-c rp-cf" title="${esc(OBS)} · unmerged paths">!${c.conflicts}</span>`);
  if (c.staged) parts.push(`<span class="rp-c rp-st" title="${esc(OBS)} · staged changes (index)">+${c.staged}</span>`);
  if (c.unstaged) parts.push(`<span class="rp-c rp-un" title="${esc(OBS)} · unstaged changes (work tree)">~${c.unstaged}</span>`);
  if (c.untracked) parts.push(`<span class="rp-c rp-ut" title="${esc(OBS)} · untracked entries (folders count once)">?${c.untracked}</span>`);
  return parts.join('');
}

function trackCell(b: BranchInfo | undefined): string {
  if (!b) return `<span class="muted">—</span>`;
  if (b.gone) return `<span class="rp-warn" title="${esc(OBS)} · upstream ${esc(b.upstream ?? '')} no longer exists">upstream gone</span>`;
  if (!b.upstream) return `<span class="muted" title="${esc(OBS)} · no upstream configured: never pushed or not tracking">local only</span>`;
  const t = `${OBS} · against ${b.upstream} as last fetched (Agent never fetches)`;
  if (!b.ahead && !b.behind) return `<span class="rp-clean" title="${esc(t)}">= ${esc(b.upstream)}</span>`;
  return `<span title="${esc(t)}">${b.ahead ? `<span class="rp-ah">↑${b.ahead}</span>` : ''}${b.behind ? `<span class="rp-bh">↓${b.behind}</span>` : ''} <span class="muted">${esc(b.upstream)}</span></span>`;
}

function agents(list: AgentSessionSnapshot[] | undefined, st: WsState, now: number, max = 6): string {
  if (!list?.length) return '';
  const live = list.filter(isLive);
  const recent = list.filter(s => !isLive(s) && now - (s.lastActivityAt ?? 0) < DAY);
  const shown = [...live, ...recent].slice(0, max);
  const more = live.length + recent.length - shown.length;
  const older = list.length - live.length - recent.length;
  return (
    shown
      .map(s => `<span class="agent${st.selected === s.key ? ' sel' : ''}${isLive(s) ? '' : ' rp-past'}" data-select="${esc(s.key)}" title="${esc(`${titleOf(s)} — ${s.status}${isLive(s) ? ' now' : `, last active ${ago(now, s.lastActivityAt)}`} · DERIVED: session cwd inside this worktree`)}"><span class="dot ${esc(s.status)}"></span>${s.provider === 'claude' ? 'Claude' : 'Codex'}${s.isWorker ? ' <span class="muted">worker</span>' : ''} <span class="muted">${esc(titleOf(s).slice(0, 22))}</span></span>`)
      .join('') +
    (more > 0 ? `<span class="muted">+${more}</span>` : '') +
    (older > 0 ? ` <span class="muted" title="sessions older than 24 h in the loaded history">${older} older</span>` : '')
  );
}

function acts(d: WsData, p: string, label = true): string {
  return `<span class="rp-acts">${actBtn('open', p, label ? 'Reveal' : '↗', 'Reveal this folder in the OS file manager')}${actBtn('copy', p, label ? 'Copy path' : '⧉', 'Copy the path')}${d.ternAvailable ? actBtn('tern', p, 'Tern', 'Open this worktree in Tern') : ''}</span>`;
}

const sha = (s?: string) => (s ? s.slice(0, 8) : '');
const wtName = (r: RepoInfo, w: WorktreeInfo) => (w.main ? `${r.name} (main)` : base(w.path));

function liveCount(c: Ctx, w: WorktreeInfo): number {
  return (c.where.get(w.path) ?? []).filter(isLive).length;
}
function recentCount(c: Ctx, w: WorktreeInfo): number {
  return (c.where.get(w.path) ?? []).filter(s => c.d.now - (s.lastActivityAt ?? 0) < DAY).length;
}

function keepWorktree(c: Ctx, w: WorktreeInfo, b?: BranchInfo): boolean {
  if (c.show === 'dirty') return isDirty(w.dirty) || !!b?.ahead || !w.exists;
  if (c.show === 'active') return recentCount(c, w) > 0 || isDirty(w.dirty) || w.main;
  return true;
}

function keepBranch(c: Ctx, b: BranchInfo): boolean {
  if (c.show === 'dirty') return !!b.ahead || !!b.behind || b.gone;
  if (c.show === 'active') return !!b.worktree || !!b.ahead || !!b.behind || c.d.now - b.at < 14 * DAY;
  return true;
}

function sortWorktrees(c: Ctx, ws: WorktreeInfo[]): WorktreeInfo[] {
  return [...ws].sort((a, b) => liveCount(c, b) - liveCount(c, a) || recentCount(c, b) - recentCount(c, a) || Number(isDirty(b.dirty)) - Number(isDirty(a.dirty)) || Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- table views

function wtRow(c: Ctx, r: RepoInfo, w: WorktreeInfo, withRepo: boolean): string {
  const b = r.branches.find(x => x.name === w.branch);
  const live = liveCount(c, w);
  return `<tr class="${live ? 'rp-live' : ''}" style="--id:${identityColor(r.name)}">${withRepo ? `<td class="rp-rn"><span class="sw"></span>${esc(r.name)}</td>` : ''}<td class="rp-path" title="${esc(w.path)}">${live ? '<span class="rp-pulse" title="live session here"></span>' : ''}${esc(wtName(r, w))}${w.locked ? ' <span class="chip" title="OBSERVED · git worktree lock">locked</span>' : ''}</td><td class="rp-br">${w.branch ? `⎇ ${esc(w.branch)}` : `<span class="rp-warn" title="OBSERVED · detached HEAD">detached ${esc(sha(w.head))}</span>`}</td><td class="rp-trk">${trackCell(b)}</td><td class="rp-dirty">${dirtyCell(w)}</td><td><div class="rp-who">${agents(c.where.get(w.path), c.st, c.d.now, withRepo ? 4 : 6)}</div></td><td>${acts(c.d, w.path, false)}</td></tr>`;
}

const WT_HEAD = (withRepo: boolean) => `<tr>${withRepo ? '<th>Repository</th>' : ''}<th>Worktree</th><th>Branch</th><th title="commits ahead ↑ / behind ↓ the upstream, as last fetched">Upstream</th><th title="+ staged · ~ unstaged · ? untracked · ! conflicts">Changes</th><th>Sessions here (live, 24 h)</th><th></th></tr>`;

function brRow(c: Ctx, r: RepoInfo, b: BranchInfo, withRepo: boolean): string {
  const w = r.worktrees.find(x => x.path === b.worktree);
  return `<tr style="--id:${identityColor(r.name)}">${withRepo ? `<td class="rp-rn"><span class="sw"></span>${esc(r.name)}</td>` : ''}<td class="rp-br">⎇ ${esc(b.name)}</td><td class="rp-trk">${trackCell(b)}</td><td class="num" title="${esc(OBS)} · committer date of the branch tip">${esc(ago(c.d.now, b.at))}</td><td class="rp-subj"><code>${esc(sha(b.sha))}</code> ${esc(b.subject)}</td><td>${w ? `<span class="chip" title="${esc(w.path)}">${esc(wtName(r, w))}</span> ${w.dirty ? dirtyCell(w) : ''}` : '<span class="muted">not checked out</span>'}</td><td><div class="rp-who">${w ? agents(c.where.get(w.path), c.st, c.d.now, 3) : ''}</div></td></tr>`;
}

const BR_HEAD = (withRepo: boolean) => `<tr>${withRepo ? '<th>Repository</th>' : ''}<th>Branch</th><th>Upstream</th><th>Tip</th><th>Last commit</th><th>Checked out in</th><th>Sessions</th></tr>`;

function byRepo(c: Ctx): string {
  const nb = opt(c.st, 'repos.nbranches', '8');
  return c.snap.repos
    .map(r => {
      const ws = sortWorktrees(c, r.worktrees.filter(w => keepWorktree(c, w, r.branches.find(b => b.name === w.branch))));
      const brs = r.branches.filter(b => keepBranch(c, b)).sort((a, b) => Number(!!b.worktree) - Number(!!a.worktree) || b.at - a.at);
      const brShown = nb === 'all' ? brs : brs.slice(0, Number(nb));
      if (c.show !== 'all' && !ws.length && !brs.length) return '';
      const live = r.worktrees.reduce((n, w) => n + liveCount(c, w), 0);
      const dirty = r.worktrees.filter(w => isDirty(w.dirty)).length;
      const ahead = r.branches.filter(b => b.ahead).length;
      const head = `<div class="repoh"><span class="sw"></span><b title="${esc(r.repository)}">${esc(r.name)}</b><span class="muted">${r.worktrees.length} worktree${r.worktrees.length === 1 ? '' : 's'} · ${r.branches.length} branch${r.branches.length === 1 ? '' : 'es'}${dirty ? ` · <span class="rp-warn">${dirty} dirty</span>` : ''}${ahead ? ` · <span class="rp-ah">${ahead} unpushed</span>` : ''}${r.stashes ? ` · <span title="${esc(OBS)} · entries in refs/stash">${r.stashes} stash${r.stashes === 1 ? '' : 'es'}</span>` : ''}${live ? ` · <span class="pass">${live} live</span>` : ''}</span><span class="right muted" title="time git took for this repository">${r.ms} ms</span>${acts(c.d, r.repository)}</div>`;
      if (r.error) return `<div class="repo rp-repo" style="--id:${identityColor(r.name)}">${head}<div class="rp-warn">${esc(r.error)}</div></div>`;
      const wtT = ws.length ? `<table class="rp-t">${WT_HEAD(false)}${ws.map(w => wtRow(c, r, w, false)).join('')}</table>` : '';
      const brT = brShown.length ? `<details class="rp-d"${nb !== '0' ? ' open' : ''}><summary>Branches <span class="muted">${brShown.length}${brs.length > brShown.length ? ` of ${brs.length}` : ''}</span></summary><table class="rp-t">${BR_HEAD(false)}${brShown.map(b => brRow(c, r, b, false)).join('')}</table></details>` : '';
      const cm = r.commits.length ? `<details class="rp-d"><summary>Recent commits <span class="muted">${r.commits.length}, all local branches</span></summary><div class="rp-cm">${r.commits.map(x => `<div title="${esc(OBS)}"><span class="num muted">${esc(ago(c.d.now, x.at))}</span><code>${esc(x.sha)}</code>${x.refs.map(f => `<span class="chip">${esc(f)}</span>`).join('')} <span class="rp-subj">${esc(x.subject)}</span></div>`).join('')}</div></details>` : '';
      return `<div class="repo rp-repo" style="--id:${identityColor(r.name)}">${head}${wtT}${brT}${cm}</div>`;
    })
    .join('');
}

function byWorktree(c: Ctx): string {
  const rows = c.snap.repos.flatMap(r => r.worktrees.filter(w => keepWorktree(c, w, r.branches.find(b => b.name === w.branch))).map(w => ({ r, w })));
  const sorted = rows.sort((a, b) => liveCount(c, b.w) - liveCount(c, a.w) || recentCount(c, b.w) - recentCount(c, a.w) || Number(isDirty(b.w.dirty)) - Number(isDirty(a.w.dirty)) || a.r.name.localeCompare(b.r.name));
  if (!sorted.length) return `<div class="empty">No worktree matches this filter.</div>`;
  return `<table class="rp-t">${WT_HEAD(true)}${sorted.map(({ r, w }) => wtRow(c, r, w, true)).join('')}</table>`;
}

function byBranch(c: Ctx): string {
  const rows = c.snap.repos.flatMap(r => r.branches.filter(b => keepBranch(c, b)).map(b => ({ r, b })));
  const sorted = rows.sort((a, b) => Number(!!b.b.worktree) - Number(!!a.b.worktree) || (b.b.ahead ?? 0) + (b.b.behind ?? 0) - (a.b.ahead ?? 0) - (a.b.behind ?? 0) || b.b.at - a.b.at);
  if (!sorted.length) return `<div class="empty">No branch matches this filter.</div>`;
  return `<table class="rp-t">${BR_HEAD(true)}${sorted.slice(0, 400).map(({ r, b }) => brRow(c, r, b, true)).join('')}</table>${sorted.length > 400 ? `<div class="foot">${sorted.length - 400} more branches not shown.</div>` : ''}`;
}

// ---------------------------------------------------------------- spine diagram

/** Per repository: a trunk (the upstream line) with every branch drawn as a diverging bar, behind on one side,
 *  ahead on the other; worktree markers and live sessions sit on the branch. */
function spine(c: Ctx): string {
  const vertical = opt(c.st, 'repos.orient', 'horizontal') === 'vertical';
  const nb = opt(c.st, 'repos.nbranches', '8');
  const repos = c.snap.repos
    .filter(r => !r.error)
    .map(r => {
      const brs = r.branches.filter(b => keepBranch(c, b)).sort((a, b) => Number(!!b.worktree) - Number(!!a.worktree) || b.at - a.at);
      return { r, brs: nb === 'all' ? brs : brs.slice(0, Math.max(1, Number(nb) || 8)) };
    })
    .filter(x => x.brs.length);
  if (!repos.length) return `<div class="empty">No branch matches this filter.</div>`;
  const max = Math.max(1, ...repos.flatMap(x => x.brs.map(b => Math.max(b.ahead ?? 0, b.behind ?? 0))));
  const scale = (n: number) => (n ? Math.max(4, Math.round((Math.sqrt(n) / Math.sqrt(max)) * 100)) : 0);
  const node = (r: RepoInfo, b: BranchInfo) => {
    const w = r.worktrees.find(x => x.path === b.worktree);
    const list = w ? c.where.get(w.path) : undefined;
    const live = (list ?? []).filter(isLive);
    const marks = `${w ? `<span class="rp-wt${isDirty(w.dirty) ? ' dirty' : ''}" title="${esc(`checked out in ${w.path}${w.dirty ? '' : ' (status not read)'}`)}"></span>` : ''}${live.map(s => `<span class="dot ${esc(s.status)}" data-select="${esc(s.key)}" title="${esc(`${titleOf(s)} — ${s.provider} ${s.status} · DERIVED: session cwd inside this worktree`)}"></span>`).join('')}`;
    const tip = `${b.name} · ${b.upstream ? (b.gone ? 'upstream gone' : `↑${b.ahead ?? 0} ↓${b.behind ?? 0} vs ${b.upstream}`) : 'local only (no upstream)'} · tip ${ago(c.d.now, b.at)}${w?.dirty ? ` · +${w.dirty.staged} ~${w.dirty.unstaged} ?${w.dirty.untracked}` : ''} · ${OBS}`;
    const cls = !b.upstream ? ' local' : b.gone ? ' gone' : '';
    return `<div class="rp-n${cls}" title="${esc(tip)}"><span class="rp-lab">${esc(b.name)}</span><span class="rp-bhs"><i style="--v:${scale(b.behind ?? 0)}%"></i>${b.behind ? `<em>${b.behind}</em>` : ''}</span><span class="rp-ax"></span><span class="rp-ahs"><i style="--v:${scale(b.ahead ?? 0)}%"></i>${b.ahead ? `<em>${b.ahead}</em>` : ''}</span><span class="rp-mk">${marks}${w?.dirty && isDirty(w.dirty) ? `<span class="rp-dm">${dirtyChips(w.dirty)}</span>` : ''}</span></div>`;
  };
  return `<div class="rp-spines${vertical ? ' v' : ''}">${repos
    .map(({ r, brs }) => `<div class="repo rp-sp" style="--id:${identityColor(r.name)}"><div class="repoh"><span class="sw"></span><b>${esc(r.name)}</b><span class="muted">${brs.length} branch${brs.length === 1 ? '' : 'es'}${r.stashes ? ` · ${r.stashes} stash${r.stashes === 1 ? '' : 'es'}` : ''}</span></div><div class="rp-axh"><span>branch</span><span>↓ behind upstream</span><span></span><span>ahead of upstream ↑</span><span>worktree · sessions</span></div>${brs.map(b => node(r, b)).join('')}</div>`)
    .join('')}</div><div class="legend"><span class="rp-sample bh"></span>behind upstream <span class="rp-sample ah"></span>ahead (unpushed) <span class="rp-wt"></span>checked out in a worktree <span class="rp-wt dirty"></span>worktree has changes <span class="dot RUNNING"></span>live session · bar length is √commits, scaled to the largest on screen; dashed = no upstream</div>`;
}

// ---------------------------------------------------------------- screen

function stateLine(f: FeedState<ReposSnapshot>, now: number): string {
  const s = f.value;
  const bits = [s ? `read ${ago(now, s.at) || 'just now'}` : '', f.ms !== undefined ? `${f.ms} ms` : '', s?.gitCalls ? `${s.gitCalls} git calls` : '', f.running ? 'refreshing…' : '', s?.skipped ? `${s.skipped} more repositories over agent.repos.maxRepos` : ''].filter(Boolean);
  return `<span class="muted rp-state">${esc(bits.join(' · '))}</span>`;
}

function render(d: WsData, st: WsState): string {
  const f = feedValue<ReposSnapshot>(FEED);
  const view = opt(st, 'repos.view', 'table');
  const by = opt(st, 'repos.by', 'repo');
  const tb = toolbar(
    view === 'table' ? seg(st, 'repos.by', [['repo', 'By repo'], ['worktree', 'By worktree'], ['branch', 'By branch']], 'repo', 'Group rows by') : '',
    seg(st, 'repos.view', [['table', 'Table'], ['spine', 'Spine']], 'table', 'Table or ahead / behind spine diagram'),
    view === 'spine' ? seg(st, 'repos.orient', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal', 'Orientation of the spine') : '',
    seg(st, 'repos.show', [['all', 'All'], ['active', 'Active'], ['dirty', 'Needs push / commit']], 'active', 'Active: sessions in 24 h, changes, divergence or tips < 14 days old'),
    view === 'spine' || by === 'repo' ? seg(st, 'repos.nbranches', [['0', '0'], ['8', '8'], ['20', '20'], ['all', 'All']], '8', 'Branches per repository') : '',
    actBtn('refresh', '', 'Re-read git', 'Run the read-only git commands again now'),
    stateLine(f, d.now),
  );
  if (f.error && !f.value) return `${tb}${loadError(`Git could not be read: ${f.error}`, 'refresh')}`;
  const snap = f.value;
  if (!snap) return `${tb}${loading('repos', f.running ? 'Reading git in every repository agents touched…' : 'Waiting for the first git read…', { retry: 'refresh' })}`;
  if (snap.off === 'untrusted') return `${tb}<div class="empty">Off in untrusted workspaces: Agent runs no git process until you trust this workspace.</div>`;
  if (!snap.repos.length) return `${tb}<div class="empty">No repository found for the sessions in the loaded history.</div>`;
  const c: Ctx = { d, st, snap, where: sessionsByWorktree(d, snap.repos), show: opt(st, 'repos.show', 'active') };
  const wts = snap.repos.flatMap(r => r.worktrees);
  const brs = snap.repos.flatMap(r => r.branches);
  const liveWt = wts.filter(w => liveCount(c, w) > 0).length;
  const dirtyIdle = wts.filter(w => isDirty(w.dirty) && !liveCount(c, w)).length;
  const k = `<div class="kpis">${kpi(snap.repos.length, 'Repositories', '', 'repositories of sessions in the loaded history (plus agent.repos.extra)')}${kpi(wts.length, 'Worktrees', '', OBS)}${kpi(liveWt, 'With live agent', liveWt ? 'k-run' : '', 'DERIVED · worktrees whose path contains a live session cwd')}${kpi(wts.filter(w => isDirty(w.dirty)).length, 'Uncommitted', '', `${OBS} · worktrees with staged, unstaged or untracked changes`)}${kpi(dirtyIdle, 'Dirty, nobody on it', dirtyIdle ? 'k-need' : '', 'uncommitted changes in a worktree with no live session')}${kpi(brs.filter(b => b.ahead).length, 'Unpushed branches', '', `${OBS} · ahead of upstream`)}${kpi(brs.filter(b => b.behind).length, 'Behind upstream', '', `${OBS} · as of the last fetch`)}${kpi(brs.filter(b => !b.upstream).length, 'Local only', '', 'branches without an upstream')}${kpi(snap.repos.reduce((n, r) => n + r.stashes, 0), 'Stashes', '', `${OBS} · refs/stash entries`)}</div>`;
  const body = view === 'spine' ? spine(c) : by === 'worktree' ? byWorktree(c) : by === 'branch' ? byBranch(c) : byRepo(c);
  return `<div class="rp">${tb}${k}${body || '<div class="empty">Nothing matches this filter.</div>'}<div class="foot">OBSERVED: git output read now by Agent (worktree list, for-each-ref, status, log, rev-list; hardened, 5 s timeout, never fetch / checkout / write). Ahead / behind compare with the upstream as of your last fetch. DERIVED: a session belongs to the worktree that contains its cwd.</div></div>`;
}

// ---------------------------------------------------------------- actions

/** Only paths the last git read listed (repository roots and worktrees) are accepted from the webview. */
function knownPath(arg: string): { repo: RepoInfo; wt?: WorktreeInfo } | undefined {
  const snap = feedValue<ReposSnapshot>(FEED).value;
  if (!snap || typeof arg !== 'string' || !arg) return undefined;
  for (const r of snap.repos) {
    if (r.repository === arg) return { repo: r, wt: r.worktrees.find(w => w.main) };
    const wt = r.worktrees.find(w => w.path === arg);
    if (wt) return { repo: r, wt };
  }
  return undefined;
}

async function reveal(arg: string, ctx: ActCtx): Promise<void> {
  const k = knownPath(arg);
  if (!k || !fs.existsSync(arg)) return ctx.info('Agent: this folder is not available on disk.');
  await ctx.revealInOs(arg);
}

async function copy(arg: string, ctx: ActCtx): Promise<void> {
  if (!knownPath(arg)) return;
  await ctx.copy(arg);
  ctx.info(`Copied ${arg}`);
}

async function tern(arg: string, ctx: ActCtx): Promise<void> {
  const k = knownPath(arg);
  if (!k) return;
  const w = k.wt;
  try {
    await ctx.runCommand('tern.revealWorktree', { repository: k.repo.repository, worktree: w?.path ?? k.repo.repository, branch: w?.branch, head: w?.head });
  } catch {
    ctx.info('Agent: Tern is not available.');
  }
}

export const reposView: ExtraView = {
  id: 'repos',
  label: 'Repositories',
  group: 'Change',
  hint: 'Every repository agents touched: branches, worktrees, dirty state, ahead / behind.',
  ready: true,
  feeds: [reposFeed as Feed],
  render,
  badge: () => {
    const v = feedValue<ReposSnapshot>(FEED).value;
    const n = v ? v.repos.reduce((a, r) => a + r.worktrees.filter(w => isDirty(w.dirty)).length, 0) : 0;
    return n ? String(n) : '';
  },
  actions: {
    open: reveal,
    copy,
    tern,
    refresh: (_a, ctx) => ctx.refreshFeeds(),
  },
  css: `
.rp .rp-t { margin: 4px 0 6px; font-size: 12px; }
.rp .rp-t th { white-space: nowrap; }
.rp .rp-t td { vertical-align: middle; }
.rp .rp-t tr:hover td { background: var(--vscode-list-hoverBackground); }
.rp .rp-t tr.rp-live td:first-child { box-shadow: inset 2px 0 0 var(--ok); }
.rp .rp-path { font-family: var(--vscode-editor-font-family); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.rp .rp-br { font-family: var(--vscode-editor-font-family); color: var(--id); font-weight: 600; white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.rp .rp-subj { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp .rp-who { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.rp .rp-who:empty::after { content: '·'; color: var(--quiet); }
.rp .rp-past { opacity: .62; }
.rp .rp-who .agent { white-space: nowrap; max-width: 230px; overflow: hidden; text-overflow: ellipsis; display: inline-block; line-height: 16px; }
.rp .rp-rn { white-space: nowrap; }
.rp .rp-acts { display: inline-flex; gap: 8px; white-space: nowrap; margin-left: 8px; font-size: 11px; }
.rp .repoh .rp-acts { margin-left: 4px; }
.rp .repoh .right { margin-left: auto; font-size: 10px; }
.rp .rp-c { display: inline-block; font-size: 10px; font-variant-numeric: tabular-nums; padding: 0 5px; margin-right: 3px; border-radius: 8px; border: 1px solid; }
.rp .rp-st { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.rp .rp-un { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.rp .rp-ut { color: var(--vscode-descriptionForeground); border-color: var(--line); }
.rp .rp-cf { color: var(--bad); border-color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); font-weight: 600; }
.rp .rp-trk, .rp .rp-dirty { white-space: nowrap; }
.rp .rp-clean { color: var(--vscode-descriptionForeground); }
.rp .rp-warn { color: var(--warn); }
.rp .rp-ah { color: var(--ok); font-weight: 600; margin-right: 4px; font-variant-numeric: tabular-nums; }
.rp .rp-bh { color: var(--warn); font-weight: 600; margin-right: 4px; font-variant-numeric: tabular-nums; }
.rp .rp-pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-right: 5px; animation: rp-p 1.6s ease-in-out infinite; }
@keyframes rp-p { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 50% { box-shadow: 0 0 0 4px transparent; } }
@media (prefers-reduced-motion: reduce) { .rp .rp-pulse { animation: none; } }
.rp .rp-d { margin: 2px 0 4px; } .rp .rp-d summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
.rp .rp-cm { display: grid; gap: 1px; font-size: 12px; padding: 2px 0 2px 12px; }
.rp .rp-cm > div { display: flex; gap: 6px; align-items: baseline; white-space: nowrap; overflow: hidden; } .rp .rp-cm .num { min-width: 64px; text-align: right; font-size: 11px; }
.rp .rp-state { font-size: 11px; }
.rp .rp-spines { display: grid; gap: 8px; }
.rp .rp-axh, .rp .rp-n { display: grid; grid-template-columns: minmax(120px, 220px) 1fr 2px 1fr minmax(60px, 180px); align-items: center; gap: 0 6px; }
.rp .rp-axh { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; } .rp .rp-axh span:nth-child(2) { text-align: right; } .rp .rp-axh span { white-space: nowrap; overflow: hidden; }
.rp .rp-n { padding: 1px 0; border-radius: 3px; } .rp .rp-n:hover { background: var(--vscode-list-hoverBackground); }
.rp .rp-lab { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--id); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp .rp-ax { height: 18px; background: var(--vscode-foreground); opacity: .5; }
.rp .rp-n.local .rp-ax { background: none; border-left: 2px dashed var(--quiet); opacity: 1; }
.rp .rp-n.gone .rp-ax { background: var(--warn); }
.rp .rp-bhs, .rp .rp-ahs { display: flex; align-items: center; gap: 4px; height: 12px; font-size: 10px; font-style: normal; }
.rp .rp-bhs { flex-direction: row-reverse; }
.rp .rp-bhs i, .rp .rp-ahs i { display: block; height: 10px; width: var(--v); border-radius: 2px; }
.rp .rp-bhs i { background: var(--warn); } .rp .rp-ahs i { background: var(--ok); }
.rp .rp-bhs em, .rp .rp-ahs em { font-style: normal; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.rp .rp-mk { display: flex; gap: 4px; align-items: center; min-width: 0; overflow: hidden; } .rp .rp-mk .dot { cursor: pointer; }
.rp .rp-wt { display: inline-block; width: 9px; height: 9px; border: 2px solid var(--id, var(--accent)); border-radius: 2px; box-sizing: border-box; }
.rp .rp-wt.dirty { background: var(--warn); border-color: var(--warn); }
.rp .rp-dm .rp-c { font-size: 9px; padding: 0 3px; }
.rp .rp-sample { display: inline-block; width: 16px; height: 8px; border-radius: 2px; } .rp .rp-sample.ah { background: var(--ok); } .rp .rp-sample.bh { background: var(--warn); }
.rp .rp-spines.v { grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); align-items: start; }
.rp .rp-spines.v .rp-sp { display: flex; flex-wrap: wrap; gap: 4px; align-items: stretch; }
.rp .rp-spines.v .repoh { flex-basis: 100%; }
.rp .rp-spines.v .rp-axh { display: none; }
.rp .rp-spines.v .rp-n { grid-template-columns: 1fr; grid-template-rows: 70px 2px 70px auto auto; justify-items: center; width: 34px; gap: 2px 0; padding: 2px; }
.rp .rp-spines.v .rp-ahs { grid-row: 1; flex-direction: column-reverse; height: 70px; width: 12px; justify-content: flex-start; }
.rp .rp-spines.v .rp-ax { grid-row: 2; height: 2px; width: 30px; }
.rp .rp-spines.v .rp-bhs { grid-row: 3; flex-direction: column; height: 70px; width: 12px; justify-content: flex-start; }
.rp .rp-spines.v .rp-bhs i, .rp .rp-spines.v .rp-ahs i { width: 10px; height: var(--v); }
.rp .rp-spines.v .rp-mk { grid-row: 4; flex-direction: column; overflow: visible; } .rp .rp-spines.v .rp-dm { display: none; }
.rp .rp-spines.v .rp-lab { grid-row: 5; writing-mode: vertical-rl; transform: rotate(180deg); max-height: 140px; font-size: 11px; }
.rp .rp-spines.v .rp-n.local .rp-ax { border-left: none; border-top: 2px dashed var(--quiet); }
`,
};
