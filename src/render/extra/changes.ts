// Add-on screen "Changes": files changed by sessions. Per-file +/- over each session's commit window (git),
// edit calls the providers recorded, uncommitted work per live worktree, and a heat map of the most edited files.
// Data: src/git/changes.ts (feed, read-only hardened git) and src/activity/changes.ts (pure aggregation).
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../../model';
import { ChangesData, collectChanges, SharedWindow, sharedWindows, WorktreeChanges, WtFileState } from '../../git/changes';
import { churn, factPath, FileRow, fileRows, folderOf, Gran, GroupBy, groupRows, heat, isPeriod, Period, since, SortBy, sortRows, SessionRow, sessionRows, wtCounts } from '../../activity/changes';
import { base, compact, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import { hhmm } from '../views';
import { ago, kpi, prettyModel, repoOf, titleOf, WsData, WsState } from '../workspace';
import { actBtn, ActCtx, ExtraView, loading, opt, seg, toolbar } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';
import { squarify } from './explore';
import { isPlausibleLocalPath, normalizeCase } from '../../util/paths';

const FEED_ID = 'changes.git';

/** Reads `agent.changes.<name>`; accepts both full and section-relative keys from the host. */
function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.changes.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`changes.${name}`, fallback);
}
const num = (v: unknown, def: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : def));

export const changesFeed: Feed<ChangesData> = {
  id: FEED_ID,
  intervalMs: 30_000,
  load(ctx) {
    return collectChanges(ctx.sessions, {
      now: ctx.now,
      trusted: ctx.trusted,
      maxSessions: num(cfg(ctx, 'maxSessions', 60), 60, 0, 400),
      maxWorktrees: num(cfg(ctx, 'maxWorktrees', 16), 16, 0, 100),
      worktreeWindowMs: num(cfg(ctx, 'worktreeHours', 24), 24, 1, 24 * 30) * 3600_000,
      untracked: cfg<boolean>(ctx, 'untracked', true) !== false,
    });
  },
};

// ---------------------------------------------------------------- small helpers

/** Short stable lowercase id for a row (toolbar values are [a-z0-9._:-]). */
function hid(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Lock files, minified bundles and build output: hidden by default in the Files tab. */
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|[^/]*\.tsbuildinfo)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|out|build|node_modules|\.next|coverage)\//i;

/** Linked worktree name; with its parent folder when it repeats the repo name (Codex worktrees/<id>/<repo>). */
function wtLabel(w: WorktreeChanges): string {
  const b = base(w.worktree);
  return b.toLowerCase() === base(w.repository).toLowerCase() ? `${base(path.dirname(w.worktree))}/${b}` : b;
}

const STATE_LETTER: Record<WtFileState, string> = { staged: 'S', unstaged: 'M', both: 'SM', untracked: '?', conflict: '!' };
const STATE_TXT: Record<WtFileState, string> = { staged: 'staged', unstaged: 'modified, not staged', both: 'staged and modified again', untracked: 'untracked (new file not added)', conflict: 'merge conflict' };

function pm(a: number, r: number, binary = false): string {
  if (binary && !a && !r) return '<span class="chg-bin" title="binary file: git reports no line counts">bin</span>';
  return `<span class="chg-a">+${compact(a)}</span> <span class="chg-r">−${compact(r)}</span>`;
}

function fileName(p: string, max = 70): string {
  const i = p.lastIndexOf('/');
  const dir = i >= 0 ? p.slice(0, i + 1) : '';
  const name = i >= 0 ? p.slice(i + 1) : p;
  const d = dir.length + name.length > max ? '…' + dir.slice(Math.max(0, dir.length - Math.max(4, max - name.length - 1))) : dir;
  return `<span class="chg-fn" title="${esc(p)}"><span class="chg-dir">${esc(d)}</span><b>${esc(name)}</b></span>`;
}

function wtChip(u: { state: WtFileState; added: number; removed: number } | undefined): string {
  if (!u) return '';
  const lines = u.added || u.removed ? ` +${compact(u.added)} −${compact(u.removed)}` : '';
  return `<span class="chg-st chg-${u.state}" title="${esc(`DERIVED now: ${STATE_TXT[u.state]}${lines} (git diff / git status in the worktree)`)}">${STATE_LETTER[u.state]}${esc(lines)}</span>`;
}

/** Uncommitted chip for a worktree: S staged · M modified · ? untracked · ! conflicts. */
function wtSummary(w: WorktreeChanges | undefined, short = false): string {
  if (!w) return '';
  if (w.error) return `<span class="chg-st chg-err" title="${esc(w.error)}">git ?</span>`;
  const c = wtCounts(w);
  if (!c.dirty) return `<span class="chg-st chg-clean" title="DERIVED now: no staged, modified or untracked file (git status)">clean</span>`;
  const parts = [c.conflicts && `!${c.conflicts}`, c.staged && `S${c.staged}`, c.unstaged && `M${c.unstaged}`, c.untracked && `?${c.untracked}`].filter(Boolean).join(' ');
  const lines = c.added || c.removed ? ` +${compact(c.added)} −${compact(c.removed)}` : '';
  return `<span class="chg-st chg-dirty${c.conflicts ? ' chg-conflict' : ''}" title="${esc(`DERIVED now, uncommitted in ${w.worktree}: ${c.staged} staged, ${c.unstaged} modified, ${c.untracked} untracked, ${c.conflicts} conflicted${lines ? ` · tracked lines${lines}` : ''}`)}">${esc(short ? parts : parts + lines)}</span>`;
}

function sessDots(keys: string[], by: Map<string, AgentSessionSnapshot>, max = 6): string {
  const ss = keys.map(k => by.get(k)).filter((s): s is AgentSessionSnapshot => !!s);
  const dots = ss.slice(0, max).map(s => `<span class="chg-sd ${s.provider}${isLive(s) ? ' live' : ''}" data-select="${esc(s.key)}" title="${esc(`${titleOf(s)} · ${s.provider}${s.isWorker ? ' worker' : ''} · ${s.status}`)}"></span>`).join('');
  return `${dots}${ss.length > max ? `<span class="muted">+${ss.length - max}</span>` : ''}`;
}

function divBar(a: number, r: number, max: number): string {
  const w = (v: number) => (max > 0 ? Math.max(v ? 1 : 0, (50 * v) / max) : 0).toFixed(2);
  return `<span class="chg-div" title="${esc(`+${a} −${r} lines`)}"><i class="chg-dr" style="width:${w(r)}%"></i><i class="chg-da" style="width:${w(a)}%"></i></span>`;
}

/** "shared window (n sessions)" badge: INFERRED, tooltip names the other sessions of the same worktree (audit A3 P1-9). */
export function sharedBadge(sw: SharedWindow | undefined, commits: number, by: Map<string, AgentSessionSnapshot>, cls = 'chg-shared'): string {
  if (!sw) return '';
  const names = sw.others.map(k => {
    const o = by.get(k);
    return o ? `${titleOf(o).slice(0, 60)} (${o.provider}, ${o.status})` : k;
  });
  const tip = `INFERRED: ${sw.shas.size} of ${commits} window commit(s) also fall inside the window of ${sw.others.length} other session(s) active in this worktree, so authorship cannot be told apart: ${names.join('; ')}. A commit the session ran itself (git commit) stays OBSERVED.`;
  return ` <span class="${cls}" data-ev="INFERRED" title="${esc(tip)}">shared window (${sw.n} sessions)</span>`;
}

const EV = {
  lines: 'DERIVED: git diff --numstat headBefore..headAfter of each session (commits observed during the session window; authorship not proven). Windows inside another session of the same worktree count once.',
  edits: 'OBSERVED: edit / write / patch tool calls the provider recorded for this file.',
  wt: 'DERIVED now: git diff (staged and unstaged) and git status in worktrees of live or recently active sessions.',
};

// ---------------------------------------------------------------- config

interface Cfg {
  tab: 'files' | 'sessions' | 'worktrees' | 'heat';
  period: Period;
  from: number;
}

function conf(st: WsState, now: number): Cfg {
  const tab = opt(st, 'changes.tab', 'files');
  const p = opt(st, 'changes.period', '24h');
  const period = isPeriod(p) ? p : '24h';
  return { tab: (['files', 'sessions', 'worktrees', 'heat'].includes(tab) ? tab : 'files') as Cfg['tab'], period, from: since(period, now) };
}

// ---------------------------------------------------------------- files tab

function openArg(r: FileRow, d: WsData, by: Map<string, AgentSessionSnapshot>): string | undefined {
  if (r.files !== undefined) return undefined;
  const wt = r.wt?.worktree ?? r.sessions.map(k => by.get(k)?.worktree).find(Boolean) ?? d.sessions.find(s => repoOf(s) === r.repo && s.worktree)?.worktree;
  if (!wt || /^[a-zA-Z]:\//.test(r.path) || r.path.startsWith('/')) return undefined;
  return path.join(wt, r.path);
}

function treemap(rows: FileRow[], val: (r: FileRow) => number, pick: string): string {
  const items = rows.map(r => ({ r, v: val(r) })).filter(x => x.v > 0);
  if (!items.length) return `<div class="empty">Nothing to size in this period.</div>`;
  const W = 1000, H = 400;
  const byId = new Map(items.map(x => [x.r.id, x.r]));
  const out = squarify(items.map(x => ({ key: x.r.id, value: x.v, sessions: [] })), W, H).map(c => ({ r: byId.get(c.g.key)!, v: c.g.value, x: c.x, y: c.y, w: c.w, h: c.h }));
  return `<div class="chg-tm">${out
    .map(c => {
      const big = c.w > 70 && c.h > 30;
      const name = c.r.path ? c.r.path.split('/').pop() : c.r.repo;
      return `<div class="chg-tmc${pick === hid(c.r.id) ? ' on' : ''}" data-opt="changes.pick" data-val="${hid(c.r.id)}" style="left:${(c.x / 10).toFixed(3)}%;top:${((100 * c.y) / H).toFixed(3)}%;width:${(c.w / 10).toFixed(3)}%;height:${((100 * c.h) / H).toFixed(3)}%;--c:${identityColor(c.r.repo)}" title="${esc(`${c.r.repo} · ${c.r.path || '(repo)'} · +${c.r.added} −${c.r.removed} · ${c.r.edits} edit call(s) · ${c.r.sessions.length} session(s)`)}">${big ? `<b>${esc(name)}</b><span>${esc(compact(c.v))}${c.r.wt ? ' · ' + STATE_LETTER[c.r.wt.state] : ''}</span>` : ''}</div>`;
    })
    .join('')}</div><div class="legend"><span>Area = ${esc(val === churn ? 'lines changed (+ and −)' : 'edit calls')}; colour = repository; letter = uncommitted state now.</span></div>`;
}

function filesTab(d: WsData, st: WsState, c: Cfg, data: ChangesData | undefined, by: Map<string, AgentSessionSnapshot>): string {
  const group = opt(st, 'changes.group', 'file') as GroupBy;
  const depth = Number(opt(st, 'changes.depth', '2')) || 2;
  const metric = opt(st, 'changes.metric', 'lines');
  const chart = opt(st, 'changes.chart', 'table');
  const only = opt(st, 'changes.only', 'all');
  const top = Number(opt(st, 'changes.top', '50')) || 50;
  const sortDef = metric === 'edits' ? 'edits' : 'churn';
  const sort = opt(st, 'changes.sort', sortDef) as SortBy;
  const pick = opt(st, 'changes.pick', '');
  const all = fileRows(d.sessions, data, c.from);
  const noise = opt(st, 'changes.noise', 'hide') === 'hide';
  let rows = all.filter(r => (only === 'uncommitted' ? !!r.wt : only === 'git' ? r.git : only === 'edited' ? r.edited : true) && (r.sessions.length || r.wt));
  const before = rows.length;
  if (noise) rows = rows.filter(r => !NOISE.test(r.path));
  const hiddenNoise = before - rows.length;
  rows = sortRows(groupRows(rows, ['file', 'folder', 'repo'].includes(group) ? group : 'file', depth), ['churn', 'edits', 'recent', 'name', 'sessions'].includes(sort) ? sort : 'churn');
  const shown = rows.slice(0, top);
  const tb = toolbar(
    seg(st, 'changes.group', [['file', 'File'], ['folder', 'Folder'], ['repo', 'Repo']], 'file', 'Group by'),
    group === 'folder' ? seg(st, 'changes.depth', [['1', 'Depth 1'], ['2', '2'], ['3', '3'], ['9', 'Full']], '2', 'Folder depth') : '',
    seg(st, 'changes.metric', [['lines', 'Lines ±'], ['edits', 'Edit calls']], 'lines', 'Size bars by'),
    seg(st, 'changes.chart', [['table', 'Table'], ['bars', 'Bars'], ['treemap', 'Treemap']], 'table', 'Chart'),
    seg(st, 'changes.only', [['all', 'All'], ['git', 'In commits'], ['edited', 'Edit calls'], ['uncommitted', 'Uncommitted']], 'all', 'Which files'),
    seg(st, 'changes.noise', [['hide', 'Hide lock / build files'], ['show', 'Show all']], 'hide', 'Lock files, minified and build output'),
    seg(st, 'changes.sort', [['churn', 'Churn'], ['edits', 'Edits'], ['sessions', 'Sessions'], ['recent', 'Recent'], ['name', 'Name']], sortDef, 'Sort'),
    seg(st, 'changes.top', [['25', '25'], ['50', '50'], ['100', '100'], ['500', '500']], '50', 'Rows'),
  );
  if (!rows.length) return tb + `<div class="empty">No changed file observed in this period${data ? '' : ' (git data still loading)'}${hiddenNoise ? ` (${hiddenNoise} lock / build file(s) hidden)` : ''}.</div>`;
  const val = metric === 'edits' ? (r: FileRow) => r.edits : churn;
  const unit = group === 'file' ? 'File' : group === 'folder' ? 'Folder' : 'Repo';
  const label = (r: FileRow) => (group === 'repo' ? `<b>${esc(r.repo)}</b>` : group === 'folder' ? `<b title="${esc(r.path)}">${esc(r.path)}/</b>` : fileName(r.path));
  let body: string;
  if (chart === 'treemap') body = treemap(shown, val, pick);
  else if (chart === 'bars') {
    const maxL = Math.max(1, ...shown.map(r => Math.max(r.added, r.removed)));
    const maxE = Math.max(1, ...shown.map(r => r.edits));
    body = `<div class="chg-bars">${shown
      .map(r => {
        const bar = metric === 'edits' ? `<span class="chg-eb"><i style="width:${((100 * r.edits) / maxE).toFixed(2)}%"></i></span>` : divBar(r.added, r.removed, maxL);
        return `<div class="chg-br${pick === hid(r.id) ? ' on' : ''}" data-opt="changes.pick" data-val="${hid(r.id)}"><span class="chg-sw" style="background:${identityColor(r.repo)}" title="${esc(r.repo)}"></span><span class="chg-bl">${label(r)}</span>${bar}<span class="chg-bv">${metric === 'edits' ? `<b>${r.edits}</b>` : pm(r.added, r.removed, r.binary)}</span><span>${wtChip(r.wt)}</span></div>`;
      })
      .join('')}</div><div class="legend"><span class="chg-a">+ added</span><span class="chg-r">− removed</span><span>bars centred at zero, scaled to the largest file shown</span></div>`;
  } else {
    const maxL = Math.max(1, ...shown.map(r => Math.max(r.added, r.removed)));
    body = `<table class="chg-t"><tr><th>${group === 'repo' ? '' : 'Repo'}</th><th>${unit}</th>${group !== 'file' ? '<th class="r">Files</th>' : ''}<th class="r" title="${esc(EV.lines)}">+</th><th class="r" title="${esc(EV.lines)}">−</th><th title="${esc(EV.lines)}"></th><th class="r" title="${esc(EV.edits)}">Edits</th><th title="sessions that touched it (commit window or edit call)">Sessions</th><th title="${esc(EV.wt)}">Uncommitted</th><th class="r">Last</th></tr>${shown
      .map(r => `<tr class="${pick === hid(r.id) ? 'on' : ''}" data-opt="changes.pick" data-val="${hid(r.id)}"><td class="muted chg-repo" title="${esc(r.repo)}">${group === 'repo' ? `<span class="chg-sw" style="background:${identityColor(r.repo)}"></span>` : `<span class="chg-sw" style="background:${identityColor(r.repo)}"></span>${esc(r.repo)}`}</td><td>${label(r)}${r.overlap ? ' <span class="chg-warn" title="sessions with partially overlapping windows in one worktree: the same commit may be counted twice">≈</span>' : ''}</td>${group !== 'file' ? `<td class="r">${r.files ?? 1}</td>` : ''}<td class="r chg-a">${r.binary && !r.added ? '<span class="chg-bin">bin</span>' : r.git ? compact(r.added) : '<span class="muted" title="no commit in its sessions\' windows">·</span>'}</td><td class="r chg-r">${r.git && !(r.binary && !r.removed) ? compact(r.removed) : ''}</td><td class="chg-dc">${r.git ? divBar(r.added, r.removed, maxL) : ''}</td><td class="r">${r.edits || '<span class="muted">·</span>'}</td><td class="chg-nw">${sessDots(r.sessions, by)}</td><td>${wtChip(r.wt)}</td><td class="r muted" title="${esc(r.lastAt ? new Date(r.lastAt).toLocaleString() : '')}">${esc(r.lastAt ? ago(d.now, r.lastAt) : '')}</td></tr>`)
      .join('')}</table>`;
  }
  const more = rows.length > shown.length || hiddenNoise ? `<div class="foot">${rows.length > shown.length ? `${rows.length - shown.length} more ${unit.toLowerCase()}(s) not shown (raise “Rows”). ` : ''}${hiddenNoise ? `${hiddenNoise} lock / build file(s) hidden.` : ''}</div>` : '';
  return tb + body + more + drill(d, st, rows.find(r => hid(r.id) === pick), all, by, group, depth);
}

function drill(d: WsData, st: WsState, r: FileRow | undefined, all: FileRow[], by: Map<string, AgentSessionSnapshot>, group: GroupBy, depth: number): string {
  const pick = opt(st, 'changes.pick', '');
  if (!pick) return '';
  if (!r) return `<div class="foot">Selected row not in this view. <button class="link" data-opt="changes.pick" data-val="">clear</button></div>`;
  const ss = r.sessions.map(k => by.get(k)).filter((s): s is AgentSessionSnapshot => !!s).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const members = group === 'file' ? [r] : all.filter(x => x.repo === r.repo && (group === 'repo' || folderOf(x.path, depth) === r.path)).sort((a, b) => churn(b) - churn(a) || b.edits - a.edits);
  const file = openArg(r, d, by);
  const acts = file ? `${actBtn('open', file, 'Open file', 'Open in the editor')} ${actBtn('copy', file, 'Copy path')}` : '';
  let h = `<div class="chg-drill"><h2>${esc(r.repo)} · ${esc(r.path || '(whole repo)')} ${pm(r.added, r.removed, r.binary)} <span class="muted">${r.edits} edit call(s)</span> ${wtChip(r.wt)} ${acts} <button class="link" data-opt="changes.pick" data-val="" title="close">✕</button></h2>`;
  if (members.length > 1) {
    h += `<table class="chg-t chg-mini"><tr><th>File</th><th class="r">+</th><th class="r">−</th><th class="r">Edits</th><th>Uncommitted</th></tr>${members
      .slice(0, 30)
      .map(m => `<tr><td>${fileName(m.path)}</td><td class="r chg-a">${m.git ? compact(m.added) : ''}</td><td class="r chg-r">${m.git ? compact(m.removed) : ''}</td><td class="r">${m.edits || ''}</td><td>${wtChip(m.wt)}</td></tr>`)
      .join('')}</table>${members.length > 30 ? `<div class="muted">… ${members.length - 30} more</div>` : ''}`;
  }
  h += ss.length
    ? `<table class="chg-t chg-mini"><tr><th>Session</th><th>Provider</th><th>Branch</th><th class="r">Edit calls here</th><th class="r">Last activity</th></tr>${ss
        .slice(0, 40)
        .map(s => {
          const e = (s.facts?.files ?? []).filter(f => (group === 'file' ? factPath(s, f.path) === r.path : group === 'repo' || folderOf(factPath(s, f.path), depth) === r.path)).reduce((a, f) => a + f.edits, 0);
          return `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}" tabindex="0"><td><span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 70))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted">${esc([s.provider, prettyModel(s.model)].filter(Boolean).join(' · '))}</td><td class="muted">${esc(s.branch ?? '')}</td><td class="r">${e || ''}</td><td class="r muted">${esc(ago(d.now, s.lastActivityAt))}</td></tr>`;
        })
        .join('')}</table>`
    : `<div class="muted">No session in this period touched it; it is uncommitted in a worktree agents use.</div>`;
  return h + '</div>';
}

// ---------------------------------------------------------------- sessions tab

function sessionsTab(d: WsData, st: WsState, c: Cfg, data: ChangesData | undefined): string {
  const shared = sharedWindows(d.sessions, d.now);
  const byKey = new Map(d.sessions.map(s => [s.key, s]));
  const sb = (s: AgentSessionSnapshot) => sharedBadge(shared.get(s.key), s.commits.length, byKey);
  const who = opt(st, 'changes.who', 'leads');
  const sort = opt(st, 'changes.ssort', 'recent');
  const layout = opt(st, 'changes.slayout', 'table');
  let rows = sessionRows(d.sessions, data, c.from).filter(r => who === 'all' || !r.s.isWorker || !d.sessions.some(p => p.key === r.s.parentSessionId));
  const live = (r: SessionRow) => (isLive(r.s) ? 1 : 0);
  rows.sort(sort === 'churn' ? (a, b) => b.added + b.removed - (a.added + a.removed) : sort === 'files' ? (a, b) => b.files - a.files : (a, b) => live(b) - live(a) || (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));
  const tb = toolbar(
    seg(st, 'changes.who', [['leads', 'Leads (workers folded)'], ['all', 'All sessions']], 'leads'),
    seg(st, 'changes.ssort', [['recent', 'Live first'], ['churn', 'Churn'], ['files', 'Files']], 'recent', 'Sort'),
    seg(st, 'changes.slayout', [['table', 'Table'], ['cards', 'Cards']], 'table', 'Layout'),
  );
  if (!rows.length) return tb + `<div class="empty">No session with a file change in this period.</div>`;
  rows = rows.slice(0, 150);
  const topFiles = (r: SessionRow, n: number) => r.top.slice(0, n).map(f => `<span class="chg-tf" title="${esc(`${f.path} · +${f.added} −${f.removed} · ${f.edits} edit call(s)`)}">${esc(f.path.split('/').pop())}${f.added || f.removed ? ` <span class="chg-a">+${compact(f.added)}</span><span class="chg-r">−${compact(f.removed)}</span>` : f.edits ? ` <span class="muted">×${f.edits}</span>` : ''}</span>`).join('');
  const lines = (r: SessionRow) => (r.diff ? pm(r.added, r.removed) : r.added || r.removed ? `<span title="provider-recorded line counts (edit tools only)">${pm(r.added, r.removed)}</span>` : '<span class="muted" title="no commit in its window">·</span>');
  let h: string;
  if (layout === 'cards') {
    h = `<div class="chg-cards">${rows
      .map(r => `<div class="chg-card${st.selected === r.s.key ? ' sel' : ''}" style="--id:${identityColor(repoOf(r.s))}" data-select="${esc(r.s.key)}" tabindex="0"><div class="chg-ch"><span class="dot ${esc(r.s.status)}"></span><b>${esc(titleOf(r.s).slice(0, 60))}</b><span class="right">${lines(r)}</span></div><div class="muted">${esc([repoOf(r.s), r.s.branch, r.s.provider, prettyModel(r.s.model)].filter(Boolean).join(' · '))}</div><div>${r.files} file(s) · ${r.edits} edit call(s) · ${r.s.commits.length} commit(s)${sb(r.s)} ${isLive(r.s) || r.wt ? wtSummary(r.wt) : ''}</div><div class="chg-tfs">${topFiles(r, 6)}</div></div>`)
      .join('')}</div>`;
  } else {
    h = `<table class="chg-t"><tr><th>Session</th><th>Repo · branch</th><th>Who</th><th class="r" title="${esc(EV.lines)}">Lines</th><th class="r">Files</th><th class="r" title="${esc(EV.edits)}">Edits</th><th class="r" title="commits observed during the session window">Commits</th><th title="${esc(EV.wt)}">Worktree now</th><th>Top files</th><th class="r">Last</th></tr>${rows
      .map(r => `<tr class="${st.selected === r.s.key ? 'sel' : ''}" data-select="${esc(r.s.key)}" tabindex="0"><td><span class="dot ${esc(r.s.status)}"></span> ${esc(titleOf(r.s).slice(0, 56))}${r.s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted"><span class="chg-sw" style="background:${identityColor(repoOf(r.s))}"></span>${esc(repoOf(r.s))}${r.s.branch ? ` · ${esc(r.s.branch)}` : ''}</td><td class="muted chg-nw"><span class="chg-pv ${r.s.provider}"></span>${esc(prettyModel(r.s.model) || r.s.provider)}</td><td class="r chg-nw">${lines(r)}</td><td class="r">${r.files}</td><td class="r">${r.edits || ''}</td><td class="r">${r.s.commits.length || ''}${sb(r.s)}</td><td>${wtSummary(r.wt, true)}</td><td class="chg-tfs">${topFiles(r, 3)}</td><td class="r muted">${esc(ago(d.now, r.s.lastActivityAt))}</td></tr>`)
      .join('')}</table>`;
  }
  const sel = rows.find(r => r.s.key === st.selected);
  if (sel) {
    const maxL = Math.max(1, ...sel.top.map(f => Math.max(f.added, f.removed)));
    h += `<div class="chg-drill"><h2>${esc(titleOf(sel.s).slice(0, 80))} · ${sel.files} file(s) ${lines(sel)}${sel.diff ? ` <span class="muted" title="${esc(EV.lines)}">${esc(sel.diff.from.slice(0, 7))}..${esc(sel.diff.to.slice(0, 7))}</span>` : ''}${sb(sel.s)}</h2><table class="chg-t chg-mini"><tr><th>File</th><th class="r">+</th><th class="r">−</th><th></th><th class="r">Edits</th></tr>${sel.top
      .slice(0, 60)
      .map(f => `<tr><td>${fileName(f.path)}</td><td class="r chg-a">${sel.diff ? compact(f.added) : ''}</td><td class="r chg-r">${sel.diff ? compact(f.removed) : ''}</td><td class="chg-dc">${sel.diff ? divBar(f.added, f.removed, maxL) : ''}</td><td class="r">${f.edits || ''}</td></tr>`)
      .join('')}</table>${sel.top.length > 60 ? `<div class="muted">… ${sel.top.length - 60} more</div>` : ''}</div>`;
  }
  return tb + h;
}

// ---------------------------------------------------------------- worktrees tab

function worktreesTab(d: WsData, st: WsState, data: ChangesData | undefined, by: Map<string, AgentSessionSnapshot>): string {
  const show = opt(st, 'changes.wshow', 'dirty');
  const layout = opt(st, 'changes.wlayout', 'cards');
  const tb = toolbar(
    seg(st, 'changes.wshow', [['dirty', 'With uncommitted work'], ['live', 'With live sessions'], ['all', 'All inspected']], 'dirty', 'Which worktrees'),
    seg(st, 'changes.wlayout', [['cards', 'Cards'], ['table', 'Table']], 'cards', 'Layout'),
  );
  if (!data) return tb + loading('changes.git', 'Reading worktrees…', { retry: 'refresh' });
  const liveOf = (w: WorktreeChanges) => w.sessions.map(k => by.get(k)).filter((s): s is AgentSessionSnapshot => !!s && isLive(s));
  const wts = data.worktrees.filter(w => (show === 'dirty' ? wtCounts(w).dirty || !!w.error : show === 'live' ? liveOf(w).length > 0 : true));
  if (!wts.length) return tb + `<div class="empty">${data.worktrees.length ? `All ${data.worktrees.length} inspected worktree(s) are clean.` : 'No worktree of a live or recently active session.'}</div>`;
  const name = (w: WorktreeChanges) => `${esc(base(w.repository) || base(w.worktree))}${w.branch ? ` · <span class="chg-br2">${esc(w.branch)}</span>` : ''}${w.repository && normalizeCase(w.repository) !== normalizeCase(w.worktree) ? ` · <span class="muted" title="linked worktree">wt ${esc(wtLabel(w))}</span>` : ''}`;
  const acts = (w: WorktreeChanges) => `${actBtn('reveal', w.worktree, 'Reveal', 'Reveal the folder in the OS file explorer')} ${actBtn('copy', w.worktree, 'Copy path')}`;
  if (layout === 'table') {
    return (
      tb +
      `<table class="chg-t"><tr><th>Worktree</th><th>Sessions</th><th class="r" title="staged files">Staged</th><th class="r" title="modified, not staged">Modified</th><th class="r">Untracked</th><th class="r">Conflicts</th><th class="r" title="tracked lines, staged + unstaged">Lines</th><th></th></tr>${wts
        .map(w => {
          const k = wtCounts(w);
          return `<tr><td title="${esc(w.worktree)}"><span class="chg-sw" style="background:${identityColor(base(w.repository) || base(w.worktree))}"></span>${name(w)}${w.error ? ` <span class="chg-r" title="${esc(w.error)}">git ?</span>` : ''}</td><td class="chg-nw">${sessDots(w.sessions, by)}</td><td class="r">${k.staged || ''}</td><td class="r">${k.unstaged || ''}</td><td class="r">${k.untracked || ''}</td><td class="r chg-r">${k.conflicts || ''}</td><td class="r chg-nw">${k.added || k.removed ? pm(k.added, k.removed) : ''}</td><td class="chg-nw">${acts(w)}</td></tr>`;
        })
        .join('')}</table>`
    );
  }
  return (
    tb +
    `<div class="chg-wts">${wts
      .map(w => {
        const files: { p: string; st: WtFileState; a: number; r: number }[] = [];
        const m = new Map<string, { p: string; st: WtFileState; a: number; r: number }>();
        for (const r of w.staged) m.set(r.path, { p: r.path, st: 'staged', a: r.added, r: r.removed });
        for (const r of w.unstaged) {
          const e = m.get(r.path);
          if (e) Object.assign(e, { st: 'both', a: e.a + r.added, r: e.r + r.removed });
          else m.set(r.path, { p: r.path, st: 'unstaged', a: r.added, r: r.removed });
        }
        for (const p of w.untracked) if (!m.has(p)) m.set(p, { p, st: 'untracked', a: 0, r: 0 });
        for (const p of w.conflicts) m.set(p, { ...(m.get(p) ?? { p, a: 0, r: 0 }), st: 'conflict' });
        files.push(...[...m.values()].sort((a, b) => Number(b.st === 'conflict') - Number(a.st === 'conflict') || b.a + b.r - (a.a + a.r) || a.p.localeCompare(b.p)));
        const live = liveOf(w);
        return `<div class="chg-wt${live.length ? ' live' : ''}" style="--id:${identityColor(base(w.repository) || base(w.worktree))}"><div class="chg-wh"><b title="${esc(w.worktree)}">${name(w)}</b><span class="right">${wtSummary(w)}</span></div><div class="chg-wm">${sessDots(w.sessions, by, 10)} <span class="muted">${live.length ? `${live.length} live` : 'no live session'} · checked ${esc(hhmm(w.at))}</span> <span class="right">${acts(w)}</span></div>${files.length ? `<div class="chg-wf">${files
          .slice(0, 14)
          .map(f => `<div class="chg-wfr"><span class="chg-st chg-${f.st}" title="${esc(STATE_TXT[f.st])}">${STATE_LETTER[f.st]}</span>${fileName(f.p, 60)}<span class="chg-nw">${f.a || f.r ? pm(f.a, f.r) : ''}</span>${f.st !== 'conflict' && !f.p.endsWith('/') ? actBtn('open', path.join(w.worktree, f.p), '↗', 'Open in the editor', 'link chg-op') : ''}</div>`)
          .join('')}${files.length > 14 ? `<div class="muted">… ${files.length - 14} more</div>` : ''}</div>` : ''}</div>`;
      })
      .join('')}</div><div class="legend"><span class="chg-st chg-staged">S</span>staged <span class="chg-st chg-unstaged">M</span>modified <span class="chg-st chg-both">SM</span>both <span class="chg-st chg-untracked">?</span>untracked <span class="chg-st chg-conflict">!</span>conflict · ${esc(EV.wt)}</div>`
  );
}

// ---------------------------------------------------------------- heat tab

function heatTab(d: WsData, st: WsState, c: Cfg): string {
  const gran = opt(st, 'changes.gran', c.period === '24h' ? 'hour' : 'day') as Gran;
  const orient = opt(st, 'changes.orient', 'rows');
  const top = Number(opt(st, 'changes.htop', '25')) || 25;
  const tb = toolbar(
    seg(st, 'changes.gran', [['hour', 'Hour'], ['day', 'Day']], c.period === '24h' ? 'hour' : 'day', 'Granularity'),
    seg(st, 'changes.orient', [['rows', 'Files as rows'], ['cols', 'Files as columns']], 'rows', 'Orientation'),
    seg(st, 'changes.htop', [['15', 'Top 15'], ['25', '25'], ['50', '50']], '25', 'Files'),
  );
  const events = d.timeline?.(undefined, 200_000) ?? d.events;
  const h = heat(d.sessions, events, { from: c.from, now: d.now, gran: gran === 'day' ? 'day' : 'hour', top });
  if (!h.rows.length) return tb + `<div class="empty">No file edit event in this period.</div>`;
  const lab = (t: number, i: number) => {
    const x = new Date(t);
    if (h.gran === 'day') return `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return x.getHours() === 0 || i === 0 ? `${String(x.getDate()).padStart(2, '0')}·${String(x.getHours()).padStart(2, '0')}h` : `${String(x.getHours()).padStart(2, '0')}`;
  };
  const cell = (v: number, r: (typeof h.rows)[number], t: number) => {
    const pct = v ? Math.round(18 + (82 * v) / Math.max(1, h.max)) : 0;
    return `<i class="${pct > 60 ? 'hi' : ''}" style="${v ? `background:color-mix(in srgb, var(--warn) ${pct}%, transparent)` : ''}" title="${esc(`${r.path} · ${new Date(t).toLocaleString()} · ${v} edit(s)`)}">${v || ''}</i>`;
  };
  const rowLab = (r: (typeof h.rows)[number]) => `<span class="chg-hl" title="${esc(`${r.repo} · ${r.path} · ${r.total} edit(s) by ${r.sessions} session(s)`)}"><span class="chg-sw" style="background:${identityColor(r.repo)}"></span>${esc(r.path.split('/').pop())}</span>`;
  let g: string;
  if (orient === 'cols') {
    g = `<div class="chg-hm" style="grid-template-columns:minmax(64px,max-content) repeat(${h.rows.length}, minmax(26px,1fr))"><span></span>${h.rows.map(r => `<span class="chg-hv">${rowLab(r)}</span>`).join('')}`;
    h.buckets.forEach((t, i) => {
      g += `<span class="chg-hh">${esc(lab(t, i))}</span>${h.rows.map(r => cell(r.cells[i], r, t)).join('')}`;
    });
    g += `<span class="chg-hh">Σ</span>${h.rows.map(r => `<span class="chg-hs">${r.total}</span>`).join('')}</div>`;
  } else {
    g = `<div class="chg-hm" style="grid-template-columns:minmax(120px,max-content) repeat(${h.buckets.length}, minmax(18px,1fr)) minmax(30px,max-content)"><span></span>${h.buckets.map((t, i) => `<span class="chg-hh">${esc(lab(t, i))}</span>`).join('')}<span class="chg-hh">Σ</span>`;
    for (const r of h.rows) g += `${rowLab(r)}${r.cells.map((v, i) => cell(v, r, h.buckets[i])).join('')}<span class="chg-hs">${r.total}</span>`;
    g += '</div>';
  }
  return tb + g + `<div class="legend"><span>Edit tool calls per ${esc(h.gran)} (OBSERVED events; file matched to the session's recorded files by name, DERIVED).</span>${h.unmatched ? `<span title="multi-file patches and events without a file name">${h.unmatched} multi-file event(s) not split</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = conf(st, d.now);
  const fs0 = feedValue<ChangesData>(FEED_ID);
  const data = fs0.value;
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const rows = fileRows(d.sessions, data, c.from);
  const added = rows.reduce((a, r) => a + r.added, 0);
  const removed = rows.reduce((a, r) => a + r.removed, 0);
  const edits = rows.reduce((a, r) => a + r.edits, 0);
  const dirty = (data?.worktrees ?? []).filter(w => wtCounts(w).dirty);
  const dirtyLive = dirty.filter(w => w.sessions.some(k => by.get(k) && isLive(by.get(k)!)));
  const conflicts = (data?.worktrees ?? []).reduce((a, w) => a + w.conflicts.length, 0);
  const hot = [...rows].sort((a, b) => b.edits - a.edits)[0];
  const kpis = `<div class="kpis chg-k">${kpi(rows.filter(r => r.sessions.length).length, 'files touched', '', 'files with a commit-window diff or an edit call in the period')}${kpi(`+${compact(added)}`, 'lines added', 'chg-ka', EV.lines)}${kpi(`−${compact(removed)}`, 'lines removed', 'chg-kr', EV.lines)}${kpi(edits, 'edit calls', '', EV.edits)}${kpi(`${dirtyLive.length}/${dirty.length}`, 'dirty worktrees live/all', dirtyLive.length ? 'k-need' : '', EV.wt)}${conflicts ? kpi(conflicts, 'conflicts', 'k-fail', 'files in merge conflict now') : ''}${hot && hot.edits ? kpi(hot.path.split('/').pop() ?? '', `most edited · ${hot.edits}×`, '', `${hot.repo} · ${hot.path}`) : ''}</div>`;
  const chips = dirtyLive.length
    ? `<div class="chg-chips">${dirtyLive
        .map(w => `<button class="chg-chip" data-opt="changes.tab" data-val="worktrees" style="--id:${identityColor(base(w.repository) || base(w.worktree))}" title="${esc(w.worktree)}"><b>${esc(base(w.repository) || base(w.worktree))}</b>${w.branch ? ` <span class="muted">${esc(w.branch)}</span>` : ''} ${wtSummary(w, true)}</button>`)
        .join('')}</div>`
    : '';
  const src = data?.off
    ? `<span class="chg-off" title="${esc(data.off)}">git off · ${esc(data.off)}</span>`
    : fs0.error
      ? `<span class="chg-r" title="${esc(fs0.error)}">git error</span> ${actBtn('refresh', '', 'Retry', 'Run the read-only git commands again now')}`
      : data
        ? `<span class="muted" title="read-only hardened git, 5 s timeout per call">git ${data.calls} call(s) · ${data.ms} ms${data.failed ? ` · ${data.failed} failed` : ''}${data.skipped ? ` · ${data.skipped} older window(s) skipped` : ''} · ${esc(hhmm(fs0.at))}</span>`
        : loading('changes.git', 'reading git…', { retry: 'refresh', inline: true });
  const tb = toolbar(
    seg(st, 'changes.tab', [['files', 'Files'], ['sessions', 'Sessions'], ['worktrees', 'Uncommitted'], ['heat', 'Edit heat']], 'files', 'View'),
    seg(st, 'changes.period', [['24h', '24 h'], ['7d', '7 d'], ['all', 'All loaded']], '24h', 'Period (session last activity); uncommitted state is always now'),
    src,
  );
  const body = c.tab === 'sessions' ? sessionsTab(d, st, c, data) : c.tab === 'worktrees' ? worktreesTab(d, st, data, by) : c.tab === 'heat' ? heatTab(d, st, c) : filesTab(d, st, c, data, by);
  return `<div class="chg">${tb}${kpis}${chips}${body}</div>`;
}

// ---------------------------------------------------------------- actions

const FORBIDDEN = /(^|[\\/])(\.credentials\.json|auth\.json|\.env(\.[^\\/]*)?|id_[a-z0-9]+|[^\\/]*\.(pem|key|p12|pfx))$/i;

/** Accepts only an absolute path inside a worktree of a current session; never auth or key files. */
export function allowedPath(p: string, sessions: AgentSessionSnapshot[]): boolean {
  if (!isPlausibleLocalPath(p) || p.length > 1000 || FORBIDDEN.test(p)) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false;
  const n = normalizeCase(path.resolve(p));
  return sessions.some(s => {
    if (!s.worktree) return false;
    const w = normalizeCase(path.resolve(s.worktree));
    const rel = path.relative(w, n);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

async function guarded(arg: string, ctx: ActCtx, fn: (p: string) => Promise<void>): Promise<void> {
  if (!allowedPath(arg, ctx.sessions())) {
    ctx.info('Changes: path is not inside a worktree agents use.');
    return;
  }
  await fn(arg);
}

export const changesView: ExtraView = {
  id: 'changes',
  label: 'Changes',
  group: 'Change',
  hint: 'Files changed by sessions: per-file +/− over commit windows, edit calls, uncommitted work per worktree, edit heat.',
  ready: true,
  render,
  feeds: [changesFeed as Feed],
  badge(d) {
    const v = feedValue<ChangesData>(FEED_ID).value;
    if (!v) return '';
    const live = new Set(d.sessions.filter(isLive).map(s => s.key));
    return String(v.worktrees.filter(w => wtCounts(w).dirty && w.sessions.some(k => live.has(k))).length || '');
  },
  actions: {
    refresh: (_arg, ctx) => ctx.refreshFeeds(),
    open: (arg, ctx) =>
      guarded(arg, ctx, async p => {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return ctx.info('Changes: file no longer exists (deleted or renamed).');
        await ctx.openFile(p);
      }),
    reveal: (arg, ctx) => guarded(arg, ctx, p => ctx.revealInOs(p)),
    copy: (arg, ctx) => guarded(arg, ctx, p => ctx.copy(p)),
  },
  css: `
.chg .chg-k { margin: 4px 0 8px; }
.chg .chg-t td.chg-repo { white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.chg .chg-ka b, .chg .chg-a { color: var(--ok); }
.chg .chg-kr b, .chg .chg-r { color: var(--bad); }
.chg .chg-a, .chg .chg-r { font-variant-numeric: tabular-nums; }
.chg .chg-warn { color: var(--warn); cursor: help; }
.chg .chg-shared { color: var(--warn); border: 1px dashed var(--warn); border-radius: 3px; padding: 0 3px; font-size: 0.85em; white-space: nowrap; cursor: help; }
.chg .chg-off { color: var(--quiet); }
.chg .chg-bin { font-size: 10px; color: var(--vscode-descriptionForeground); border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.chg .chg-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
.chg .chg-pv { display: inline-block; width: 3px; height: 10px; border-radius: 1px; margin-right: 5px; vertical-align: -1px; background: var(--quiet); }
.chg .chg-pv.claude, .chg .chg-sd.claude { background: var(--claude); }
.chg .chg-pv.codex, .chg .chg-sd.codex { background: var(--codex); }
.chg .chg-sd { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 2px; opacity: .55; cursor: pointer; vertical-align: 0; }
.chg .chg-sd.live { opacity: 1; box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok) 55%, transparent); }
.chg .chg-nw { white-space: nowrap; }
.chg .chg-fn { white-space: nowrap; }
.chg .chg-dir { color: var(--vscode-descriptionForeground); }
.chg .chg-fn b { font-weight: 600; }
.chg table.chg-t { font-size: 12px; border-collapse: collapse; width: 100%; max-width: 1280px; }
.chg table.chg-t th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 2px 6px; white-space: nowrap; }
.chg table.chg-t td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: middle; }
.chg table.chg-t .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chg table.chg-t tr[data-opt]:hover, .chg table.chg-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
.chg table.chg-t tr.on, .chg table.chg-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.chg table.chg-mini { max-width: 980px; margin-top: 4px; }
.chg .chg-dc { width: 18%; min-width: 80px; }
.chg .chg-div { position: relative; display: block; height: 9px; background: var(--raise); border-radius: 2px; }
.chg .chg-div::after { content: ''; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px; background: var(--line); }
.chg .chg-div i { position: absolute; top: 0; height: 100%; }
.chg .chg-div .chg-da { left: 50%; background: var(--ok); border-radius: 0 2px 2px 0; opacity: .85; }
.chg .chg-div .chg-dr { right: 50%; background: var(--bad); border-radius: 2px 0 0 2px; opacity: .85; }
.chg .chg-st { display: inline-block; font-size: 10px; font-weight: 600; line-height: 14px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); margin-right: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chg .chg-staged { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 60%, transparent); }
.chg .chg-unstaged, .chg .chg-both, .chg .chg-dirty { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.chg .chg-untracked { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
.chg .chg-conflict, .chg .chg-err { color: var(--bad); border-color: var(--bad); }
.chg .chg-clean { color: var(--quiet); }
.chg .chg-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.chg .chg-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 12px; background: var(--raise); color: var(--vscode-foreground); padding: 2px 8px; cursor: pointer; font: inherit; font-size: 11px; }
.chg .chg-bars { display: grid; gap: 2px; max-width: 1100px; }
.chg .chg-br { display: grid; grid-template-columns: 10px minmax(160px, 38%) minmax(0, 1fr) 110px 80px; gap: 6px; align-items: center; padding: 1px 4px; border-radius: 3px; font-size: 12px; cursor: pointer; }
.chg .chg-br:hover, .chg .chg-br.on { background: var(--vscode-list-hoverBackground); }
.chg .chg-br.on { outline: 1px solid var(--vscode-focusBorder); }
.chg .chg-bl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg .chg-bv { text-align: right; white-space: nowrap; }
.chg .chg-eb { display: block; height: 10px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.chg .chg-eb i { display: block; height: 100%; background: var(--warn); opacity: .8; }
.chg .chg-tm { position: relative; height: 400px; max-width: 1100px; border-radius: 4px; overflow: hidden; }
.chg .chg-tmc { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background, #0000); background: color-mix(in srgb, var(--c) 70%, transparent); color: var(--vscode-editor-foreground, var(--vscode-foreground)); padding: 3px 5px; overflow: hidden; font-size: 11px; display: flex; flex-direction: column; cursor: pointer; }
.chg .chg-tmc:hover, .chg .chg-tmc.on { background: var(--c); outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; z-index: 1; }
.chg .chg-tmc b, .chg .chg-tmc span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 3px var(--vscode-editor-background, #0008); }
.chg .chg-drill { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 4px; }
.chg .chg-drill h2 { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chg .chg-tfs { max-width: 420px; }
.chg .chg-tf { display: inline-block; font-size: 11px; margin-right: 8px; white-space: nowrap; }
.chg .chg-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.chg .chg-card { border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 6px; padding: 6px 9px; background: var(--raise); display: grid; gap: 3px; font-size: 12px; cursor: pointer; min-width: 0; }
.chg .chg-card.sel { outline: 1px solid var(--vscode-focusBorder); }
.chg .chg-ch, .chg .chg-wh, .chg .chg-wm { display: flex; gap: 6px; align-items: center; min-width: 0; }
.chg .chg-ch b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg .right { margin-left: auto; }
.chg .chg-wts { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 8px; }
.chg .chg-wt { border: 1px solid var(--line); border-top: 3px solid var(--id); border-radius: 6px; padding: 6px 9px; background: var(--raise); display: grid; align-content: start; gap: 4px; font-size: 12px; min-width: 0; }
.chg .chg-wt.live { box-shadow: inset 3px 0 0 var(--ok); }
.chg .chg-br2 { font-weight: 400; color: var(--accent); }
.chg .chg-wf { display: grid; gap: 1px; }
.chg .chg-wfr { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto 18px; gap: 4px; align-items: center; overflow: hidden; }
.chg .chg-wfr > .chg-st { justify-self: start; }
.chg .chg-wfr .chg-fn { overflow: hidden; text-overflow: ellipsis; }
.chg .chg-op { padding: 0; }
.chg .chg-hm { display: grid; gap: 2px; font-size: 10px; max-width: 1280px; overflow-x: auto; }
.chg .chg-hm i { height: 18px; min-width: 14px; border-radius: 2px; border: 1px solid color-mix(in srgb, var(--line) 60%, transparent); font-style: normal; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; color: var(--vscode-foreground); }
.chg .chg-hm i.hi { font-weight: 700; }
.chg .chg-hh { color: var(--vscode-descriptionForeground); text-align: center; white-space: nowrap; overflow: hidden; align-self: end; }
.chg .chg-hl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; align-self: center; font-size: 11px; }
.chg .chg-hv { writing-mode: vertical-rl; transform: rotate(180deg); max-height: 140px; justify-self: center; }
.chg .chg-hv .chg-hl { padding: 0; }
.chg .chg-hs { color: var(--vscode-descriptionForeground); align-self: center; text-align: right; font-variant-numeric: tabular-nums; }
`,
};
