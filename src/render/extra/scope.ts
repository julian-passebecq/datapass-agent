// Add-on screen "Scope map": for each project, the milestones of its plan files (headings of handoff/PLAN.md,
// ROADMAP.md …) with their packages / items coloured by state, a done / total bar per milestone, what is left,
// the sessions linked to each item, and what changed since the archive snapshot of about a week ago.
// Read-only. Parsing and linking are Backlog's (src/activity/backlog.ts, same feed); regrouping in
// src/activity/scope.ts; baseline snapshot in src/feeds/scope.ts. Everything printed is escaped here.
import type { AgentSessionSnapshot } from '../../model';
import { fileKey, PlanFile, sessionRoot, SHAPE_LABEL, STATE_LABEL } from '../../activity/backlog';
import { compact, identityColor } from '../../activity/insights';
import {
  buildMaps, Counts, MAP_LABEL, MAX_MILESTONES, MapItem, MapState, Milestone, progress, ProjectMap, UNSORTED,
} from '../../activity/scope';
import { itemKey } from '../../archive/reader';
import { Baseline, BASELINE_FEED, baselineFeed } from '../../feeds/scope';
import { esc } from '../html';
import { ago, kpi, titleOf, WsData, WsState } from '../workspace';
import { BACKLOG_FEED, backlogFeed, BacklogFeedOut, backlogLinks } from './backlog';
import { Feed, feedValue } from './feeds';
import { actBtn, ActCtx, ExtraView, loadError, loading, opt, seg, toolbar } from './kit';

const MAX_CHIPS = 120;
const MAX_PICK = 8;
const nk = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const pct = (x: number) => `${Math.round(100 * x)} %`;

const EV_STATE = 'State: checklist box OBSERVED; table state cell or explicit marker (done, merged, ✓, running, blocked …) DERIVED; otherwise Pending.';
const EV_MS = 'Milestone DERIVED: the first heading above the item that names a milestone / wave / phase / release / version (V1, M2 …), else its outermost level-2 heading, else Unsorted.';
const EV_PROG = 'DERIVED: done / (done + active + blocked + pending); dropped items are left out.';
const EV_SESS = 'INFERRED: same repository and the item id appears in a session branch, worktree, title, last action or spawn description (as in Backlog).';

interface Cfg {
  proj: string;
  layout: 'grid' | 'tree';
  show: 'all' | 'left';
  changes: boolean;
}

function conf(st: WsState, hasBase: boolean): Cfg {
  const layout = opt(st, 'scope.layout', 'grid');
  return {
    proj: opt(st, 'scope.proj', 'all'),
    layout: layout === 'tree' ? 'tree' : 'grid',
    show: opt(st, 'scope.show', 'all') === 'left' ? 'left' : 'all',
    changes: hasBase && opt(st, 'scope.changes', 'off') === 'on',
  };
}

function visible(c: Cfg, m: MapItem): boolean {
  if (c.changes && !m.change) return false;
  if (c.show === 'left' && (m.state === 'done' || m.state === 'dropped')) return false;
  return true;
}

// ---------------------------------------------------------------- small parts

function bar(cn: Counts, title: string, wide = false): string {
  const tot = cn.done + cn.active + cn.blocked + cn.pending || 1;
  const seg1 = (s: MapState) => (cn[s] ? `<i class="sc-${s}" style="width:${((100 * cn[s]) / tot).toFixed(2)}%"></i>` : '');
  return `<span class="sc-bar${wide ? ' wide' : ''}" title="${esc(title)}">${seg1('done')}${seg1('active')}${seg1('blocked')}${seg1('pending')}</span>`;
}

function countsTip(cn: Counts): string {
  return `${cn.done} done · ${cn.active} active · ${cn.blocked} blocked · ${cn.pending} pending${cn.dropped ? ` · ${cn.dropped} dropped (not counted)` : ''}`;
}

function changeTag(m: MapItem, base: Baseline | undefined): string {
  if (!m.change || !base) return '';
  const from = m.change.from === 'new' ? 'new' : `was ${STATE_LABEL[m.change.from]}`;
  return `<span class="sc-chg" title="${esc(`DERIVED: compared with Agent's archive snapshot of ${base.day} (OBSERVED then): ${m.change.from === 'new' ? 'not in that snapshot' : `${STATE_LABEL[m.change.from]} → ${STATE_LABEL[m.change.to]}`}`)}">${esc(from)}</span>`;
}

function sessDots(d: WsData, st: WsState, m: MapItem, byKey: Map<string, AgentSessionSnapshot>): string {
  if (!m.links.length) return '';
  const ss = m.links
    .map(l => ({ l, s: byKey.get(l.key) }))
    .filter((x): x is { l: (typeof m.links)[number]; s: AgentSessionSnapshot } => !!x.s)
    .sort((a, b) => (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));
  const shown = ss.slice(0, 3);
  return `<span class="sc-ss">${shown
    .map(({ l, s }) => {
      const tip = `${titleOf(s)} · ${s.provider} · ${s.status} · ${ago(d.now, s.lastActivityAt)} · INFERRED: ${l.via === 'branch' ? 'branch / worktree name' : 'title, last action or spawn text'} mentions the id`;
      return `<button class="sc-s ${esc(s.provider)}${st.selected === s.key ? ' on' : ''}" data-select="${esc(s.key)}" title="${esc(tip)}"><span class="sd ${esc(s.status)}"></span></button>`;
    })
    .join('')}${ss.length > 3 ? `<span class="muted sc-more">+${ss.length - 3}</span>` : ''}</span>`;
}

function chip(d: WsData, st: WsState, m: MapItem, base: Baseline | undefined, byKey: Map<string, AgentSessionSnapshot>): string {
  const ev = m.it.shape === 'check' ? 'OBSERVED' : 'DERIVED';
  const tip = `${m.it.id ? `${m.it.id} · ` : ''}${m.it.title}\n${MAP_LABEL[m.state]} · ${ev}: ${m.it.stateBasis} (${SHAPE_LABEL[m.it.shape]})\n${m.f.repo}/${m.f.rel}:${m.it.line} · click to open at the line${m.links.length ? `\n${m.links.length} linked session(s), INFERRED` : ''}`;
  const label = m.it.id ? `<code>${esc(m.it.id)}</code> ${esc(m.it.title === m.it.id ? '' : m.it.title)}` : esc(m.it.title);
  return `<span class="sc-ch sc-${m.state}${m.change ? ' sc-changed' : ''}"><button class="sc-open" data-act="open" data-arg="${esc(`${m.f.file}#${m.it.line}`)}" title="${esc(tip)}">${label}</button>${changeTag(m, base)}${sessDots(d, st, m, byKey)}</span>`;
}

function msHead(p: ProjectMap, m: Milestone): string {
  const multi = p.files.length > 1;
  const pr = progress(m.counts);
  return `<div class="sc-mh"><button class="sc-mn" data-act="open" data-arg="${esc(`${m.file.file}#${m.line}`)}" title="${esc(`${m.name === UNSORTED ? 'Items with no heading above them' : m.name}\n${m.file.rel} · ${EV_MS}`)}">${esc(m.name)}</button>${multi ? `<span class="muted sc-mf">${esc(m.file.rel)}</span>` : ''}</div>${bar(m.counts, `${m.counts.done} / ${m.total} done (${pct(pr)}) · ${countsTip(m.counts)} · ${EV_PROG}`, true)}<div class="sc-mc muted"><span title="${esc(EV_PROG)}">${m.counts.done}/${m.total} · ${pct(pr)}</span> · <span title="DERIVED: active + blocked + pending">${m.left} left</span>${m.counts.blocked ? ` · <span class="sc-bad">${m.counts.blocked} blocked</span>` : ''}${m.changed ? ` · <span title="DERIVED: state differs from the baseline snapshot, or new">${m.changed} changed</span>` : ''}</div>`;
}

function items(d: WsData, st: WsState, c: Cfg, m: Milestone, base: Baseline | undefined, byKey: Map<string, AgentSessionSnapshot>, groupCls: string): { html: string; n: number } {
  let n = 0;
  let html = '';
  for (const g of m.groups) {
    const vis = g.items.filter(x => visible(c, x));
    if (!vis.length) continue;
    const room = Math.max(0, MAX_CHIPS - n);
    const shown = vis.slice(0, room);
    n += shown.length;
    html += `<div class="${groupCls}">${g.name ? `<div class="sc-gn" title="${esc(g.name)}">${esc(g.name)}</div>` : ''}<div class="sc-chips">${shown.map(x => chip(d, st, x, base, byKey)).join('')}${vis.length > shown.length ? `<span class="muted sc-more">+${vis.length - shown.length} more (see Backlog)</span>` : ''}</div></div>`;
  }
  return { html, n };
}

// ---------------------------------------------------------------- views

function overview(d: WsData, c: Cfg, maps: ProjectMap[], base: Baseline | undefined): string {
  let h = `<table class="sc-t"><tr><th>Project</th><th title="${esc(`One segment per milestone, width ∝ items; fill = done share. ${EV_MS}`)}">Milestones</th><th class="r" title="${esc(EV_PROG)}">Done</th><th class="r" title="DERIVED: active + blocked + pending">Left</th><th class="r">Active</th><th class="r">Blocked</th>${base ? `<th class="r" title="DERIVED: items whose state differs from the snapshot of ${esc(base.day)}">Changed</th>` : ''}<th class="r" title="${esc(EV_SESS)}">Sessions</th></tr>`;
  for (const p of maps) {
    const k = fileKey(p.root);
    const segs = p.milestones
      .filter(m => m.total)
      .map(m => {
        const pr = progress(m.counts);
        return `<span class="sc-sg${m.counts.blocked ? ' sc-sgb' : ''}" style="flex:${m.total} 1 0" title="${esc(`${m.name} · ${m.file.rel}\n${m.counts.done}/${m.total} done (${pct(pr)}) · ${countsTip(m.counts)}`)}"><i style="width:${(100 * pr).toFixed(1)}%"></i></span>`;
      })
      .join('');
    const pr = progress(p.counts);
    h += `<tr class="sc-r${c.proj === k ? ' on' : ''}" data-opt="scope.proj" data-val="${esc(k)}" title="Click: open this project's map"><td class="sc-pn"><span class="sc-sw" style="background:${identityColor(p.repo)}"></span>${esc(p.repo)} <span class="muted">${p.milestones.length} milestone${p.milestones.length === 1 ? '' : 's'}</span></td><td class="sc-sc"><div class="sc-segs">${segs || '<span class="muted">no items</span>'}</div></td><td class="r">${p.counts.done}/${p.total} <span class="muted">${pct(pr)}</span></td><td class="r">${p.left}</td><td class="r">${p.counts.active || ''}</td><td class="r sc-bad">${p.counts.blocked || ''}</td>${base ? `<td class="r">${p.changed || ''}</td>` : ''}<td class="r">${p.sessions.size || ''}</td></tr>`;
  }
  return h + '</table>';
}

function projectView(d: WsData, st: WsState, c: Cfg, p: ProjectMap, base: Baseline | undefined, byKey: Map<string, AgentSessionSnapshot>): string {
  const ms = p.milestones.filter(m => m.groups.some(g => g.items.some(x => visible(c, x))));
  if (!ms.length) return `<div class="empty">${c.changes ? `No item changed state since ${esc(base?.day ?? '')}.` : c.show === 'left' ? 'Nothing left: every item is done or dropped.' : 'No item in this project.'}</div>`;
  let h = '';
  if (c.layout === 'grid') {
    h += `<div class="sc-grid">${ms
      .map(m => {
        const it = items(d, st, c, m, base, byKey, 'sc-g');
        return `<div class="sc-col${m.left === 0 && m.total ? ' sc-col-done' : ''}">${msHead(p, m)}<div class="sc-cb">${it.html}</div></div>`;
      })
      .join('')}</div>`;
  } else {
    h += `<div class="sc-tree">${ms
      .map(m => {
        const it = items(d, st, c, m, base, byKey, 'sc-tg');
        return `<div class="sc-tr"><div class="sc-tm">${msHead(p, m)}</div><div class="sc-tb">${it.html}</div></div>`;
      })
      .join('')}</div>`;
  }
  if (p.more) h += `<div class="foot">${p.more} item(s) under further milestones not shown (cap ${MAX_MILESTONES} milestones per project).</div>`;
  return h;
}

// ---------------------------------------------------------------- render

function render(d: WsData, st: WsState): string {
  const fs = feedValue<BacklogFeedOut>(BACKLOG_FEED);
  const out = fs.value;
  if (!out) return fs.error ? loadError(`Could not read plan files: ${fs.error}`, 'refresh') : loading('scope', 'Reading plan files…', { retry: 'refresh' });
  const base = feedValue<Baseline | undefined>(BASELINE_FEED).value;
  const c = conf(st, !!base);
  const { report } = out;
  // scope: repositories of the sessions on screen, plus Backlog's extra roots (same rule as Backlog)
  const inScope = new Set(d.sessions.map(sessionRoot).filter((x): x is string => !!x));
  const extra = new Set(out.extra.map(nk));
  const files = report.files.filter(f => inScope.has(nk(f.root)) || extra.has(nk(f.root)));
  const byKey = new Map(d.sessions.map(s => [s.key, s]));
  const lk = backlogLinks({ ...report, files }, d.sessions);
  const maps = buildMaps(files, lk, base ? { states: base.states, keyOf: (f: PlanFile, it) => itemKey(f.root, f.rel, it) } : undefined)
    .filter(p => p.total + p.counts.dropped > 0)
    .sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));

  let h = '<div class="sc">';
  if (!maps.length) {
    h += `<div class="empty">No plan items found in the ${report.roots.length} repositor${report.roots.length === 1 ? 'y' : 'ies'} agents used${inScope.size ? '' : ' (no session in scope)'}. The map reads the same files as Backlog (handoff/PLAN.md, ROADMAP.md, TODO.md …).</div>`;
    return h + '</div>';
  }
  const sel = c.proj !== 'all' ? maps.find(p => fileKey(p.root) === c.proj) : undefined;
  const shown = sel ? [sel] : maps;
  const cn: Counts = { done: 0, active: 0, blocked: 0, pending: 0, dropped: 0 };
  let total = 0;
  let changed = 0;
  let nms = 0;
  for (const p of shown) {
    for (const s of Object.keys(cn) as MapState[]) cn[s] += p.counts[s];
    total += p.total;
    changed += p.changed;
    nms += p.milestones.length;
  }
  const left = cn.active + cn.blocked + cn.pending;
  h += `<div class="kpis">${sel ? '' : kpi(maps.length, 'Projects', '', 'OBSERVED: repositories with plan items')}${kpi(nms, 'Milestones', '', EV_MS)}${kpi(total, 'Items', '', 'OBSERVED in the plan files (dropped not counted)')}${kpi(`${cn.done} · ${pct(total ? cn.done / total : 0)}`, 'Done', '', EV_PROG)}${kpi(left, "What's left", '', 'DERIVED: active + blocked + pending')}${kpi(cn.active, 'Active', cn.active ? 'k-run' : '')}${kpi(cn.blocked, 'Blocked', cn.blocked ? 'k-fail' : '')}${base ? kpi(changed, `Changed since ${base.day}`, '', `DERIVED: state differs from Agent's archive snapshot of ${base.day}, or new since`) : ''}</div>`;

  const pick: [string, string][] = [['all', 'All projects']];
  const top = maps.slice(0, MAX_PICK);
  if (sel && !top.includes(sel)) top.push(sel);
  for (const p of top) pick.push([fileKey(p.root), p.repo.length > 18 ? `${p.repo.slice(0, 17)}…` : p.repo]);
  h += toolbar(
    seg(st, 'scope.proj', pick, 'all', 'Project (more in the All projects table)'),
    sel ? seg(st, 'scope.layout', [['grid', 'Milestone columns'], ['tree', 'Tree']], 'grid', 'Layout: one column per milestone, or a horizontal tree milestone → section → items') : '',
    sel ? seg(st, 'scope.show', [['all', 'Everything'], ['left', "What's left"]], 'all', "What's left hides done and dropped items") : '',
    base ? seg(st, 'scope.changes', [['off', 'All items'], ['on', `Changed since ${base.day}`]], 'off', `Only items whose state changed since Agent's archive snapshot of ${base.day} (the newest one at least 7 days old, else the oldest; ${base.days} snapshot(s))`) : '',
    `<span class="muted" title="${esc(new Date(report.at).toLocaleString())}">read ${esc(ago(d.now, report.at))}</span>`,
    actBtn('refresh', '', 'Re-read', 'Read the plan files again'),
  );
  h += sel ? `<div class="sc-ph"><span class="sc-sw" style="background:${identityColor(sel.repo)}"></span><b>${esc(sel.repo)}</b> <span class="muted">${sel.files.map(f => esc(f.rel)).join(' · ')}${sel.sessions.size ? ` · ${sel.sessions.size} linked session(s)` : ''}</span> ${bar(sel.counts, `${countsTip(sel.counts)} · ${EV_PROG}`, true)}</div>${projectView(d, st, c, sel, base, byKey)}` : overview(d, c, maps, base);
  if (!sel && c.changes) h += `<div class="foot">Pick a project to see which items changed.</div>`;
  const tok = shown.reduce((a, p) => a + [...p.sessions].reduce((b, k) => b + (byKey.get(k)?.usage?.totalTokens ?? 0), 0), 0);
  h += `<div class="foot sc-legend"><span class="sc-k sc-done"></span> done <span class="sc-k sc-active"></span> active <span class="sc-k sc-blocked"></span> blocked <span class="sc-k sc-pending"></span> pending · ${esc(EV_STATE)} ${esc(EV_MS)} Progress ${esc(EV_PROG)} Sessions ${esc(EV_SESS)}${tok ? ` Linked sessions recorded ${esc(compact(tok))} tokens (OBSERVED).` : ''}${base ? '' : ' "Changed since" appears once Agent\'s archive (npm run archive) holds a backlog snapshot older than today.'}</div>`;
  return h + '</div>';
}

/** "file#line" → a plan file Backlog read, and a 1-based line. */
export function checkTarget(arg: string): { file: string; line: number } {
  const m = /^(.*)#(\d{1,7})$/.exec(arg);
  if (!m) throw new Error('Bad target.');
  const files = feedValue<BacklogFeedOut>(BACKLOG_FEED).value?.report.files ?? [];
  const f = files.find(x => x.file === m[1]);
  if (!f) throw new Error('Unknown plan file.');
  return { file: f.file, line: Math.max(1, Number(m[2])) };
}

export const scopeView: ExtraView = {
  id: 'scope',
  label: 'Scope map',
  group: 'Work',
  hint: "Map of each project's plan: milestones → sections → items coloured by state, progress per milestone, what's left, linked sessions, and what changed since last week's archive snapshot.",
  ready: true,
  feeds: [backlogFeed as Feed, baselineFeed as Feed],
  render,
  actions: {
    open: async (arg: string, ctx: ActCtx) => {
      const t = checkTarget(arg);
      await ctx.openFile(t.file);
      try {
        await ctx.runCommand('revealLine', { lineNumber: t.line - 1, at: 'center' });
      } catch {
        /* file is open; the line reveal is best effort */
      }
    },
    refresh: (_arg: string, ctx: ActCtx) => ctx.refreshFeeds(),
  },
  css: `
.sc .sc-t { font-size: 12px; width: 100%; border-collapse: collapse; }
.sc .sc-t th { text-align: left; font-weight: 600; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 2px 6px; white-space: nowrap; }
.sc .sc-t td { padding: 3px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: middle; }
.sc .sc-t .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sc .sc-r { cursor: pointer; }
.sc .sc-r:hover td { background: var(--vscode-list-hoverBackground); }
.sc .sc-r.on td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.sc .sc-pn { white-space: nowrap; }
.sc .sc-sc { width: 55%; }
.sc .sc-segs { display: flex; gap: 2px; align-items: center; min-width: 160px; }
.sc .sc-sg { display: block; height: 12px; min-width: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--vscode-descriptionForeground) 30%, transparent); }
.sc .sc-sg i { display: block; height: 100%; background: var(--ok); }
.sc .sc-sgb { box-shadow: inset 0 -2px 0 var(--bad); }
.sc .sc-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.sc .sc-bad { color: var(--bad); }
.sc .sc-bar { display: inline-flex; width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--line) 60%, transparent); vertical-align: middle; }
.sc .sc-bar.wide { height: 8px; }
.sc .sc-bar i { display: block; height: 100%; }
.sc .sc-bar i.sc-done, .sc .sc-k.sc-done { background: var(--ok); }
.sc .sc-bar i.sc-active, .sc .sc-k.sc-active { background: var(--accent); }
.sc .sc-bar i.sc-blocked, .sc .sc-k.sc-blocked { background: var(--bad); }
.sc .sc-bar i.sc-pending, .sc .sc-k.sc-pending { background: color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent); }
.sc .sc-k { display: inline-block; width: 9px; height: 9px; border-radius: 2px; vertical-align: -1px; margin-left: 4px; }
.sc .sc-ph { display: flex; align-items: center; gap: 6px; margin: 2px 0 8px; font-size: 12px; }
.sc .sc-ph .sc-bar { max-width: 260px; }
.sc .sc-grid { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(220px, 280px); gap: 8px; overflow-x: auto; align-items: start; padding-bottom: 4px; }
.sc .sc-col { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 6px; min-width: 0; display: grid; gap: 4px; }
.sc .sc-col-done { opacity: .75; }
.sc .sc-cb { display: grid; gap: 6px; max-height: 70vh; overflow-y: auto; }
.sc .sc-mh { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.sc .sc-mn { background: none; border: none; padding: 0; font: inherit; font-weight: 600; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc .sc-mn:hover { text-decoration: underline; }
.sc .sc-mf { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc .sc-mc { font-size: 10.5px; }
.sc .sc-gn { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin: 0 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc .sc-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.sc .sc-ch { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; border: 1px solid var(--line); border-left: 3px solid var(--quiet); border-radius: 4px; background: var(--vscode-editor-background); padding: 0 4px 0 0; font-size: 11px; }
.sc .sc-ch.sc-done { border-left-color: var(--ok); }
.sc .sc-ch.sc-active { border-left-color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
.sc .sc-ch.sc-blocked { border-left-color: var(--bad); border-color: var(--bad); }
.sc .sc-ch.sc-pending { border-left-color: color-mix(in srgb, var(--vscode-descriptionForeground) 60%, transparent); }
.sc .sc-ch.sc-dropped { opacity: .55; text-decoration: line-through; }
.sc .sc-ch.sc-changed { outline: 1px dashed var(--warn); outline-offset: 1px; }
.sc .sc-ch.sc-done .sc-open { color: var(--vscode-descriptionForeground); }
.sc .sc-open { background: none; border: none; font: inherit; color: var(--vscode-foreground); cursor: pointer; padding: 1px 4px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 230px; }
.sc .sc-open:hover { text-decoration: underline; }
.sc .sc-open code { font-size: 10.5px; }
.sc .sc-chg { font-size: 9.5px; padding: 0 4px; border-radius: 6px; border: 1px solid var(--warn); color: var(--warn); white-space: nowrap; }
.sc .sc-ss { display: inline-flex; gap: 2px; align-items: center; }
.sc .sc-s { display: inline-flex; align-items: center; padding: 0 2px; border: 1px solid var(--line); border-left: 3px solid var(--codex); border-radius: 6px; background: none; cursor: pointer; height: 13px; }
.sc .sc-s.claude { border-left-color: var(--claude); }
.sc .sc-s.on { background: var(--vscode-list-activeSelectionBackground); }
.sc .sc-s .sd { margin-right: 0; }
.sc .sc-more { font-size: 10.5px; }
.sc .sc-tree { display: grid; gap: 8px; }
.sc .sc-tr { display: grid; grid-template-columns: minmax(180px, 240px) 1fr; gap: 0; align-items: start; }
.sc .sc-tm { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 6px; display: grid; gap: 4px; position: sticky; left: 0; }
.sc .sc-tb { display: grid; gap: 4px; border-left: 2px solid var(--line); margin-left: 10px; padding-left: 10px; }
.sc .sc-tg { position: relative; display: grid; grid-template-columns: minmax(100px, 180px) 1fr; gap: 6px; align-items: start; }
.sc .sc-tg::before { content: ''; position: absolute; left: -10px; top: 8px; width: 8px; border-top: 2px solid var(--line); }
.sc .sc-tg .sc-gn { margin: 2px 0 0; }
.sc .sc-tg .sc-chips:only-child { grid-column: 1 / -1; }
.sc .sc-legend { margin-top: 12px; }
`,
};
