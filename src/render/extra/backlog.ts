// Add-on screen "Backlog": packages and checklist items found in the plan files of the repositories agents
// touched (handoff/PLAN.md, ROADMAP.md, PLAN.md, TODO.md …), their state and age, the sessions that mention
// each package id, and a weekly archive of what closed. Read-only; parsing in src/activity/backlog.ts,
// fs reads in src/feeds/backlog.ts. Everything printed is escaped here.
import type { AgentSessionSnapshot } from '../../model';
import {
  BacklogItem, BacklogReport, fileKey, isoWeek, ItemState, Link, linkSessions, PlanFile, repoRootOf, SHAPE_LABEL, sessionRoot, STATE_LABEL,
  STATES, weekly, WHEN_LABEL,
} from '../../activity/backlog';
import { duration } from '../../activity/activity';
import { compact, identityColor } from '../../activity/insights';
import { MAX_BYTES, scanBacklog, uniqueRoots } from '../../feeds/backlog';
import { ARCHIVE_FEED, archiveFeed, ArchiveView, itemKey } from '../../archive/reader';
import * as path from 'path';
import { esc } from '../html';
import { ago, bytes, kpi, titleOf, WsData, WsState } from '../workspace';
import { actBtn, ActCtx, ExtraView, loadError, loading, opt, seg, toolbar } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';

export const BACKLOG_FEED = 'backlog.plans';
const FEED_ID = BACKLOG_FEED;

export interface BacklogFeedOut {
  report: BacklogReport;
  extra: string[];
}

function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.backlog.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`backlog.${name}`, fallback);
}

/** Repository roots of the sessions, most recent first (linked worktrees fold onto their main repo). */
function rootsOf(sessions: AgentSessionSnapshot[]): string[] {
  const seen = new Map<string, { p: string; t: number }>();
  for (const s of sessions) {
    const p = repoRootOf(s);
    if (!p) continue;
    const k = p.replace(/\\/g, '/').toLowerCase();
    const prev = seen.get(k);
    if (!prev || (s.lastActivityAt ?? 0) > prev.t) seen.set(k, { p, t: s.lastActivityAt ?? 0 });
  }
  return [...seen.values()].sort((a, b) => b.t - a.t).map(x => x.p);
}

export const backlogFeed: Feed<BacklogFeedOut> = {
  id: FEED_ID,
  intervalMs: 60_000,
  async load(ctx) {
    const max = Math.max(1, Math.min(200, Number(cfg<number>(ctx, 'maxRepos', 40)) || 40));
    const raw = cfg<unknown>(ctx, 'extraRoots', []);
    const extra = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
    const kb = Math.max(16, Math.min(1024, Number(cfg<number>(ctx, 'maxKB', MAX_BYTES / 1024)) || MAX_BYTES / 1024));
    const roots = await uniqueRoots([...extra, ...rootsOf(ctx.sessions)], max + extra.length);
    const report = await scanBacklog({ roots, now: ctx.now, maxBytes: kb * 1024, archive: cfg<boolean>(ctx, 'archive', true) !== false });
    return { report, extra };
  },
};

// ---------------------------------------------------------------- model for the view

interface Row {
  f: PlanFile;
  it: BacklogItem;
  links: Link[];
  /** Age reference: written date, else file mtime. */
  since: number;
  sinceBasis: 'dated' | 'file';
  /** Known only from Agent's daily archive: last day the item was seen. */
  arch?: string;
}

const nk = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let memo: { sig: string; links: Map<string, Link[]> } | undefined;

/** Item → sessions links for a report, memoised on (report time, session count, last activity). Shared with Scope map. */
export function backlogLinks(report: BacklogReport, sessions: AgentSessionSnapshot[]): Map<string, Link[]> {
  let last = 0;
  for (const s of sessions) last = Math.max(last, s.lastActivityAt ?? 0);
  const sig = `${report.at}|${report.files.length}|${sessions.length}|${last}`;
  if (memo?.sig !== sig) memo = { sig, links: linkSessions(report.files, sessions) };
  return memo.links;
}

interface Cfg {
  view: 'board' | 'table' | 'files' | 'weeks';
  state: 'pending' | 'all' | ItemState;
  group: 'repo' | 'file' | 'section' | 'none';
  orient: 'columns' | 'rows';
  sort: 'file' | 'age' | 'sessions' | 'id';
  link: 'all' | 'linked' | 'unlinked';
  gran: 'week' | 'day';
  span: number;
  archive: boolean;
  /** Include items kept in Agent's daily archive that are no longer in the plan files. */
  snap: boolean;
  file: string;
}

function conf(st: WsState): Cfg {
  const pick = <T extends string>(name: string, vals: readonly T[], fb: T): T => {
    const v = opt(st, `backlog.${name}`, fb);
    return (vals as readonly string[]).includes(v) ? (v as T) : fb;
  };
  return {
    view: pick('view', ['board', 'table', 'files', 'weeks'] as const, 'board'),
    state: pick('state', ['pending', 'all', ...STATES] as const, 'pending'),
    group: pick('group', ['repo', 'file', 'section', 'none'] as const, 'file'),
    orient: pick('orient', ['columns', 'rows'] as const, 'columns'),
    sort: pick('sort', ['file', 'age', 'sessions', 'id'] as const, 'file'),
    link: pick('link', ['all', 'linked', 'unlinked'] as const, 'all'),
    gran: pick('gran', ['week', 'day'] as const, 'week'),
    span: { '4': 4, '8': 8, '16': 16, '52': 52 }[opt(st, 'backlog.span', '8')] ?? 8,
    archive: opt(st, 'backlog.archive', 'hide') === 'show',
    snap: opt(st, 'backlog.snap', 'on') !== 'off',
    file: opt(st, 'backlog.file', ''),
  };
}

const keep = (c: Cfg, s: ItemState) => (c.state === 'all' ? true : c.state === 'pending' ? s === 'open' || s === 'active' || s === 'blocked' : s === c.state);

function sortRows(c: Cfg, rows: Row[]): Row[] {
  const out = [...rows];
  if (c.sort === 'age') out.sort((a, b) => a.since - b.since);
  else if (c.sort === 'sessions') out.sort((a, b) => b.links.length - a.links.length || a.since - b.since);
  else if (c.sort === 'id') out.sort((a, b) => (a.it.id ?? '~').localeCompare(b.it.id ?? '~', undefined, { numeric: true }));
  return out;
}

function groupKey(c: Cfg, r: Row): string {
  if (c.group === 'repo') return r.f.repo;
  if (c.group === 'file') return `${r.f.repo} · ${r.f.rel}`;
  if (c.group === 'section') return `${r.f.repo} › ${r.it.section || '(top)'}`;
  return '';
}

// ---------------------------------------------------------------- small parts

const STATE_ORDER: ItemState[] = ['open', 'active', 'blocked', 'done', 'dropped'];

function stPill(it: BacklogItem): string {
  const ev = it.shape === 'check' ? 'OBSERVED' : 'DERIVED';
  return `<span class="bl-st bl-${it.state}" title="${esc(`${STATE_LABEL[it.state]} · ${ev}: ${it.stateBasis} (${SHAPE_LABEL[it.shape]})`)}">${esc(STATE_LABEL[it.state])}</span>`;
}

function ageCell(d: WsData, r: Row): string {
  const t = r.since;
  const basis = r.sinceBasis === 'dated' ? WHEN_LABEL.dated : WHEN_LABEL.file;
  return `<span class="bl-age${r.sinceBasis === 'file' ? ' bl-weak' : ''}" title="${esc(`${new Date(t).toLocaleDateString()} · ${basis}`)}">${esc(duration(Math.max(0, d.now - t)))}</span>`;
}

function sessChips(d: WsData, st: WsState, ls: Link[], byKey: Map<string, AgentSessionSnapshot>, max = 4): string {
  if (!ls.length) return '';
  const ss = ls
    .map(l => ({ l, s: byKey.get(l.key) }))
    .filter((x): x is { l: Link; s: AgentSessionSnapshot } => !!x.s)
    .sort((a, b) => (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));
  const shown = ss.slice(0, max);
  const tok = ss.reduce((a, x) => a + (x.s.usage?.totalTokens ?? 0), 0);
  return `<span class="bl-ss">${shown
    .map(({ l, s }) => {
      const tip = `${titleOf(s)} · ${s.provider} · ${s.status}${s.branch ? ' · ' + s.branch : ''} · ${ago(d.now, s.lastActivityAt)} · INFERRED: ${l.via === 'branch' ? 'branch / worktree name' : 'title, last action or spawn text'} mentions the id`;
      return `<button class="bl-s ${esc(s.provider)}${st.selected === s.key ? ' on' : ''}" data-select="${esc(s.key)}" title="${esc(tip)}"><span class="sd ${esc(s.status)}"></span>${esc(titleOf(s).slice(0, 22))}</button>`;
    })
    .join('')}${ss.length > max ? `<span class="muted bl-more">+${ss.length - max}</span>` : ''}${tok ? `<span class="muted bl-tok" title="OBSERVED: provider-recorded tokens summed over the ${ss.length} linked session(s)">${esc(compact(tok))}</span>` : ''}</span>`;
}

function idChip(it: BacklogItem, repo: string): string {
  return it.id ? `<code class="bl-id" style="--id:${identityColor(repo)}">${esc(it.id)}</code>` : '';
}

function archTag(r: Row): string {
  return r.arch ? ` <span class="bl-archd" title="${esc(`ARCHIVED · OBSERVED in ${fileName(r.f)} on ${r.arch} by Agent's daily archive; no longer in the file today (state as last seen)`)}">ARCHIVED ${esc(r.arch)}</span>` : '';
}

function stack(counts: Record<ItemState, number>, wide = false): string {
  const total = STATE_ORDER.reduce((a, s) => a + counts[s], 0) || 1;
  return `<span class="bl-stack${wide ? ' wide' : ''}">${['done', 'active', 'blocked', 'open', 'dropped']
    .map(s => (counts[s as ItemState] ? `<i class="bl-${s}" style="width:${((100 * counts[s as ItemState]) / total).toFixed(2)}%" title="${esc(`${STATE_LABEL[s as ItemState]}: ${counts[s as ItemState]}`)}"></i>` : ''))
    .join('')}</span>`;
}

function countOf(items: BacklogItem[]): Record<ItemState, number> {
  const c = { open: 0, active: 0, blocked: 0, done: 0, dropped: 0 };
  for (const it of items) c[it.state]++;
  return c;
}

const fileName = (f: PlanFile) => `${f.repo}/${f.rel}`;

// ---------------------------------------------------------------- views

function tableView(d: WsData, st: WsState, c: Cfg, rows: Row[], byKey: Map<string, AgentSessionSnapshot>): string {
  if (!rows.length) return '<div class="empty">No item matches these filters.</div>';
  const groups = new Map<string, Row[]>();
  for (const r of sortRows(c, rows)) {
    const k = groupKey(c, r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let h = `<table class="bl-t"><tr><th>State</th><th>Id</th><th>Item</th>${c.group === 'section' ? '' : '<th>Section</th>'}<th class="r" title="Since the date written on the item or its heading, else since the file was modified">Age</th><th>Sessions</th><th></th></tr>`;
  for (const [k, rs] of groups) {
    if (k) h += `<tr class="bl-gh"><td colspan="7"><span class="bl-sw" style="background:${identityColor(rs[0].f.repo)}"></span>${esc(k)} <span class="muted">${rs.length}</span> ${stack(countOf(rs.map(r => r.it)))}</td></tr>`;
    h += rs
      .slice(0, 400)
      .map(
        r => `<tr class="bl-r bl-row-${r.it.state}"><td>${stPill(r.it)}</td><td>${idChip(r.it, r.f.repo)}</td><td class="bl-ti" style="padding-left:${6 + 12 * r.it.depth}px" title="${esc(`${r.it.title}\n${fileName(r.f)}:${r.it.line}`)}">${esc(r.it.title)}${archTag(r)}</td>${c.group === 'section' ? '' : `<td class="bl-sec muted" title="${esc(r.it.section)}">${esc(r.it.section)}</td>`}<td class="r">${ageCell(d, r)}</td><td>${sessChips(d, st, r.links, byKey)}</td><td class="bl-acts">${r.arch ? '' : actBtn('open', r.f.file, `L${r.it.line}`, `Open ${fileName(r.f)} (item on line ${r.it.line})`)}</td></tr>`,
      )
      .join('');
    if (rs.length > 400) h += `<tr><td colspan="7" class="muted">+${rs.length - 400} more in this group</td></tr>`;
  }
  return h + '</table>';
}

function boardView(d: WsData, st: WsState, c: Cfg, rows: Row[], byKey: Map<string, AgentSessionSnapshot>): string {
  const states = STATE_ORDER.filter(s => keep(c, s) && (s !== 'dropped' || c.state === 'dropped' || c.state === 'all'));
  const card = (r: Row) =>
    `<div class="bl-c bl-c-${r.it.state}" style="--id:${identityColor(r.f.repo)}" title="${esc(`${r.it.title}\n${fileName(r.f)}:${r.it.line} · ${r.it.section}`)}"><div class="bl-ch">${idChip(r.it, r.f.repo)}<span class="bl-ct">${esc(r.it.title)}</span></div><div class="bl-cm muted">${c.group === 'repo' || c.group === 'none' ? `${esc(r.f.repo)} · ` : ''}${esc(r.it.section.split(' › ').pop() ?? '')} · ${ageCell(d, r)} ${r.arch ? archTag(r) : actBtn('open', r.f.file, `L${r.it.line}`, `Open ${fileName(r.f)} (line ${r.it.line})`)}</div>${r.links.length ? `<div>${sessChips(d, st, r.links, byKey, 3)}</div>` : ''}</div>`;
  const cap = 60;
  const lane = (s: ItemState) => {
    const rs = sortRows(c, rows.filter(r => r.it.state === s));
    const ordered = s === 'done' && c.sort === 'file' ? [...rs].sort((a, b) => b.since - a.since) : rs;
    let inner = '';
    let last = '';
    for (const r of ordered.slice(0, cap)) {
      const g = c.group !== 'none' ? groupKey(c, r) : '';
      if (g && g !== last) inner += `<div class="bl-lg"><span class="bl-sw" style="background:${identityColor(r.f.repo)}"></span>${esc(g)}</div>`;
      last = g;
      inner += card(r);
    }
    if (ordered.length > cap) inner += `<div class="muted bl-more">+${ordered.length - cap} more · switch to Table</div>`;
    return `<div class="bl-lane"><div class="bl-lh"><span class="bl-st bl-${s}">${esc(STATE_LABEL[s])}</span> <b>${rs.length}</b></div><div class="bl-lb">${inner || '<div class="muted bl-none">none</div>'}</div></div>`;
  };
  return `<div class="bl-board ${c.orient}">${states.map(lane).join('')}</div>`;
}

function filesView(d: WsData, report: BacklogReport, files: PlanFile[], c: Cfg): string {
  if (!files.length) return '<div class="empty">No plan file in the repositories agents used.</div>';
  const maxItems = Math.max(...files.map(f => f.items.length), 1);
  let h = `<table class="bl-t bl-ft"><tr><th>Repository</th><th>File</th><th class="r">Items</th><th>Progress</th><th class="r">Done</th><th class="r">Open</th><th class="r">Active</th><th class="r">Blocked</th><th class="r">Size</th><th>Modified</th><th></th></tr>`;
  for (const f of files) {
    const n = countOf(f.items);
    const tot = f.items.length;
    const pct = tot ? Math.round((100 * n.done) / Math.max(1, tot - n.dropped)) : 0;
    const k = fileKey(f.file);
    h += `<tr class="bl-r${c.file === k ? ' on' : ''}${f.archive ? ' bl-arch' : ''}" data-opt="backlog.file" data-val="${esc(c.file === k ? '' : k)}" title="Click: show only this file in Board / Table"><td><span class="bl-sw" style="background:${identityColor(f.repo)}"></span>${esc(f.repo)}</td><td class="bl-path">${esc(f.rel)}${f.archive ? ' <span class="chip">archive</span>' : ''}</td><td class="r">${f.skipped ? `<span class="bl-warn">${esc(f.skipped)}</span>` : tot}</td><td><span class="bl-pw" style="width:${Math.max(8, (100 * tot) / maxItems).toFixed(1)}%">${stack(n, true)}</span></td><td class="r">${tot ? `${n.done} <span class="muted">${pct} %</span>` : ''}</td><td class="r">${n.open || ''}</td><td class="r">${n.active || ''}</td><td class="r bl-bad">${n.blocked || ''}</td><td class="r muted">${bytes(f.bytes)}</td><td class="muted" title="OBSERVED: ${esc(new Date(f.mtime).toLocaleString())}">${esc(ago(d.now, f.mtime))}</td><td class="bl-acts">${actBtn('open', f.file, 'Open', 'Open in the editor (read-only preview until you edit)')}${actBtn('reveal', f.file, 'Reveal', 'Reveal in the file explorer')}</td></tr>`;
    if (c.file === k && f.items.length) {
      const secs = new Map<string, BacklogItem[]>();
      for (const it of f.items) secs.set(it.section || '(top)', [...(secs.get(it.section || '(top)') ?? []), it]);
      h += [...secs]
        .map(([s, its]) => `<tr class="bl-sub"><td></td><td class="bl-sec" title="${esc(s)}">${esc(s)}</td><td class="r">${its.length}</td><td>${stack(countOf(its), true)}</td><td class="r">${countOf(its).done || ''}</td><td class="r">${countOf(its).open || ''}</td><td class="r">${countOf(its).active || ''}</td><td class="r bl-bad">${countOf(its).blocked || ''}</td><td colspan="3"></td></tr>`)
        .join('');
    }
  }
  h += '</table>';
  if (report.empty.length) h += `<div class="foot">No plan file in: ${report.empty.map(r => esc(r.replace(/\\/g, '/').split('/').pop() ?? r)).join(', ')}. Looked for handoff/PLAN.md, handoff/ROADMAP.md, PLAN.md, ROADMAP.md, TODO.md, docs/PLAN.md and handoff/archive/*.md.</div>`;
  return h;
}

function weeksView(d: WsData, st: WsState, c: Cfg, files: PlanFile[], lk: Map<string, Link[]>, byKey: Map<string, AgentSessionSnapshot>): string {
  const buckets = weekly(files, lk, byKey, d.now, c.gran === 'day' ? Math.min(c.span * 7, 62) : c.span, c.gran);
  const max = Math.max(...buckets.map(b => Math.max(b.done.length, b.added)), 1);
  const cols = [...buckets].reverse();
  const unit = c.gran === 'day' ? 'day' : 'week';
  let h = `<div class="bl-wk ${c.orient}">${cols
    .map(b => {
      const lab = c.gran === 'day' ? new Date(b.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : `${b.label.slice(5)} · ${new Date(b.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
      const tip = `${c.gran === 'day' ? b.label : `${b.label} (from ${new Date(b.start).toLocaleDateString()})`}: ${b.done.length} done, ${b.added} new pending item(s) dated that ${unit}, ${b.sessions.size} linked session(s)`;
      return `<div class="bl-wc" title="${esc(tip)}"><span class="bl-wv">${b.done.length || ''}</span><span class="bl-wbar"><i class="bl-done" style="--v:${((100 * b.done.length) / max).toFixed(1)}%"></i><i class="bl-open" style="--v:${((100 * b.added) / max).toFixed(1)}%"></i></span><span class="bl-wl">${esc(lab)}</span></div>`;
    })
    .join('')}</div><div class="foot bl-wlg"><span class="bl-k bl-done"></span> done in that ${unit} (when: latest linked ended session, else the date written on the item, else the file's modified time) · <span class="bl-k bl-open"></span> new pending items dated that ${unit}</div>`;
  const shown = buckets.filter(b => b.done.length);
  if (!shown.length) return h + '<div class="empty">Nothing closed in this period.</div>';
  for (const b of shown) {
    const head = c.gran === 'day' ? b.label : `${b.label} · ${new Date(b.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    h += `<div class="bl-wh"><b>${esc(head)}</b> <span class="muted">${b.done.length} done · ${b.sessions.size} session(s)</span></div><table class="bl-t">${b.done
      .slice(0, 120)
      .map(x => {
        const ls = lk.get(`${x.f.file}#${x.it.line}`) ?? [];
        return `<tr class="bl-r"><td class="muted bl-when" title="${esc(WHEN_LABEL[x.basis])}">${esc(new Date(x.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}${x.basis === 'file' ? ' ?' : ''}</td><td>${idChip(x.it, x.f.repo)}</td><td class="bl-ti" title="${esc(`${fileName(x.f)}:${x.it.line} · ${x.it.stateBasis}`)}">${esc(x.it.title)}</td><td class="muted bl-sec">${esc(x.f.repo)} · ${esc(x.f.rel)}${x.f.archive ? ' <span class="chip">archive</span>' : ''}</td><td>${sessChips(d, st, ls, byKey)}</td></tr>`;
      })
      .join('')}${b.done.length > 120 ? `<tr><td colspan="5" class="muted">+${b.done.length - 120} more</td></tr>` : ''}</table>`;
  }
  return h;
}

// ---------------------------------------------------------------- daily archive

/** Items of the daily archive's backlog snapshots that are no longer in today's plan files (in scope only). */
function archivedRows(av: ArchiveView | undefined, files: PlanFile[], inScope: (root: string) => boolean): Row[] {
  if (!av?.items.length) return [];
  const present = new Set<string>();
  for (const f of files) for (const it of f.items) present.add(itemKey(f.root, f.rel, it));
  const synth = new Map<string, PlanFile>();
  const out: Row[] = [];
  for (const a of av.items) {
    if (!inScope(a.root) || present.has(itemKey(a.root, a.rel, a.item))) continue;
    const fk = `${nk(a.root)}|${a.rel}`;
    let f = synth.get(fk);
    if (!f) synth.set(fk, (f = { root: a.root, repo: a.repo, rel: a.rel, file: path.join(a.root, ...a.rel.split('/')), bytes: 0, mtime: 0, archive: false, items: [] }));
    const seen = new Date(`${a.day}T12:00:00`).getTime();
    out.push({ f, it: a.item, links: [], since: a.item.dated ?? seen, sinceBasis: a.item.dated !== undefined ? 'dated' : 'file', arch: a.day });
  }
  return out;
}

// ---------------------------------------------------------------- render

function render(d: WsData, st: WsState): string {
  const fs = feedValue<BacklogFeedOut>(FEED_ID);
  const out = fs.value;
  if (!out) return fs.error ? loadError(`Could not read plan files: ${fs.error}`, 'refresh') : loading('backlog', 'Reading plan files…', { retry: 'refresh' });
  const { report } = out;
  const c = conf(st);
  // scope: only repositories of the sessions on screen, plus configured extra roots
  const inScope = new Set(d.sessions.map(sessionRoot).filter((x): x is string => !!x));
  const extra = new Set(out.extra.map(nk));
  const allFiles = report.files.filter(f => inScope.has(nk(f.root)) || extra.has(nk(f.root)));
  const byKey = new Map(d.sessions.map(s => [s.key, s]));
  const lk = backlogLinks({ ...report, files: allFiles }, d.sessions);
  const liveFiles = allFiles.filter(f => !f.archive || c.archive);
  const fileSel = c.file ? liveFiles.filter(f => fileKey(f.file) === c.file) : liveFiles;
  const files = fileSel.length ? fileSel : liveFiles;

  const all: Row[] = [];
  for (const f of files)
    for (const it of f.items) {
      const ls = lk.get(`${f.file}#${it.line}`) ?? [];
      all.push({ f, it, links: ls, since: it.dated ?? f.mtime, sinceBasis: it.dated !== undefined ? 'dated' : 'file' });
    }
  const av = feedValue<ArchiveView>(ARCHIVE_FEED).value;
  const archived = c.snap && !c.file ? archivedRows(av, allFiles, (root: string) => inScope.has(nk(root)) || extra.has(nk(root))) : [];
  all.push(...archived);
  const rows = all.filter(r => keep(c, r.it.state) && (c.link === 'all' || (c.link === 'linked') === r.links.length > 0));

  // KPIs over every item in scope (not the state filter)
  const n = countOf(all.map(r => r.it));
  const pending = n.open + n.active + n.blocked;
  const linked = all.filter(r => r.links.length).length;
  const oldest = all.filter(r => r.it.state === 'open' || r.it.state === 'blocked').reduce((m, r) => Math.min(m, r.since), Infinity);
  const wk = weekly(allFiles, lk, byKey, d.now, 1);
  const repos = new Set(files.map(f => f.repo)).size;
  let h = '<div class="bl">';
  h += `<div class="kpis">${kpi(liveFiles.length, 'Plan files', '', `OBSERVED: ${liveFiles.length} file(s) in ${repos} repo(s); ${allFiles.length - liveFiles.length} archive file(s) hidden`)}${kpi(all.length, 'Items', '', 'OBSERVED: checklist boxes, table rows with a state column, bold or heading lines that start with a package id')}${kpi(pending, 'Pending', '', 'DERIVED: open + active + blocked')}${kpi(n.active, 'Active', n.active ? 'k-run' : '')}${kpi(n.blocked, 'Blocked', n.blocked ? 'k-fail' : '')}${kpi(`${n.done}${all.length ? ` · ${Math.round((100 * n.done) / Math.max(1, all.length - n.dropped))} %` : ''}`, 'Done', '', 'DERIVED: done over items not dropped')}${kpi(linked, 'Linked to sessions', '', 'INFERRED: items whose id appears in a session branch, worktree, title, last action or spawn description (same repository)')}${kpi(Number.isFinite(oldest) ? duration(d.now - oldest) : '—', 'Oldest open', '', 'DERIVED: from the date written on the item / heading, else the file modified time')}${kpi(wk[0]?.done.length ?? 0, 'Done this week', '', 'INFERRED / DERIVED: see Weeks')}</div>`;
  const fsel = c.file ? liveFiles.find(f => fileKey(f.file) === c.file) : undefined;
  h += toolbar(
    seg(st, 'backlog.view', [['board', 'Board'], ['table', 'Table'], ['files', 'Files'], ['weeks', 'Weeks']], 'board', 'View'),
    c.view !== 'files' && c.view !== 'weeks' ? seg(st, 'backlog.state', [['pending', `Pending ${pending}`], ['open', 'Open'], ['active', 'Active'], ['blocked', 'Blocked'], ['done', 'Done'], ['all', 'All']], 'pending', 'State filter') : '',
    c.view === 'board' || c.view === 'table' ? seg(st, 'backlog.group', [['file', 'By file'], ['repo', 'By repo'], ['section', 'By section'], ['none', 'Flat']], 'file', 'Group by') : '',
    c.view === 'board' || c.view === 'weeks' ? seg(st, 'backlog.orient', [['columns', 'Columns'], ['rows', 'Rows']], 'columns', c.view === 'board' ? 'Board orientation: state columns side by side, or stacked state rows' : 'Chart orientation: vertical bars, or horizontal bars') : '',
    c.view === 'board' || c.view === 'table' ? seg(st, 'backlog.sort', [['file', 'File order'], ['age', 'Oldest'], ['sessions', 'Most sessions'], ['id', 'Id']], 'file', 'Sort') : '',
    c.view === 'board' || c.view === 'table' ? seg(st, 'backlog.link', [['all', 'All'], ['linked', 'With sessions'], ['unlinked', 'No session']], 'all', 'Sessions that mention the item id (INFERRED)') : '',
    c.view === 'weeks' ? seg(st, 'backlog.gran', [['week', 'Week'], ['day', 'Day']], 'week', 'Granularity') : '',
    c.view === 'weeks' ? seg(st, 'backlog.span', [['4', '4 w'], ['8', '8 w'], ['16', '16 w'], ['52', '1 y']], '8', 'Period') : '',
    c.view !== 'weeks' ? seg(st, 'backlog.archive', [['hide', 'Live plans'], ['show', '+ archive']], 'hide', 'Include handoff/archive/*.md (always counted in Weeks)') : '',
    c.view === 'board' || c.view === 'table' ? seg(st, 'backlog.snap', [['on', `+ Daily archive${archived.length ? ` ${archived.length}` : ''}`], ['off', 'Files only']], 'on', `Include items seen earlier by Agent's daily archive (npm run archive${av ? `, ${av.backlogDays.length} snapshot(s)` : ''}) that are no longer in the plan files: shown as ARCHIVED with the last day seen`) : '',
    fsel ? `<button class="pill on" data-opt="backlog.file" data-val="" title="Show every file" style="--id:${identityColor(fsel.repo)}">${esc(fileName(fsel))} ✕</button>` : '',
    `<span class="muted" title="${esc(new Date(report.at).toLocaleString())}">read ${esc(ago(d.now, report.at))}${fs.ms !== undefined ? ` in ${fs.ms} ms` : ''}</span>`,
    actBtn('refresh', '', 'Re-read', 'Read the plan files again'),
  );
  if (!allFiles.length) {
    h += `<div class="empty">No plan file found in the ${report.roots.length} repositor${report.roots.length === 1 ? 'y' : 'ies'} agents used${inScope.size ? '' : ' (no session in scope)'}. Looked for handoff/PLAN.md, handoff/ROADMAP.md, PLAN.md, ROADMAP.md, TODO.md, docs/PLAN.md. Add folders with the setting agent.backlog.extraRoots.</div>`;
    return h + '</div>';
  }
  h +=
    c.view === 'table'
      ? tableView(d, st, c, rows, byKey)
      : c.view === 'files'
        ? filesView(d, report, c.archive ? allFiles : allFiles.filter(f => !f.archive), c)
        : c.view === 'weeks'
          ? weeksView(d, st, c, fsel ? allFiles.filter(f => f === fsel) : allFiles, lk, byKey)
          : boardView(d, st, c, rows, byKey);
  h += `<div class="foot bl-legend">Items OBSERVED in the files (read-only, ≤ ${Math.round(MAX_BYTES / 1024)} KB each by default). State: checklist box OBSERVED; table state cell or an explicit marker on the line (done, merged, ✓, running, blocked …) DERIVED, otherwise Open. Sessions INFERRED: same repository and the id appears in a branch, worktree, title, last action or spawn description; lowercase ids match branch / worktree names only. Age DERIVED from a written date, else the file's modified time (dimmed). Week ${esc(isoWeek(d.now))}.</div>`;
  return h + '</div>';
}

function checkPath(arg: string): string {
  const files = feedValue<BacklogFeedOut>(FEED_ID).value?.report.files ?? [];
  const f = files.find(x => x.file === arg);
  if (!f) throw new Error('Unknown plan file.');
  return f.file;
}

export const backlogView: ExtraView = {
  id: 'backlog',
  label: 'Backlog',
  group: 'Work',
  hint: 'Plans and packages found in repositories (handoff/PLAN.md, ROADMAP.md, TODO.md): state, age, the sessions that worked on them, and a weekly archive.',
  ready: true,
  feeds: [backlogFeed as Feed, archiveFeed as Feed],
  render,
  badge: () => {
    const out = feedValue<BacklogFeedOut>(FEED_ID).value;
    if (!out) return '';
    const b = out.report.files.filter(f => !f.archive).reduce((a, f) => a + f.items.filter(i => i.state === 'blocked').length, 0);
    return b ? String(b) : '';
  },
  actions: {
    open: (arg: string, ctx: ActCtx) => ctx.openFile(checkPath(arg)),
    reveal: (arg: string, ctx: ActCtx) => ctx.revealInOs(checkPath(arg)),
    refresh: (_arg: string, ctx: ActCtx) => ctx.refreshFeeds(),
  },
  css: `
.bl .bl-t { font-size: 12px; width: 100%; border-collapse: collapse; }
.bl .bl-t th { text-align: left; font-weight: 600; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 2px 6px; white-space: nowrap; }
.bl .bl-t td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: middle; }
.bl .bl-t .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.bl .bl-r:hover td { background: var(--vscode-list-hoverBackground); }
.bl .bl-r.on td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.bl .bl-ft .bl-r { cursor: pointer; }
.bl .bl-gh td { background: var(--raise); font-weight: 600; padding-top: 6px; border-bottom: 1px solid var(--line); }
.bl .bl-gh .bl-stack { width: 120px; margin-left: 8px; vertical-align: middle; }
.bl .bl-sub td { font-size: 11px; color: var(--vscode-descriptionForeground); }
.bl .bl-ti { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl .bl-sec { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.bl .bl-path { font-family: var(--vscode-editor-font-family); font-size: 11px; }
.bl .bl-row-done .bl-ti, .bl .bl-row-dropped .bl-ti { color: var(--vscode-descriptionForeground); }
.bl .bl-row-dropped .bl-ti { text-decoration: line-through; }
.bl .bl-st { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 8px; border: 1px solid currentColor; white-space: nowrap; line-height: 15px; }
.bl .bl-st.bl-open { color: var(--vscode-descriptionForeground); } .bl .bl-st.bl-active { color: var(--accent); } .bl .bl-st.bl-blocked { color: var(--bad); } .bl .bl-st.bl-done { color: var(--ok); } .bl .bl-st.bl-dropped { color: var(--quiet); }
.bl .bl-id { font-size: 10.5px; padding: 0 4px; border-radius: 3px; border-left: 3px solid var(--id); background: var(--raise); white-space: nowrap; }
.bl .bl-age { font-variant-numeric: tabular-nums; } .bl .bl-weak { opacity: .55; }
.bl .bl-ss { display: inline-flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.bl .bl-s { display: inline-flex; align-items: center; gap: 3px; font: inherit; font-size: 10.5px; padding: 0 6px 0 4px; border: 1px solid var(--line); border-left: 3px solid var(--codex); border-radius: 8px; background: none; color: var(--vscode-foreground); cursor: pointer; max-width: 170px; overflow: hidden; white-space: nowrap; }
.bl .bl-s.claude { border-left-color: var(--claude); } .bl .bl-s .sd { margin-right: 0; }
.bl .bl-s.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.bl .bl-more, .bl .bl-tok { font-size: 10.5px; }
.bl .bl-acts { white-space: nowrap; text-align: right; } .bl .bl-acts .link { margin-left: 6px; font-size: 11px; }
.bl .bl-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.bl .bl-stack { display: inline-flex; width: 100%; height: 8px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--line) 60%, transparent); }
.bl .bl-stack.wide { height: 10px; }
.bl .bl-stack i { display: block; height: 100%; }
.bl .bl-stack i.bl-done, .bl .bl-k.bl-done, .bl .bl-wbar i.bl-done { background: var(--ok); }
.bl .bl-stack i.bl-active { background: var(--accent); }
.bl .bl-stack i.bl-blocked { background: var(--bad); }
.bl .bl-stack i.bl-open, .bl .bl-k.bl-open, .bl .bl-wbar i.bl-open { background: color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent); }
.bl .bl-stack i.bl-dropped { background: var(--quiet); opacity: .5; }
.bl .bl-pw { display: inline-block; min-width: 40px; }
.bl .bl-arch td { opacity: .7; }
.bl .bl-bad, .bl .bl-warn { color: var(--bad); }
.bl .bl-board { display: grid; gap: 8px; }
.bl .bl-board.columns { grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); overflow-x: auto; align-items: start; }
.bl .bl-board.rows .bl-lb { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 5px; }
.bl .bl-board.rows .bl-lg { grid-column: 1 / -1; }
.bl .bl-lane { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 5px; min-width: 0; }
.bl .bl-board.columns .bl-lb { display: grid; gap: 5px; max-height: 70vh; overflow-y: auto; }
.bl .bl-lh { font-size: 12px; margin: 0 0 5px 2px; }
.bl .bl-lg { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin: 4px 0 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl .bl-c { border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 4px; background: var(--vscode-editor-background); padding: 3px 6px; display: grid; gap: 2px; font-size: 12px; min-width: 0; }
.bl .bl-c-done, .bl .bl-c-dropped { opacity: .72; }
.bl .bl-c-blocked { border-color: var(--bad); border-left-color: var(--id); }
.bl .bl-c-active { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.bl .bl-ch { display: flex; gap: 5px; align-items: baseline; min-width: 0; }
.bl .bl-ct { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.bl .bl-cm { font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .bl .bl-cm .link { font-size: 10.5px; }
.bl .bl-none { font-size: 11px; padding: 2px; }
.bl .bl-wk { display: flex; gap: 3px; margin: 4px 0 2px; }
.bl .bl-wk.columns { align-items: flex-end; height: 150px; }
.bl .bl-wk.columns .bl-wc { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; height: 100%; }
.bl .bl-wk.columns .bl-wbar { flex: 1; width: 70%; display: flex; align-items: flex-end; gap: 2px; }
.bl .bl-wk.columns .bl-wbar i { flex: 1; height: var(--v); min-height: 1px; border-radius: 2px 2px 0 0; }
.bl .bl-wk.columns .bl-wl { font-size: 9.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.bl .bl-wk.rows { flex-direction: column-reverse; }
.bl .bl-wk.rows .bl-wc { display: grid; grid-template-columns: 110px 1fr 30px; align-items: center; gap: 6px; font-size: 11px; }
.bl .bl-wk.rows .bl-wl { order: -1; color: var(--vscode-descriptionForeground); }
.bl .bl-wk.rows .bl-wv { order: 2; text-align: right; }
.bl .bl-wk.rows .bl-wbar { display: grid; gap: 1px; }
.bl .bl-wk.rows .bl-wbar i { width: var(--v); height: 6px; min-width: 1px; border-radius: 0 2px 2px 0; }
.bl .bl-wv { font-size: 10.5px; font-variant-numeric: tabular-nums; }
.bl .bl-k { display: inline-block; width: 9px; height: 9px; border-radius: 2px; vertical-align: -1px; }
.bl .bl-wh { margin: 10px 0 2px; font-size: 12px; }
.bl .bl-when { white-space: nowrap; width: 90px; }
.bl .bl-legend { margin-top: 12px; }
.bl .bl-archd { display: inline-block; font-size: 9.5px; font-weight: 600; padding: 0 5px; border-radius: 8px; border: 1px dashed var(--quiet); color: var(--vscode-descriptionForeground); white-space: nowrap; margin-left: 4px; }
`,
};
