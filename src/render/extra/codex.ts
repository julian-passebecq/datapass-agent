// Add-on screen "Codex": the Codex desktop app's own state (threads, projects, sub-agents, automations,
// goals, queue, turn timing), read from ~/.codex sqlite copies by src/providers/codex/state.ts.
// OBSERVED from an undocumented format: labelled "Codex app state (undocumented, may change)". All text escaped.
import type { AgentSessionSnapshot } from '../../model';
import { codexRoot } from '../../providers/codex/codex';
import { CodexState, CodexThread, CodexTurn, loadCodexState, threadActivity } from '../../providers/codex/state';
import { base, compact, identityColor } from '../../activity/insights';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ExtraView, actBtn, loadError, loading, opt, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';

const FEED_ID = 'codex.state';
const LABEL = 'Codex app state (undocumented, may change)';
const OBS = `OBSERVED: ${LABEL}`;
const MAX_ROWS = 400;

const codexFeed: Feed<CodexState> = {
  id: FEED_ID,
  intervalMs: 60_000,
  load: ctx => loadCodexState({ root: codexRoot(), now: ctx.now }),
};

// ---------------------------------------------------------------- helpers

const ago = (now: number, t?: number) => {
  if (!t) return '';
  const s = Math.round((now - t) / 1000);
  const a = Math.abs(s);
  const v = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return s >= 0 ? `${v} ago` : `in ${v}`;
};
const when = (now: number, t?: number) => (t ? `<span title="${esc(new Date(t).toLocaleString())}">${esc(ago(now, t))}</span>` : '<span class="muted">—</span>');
function dur(msv?: number): string {
  if (msv === undefined) return '—';
  const s = msv / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
}
function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
const short = (id: string) => id.slice(0, 8);

function activity(st: CodexState, now: number): { running: Set<string>; open: Set<string> } {
  const running = new Set<string>();
  const open = new Set<string>();
  for (const [id, a] of threadActivity(st, now)) (a === 'running' ? running : open).add(id);
  return { running, open };
}

interface Ctx {
  st: CodexState;
  d: WsData;
  byId: Map<string, CodexThread>;
  running: Set<string>;
  open: Set<string>;
  lockAt: Map<string, number>;
  turns: Map<string, CodexTurn[]>;
  sessions: Map<string, AgentSessionSnapshot>;
  projName: Map<string, string>;
}

function ctxOf(st: CodexState, d: WsData): Ctx {
  const turns = new Map<string, CodexTurn[]>();
  for (const t of st.turns) turns.set(t.thread, [...(turns.get(t.thread) ?? []), t]);
  return {
    st,
    d,
    byId: new Map(st.threads.map(t => [t.id, t])),
    ...activity(st, d.now),
    lockAt: new Map(st.locks.map(l => [l.id, l.mtime])),
    turns,
    sessions: new Map(d.sessions.filter(s => s.provider === 'codex').map(s => [s.key, s])),
    projName: new Map(st.projects.map(p => [p.id, p.name ?? short(p.id)])),
  };
}

function label(c: Ctx, id: string): string {
  const t = c.byId.get(id);
  const s = c.sessions.get(`codex:${id}`);
  return t?.title ?? t?.nickname ?? s?.title ?? short(id);
}

/** Thread name, linked to the session row (data-select) when the session is loaded. */
function link(c: Ctx, id: string): string {
  const key = `codex:${id}`;
  const txt = esc(label(c, id));
  return c.sessions.has(key) ? `<a href="#" class="cx-ln" data-select="${esc(key)}" title="${esc(`Select session ${id}`)}">${txt}</a>` : `<span title="${esc(`${id} · not in the loaded session window`)}">${txt}</span>`;
}

function projectOf(c: Ctx, t: CodexThread): string {
  if (t.projectId && c.projName.has(t.projectId)) return c.projName.get(t.projectId)!;
  return t.cwd ? base(t.cwd) || '(no project)' : '(no project)';
}

function runDot(c: Ctx, id: string): string {
  const m = c.lockAt.get(id);
  if (m === undefined) return '';
  const since = new Date(m).toLocaleString();
  return c.running.has(id)
    ? `<span class="cx-run" title="${esc(`INFERRED running: thread-writer-locks/${id}.lock held since ${since} and an inProgress turn or an update in the last 5 min`)}">●</span>`
    : `<span class="cx-open" title="${esc(`INFERRED open in the Codex app: thread-writer-locks/${id}.lock held since ${since}, no turn in progress`)}">○</span>`;
}

function turnStats(c: Ctx, id: string): { n: number; avg?: number; failed: number } {
  const ts = c.turns.get(id) ?? [];
  const ds = ts.map(t => t.durationMs).filter((x): x is number => x !== undefined);
  return { n: ts.length, avg: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : undefined, failed: ts.filter(t => t.failed).length };
}

const th = (txt: string, title = OBS) => `<th title="${esc(title)}">${esc(txt)}</th>`;

// ---------------------------------------------------------------- tabs

function threadsTab(c: Ctx, st: WsState): string {
  const show = opt(st, 'codex.show', 'active');
  const sort = opt(st, 'codex.sort', 'updated');
  let rows = c.st.threads.filter(t => show === 'all' || (show === 'running' ? c.running.has(t.id) : show === 'open' ? c.lockAt.has(t.id) : !t.archived));
  const key = (t: CodexThread) => (sort === 'tokens' ? t.tokens ?? 0 : sort === 'turns' ? c.turns.get(t.id)?.length ?? 0 : t.updatedAt ?? 0);
  rows = rows.sort((a, b) => key(b) - key(a));
  const tb = toolbar(
    seg(st, 'codex.show', [['active', 'Not archived'], ['running', 'Running'], ['open', 'Open in app'], ['all', 'All']], 'active', 'Which threads'),
    seg(st, 'codex.sort', [['updated', 'Recent'], ['tokens', 'Tokens'], ['turns', 'Turns']], 'updated', 'Sort'),
  );
  const body = rows
    .slice(0, MAX_ROWS)
    .map(t => {
      const ts = turnStats(c, t.id);
      const key = `codex:${t.id}`;
      const sel = c.sessions.has(key) ? ` data-select="${esc(key)}"` : '';
      return `<tr${sel}><td>${runDot(c, t.id)}${t.pinned ? '<span class="cx-pin" title="OBSERVED: pinned in the Codex app">★</span>' : ''}${link(c, t.id)}${t.archived ? ' <span class="muted">archived</span>' : ''}</td><td>${esc(projectOf(c, t))}</td><td title="${esc(t.repo ? `origin ${t.repo}` : '')}">${esc(t.branch ?? '')}</td><td>${esc([t.model, t.effort].filter(Boolean).join(' · '))}</td><td class="num">${t.tokens !== undefined ? esc(compact(t.tokens)) : '—'}</td><td class="num">${ts.n || '—'}${ts.failed ? ` <span class="cx-bad" title="OBSERVED: turns with an error or failed status">${ts.failed}✗</span>` : ''}</td><td class="num" title="DERIVED: mean of thread_turns.duration_ms">${esc(dur(ts.avg))}</td><td>${when(c.d.now, t.updatedAt)}</td></tr>`;
    })
    .join('');
  return `${tb}<table class="cx-t"><thead><tr>${th('Thread')}${th('Project')}${th('Branch')}${th('Model')}${th('Tokens', `${OBS} · threads.tokens_used`)}${th('Turns', `${OBS} · thread_history turns`)}${th('Avg turn', 'DERIVED: mean turn duration')}${th('Updated')}</tr></thead><tbody>${body || '<tr><td colspan="8" class="muted">No threads.</td></tr>'}</tbody></table>${rows.length > MAX_ROWS ? `<div class="muted">${rows.length - MAX_ROWS} more not shown.</div>` : ''}`;
}

function projectsTab(c: Ctx, st: WsState): string {
  const depth = opt(st, 'codex.pdepth', 'threads');
  const groups = new Map<string, CodexThread[]>();
  for (const t of c.st.threads) {
    if (t.archived) continue;
    const p = projectOf(c, t);
    groups.set(p, [...(groups.get(p) ?? []), t]);
  }
  const order = new Map(c.st.projects.map((p, i) => [p.name ?? short(p.id), i]));
  const names = [...groups.keys()].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
  const tb = toolbar(seg(st, 'codex.pdepth', [['projects', 'Projects only'], ['threads', 'Projects → threads']], 'threads', 'Depth'));
  const out = names.map(n => {
    const ts = groups.get(n)!.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const tok = ts.reduce((a, t) => a + (t.tokens ?? 0), 0);
    const run = ts.filter(t => c.running.has(t.id)).length;
    const turns = ts.reduce((a, t) => a + (c.turns.get(t.id)?.length ?? 0), 0);
    const proj = c.st.projects.find(p => (p.name ?? short(p.id)) === n);
    const head = `<summary><span class="cx-sw" style="background:${identityColor(n)}"></span><b>${esc(n)}</b> <span class="muted">${ts.length} threads · ${esc(compact(tok))} tok · ${turns} turns${run ? ` · <span class="cx-run">●</span> ${run} running` : ''}</span>${proj?.roots.length ? ` <span class="muted" title="${esc(proj.roots.join('\n'))}">${esc(proj.roots.map(r => base(r)).join(', '))}</span>` : ''}</summary>`;
    const kids = depth === 'threads' ? `<ul class="cx-tree">${ts.slice(0, 60).map(t => `<li>${runDot(c, t.id)}${link(c, t.id)} <span class="muted">${esc([t.branch, t.model, t.tokens !== undefined ? compact(t.tokens) + ' tok' : ''].filter(Boolean).join(' · '))} · ${when(c.d.now, t.updatedAt)}</span></li>`).join('')}${ts.length > 60 ? `<li class="muted">${ts.length - 60} more</li>` : ''}</ul>` : '';
    return `<details class="cx-p"${depth === 'threads' ? ' open' : ''}>${head}${kids}</details>`;
  });
  return tb + (out.join('') || '<div class="muted">No projects.</div>');
}

function agentsTab(c: Ctx, st: WsState): string {
  const depthOpt = opt(st, 'codex.adepth', 'all');
  const maxDepth = depthOpt === '1' ? 1 : depthOpt === '2' ? 2 : 20;
  const kids = new Map<string, { child: string; status?: string }[]>();
  const isChild = new Set<string>();
  for (const e of c.st.edges) {
    kids.set(e.parent, [...(kids.get(e.parent) ?? []), { child: e.child, status: e.status }]);
    isChild.add(e.child);
  }
  const roots = [...kids.keys()].filter(p => !isChild.has(p)).sort((a, b) => (c.byId.get(b)?.updatedAt ?? 0) - (c.byId.get(a)?.updatedAt ?? 0));
  const seen = new Set<string>();
  const node = (id: string, depth: number, status?: string): string => {
    if (seen.has(id)) return `<li class="muted">↺ ${esc(short(id))}</li>`;
    seen.add(id);
    const t = c.byId.get(id);
    const meta = [t?.role, t?.model, t?.tokens !== undefined ? `${compact(t.tokens)} tok` : '', status ? `edge ${status}` : ''].filter(Boolean).join(' · ');
    const ch = kids.get(id) ?? [];
    const sub = ch.length && depth < maxDepth ? `<ul class="cx-tree">${ch.map(k => node(k.child, depth + 1, k.status)).join('')}</ul>` : ch.length ? ` <span class="muted">+${ch.length}</span>` : '';
    return `<li>${runDot(c, id)}${link(c, id)} <span class="muted">${esc(meta)}</span>${sub}</li>`;
  };
  const tb = toolbar(seg(st, 'codex.adepth', [['1', 'Depth 1'], ['2', 'Depth 2'], ['all', 'All']], 'all', 'Tree depth'));
  const body = roots.length ? `<ul class="cx-tree cx-top" title="${esc(`${OBS} · thread_spawn_edges parent → child`)}">${roots.slice(0, 100).map(r => node(r, 0)).join('')}</ul>` : '<div class="muted">No sub-agent edges.</div>';
  return `${tb}<div class="muted">${c.st.edges.length} edges · ${roots.length} lead threads</div>${body}`;
}

function automationsTab(c: Ctx): string {
  const rows = c.st.automations
    .map(a => {
      const runs = Object.entries(a.runs).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
      return `<tr><td>${esc(a.name ?? short(a.id))}</td><td>${esc(a.kind ?? '')}</td><td>${esc(a.status ?? '')}</td><td class="cx-mono" title="${esc(`${OBS} · rrule`)}">${esc(a.rrule ?? '')}</td><td>${when(c.d.now, a.lastRunAt)}</td><td>${when(c.d.now, a.nextRunAt)}</td><td>${esc([a.model, a.effort].filter(Boolean).join(' · '))}</td><td>${esc(runs)}</td></tr>`;
    })
    .join('');
  return `<table class="cx-t"><thead><tr>${th('Name')}${th('Kind')}${th('Status')}${th('Schedule')}${th('Last run')}${th('Next run')}${th('Model')}${th('Runs', `${OBS} · automation_runs counts by status`)}</tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">No automations.</td></tr>'}</tbody></table><div class="muted">Prompts are never read.</div>`;
}

function goalsTab(c: Ctx): string {
  const g = c.st.goals;
  const by = new Map<string, number>();
  for (const x of g) by.set(x.status ?? 'unknown', (by.get(x.status ?? 'unknown') ?? 0) + 1);
  const used = g.reduce((a, x) => a + (x.tokensUsed ?? 0), 0);
  const budget = g.reduce((a, x) => a + (x.tokenBudget ?? 0), 0);
  const qItems = Object.values(c.st.queue).reduce((a, b) => a + b, 0);
  const k = (v: string | number, l: string, t = OBS) => `<div class="kpi" title="${esc(t)}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const kpis = `<div class="cx-kpis">${k(g.length, 'goals')}${[...by].map(([s, n]) => k(n, s)).join('')}${k(compact(used), 'goal tokens used')}${budget ? k(compact(budget), 'goal token budget') : ''}${k(qItems, 'queued follow-ups', `${OBS} · queued_items count (payload never read)`)}${k(Object.keys(c.st.queue).length, 'threads with queue')}${k(c.st.queueRevisions, 'queue revisions')}</div>`;
  const rows = g
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_ROWS)
    .map(x => {
      const p = x.tokenBudget ? Math.min(100, Math.round(((x.tokensUsed ?? 0) / x.tokenBudget) * 100)) : undefined;
      return `<tr><td>${link(c, x.thread)}</td><td>${esc(x.status ?? '')}</td><td class="num">${x.tokensUsed !== undefined ? esc(compact(x.tokensUsed)) : '—'}</td><td class="num">${x.tokenBudget ? esc(compact(x.tokenBudget)) : '—'}</td><td>${p !== undefined ? `<span class="cx-bar" title="DERIVED: used / budget"><i style="width:${p}%"></i></span> ${p}%` : ''}</td><td class="num">${x.timeUsedSec !== undefined ? esc(dur(x.timeUsedSec * 1000)) : '—'}</td><td>${when(c.d.now, x.updatedAt)}</td></tr>`;
    })
    .join('');
  const qRows = Object.entries(c.st.queue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([t, n]) => `<tr><td>${link(c, t)}</td><td class="num">${n}</td></tr>`)
    .join('');
  return `${kpis}<h4 class="cx-hd">Goals <span class="muted">(objective text is never read)</span></h4><table class="cx-t"><thead><tr>${th('Thread')}${th('Status')}${th('Tokens used')}${th('Budget')}${th('Progress', 'DERIVED')}${th('Time used')}${th('Updated')}</tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">No goals.</td></tr>'}</tbody></table>${qRows ? `<h4 class="cx-hd">Queue</h4><table class="cx-t"><thead><tr>${th('Thread')}${th('Queued')}</tr></thead><tbody>${qRows}</tbody></table>` : ''}`;
}

const BUCKETS: [number, string][] = [
  [10_000, '<10s'],
  [30_000, '10–30s'],
  [60_000, '30s–1m'],
  [120_000, '1–2m'],
  [300_000, '2–5m'],
  [600_000, '5–10m'],
  [1_800_000, '10–30m'],
  [Infinity, '30m+'],
];

function timingTab(c: Ctx, st: WsState): string {
  const orient = opt(st, 'codex.orient', 'horizontal');
  const by = new Map<string, number[]>();
  let failed = 0;
  for (const t of c.st.turns) {
    if (t.failed) failed++;
    if (t.durationMs === undefined) continue;
    const m = c.byId.get(t.thread)?.model ?? 'unknown';
    by.set(m, [...(by.get(m) ?? []), t.durationMs]);
  }
  const models = [...by.keys()].sort((a, b) => by.get(b)!.length - by.get(a)!.length);
  const counts = BUCKETS.map(([hi], i) => {
    const lo = i ? BUCKETS[i - 1][0] : 0;
    return models.map(m => by.get(m)!.filter(v => v >= lo && v < hi).length);
  });
  const max = Math.max(1, ...counts.map(r => r.reduce((a, b) => a + b, 0)));
  const bars = BUCKETS.map(([, name], i) => {
    const tot = counts[i].reduce((a, b) => a + b, 0);
    const segs = models
      .map((m, j) => (counts[i][j] ? `<i style="${orient === 'vertical' ? 'height' : 'width'}:${(counts[i][j] / max) * 100}%;background:${identityColor(m)}" title="${esc(`${m}: ${counts[i][j]} turns ${name}`)}"></i>` : ''))
      .join('');
    return `<div class="cx-hb"><span class="cx-hl">${esc(name)}</span><span class="cx-hs">${segs}</span><span class="cx-hn">${tot}</span></div>`;
  }).join('');
  const legend = models.map(m => `<span class="cx-lg"><span class="cx-sw" style="background:${identityColor(m)}"></span>${esc(m)}</span>`).join('');
  const rows = models
    .map(m => {
      const xs = by.get(m)!;
      return `<tr><td>${esc(m)}</td><td class="num">${xs.length}</td><td class="num">${esc(dur(median(xs)))}</td><td class="num">${esc(dur(pct(xs, 0.9)))}</td><td class="num">${esc(dur(Math.max(...xs)))}</td></tr>`;
    })
    .join('');
  const tb = toolbar(seg(st, 'codex.orient', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal', 'Histogram orientation'));
  return `${tb}<div class="muted" title="DERIVED: thread_turns.duration_ms grouped by the thread's model">${c.st.turns.length} turns · ${failed} with error/failed status · model = the thread's current model</div><div class="cx-hist cx-${orient === 'vertical' ? 'v' : 'h'}">${bars}</div><div class="cx-legend">${legend}</div><table class="cx-t"><thead><tr>${th('Model')}${th('Turns')}${th('Median', 'DERIVED')}${th('p90', 'DERIVED')}${th('Max', 'DERIVED')}</tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No timed turns.</td></tr>'}</tbody></table>`;
}

function sourcesLine(st: CodexState): string {
  return `<div class="cx-src">${st.sources.map(s => `<span class="cx-s cx-${s.status}" title="${esc(`${s.detail}${s.count !== undefined ? ` · ${s.count} rows` : ''}`)}">${esc(s.label)}${s.count !== undefined ? ` ${s.count}` : ''}</span>`).join('')}${st.models.length ? `<span class="muted" title="${esc(st.models.map(m => `${m.slug}${m.context ? ` · ${compact(m.context)} ctx` : ''}`).join('\n'))}">${st.models.length} models in catalog</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- view

function render(d: WsData, st: WsState): string {
  const f = feedValue<CodexState>(FEED_ID);
  const head = `<div class="cx-head"><b>Codex</b> <span class="cx-ev" title="${esc(`${OBS}. Copies of ~/.codex sqlite files read with node:sqlite (readOnly), whitelisted non-text columns only; prompts, objectives and payloads are never read.`)}">${esc(LABEL)}</span> ${actBtn('refresh', '', 'Refresh')}</div>`;
  if (!f.value) return `${head}${f.error ? loadError(`Load failed: ${f.error}`, 'refresh') : loading('codex', 'Loading Codex app state…', { retry: 'refresh' })}`;
  const s = f.value;
  if (!s.sqlite) return `${head}<div class="cx-warn">${esc(s.sqliteReason ?? 'node:sqlite unavailable')}: Codex app databases are not read in this runtime.</div>${sourcesLine(s)}`;
  const c = ctxOf(s, d);
  const tab = opt(st, 'codex.tab', 'threads');
  const tabs = seg(st, 'codex.tab', [['threads', `Threads ${s.threads.length}`], ['projects', 'Projects'], ['agents', `Agents ${s.edges.length}`], ['automations', `Automations ${s.automations.length}`], ['goals', 'Goals & queue'], ['timing', 'Turn timing']], 'threads', 'Tab');
  const kp = `<span class="muted">${c.running.size} running · ${c.open.size} open in app · ${s.threads.filter(t => !t.archived).length} open threads · ${esc(compact(s.threads.reduce((a, t) => a + (t.tokens ?? 0), 0)))} tokens · updated ${esc(ago(d.now, f.at ?? s.at))}</span>`;
  const body = tab === 'projects' ? projectsTab(c, st) : tab === 'agents' ? agentsTab(c, st) : tab === 'automations' ? automationsTab(c) : tab === 'goals' ? goalsTab(c) : tab === 'timing' ? timingTab(c, st) : threadsTab(c, st);
  return `<div class="cx">${head}${toolbar(tabs, kp)}${body}${sourcesLine(s)}</div>`;
}

export const codexView: ExtraView = {
  id: 'codex',
  label: 'Codex',
  hint: 'Codex app state: threads, projects, sub-agents, automations, goals, turn timing',
  group: 'Now',
  ready: true,
  feeds: [codexFeed as Feed],
  render,
  badge: () => {
    const v = feedValue<CodexState>(FEED_ID).value;
    const n = v ? activity(v, Date.now()).running.size : 0;
    return n ? String(n) : '';
  },
  actions: {
    refresh: (_arg, ctx) => ctx.refreshFeeds(),
  },
  css: `
.cx .cx-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.cx .cx-ev { font-size: 10px; border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; color: var(--vscode-descriptionForeground); }
.cx .cx-warn { color: var(--warn); margin: 6px 0; }
.cx .cx-t { border-collapse: collapse; width: 100%; font-size: 12px; margin: 4px 0 10px; }
.cx .cx-t th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; }
.cx .cx-t td { border-bottom: 1px solid var(--line); padding: 3px 6px; vertical-align: top; }
.cx .cx-t tr[data-select] { cursor: pointer; }
.cx .cx-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); }
.cx .num { text-align: right; font-variant-numeric: tabular-nums; }
.cx .cx-mono { font-family: var(--vscode-editor-font-family); font-size: 11px; }
.cx .cx-run { color: var(--ok); margin-right: 4px; }
.cx .cx-open { color: var(--vscode-descriptionForeground); margin-right: 4px; }
.cx .cx-pin { margin-right: 3px; font-size: 10px; }
.cx .cx-bad { color: var(--bad); }
.cx .cx-ln { color: var(--vscode-textLink-foreground); text-decoration: none; }
.cx .cx-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
.cx .cx-p { margin: 4px 0; }
.cx .cx-p summary { cursor: pointer; }
.cx .cx-tree { list-style: none; margin: 2px 0 2px 8px; padding-left: 10px; border-left: 1px solid var(--line); font-size: 12px; }
.cx .cx-tree.cx-top { border-left: none; padding-left: 0; margin-left: 0; }
.cx .cx-tree li { margin: 2px 0; }
.cx .cx-kpis { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 8px; }
.cx .cx-hd { margin: 8px 0 2px; font-size: 12px; }
.cx .cx-bar { display: inline-block; width: 60px; height: 6px; background: var(--raise); border-radius: 3px; overflow: hidden; vertical-align: middle; }
.cx .cx-bar i { display: block; height: 100%; background: var(--accent); }
.cx .cx-hist.cx-h { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; }
.cx .cx-hist.cx-h .cx-hb { display: grid; grid-template-columns: 60px 1fr 40px; gap: 6px; align-items: center; font-size: 11px; }
.cx .cx-hist.cx-h .cx-hs { display: flex; height: 12px; background: var(--raise); border-radius: 2px; overflow: hidden; }
.cx .cx-hist.cx-v { display: flex; gap: 6px; align-items: flex-end; height: 160px; margin: 6px 0; }
.cx .cx-hist.cx-v .cx-hb { flex: 1; display: flex; flex-direction: column-reverse; align-items: stretch; height: 100%; font-size: 10px; text-align: center; }
.cx .cx-hist.cx-v .cx-hs { flex: 1; display: flex; flex-direction: column-reverse; background: var(--raise); border-radius: 2px; overflow: hidden; }
.cx .cx-hist.cx-v .cx-hs i { width: 100%; }
.cx .cx-hist i { display: block; }
.cx .cx-hn { color: var(--vscode-descriptionForeground); }
.cx .cx-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; margin-bottom: 6px; }
.cx .cx-src { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; font-size: 10px; }
.cx .cx-s { border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }
.cx .cx-s.cx-ready { border-color: var(--ok); }
.cx .cx-s.cx-partial { border-color: var(--warn); }
.cx .cx-s.cx-missing, .cx .cx-s.cx-off { color: var(--vscode-disabledForeground); }
`,
};
