// Add-on screen "Audit trail" (P7): observed transitions, newest first, rebuilt on every render from
// snapshots + the event timeline (src/activity/audit.ts). Log / per-session story / lanes / counts views,
// filters, newest rows flash, local JSONL export via ctx.saveText. Pure rendering; all text escaped.
import type { AgentSessionSnapshot, EvidenceKind } from '../../model';
import {
  AUDIT_CATS, AuditCat, AuditKind, autoGran, CAT_LABEL, Gran, GRAN_MS, histogram, KIND_META, toJsonl, Transition, transitions,
} from '../../activity/audit';
import { dayStart, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';

const DAY = 86400_000;
const MAX_ROWS = 400;
/** Rows newer than this flash once when they appear. */
const FLASH_MS = 90_000;
const PERIOD: Record<string, number> = { '1h': 3_600_000, '24h': DAY, '7d': 7 * DAY, all: Infinity };
const PROV: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

const CAT_COLOR: Record<AuditCat, string> = {
  lifecycle: 'var(--accent)',
  git: 'var(--vscode-charts-purple, #b180d7)',
  tests: 'var(--ok)',
  problems: 'var(--bad)',
  context: 'var(--vscode-charts-yellow, #cca700)',
};
const KIND_COLOR: Partial<Record<AuditKind, string>> = {
  ended: 'var(--quiet)',
  'worker-ended': 'var(--quiet)',
  'needs-input': 'var(--warn)',
  idle: 'var(--vscode-charts-yellow, #cca700)',
  stalled: 'var(--quiet)',
  'test-fail': 'var(--bad)',
  'test-unknown': 'var(--quiet)',
  'api-error': 'var(--warn)',
};
const kindColor = (k: AuditKind) => KIND_COLOR[k] ?? CAT_COLOR[KIND_META[k].cat];

const EVIDENCE_HINT: Record<EvidenceKind, string> = {
  OBSERVED: 'OBSERVED: read from a provider record.',
  DERIVED: 'DERIVED: computed from records (earliest timestamp, git log in the session window, outcome change).',
  INFERRED: 'INFERRED: assumed from recency (no explicit record).',
  UNKNOWN: 'UNKNOWN: not exposed.',
};

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hhmmss = (t: number) => `${hhmm(t)}:${pad(new Date(t).getSeconds())}`;
function dayLabel(t: number, now: number): string {
  if (t >= dayStart(now)) return 'Today';
  if (t >= dayStart(now) - DAY) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function rel(now: number, t: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${pad(Math.round((s % 3600) / 60))} ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function bucketLabel(t: number, g: Gran, now: number): string {
  // Weekday only where a day starts, so dense time labels stay short.
  if (g === 'minute' || g === 'hour') return t === dayStart(t) && t < dayStart(now) ? new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : t === dayStart(now) ? 'Today' : hhmm(t);
  if (g === 'day') return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `wk ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function full(t: number, g: Gran): string {
  const d = new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return g === 'minute' || g === 'hour' ? `${d} ${hhmm(t)}` : g === 'week' ? `week of ${d}` : d;
}

// ---------------------------------------------------------------- options

interface Cfg {
  period: string;
  view: 'log' | 'session' | 'lanes' | 'counts';
  cat: AuditCat | 'all';
  prov: string;
  who: string;
  tests: 'all' | 'changes';
  exit1: boolean;
  order: 'newest' | 'oldest';
  gran: string;
  orient: 'h' | 'v';
  lanes: 'cat' | 'kind' | 'repo' | 'provider';
  focus: boolean;
}

function cfg(st: WsState): Cfg {
  const view = opt(st, 'audit.view', 'log');
  const cat = opt(st, 'audit.cat', 'all');
  const lanes = opt(st, 'audit.lanes', 'cat');
  return {
    period: PERIOD[opt(st, 'audit.period', '24h')] !== undefined ? opt(st, 'audit.period', '24h') : '24h',
    view: view === 'session' || view === 'lanes' || view === 'counts' ? view : 'log',
    cat: (AUDIT_CATS as string[]).includes(cat) ? (cat as AuditCat) : 'all',
    prov: opt(st, 'audit.prov', 'all'),
    who: opt(st, 'audit.who', 'all'),
    tests: opt(st, 'audit.tests', 'all') === 'changes' ? 'changes' : 'all',
    exit1: opt(st, 'audit.exit1', 'hide') === 'show',
    order: opt(st, 'audit.order', 'newest') === 'oldest' ? 'oldest' : 'newest',
    gran: opt(st, 'audit.gran', 'auto'),
    orient: opt(st, 'audit.orient', 'h') === 'v' ? 'v' : 'h',
    lanes: lanes === 'kind' || lanes === 'repo' || lanes === 'provider' ? lanes : 'cat',
    focus: opt(st, 'audit.focus', 'all') === 'selected' && !!st.selected,
  };
}

/** Last filtered lists by signature (a few), so the export writes exactly what the screen showed (the action has no timeline access). */
const lastExport = new Map<string, Transition[]>();
function remember(sig: string, rows: Transition[]): void {
  lastExport.delete(sig);
  lastExport.set(sig, rows);
  while (lastExport.size > 6) lastExport.delete(lastExport.keys().next().value as string);
}

function sigOf(c: Cfg, selected: string | undefined): string {
  return [c.period, c.cat, c.prov, c.who, c.tests, c.exit1 ? 'x1' : '', c.focus ? selected ?? '' : ''].join('|').slice(0, 1000);
}

interface Collected {
  /** After every filter. */
  rows: Transition[];
  /** Period + provider / who / focus filters, before the category filter (for KPI counts). */
  pre: Transition[];
  from: number;
  to: number;
  sessions: Map<string, AgentSessionSnapshot>;
}

function collect(d: WsData, st: WsState, c: Cfg): Collected {
  let sessions = d.sessions;
  if (c.prov === 'claude' || c.prov === 'codex') sessions = sessions.filter(s => s.provider === c.prov);
  if (c.who === 'leads') sessions = sessions.filter(s => !s.isWorker);
  else if (c.who === 'workers') sessions = sessions.filter(s => s.isWorker);
  if (c.focus) sessions = sessions.filter(s => s.key === st.selected || s.parentSessionId === st.selected);
  const span = PERIOD[c.period];
  const since = Number.isFinite(span) ? d.now - span : -Infinity;
  sessions = sessions.filter(s => (s.lastActivityAt ?? s.startedAt ?? 0) >= since);
  const events = d.timeline ? d.timeline(c.focus ? st.selected : undefined, 200_000) : d.events;
  let all = transitions(sessions, events, { now: d.now, quietExits: c.exit1 ? [] : [1] }).filter(r => r.at >= since && r.at <= d.now + 60_000);
  if (c.tests === 'changes') all = all.filter(r => r.cat !== 'tests' || r.change);
  const rows = c.cat === 'all' ? all : all.filter(r => r.cat === c.cat);
  const from = Number.isFinite(since) ? since : all.length ? all[all.length - 1].at : d.now - DAY;
  return { rows, pre: all, from, to: d.now, sessions: new Map(sessions.map(s => [s.key, s])) };
}

// ---------------------------------------------------------------- pieces

function badge(k: AuditKind): string {
  return `<span class="au-b" style="--k:${kindColor(k)}">${esc(KIND_META[k].label)}</span>`;
}

function evPill(e: EvidenceKind, source: string): string {
  return `<span class="au-ev ${e}" title="${esc(`${EVIDENCE_HINT[e]} Source: ${source}`)}">${esc(e.toLowerCase())}</span>`;
}

function changeChip(r: Transition): string {
  if (!r.change) return '';
  const t = { first: 'first test of the session', fixed: 'passes after a failing run (DERIVED)', broke: 'fails after a passing run (DERIVED)' }[r.change];
  return `<span class="au-ch ${r.change}" title="${esc(t)}">${esc(r.change)}</span>`;
}

function kpis(c: Cfg, col: Collected, now: number): string {
  const n = (cat: AuditCat) => col.pre.filter(r => r.cat === cat).length;
  const btn = (val: string, count: number, label: string, color: string, title: string) =>
    `<button class="au-k${c.cat === val ? ' on' : ''}" style="--k:${color}" data-opt="audit.cat" data-val="${esc(val)}" title="${esc(title)}"><b>${count}</b><span>${esc(label)}</span></button>`;
  const lastHour = col.pre.filter(r => r.at >= now - 3_600_000).length;
  return `<div class="au-ks">${btn('all', col.pre.length, 'All', 'var(--vscode-foreground)', 'Every transition in the period. Click a category to filter.')}${AUDIT_CATS.map(k => btn(k, n(k), CAT_LABEL[k], CAT_COLOR[k], catHint(k))).join('')}<div class="au-k au-kq" title="DERIVED: transitions in the last 60 minutes"><b>${lastHour}</b><span>Last hour</span></div></div>`;
}

function catHint(k: AuditCat): string {
  return {
    lifecycle: 'Session / worker started or ended, worker spawned by a lead, current status (needs input, idle, unknown).',
    git: 'Commits seen by git in the session window, and git commit commands the session ran.',
    tests: 'Test and build commands with their recorded outcome; "fixed" / "broke" mark an outcome change.',
    problems: 'Commands with a non-zero exit (exit 1 hidden by default: grep / rg / diff "no match"), provider API errors.',
    context: 'Context compactions recorded by the provider.',
  }[k];
}

function newest(col: Collected, now: number): string {
  const r = col.rows.reduce<Transition | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
  if (!r) return '';
  const fresh = now - r.at < FLASH_MS;
  return `<div class="au-nw${fresh ? ' au-new' : ''}" data-select="${esc(r.key)}" title="Newest transition in this filter"><span class="au-nl">Newest</span>${badge(r.kind)}<b>${esc(r.title.slice(0, 60))}</b><span class="muted">${esc(r.repo)}</span><span class="au-nt">${esc(r.label.slice(0, 90))}</span><span class="au-rel">${esc(rel(now, r.at))}</span></div>`;
}

function sessCell(r: Transition, s: AgentSessionSnapshot | undefined): string {
  return `<span class="dot ${s?.status ?? 'UNKNOWN'}"></span>${esc(r.title.slice(0, 44))}${r.isWorker ? '<span class="chip">worker</span>' : ''}${s && isLive(s) ? '<span class="au-live" title="live now"></span>' : ''}`;
}

// ---------------------------------------------------------------- views

function logView(c: Cfg, col: Collected, d: WsData, st: WsState): string {
  const list = c.order === 'oldest' ? [...col.rows].reverse() : col.rows;
  const shown = c.order === 'oldest' ? list.slice(-MAX_ROWS) : list.slice(0, MAX_ROWS);
  let h = `<table class="au-t"><tr><th>Time</th><th>Transition</th><th>Session</th><th>Repo</th><th>Prov.</th><th>What</th><th>Evidence</th></tr>`;
  let day = '';
  for (const r of shown) {
    const dl = dayLabel(r.at, d.now);
    if (dl !== day) {
      day = dl;
      h += `<tr class="au-day"><td colspan="7">${esc(dl)}</td></tr>`;
    }
    const s = col.sessions.get(r.key);
    const cls = [st.selected === r.key ? 'sel' : '', d.now - r.at < FLASH_MS ? 'au-new' : ''].filter(Boolean).join(' ');
    h += `<tr${cls ? ` class="${cls}"` : ''} data-select="${esc(r.key)}" style="--k:${kindColor(r.kind)}"><td class="au-tm" title="${esc(new Date(r.at).toLocaleString())}">${esc(hhmmss(r.at))}</td><td>${badge(r.kind)}${changeChip(r)}</td><td class="au-s">${sessCell(r, s)}</td><td class="au-r"><span class="sw" style="--id:${identityColor(r.repo)}"></span>${esc(r.repo)}</td><td class="au-p ${r.provider}">${esc(PROV[r.provider] ?? r.provider)}</td><td class="au-w">${esc(r.label)}</td><td>${evPill(r.evidence, r.source)}</td></tr>`;
  }
  h += '</table>';
  if (list.length > shown.length) h += `<div class="muted">… ${list.length - shown.length} older transitions not shown; narrow the period or export JSONL for all of them.</div>`;
  return h;
}

function sessionView(col: Collected, d: WsData, st: WsState): string {
  const m = new Map<string, Transition[]>();
  for (const r of col.rows) (m.get(r.key) ?? m.set(r.key, []).get(r.key)!).push(r);
  const groups = [...m.entries()].sort((a, b) => b[1][0].at - a[1][0].at);
  let h = '<div class="au-ss">';
  for (const [key, rows] of groups.slice(0, 80)) {
    const s = col.sessions.get(key);
    const r0 = rows[0];
    const story = [...rows].reverse().slice(-40);
    const chips = story
      .map(r => `<span class="au-st${d.now - r.at < FLASH_MS ? ' au-new' : ''}" style="--k:${kindColor(r.kind)}" title="${esc(`${new Date(r.at).toLocaleString()} · ${KIND_META[r.kind].label} · ${r.label} · ${r.evidence.toLowerCase()}: ${r.source}`)}"><i>${esc(hhmm(r.at))}</i>${esc(KIND_META[r.kind].label)}${r.change && r.change !== 'first' ? ` <em class="au-ch ${r.change}">${esc(r.change)}</em>` : ''}</span>`)
      .join('<span class="au-ar">›</span>');
    h += `<div class="au-sb${st.selected === key ? ' sel' : ''}" data-select="${esc(key)}" style="--id:${identityColor(r0.repo)}"><div class="au-sh">${sessCell(r0, s)}<span class="muted">${esc(r0.repo)} · ${esc(PROV[r0.provider] ?? r0.provider)}</span><span class="au-n">${rows.length}</span></div><div class="au-sc">${rows.length > story.length ? `<span class="muted">… ${rows.length - story.length} earlier</span><span class="au-ar">›</span>` : ''}${chips}</div></div>`;
  }
  if (groups.length > 80) h += `<div class="muted">… ${groups.length - 80} more sessions</div>`;
  return h + '</div>';
}

function laneKey(r: Transition, by: Cfg['lanes']): [string, string, string] {
  if (by === 'kind') return [r.kind, KIND_META[r.kind].label, kindColor(r.kind)];
  if (by === 'repo') return [r.repo, r.repo, identityColor(r.repo)];
  if (by === 'provider') return [r.provider, PROV[r.provider] ?? r.provider, r.provider === 'claude' ? 'var(--claude)' : 'var(--codex)'];
  return [r.cat, CAT_LABEL[r.cat], CAT_COLOR[r.cat]];
}

function ticks(from: number, to: number, n: number): number[] {
  const span = Math.max(1, to - from);
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, DAY, 7 * DAY];
  const step = steps.find(s => span / s <= n) ?? 30 * DAY;
  const out: number[] = [];
  let t = Math.ceil(from / step) * step;
  if (step >= DAY) t = dayStart(from) + DAY;
  for (; t <= to && out.length < 40; t += step) out.push(t);
  return out;
}

function lanesView(c: Cfg, col: Collected, d: WsData): string {
  const from = col.from, to = col.to, span = Math.max(1, to - from);
  const pos = (t: number) => Math.max(0, Math.min(100, (100 * (t - from)) / span));
  const lanes = new Map<string, { label: string; color: string; rows: Transition[] }>();
  if (c.lanes === 'cat') for (const k of AUDIT_CATS) if (c.cat === 'all' || c.cat === k) lanes.set(k, { label: CAT_LABEL[k], color: CAT_COLOR[k], rows: [] });
  for (const r of col.rows.slice(0, 3000)) {
    const [id, label, color] = laneKey(r, c.lanes);
    (lanes.get(id) ?? lanes.set(id, { label, color, rows: [] }).get(id)!).rows.push(r);
  }
  const list = [...lanes.values()].filter(l => c.lanes === 'cat' || l.rows.length).sort((a, b) => (c.lanes === 'cat' ? 0 : b.rows.length - a.rows.length)).slice(0, 40);
  const tk = ticks(from, to, c.orient === 'v' ? 10 : 8);
  const v = c.orient === 'v';
  // Vertical: newest at the top, like the log.
  const p = (t: number) => (v ? 100 - pos(t) : pos(t));
  const dot = (r: Transition) =>
    `<i class="au-dt${d.now - r.at < FLASH_MS ? ' au-new' : ''}" data-select="${esc(r.key)}" style="--k:${kindColor(r.kind)};${v ? 'top' : 'left'}:${p(r.at).toFixed(2)}%" title="${esc(`${new Date(r.at).toLocaleString()} · ${KIND_META[r.kind].label} · ${r.title} · ${r.label}`)}"></i>`;
  const axis = tk.map(t => `<span style="${v ? 'top' : 'left'}:${p(t).toFixed(2)}%">${esc(span > 2 * DAY ? new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : hhmm(t))}</span>`).join('');
  const grid = tk.map(t => `<b style="${v ? 'top' : 'left'}:${p(t).toFixed(2)}%"></b>`).join('');
  const now = `<em class="au-now" style="${v ? 'top' : 'left'}:${p(d.now).toFixed(2)}%" title="now"></em>`;
  if (!v)
    return `<div class="au-lh">${list.map(l => `<div class="au-lr"><span class="au-ll"><span class="sw" style="--id:${l.color}"></span>${esc(l.label.slice(0, 28))} <span class="muted">${l.rows.length}</span></span><div class="au-lt">${grid}${now}${l.rows.map(dot).join('')}</div></div>`).join('')}<div class="au-lr"><span></span><div class="au-ax">${axis}</div></div></div>`;
  return `<div class="au-lv"><div class="au-axv">${axis}</div>${list.map(l => `<div class="au-lc"><span class="au-ll" title="${esc(l.label)}"><span class="sw" style="--id:${l.color}"></span>${esc(l.label.slice(0, 14))} <span class="muted">${l.rows.length}</span></span><div class="au-lt">${grid}${now}${l.rows.map(dot).join('')}</div></div>`).join('')}</div>`;
}

function countsView(c: Cfg, col: Collected, d: WsData): string {
  const g: Gran = c.gran === 'minute' || c.gran === 'hour' || c.gran === 'day' || c.gran === 'week' ? c.gran : autoGran(col.to - col.from);
  const hist = histogram(col.rows, col.from, col.to, g, g === 'minute' ? 180 : 200);
  const max = Math.max(1, ...hist.map(b => b.total));
  const cats = AUDIT_CATS.filter(k => c.cat === 'all' || c.cat === k);
  const segs = (b: (typeof hist)[number], v: boolean) =>
    cats.map(k => (b.n[k] ? `<i style="--k:${CAT_COLOR[k]};${v ? 'height' : 'width'}:${((100 * b.n[k]) / max).toFixed(2)}%" title="${esc(`${full(b.at, g)} · ${CAT_LABEL[k]}: ${b.n[k]}`)}"></i>` : '')).join('');
  const legend = `<div class="au-lg">${cats.map(k => `<span><span class="sw" style="--id:${CAT_COLOR[k]}"></span>${esc(CAT_LABEL[k])}</span>`).join('')}<span class="muted">· one bar per ${esc(g)} (${esc(String(GRAN_MS[g] / 60_000))} min) · bar length = transitions (DERIVED count)</span></div>`;
  const cur = (t: number) => t <= d.now && d.now < t + GRAN_MS[g];
  if (c.orient === 'v') {
    const dense = hist.length > 30;
    return `<div class="au-cv${dense ? ' dense' : ''}">${hist.map(b => `<div class="au-cc${cur(b.at) ? ' cur' : ''}" title="${esc(`${full(b.at, g)}: ${b.total}`)}"><span class="num">${b.total || ''}</span><div class="au-cs">${segs(b, true)}</div><span class="au-cl">${esc(bucketLabel(b.at, g, d.now))}</span></div>`).join('')}</div>${legend}`;
  }
  const rows = [...hist].reverse();
  return `<div class="au-ch-h">${rows.map(b => `<div class="au-chr${cur(b.at) ? ' cur' : ''}"><span class="au-cl">${esc(bucketLabel(b.at, g, d.now))}</span><div class="au-cb">${segs(b, false)}</div><span class="num">${b.total || '<span class="muted">·</span>'}</span></div>`).join('')}</div>${legend}`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const tb1 = toolbar(
    seg(st, 'audit.view', [['log', 'Log'], ['session', 'Per session'], ['lanes', 'Lanes'], ['counts', 'Counts']], 'log', 'View'),
    seg(st, 'audit.period', [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 days'], ['all', 'All loaded']], '24h', 'Period (transition time)'),
    seg(st, 'audit.prov', [['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex']], 'all', 'Provider'),
    seg(st, 'audit.who', [['all', 'Sessions + workers'], ['leads', 'Leads'], ['workers', 'Workers']], 'all', 'Lead sessions, worker sessions (subagents) or both'),
    st.selected ? seg(st, 'audit.focus', [['all', 'All sessions'], ['selected', 'Selected + workers']], 'all', 'Only the selected session and its workers') : '',
  );
  const tb2 = toolbar(
    seg(st, 'audit.tests', [['all', 'Every test'], ['changes', 'Outcome changes']], 'all', 'Tests: every run, or only the first run and fail ↔ pass changes'),
    seg(st, 'audit.exit1', [['hide', 'Hide exit 1'], ['show', 'Show exit 1']], 'hide', 'Exit code 1 is often a plain "no match" (grep, rg, diff); hidden by default'),
    c.view === 'log' ? seg(st, 'audit.order', [['newest', 'Newest first'], ['oldest', 'Oldest first']], 'newest', 'Order') : '',
    c.view === 'counts' ? seg(st, 'audit.gran', [['auto', 'Auto'], ['minute', 'Minute'], ['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']], 'auto', 'Bucket size') : '',
    c.view === 'lanes' ? seg(st, 'audit.lanes', [['cat', 'Category'], ['kind', 'Kind'], ['repo', 'Repo'], ['provider', 'Provider']], 'cat', 'One lane per') : '',
    c.view === 'counts' || c.view === 'lanes' ? seg(st, 'audit.orient', [['h', 'Horizontal'], ['v', 'Vertical']], 'h', 'Orientation') : '',
    actBtn('jsonl', sigOf(c, st.selected), 'Export JSONL', 'Save the filtered transitions (all of them, not only the shown rows) as JSON Lines, locally'),
  );
  const col = collect(d, st, c);
  remember(sigOf(c, st.selected), col.rows);
  let h = `<div class="au">${tb1}${tb2}${kpis(c, col, d.now)}${newest(col, d.now)}`;
  if (!col.rows.length) h += `<div class="empty">No transition in this period${c.cat === 'all' ? '' : ` for ${esc(CAT_LABEL[c.cat].toLowerCase())}`}. Try a longer period (loaded history follows <code>agent.historyDays</code>).</div>`;
  else if (c.view === 'session') h += sessionView(col, d, st);
  else if (c.view === 'lanes') h += lanesView(c, col, d);
  else if (c.view === 'counts') h += countsView(c, col, d);
  else h += logView(c, col, d, st);
  h += `<details class="au-rules"><summary>What counts as a transition</summary><ul>${AUDIT_CATS.map(k => `<li><span class="sw" style="--id:${CAT_COLOR[k]}"></span><b>${esc(CAT_LABEL[k])}</b>: ${esc(catHint(k))}</li>`).join('')}<li>${(['OBSERVED', 'DERIVED', 'INFERRED'] as EvidenceKind[]).map(k => `<span class="au-ev ${k}">${k.toLowerCase()}</span> ${esc(EVIDENCE_HINT[k].replace(/^\w+: /, ''))}`).join('<br>')}</li><li class="muted">Rebuilt from local provider records on every refresh; nothing is stored. Status rows (needs input, idle) show the state now, dated at the last record. Rows newer than 90 s flash once. Export stays on this machine.</li></ul></details>`;
  return h + '</div>';
}

/** Rail badge: problems (failed commands, failing tests, API errors) on live sessions in the last 15 minutes. */
function badgeCount(d: WsData): string {
  const live = d.sessions.filter(isLive);
  if (!live.length) return '';
  const since = d.now - 15 * 60_000;
  let n = 0;
  for (const s of live) {
    if ((s.lastActivityAt ?? 0) < since) continue;
    const ev = d.timeline ? d.timeline(s.key, 300) : d.events;
    n += transitions([s], ev).filter(r => r.at >= since && (r.cat === 'problems' || r.kind === 'test-fail')).length;
  }
  return n ? String(n) : '';
}

const CSS = `
.au-ks { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 8px; }
.au-k { display: flex; flex-direction: column; align-items: flex-start; min-width: 72px; padding: 3px 10px; border: 1px solid var(--line); border-top: 3px solid var(--k, var(--line)); border-radius: 5px; background: var(--raise); color: var(--vscode-foreground); font: inherit; cursor: pointer; text-align: left; }
.au-k b { font-size: 17px; font-variant-numeric: tabular-nums; line-height: 1.2; }
.au-k span { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.au-k.on { outline: 1px solid var(--vscode-focusBorder); background: color-mix(in srgb, var(--k) 14%, var(--raise)); }
.au-k.au-kq { cursor: default; border-top-style: dashed; }
.au-b { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--k) 70%, transparent); background: color-mix(in srgb, var(--k) 18%, transparent); color: var(--vscode-foreground); white-space: nowrap; }
.au-ch { display: inline-block; font-size: 9px; font-style: normal; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px; margin-left: 4px; border-radius: 3px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.au-ch.fixed { border-color: var(--ok); color: var(--ok); } .au-ch.broke { border-color: var(--bad); color: var(--bad); }
.au-ev { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); white-space: nowrap; cursor: help; }
.au-ev.OBSERVED { border-color: var(--ok); } .au-ev.DERIVED { border-color: var(--accent); } .au-ev.INFERRED { border-style: dashed; border-color: var(--warn); }
@keyframes au-flash { 0% { background: color-mix(in srgb, var(--accent) 38%, transparent); } 100% { background: transparent; } }
.au .au-new { animation: au-flash 2.4s ease-out 1; }
.au-nw { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: 4px 8px; margin: 0 0 8px; border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 4px; background: var(--raise); cursor: pointer; font-size: 12px; }
.au-nl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.au-nt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.au-rel { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.au-t { border-collapse: collapse; width: 100%; font-size: 12px; }
.au-t th { text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); padding: 3px 6px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--vscode-editor-background); }
.au-t td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); vertical-align: top; }
.au-t tr[data-select] { cursor: pointer; box-shadow: inset 2px 0 0 var(--k); }
.au-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); }
.au-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.au-t .au-day td { padding: 8px 6px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); }
.au-tm, .au-r, .au-p { white-space: nowrap; font-variant-numeric: tabular-nums; }
.au-s { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.au-w { overflow-wrap: anywhere; min-width: 200px; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.au-p.claude { color: var(--claude); } .au-p.codex { color: var(--codex); }
.au-live { display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: var(--ok); vertical-align: 1px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok) 30%, transparent); }
.au-ss { display: grid; gap: 6px; }
.au-sb { border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 5px; padding: 4px 8px; background: var(--raise); cursor: pointer; }
.au-sb.sel { outline: 1px solid var(--vscode-focusBorder); }
.au-sb:hover { background: var(--vscode-list-hoverBackground); }
.au-sh { display: flex; gap: 8px; align-items: center; font-size: 12px; margin-bottom: 3px; }
.au-sh .au-n { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.au-sc { display: flex; flex-wrap: wrap; gap: 2px 3px; align-items: center; font-size: 10px; }
.au-st { display: inline-flex; gap: 4px; align-items: center; padding: 0 5px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--k) 65%, transparent); background: color-mix(in srgb, var(--k) 14%, transparent); white-space: nowrap; }
.au-st i { font-style: normal; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.au-st .au-ch { margin-left: 0; }
.au-ar { color: var(--vscode-descriptionForeground); }
.au-lh { display: grid; gap: 4px; }
.au-lr { display: grid; grid-template-columns: minmax(110px, 190px) 1fr; gap: 8px; align-items: center; font-size: 12px; }
.au-ll { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.au-lt { position: relative; height: 18px; background: color-mix(in srgb, var(--line) 30%, transparent); border-radius: 3px; }
.au-lt > b { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--line) 70%, transparent); }
.au-now { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); opacity: .7; }
.au-dt { position: absolute; top: 4px; width: 9px; height: 9px; margin-left: -5px; border-radius: 50%; background: var(--k); border: 1px solid var(--vscode-editor-background); cursor: pointer; }
.au-dt:hover { transform: scale(1.5); z-index: 1; }
.au-ax { position: relative; height: 14px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.au-ax span { position: absolute; transform: translateX(-50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.au-lv { display: flex; gap: 6px; height: 460px; overflow-x: auto; padding-top: 18px; }
.au-lv .au-lc { display: flex; flex-direction: column; flex: 1 0 60px; max-width: 120px; min-width: 0; position: relative; }
.au-lv .au-ll { position: absolute; top: -18px; left: 0; right: 0; font-size: 10px; text-align: center; }
.au-lv .au-lt { flex: 1; height: auto; }
.au-lv .au-lt > b { left: 0; right: 0; top: auto; bottom: auto; width: auto; height: 1px; }
.au-lv .au-now { left: 0; right: 0; width: auto; height: 2px; margin: -1px 0 0; }
.au-lv .au-dt { top: auto; left: 50%; margin: -5px 0 0 -5px; }
.au-axv { position: relative; width: 70px; flex: 0 0 70px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.au-axv span { position: absolute; right: 4px; transform: translateY(-50%); white-space: nowrap; font-variant-numeric: tabular-nums; }
.au-ch-h { display: grid; gap: 2px; max-height: 560px; overflow-y: auto; }
.au-chr { display: grid; grid-template-columns: 110px 1fr 40px; gap: 8px; align-items: center; font-size: 11px; }
.au-chr.cur .au-cl { color: var(--accent); font-weight: 600; }
.au-cb { display: flex; height: 11px; background: color-mix(in srgb, var(--line) 30%, transparent); border-radius: 2px; overflow: hidden; }
.au-cb i, .au-cs i { display: block; background: var(--k); }
.au-cb i + i { border-left: 1px solid var(--vscode-editor-background); }
.au-chr .num, .au-cc .num { font-variant-numeric: tabular-nums; font-size: 10px; text-align: right; }
.au-cl { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.au-cv { display: flex; align-items: flex-end; gap: 3px; height: 240px; padding: 4px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.au-cc { display: flex; flex-direction: column; align-items: center; gap: 2px; height: 100%; flex: 1 0 26px; max-width: 60px; min-width: 0; }
.au-cv.dense .au-cc { flex-basis: 12px; }
.au-cv.dense .au-cl { writing-mode: vertical-rl; transform: rotate(180deg); max-height: 54px; }
.au-cc.cur .au-cl { color: var(--accent); font-weight: 600; }
.au-cs { flex: 1; width: 75%; display: flex; flex-direction: column-reverse; }
.au-cs i + i { border-bottom: 1px solid var(--vscode-editor-background); }
.au-lg { display: flex; flex-wrap: wrap; gap: 10px; font-size: 10px; margin: 6px 0; color: var(--vscode-descriptionForeground); }
.au-rules { margin-top: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.au-rules summary { cursor: pointer; } .au-rules ul { margin: 6px 0; padding-left: 16px; } .au-rules li { margin: 3px 0; }
`;

export const auditView: ExtraView = {
  id: 'audit',
  label: 'Audit trail',
  group: 'System',
  hint: 'Chronological observed transitions (start / end, status, commits, test outcomes, failures), exportable locally as JSONL.',
  ready: true,
  render,
  css: CSS,
  badge: badgeCount,
  actions: {
    async jsonl(arg, ctx) {
      let rows = lastExport.get(arg);
      if (!rows) {
        // Screen not rendered with this filter in this process: rebuild from sessions only (no command / worker events).
        const period = PERIOD[arg.split('|')[0]] ?? DAY;
        const since = Number.isFinite(period) ? Date.now() - period : -Infinity;
        rows = transitions(ctx.sessions(), []).filter(r => r.at >= since);
      }
      if (!rows.length) {
        ctx.info('Audit trail: nothing to export for this filter.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const saved = await ctx.saveText(`agent-audit-${stamp}.jsonl`, toJsonl(rows));
      if (saved) ctx.info(`Audit trail: saved ${rows.length} transitions to ${saved}`);
    },
  },
};
