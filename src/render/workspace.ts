// Agent Workspace: one editor panel with a navigation rail, a main surface and a selection pane.
// Pure string rendering from snapshots; every value is escaped here.
import { AgentSessionSnapshot, ProviderState, SourceState, TimelineEvent } from '../model';
import { duration, weekly } from '../activity/activity';
import { attention, AttentionItem, base, compact, dayStart, flow, hourly, identityColor, isLive, outcome, Outcome, OUTCOME_LABEL, stages, usageSince, verification, Verification, VERIFY_LABEL, workerRole } from '../activity/insights';
import { esc } from './html';
import { extraViews } from './extra';
import { hhmm, statusText } from './views';

export const WS_VIEWS = ['overview', 'attention', 'board', 'team', 'flow', 'worktrees', 'gantt', 'verify', 'activity', 'providers'] as const;
export type CoreView = (typeof WS_VIEWS)[number];
/** Core view id or an add-on screen id from render/extra. */
export type WsView = string;

/** Every screen id, core first then add-ons. */
export function allViews(): string[] {
  return [...WS_VIEWS, ...extraViews().map(v => v.id)];
}

export interface WsState {
  view: WsView;
  selected?: string;
  /** Per-screen options set by toolbar toggles (granularity, orientation, chart type …). */
  opts?: Record<string, string>;
}

export interface WsData {
  sessions: AgentSessionSnapshot[];
  providers: ProviderState[];
  events: TimelineEvent[];
  now: number;
  ternAvailable: boolean;
  idleAlertMinutes?: number;
  /** Git correlation collector state (from the store). */
  git?: { enabled: boolean; lastMs?: number; at?: number };
  /** Lazy access to the store's event history for screens that need more than `events`. */
  timeline?: (key?: string, limit?: number) => TimelineEvent[];
  /** Reads an `agent.*` setting at render time ("agent.x" or "x"). */
  config?: <T>(key: string, fallback: T) => T;
  /** Last refresh pass, for the status strip (host-measured). */
  stats?: { refreshMs: number; gitMs: number; bytesRead: number; artifacts: number; heapMB: number; at: number };
}

/** All collectors, providers first, then git. */
export function sources(d: WsData): SourceState[] {
  const out = d.providers.flatMap(p => p.sources ?? []);
  if (d.git) out.push({ id: 'git', label: 'Git correlation', status: d.git.enabled ? 'ready' : 'off', detail: d.git.enabled ? `read-only, hardened${d.git.lastMs !== undefined ? ` · last pass ${d.git.lastMs} ms` : ''}` : 'off in untrusted workspaces', at: d.git.at ?? d.now });
  return out;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const VIEW_LABEL: Record<CoreView, string> = {
  overview: 'Overview', attention: 'Attention', board: 'Board', team: 'Team', flow: 'Flow', worktrees: 'Worktrees', gantt: 'Last 24 h', verify: 'Verification', activity: 'Activity', providers: 'Sources',
};
const VIEW_HINT: Record<CoreView, string> = {
  overview: 'What is running now, what needs you, and today at a glance.',
  attention: 'Sessions that need a human look, with the observation behind each item.',
  board: 'Every session by live status.',
  team: 'Lead session and its workers, grouped by the role the provider recorded.',
  flow: 'Provider → repository → observed outcome, for sessions in the loaded history.',
  worktrees: 'Which agent works where: repository → branch / worktree → sessions.',
  gantt: 'When each session was active in the last 24 hours, with commits and test runs.',
  verify: 'Test and build commands observed in sessions, with exit-code provenance.',
  activity: 'Factual daily and hourly rollups. Not a productivity score.',
  providers: 'Collectors, provider log storage, and what Agent can observe. Missing access is shown, not hidden.',
};

export function prettyModel(m: string | undefined): string {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

export const repoOf = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';
export const titleOf = (s: AgentSessionSnapshot) => s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8);
export const ago = (now: number, t?: number) => (t ? `${duration(now - t)} ago` : '');

export function stageStrip(s: AgentSessionSnapshot): string {
  return `<span class="stages">${stages(s).map(g => `<span class="stg ${g.state}" title="${esc(`${g.label}: ${g.detail}`)}">${esc(g.label)}</span>`).join('')}</span>`;
}

export function usageLine(s: AgentSessionSnapshot): string {
  const u = s.usage;
  if (!u) return '';
  const parts: string[] = [];
  if (u.contextTokens) parts.push(u.contextWindow ? `ctx ${Math.round((100 * u.contextTokens) / u.contextWindow)}% · ${compact(u.contextTokens)}` : `ctx ${compact(u.contextTokens)}`);
  if (u.totalTokens) parts.push(`${compact(u.totalTokens)} tok`);
  if (u.costUSD !== undefined) parts.push(`$${u.costUSD.toFixed(2)}`);
  return parts.join(' · ');
}

export function ctxBar(s: AgentSessionSnapshot): string {
  const u = s.usage;
  if (!u?.contextTokens || !u.contextWindow) return '';
  const pct = Math.min(100, Math.round((100 * u.contextTokens) / u.contextWindow));
  return `<div class="meter ${pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : ''}" title="context ${pct}% of ${compact(u.contextWindow)} (provider token_count)"><i style="width:${pct}%"></i></div>`;
}

export function card(s: AgentSessionSnapshot, d: WsData, sel?: string, extra = ''): string {
  const live = isLive(s);
  const dur = live ? duration(d.now - (s.startedAt ?? d.now)) : hhmm(s.endedAt ?? s.lastActivityAt);
  const who = [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
  const where = [repoOf(s), s.branch ?? (s.detachedHead ? 'detached' : ''), s.isLinkedWorktree ? `wt ${base(s.worktree)}` : ''].filter(Boolean).join(' · ');
  const u = usageLine(s);
  const act = live && s.lastAction ? `<div class="cl act">▸ ${esc(s.lastAction)} <span class="muted">${esc(ago(d.now, s.lastActionAt))}</span></div>` : '';
  return `<div class="card${sel === s.key ? ' sel' : ''}" style="--id:${identityColor(repoOf(s))}" data-select="${esc(s.key)}" tabindex="0" title="${esc(statusText(s) + ' — ' + s.statusReason)}">
<div class="ct"><span class="dot ${s.status}"></span><b>${esc(titleOf(s))}</b><span class="right">${esc(dur)}</span></div>
<div class="cl"><span class="who">${esc(who)}</span></div><div class="cl muted">${esc(where)}</div>${u ? `<div class="cl num">${esc(u)}</div>` : ''}${ctxBar(s)}${act}${extra}<div>${stageStrip(s)}</div></div>`;
}

export function kpi(value: string | number, label: string, cls = '', title = ''): string {
  return `<div class="kpi ${cls}"${title ? ` title="${esc(title)}"` : ''}><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}

// ---------------------------------------------------------------- views

const DAY = 86400_000;

function overview(d: WsData, st: WsState): string {
  const top = d.sessions.filter(s => !s.isWorker);
  const today = d.now - DAY;
  const live = top.filter(isLive).sort((a, b) => order(a) - order(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const att = attention(d.sessions, d.now, d);
  const todays = top.filter(s => (s.lastActivityAt ?? 0) >= today);
  const tests = d.sessions.flatMap(s => s.tests).filter(t => t.at >= today);
  const commits = new Set(d.sessions.flatMap(s => s.commits).filter(c => c.at >= today).map(c => c.sha));
  const u = usageSince(d.sessions, today);
  const workers = d.sessions.filter(s => s.isWorker && isLive(s)).length;
  let h = `<div class="kpis big">${kpi(live.filter(s => s.status === 'RUNNING').length, 'Running', 'k-run')}${kpi(live.filter(s => s.status === 'NEEDS_INPUT').length, 'Needs input', 'k-need')}${kpi(live.filter(s => s.status === 'IDLE').length, 'Idle', 'k-idle')}${kpi(workers, 'Live workers')}${kpi(att.filter(a => a.severity !== 'low').length, 'Attention', att.some(a => a.severity === 'high') ? 'k-need' : '')}${kpi(todays.length, 'Sessions 24 h')}${kpi(commits.size, 'Commits 24 h')}${kpi(`${tests.filter(t => t.outcome === 'PASS').length}/${tests.length}`, 'Tests pass 24 h', tests.some(t => t.outcome === 'FAIL') ? 'k-fail' : '', 'observed test/build commands in the last 24 hours')}${kpi(compact(u.tokens), 'Tokens 24 h', '', `provider-recorded tokens of ${u.sessions} session(s) active in the last 24 hours (whole-session totals)`)}${u.costSessions ? kpi(`$${u.costUSD.toFixed(2)}`, 'Cost recorded', '', `sum of Claude Code cost-state over ${u.costSessions} session(s) active in the last 24 hours (whole-session totals); Codex records no cost`) : ''}</div>`;
  h += `<div class="cols"><div><h2>Live agents · ${live.length}</h2>${live.length ? `<div class="grid">${live.map(s => card(s, d, st.selected, workersLine(s, d))).join('')}</div>` : '<div class="empty">No live session. Ended sessions are on the Board.</div>'}</div>`;
  h += `<div><h2>Needs attention · ${att.length}</h2>${att.length ? attList(att.slice(0, 6), d, st) : '<div class="empty">Nothing needs you.</div>'}${att.length > 6 ? `<button class="link" data-nav="attention">all ${att.length} items →</button>` : ''}</div></div>`;
  h += `<h2>Last 24 hours</h2>${gantt(d, st, 14)}`;
  return h;
}

function workersLine(s: AgentSessionSnapshot, d: WsData): string {
  const kids = d.sessions.filter(c => c.parentSessionId === s.key);
  if (!kids.length) return '';
  const liveK = kids.filter(isLive).length;
  return `<div class="cl muted">${kids.length} worker${kids.length > 1 ? 's' : ''}${liveK ? ` · <span class="pass">${liveK} live</span>` : ''}</div>`;
}

function order(s: AgentSessionSnapshot): number {
  return s.status === 'NEEDS_INPUT' ? 0 : s.status === 'RUNNING' ? 1 : s.status === 'IDLE' ? 2 : 3;
}

function attList(items: AttentionItem[], d: WsData, st: WsState): string {
  const by = new Map(d.sessions.map(s => [s.key, s]));
  return items
    .map(a => {
      const s = by.get(a.key);
      if (!s) return '';
      return `<div class="att ${a.severity}${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" tabindex="0"><span class="sev">${esc(a.severity)}</span><div><b>${esc(a.reason)}</b><div class="muted">${esc(PROV[s.provider])} · ${esc(titleOf(s))} · ${esc(repoOf(s))}${s.branch ? ` · ${esc(s.branch)}` : ''}</div><div class="basis">${esc(a.basis)} · ${esc(ago(d.now, a.at))}</div></div><button class="link" data-open="${esc(s.key)}">Inspect</button></div>`;
    })
    .join('');
}

function attentionView(d: WsData, st: WsState): string {
  const att = attention(d.sessions, d.now, d);
  if (!att.length) return `<div class="empty">Nothing needs you. Items appear for: input requested, last test failed in a live session, context ≥ 80 %, open turn without activity, long idle, ended with edits but no commit.</div>`;
  return attList(att, d, st);
}

function board(d: WsData, st: WsState): string {
  const today = d.now - DAY;
  const top = d.sessions.filter(s => !s.isWorker);
  const cols: [string, string, AgentSessionSnapshot[]][] = [
    ['NEEDS_INPUT', 'Needs input', top.filter(s => s.status === 'NEEDS_INPUT')],
    ['RUNNING', 'Running', top.filter(s => s.status === 'RUNNING')],
    ['IDLE', 'Idle', top.filter(s => s.status === 'IDLE')],
    ['UNKNOWN', 'Unknown', top.filter(s => s.status === 'UNKNOWN')],
    ['ENDED', 'Ended · 24 h', top.filter(s => s.status === 'ENDED' && (s.endedAt ?? s.lastActivityAt ?? 0) >= today)],
  ];
  return `<div class="board">${cols
    .map(([k, label, list]) => `<div class="col"><div class="colh"><span class="dot ${k}"></span>${esc(label)}<span class="n">${list.length}</span></div>${list.length ? list.slice(0, 40).map(s => card(s, d, st.selected)).join('') + (list.length > 40 ? `<div class="muted">… ${list.length - 40} more</div>` : '') : '<div class="empty">—</div>'}</div>`)
    .join('')}</div>`;
}

/** Root for the Team view: the selection (or its parent), else the lead with the most live workers. */
export function teamRoot(d: WsData, selected?: string): AgentSessionSnapshot | undefined {
  const by = new Map(d.sessions.map(s => [s.key, s]));
  let s = selected ? by.get(selected) : undefined;
  while (s?.parentSessionId && by.has(s.parentSessionId)) s = by.get(s.parentSessionId);
  if (s && d.sessions.some(c => c.parentSessionId === s!.key)) return s;
  const leads = d.sessions.filter(x => !x.isWorker && d.sessions.some(c => c.parentSessionId === x.key));
  const score = (x: AgentSessionSnapshot) => d.sessions.filter(c => c.parentSessionId === x.key && isLive(c)).length * 1000 + (isLive(x) ? 500 : 0) + (x.lastActivityAt ?? 0) / 1e10;
  return leads.sort((a, b) => score(b) - score(a))[0] ?? s;
}

function team(d: WsData, st: WsState): string {
  const root = teamRoot(d, st.selected);
  const leads = d.sessions.filter(x => !x.isWorker && d.sessions.some(c => c.parentSessionId === x.key)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  let h = `<div class="pick">${leads.slice(0, 12).map(l => `<button class="pill${root?.key === l.key ? ' on' : ''}" data-select="${esc(l.key)}" style="--id:${identityColor(repoOf(l))}"><span class="dot ${l.status}"></span>${esc(titleOf(l).slice(0, 32))} <span class="muted">${d.sessions.filter(c => c.parentSessionId === l.key).length}</span></button>`).join('')}</div>`;
  if (!root) return h + `<div class="empty">No session with observed workers in the loaded history. Claude exposes subagents as subagents/ transcripts; Codex exposes them via parent_thread_id.</div>`;
  const kids = d.sessions.filter(c => c.parentSessionId === root.key).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const lanes = new Map<string, AgentSessionSnapshot[]>();
  for (const k of kids) lanes.set(workerRole(k), [...(lanes.get(workerRole(k)) ?? []), k]);
  h += `<div class="org"><div class="lead">${card(root, d, st.selected, `<div class="cl muted">${kids.length} worker(s) · ${kids.filter(isLive).length} live · ${kids.reduce((n, k) => n + k.changedFiles.length, 0)} files by workers</div>`)}</div><div class="lanes">`;
  for (const [role, list] of lanes) {
    const shown = list.slice(-12);
    h += `<div class="lane" style="--id:${identityColor(role)}"><div class="laneh"><b>${esc(role)}</b> <span class="muted">${list.length} · ${list.filter(isLive).length} live</span></div><div class="grid">${shown.map(k => card(k, d, st.selected, nested(k, d))).join('')}</div>${list.length > shown.length ? `<div class="muted">… ${list.length - shown.length} earlier ${esc(role)} worker(s)</div>` : ''}</div>`;
  }
  return h + `</div></div><div class="foot">Roles are the worker type the provider recorded (Claude subagent type, Codex agent nickname). Edges exist only where the provider recorded the parent.</div>`;
}

function nested(k: AgentSessionSnapshot, d: WsData): string {
  const n = d.sessions.filter(c => c.parentSessionId === k.key).length;
  return n ? `<div class="cl muted">${n} nested worker(s)</div>` : '';
}

const OUT_COLOR: Record<Outcome, string> = { live: 'var(--ok)', committed: 'var(--accent)', changed: 'var(--warn)', nochange: 'var(--quiet)' };

const VER_COLOR: Record<Verification, string> = { pass: 'var(--ok)', fail: 'var(--bad)', none: 'var(--quiet)' };

/** Sankey provider → repo → outcome → verification. Clicking a node or band filters the table below (flow.pick = "c<col>-<i>" or "l<stage>-<i>-<j>"). */
function flowView(d: WsData, st: WsState): string {
  const f = flow(d.sessions);
  const top = d.sessions.filter(s => !s.isWorker);
  const total = top.length;
  if (!total) return `<div class="empty">No sessions in the loaded history.</div>`;
  const cols: string[][] = [f.providers, f.repos, f.outcomes, f.verifs];
  const W = 1000, H = Math.max(260, Math.min(560, 40 + f.repos.length * 46)), nodeW = 12, gap = 10;
  const xs = [120, 390, 650, 880];
  const keyOf = (ci: number, s: AgentSessionSnapshot) => (ci === 0 ? s.provider : ci === 1 ? f.repoOf(s) : ci === 2 ? outcome(s) : verification(s));
  const val = (col: number, n: string) => top.filter(s => keyOf(col, s) === n).length;
  const scale = (H - 20 - gap * Math.max(...cols.map(c => c.length))) / total;
  const pos = new Map<string, { x: number; y: number; h: number; out: number; in: number }>();
  cols.forEach((c, ci) => {
    let y = 10;
    for (const n of c) {
      const h = Math.max(3, val(ci, n) * scale);
      pos.set(`${ci}:${n}`, { x: xs[ci], y, h, out: 0, in: 0 });
      y += h + gap;
    }
  });
  const pick = st.opts?.['flow.pick'] ?? '';
  let match: (s: AgentSessionSnapshot) => boolean = () => true;
  let pickLabel = '';
  const lab = (ci: number, n: string) => (ci === 0 ? PROV[n] : ci === 2 ? OUTCOME_LABEL[n as Outcome] : ci === 3 ? VERIFY_LABEL[n as Verification] : n);
  const mc = /^c(\d)-(\d+)$/.exec(pick), ml = /^l(\d)-(\d+)-(\d+)$/.exec(pick);
  if (mc && cols[+mc[1]]?.[+mc[2]] !== undefined) {
    const ci = +mc[1], n = cols[ci][+mc[2]];
    match = s => keyOf(ci, s) === n;
    pickLabel = lab(ci, n);
  } else if (ml && cols[+ml[1]]?.[+ml[2]] !== undefined && cols[+ml[1] + 1]?.[+ml[3]] !== undefined) {
    const ci = +ml[1], n1 = cols[ci][+ml[2]], n2 = cols[ci + 1][+ml[3]];
    match = s => keyOf(ci, s) === n1 && keyOf(ci + 1, s) === n2;
    pickLabel = `${lab(ci, n1)} → ${lab(ci + 1, n2)}`;
  }
  const colorOf = (ci: number, n: string) => (ci === 0 ? (n === 'claude' ? 'var(--claude)' : 'var(--codex)') : ci === 1 ? identityColor(n) : ci === 2 ? OUT_COLOR[n as Outcome] : VER_COLOR[n as Verification]);
  let paths = '', nodes = '';
  for (const l of f.links) {
    const ci = l.stage;
    const a = pos.get(`${ci}:${l.from}`), b = pos.get(`${ci + 1}:${l.to}`);
    if (!a || !b) continue;
    const w = Math.max(1, l.value * scale);
    const y1 = a.y + a.out + w / 2, y2 = b.y + b.in + w / 2;
    a.out += w;
    b.in += w;
    const x1 = a.x + nodeW, x2 = b.x, mx = (x1 + x2) / 2;
    const id = `l${ci}-${cols[ci].indexOf(l.from)}-${cols[ci + 1].indexOf(l.to)}`;
    paths += `<path class="fl${pick === id ? ' on' : ''}" data-opt="flow.pick" data-val="${pick === id ? '' : id}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${colorOf(ci + 1, l.to)}" stroke-width="${w.toFixed(1)}" fill="none"><title>${esc(`${lab(ci, l.from)} → ${lab(ci + 1, l.to)}: ${l.value} · click to list`)}</title></path>`;
  }
  cols.forEach((c, ci) => {
    c.forEach((n, i) => {
      const p = pos.get(`${ci}:${n}`)!;
      const id = `c${ci}-${i}`;
      const tx = ci === 0 ? p.x - 6 : p.x + nodeW + 6;
      nodes += `<g class="fn${pick === id ? ' on' : ''}" data-opt="flow.pick" data-val="${pick === id ? '' : id}"><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="3" fill="${colorOf(ci, n)}"/><text class="halo" x="${tx}" y="${p.y + p.h / 2 + 4}" text-anchor="${ci === 0 ? 'end' : 'start'}">${esc(lab(ci, n))} <tspan class="muted">${val(ci, n)}</tspan></text><title>${esc(lab(ci, n))}: click to list</title></g>`;
    });
  });
  const heads = ['Provider', 'Repository', 'Outcome', 'Verification'].map((h, i) => `<text class="fh" x="${xs[i] + (i === 0 ? nodeW : 0)}" y="8" text-anchor="${i === 0 ? 'end' : 'start'}">${h}</text>`).join('');
  const rows = top.filter(match).sort((x, y) => (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0)).slice(0, 200);
  const table = `<h2>${pick ? `${esc(pickLabel)} · ${top.filter(match).length} sessions <button class="link" data-opt="flow.pick" data-val="">clear</button>` : `All sessions · click a node or band to filter`}</h2><table class="ft"><thead><tr><th>Session</th><th>Provider</th><th>Repository</th><th>Outcome</th><th>Verification</th><th>Last activity</th></tr></thead><tbody>${rows.map(s => `<tr data-select="${esc(s.key)}" class="${s.key === st.selected ? 'sel' : ''}"><td>${esc(titleOf(s))}</td><td>${esc(PROV[s.provider])}</td><td>${esc(f.repoOf(s))}</td><td>${esc(OUTCOME_LABEL[outcome(s)])}</td><td><span class="sd" style="background:${VER_COLOR[verification(s)]}"></span> ${esc(VERIFY_LABEL[verification(s)])}</td><td>${esc(ago(d.now, s.lastActivityAt))}</td></tr>`).join('')}</tbody></table>`;
  return `<svg class="flow" viewBox="0 -6 ${W} ${H + 6}" preserveAspectRatio="xMidYMin meet">${heads}${paths}${nodes}</svg><div class="foot">${total} top-level sessions. Outcome is factual: live, commit observed in the session window, files edited without a commit, or no file change observed. Verification is the session's last observed test command. "No commit" is not a failure.</div>${table}`;
}

function worktrees(d: WsData, st: WsState): string {
  const top = d.sessions.filter(s => !s.isWorker);
  const repos = new Map<string, Map<string, AgentSessionSnapshot[]>>();
  for (const s of top) {
    const r = repoOf(s);
    const wt = `${s.branch ?? (s.detachedHead ? 'detached HEAD' : 'branch not exposed')}${s.isLinkedWorktree ? `\u0000${base(s.worktree)}` : ''}`;
    const m = repos.get(r) ?? new Map();
    m.set(wt, [...(m.get(wt) ?? []), s]);
    repos.set(r, m);
  }
  const liveIn = (m: Map<string, AgentSessionSnapshot[]>) => [...m.values()].flat().filter(isLive).length;
  const last = (m: Map<string, AgentSessionSnapshot[]>) => Math.max(...[...m.values()].flat().map(s => s.lastActivityAt ?? 0));
  const sorted = [...repos].sort((a, b) => liveIn(b[1]) - liveIn(a[1]) || last(b[1]) - last(a[1]));
  if (!sorted.length) return `<div class="empty">No sessions in the loaded history.</div>`;
  return sorted
    .map(([repo, m]) => {
      const rows = [...m].sort((a, b) => b[1].filter(isLive).length - a[1].filter(isLive).length || Math.max(...b[1].map(s => s.lastActivityAt ?? 0)) - Math.max(...a[1].map(s => s.lastActivityAt ?? 0)));
      return `<div class="repo" style="--id:${identityColor(repo)}"><div class="repoh"><span class="sw"></span><b>${esc(repo)}</b><span class="muted">${m.size} branch/worktree · ${[...m.values()].flat().length} sessions${liveIn(m) ? ` · <span class="pass">${liveIn(m)} live</span>` : ''}</span></div>${rows
        .map(([k, list]) => {
          const [br, wt] = k.split('\u0000');
          const sessions = list.sort((a, b) => order(a) - order(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
          const ternBtn = d.ternAvailable ? ` <button class="link" data-cmd="openInTern" data-key="${esc(sessions[0].key)}">Open in Tern</button>` : '';
          return `<div class="wt"><div class="wtn"><span class="br">⎇ ${esc(br)}</span>${wt ? ` <span class="chip">wt ${esc(wt)}</span>` : ''}${ternBtn}</div><div class="who">${sessions
            .slice(0, 12)
            .map(s => `<span class="agent${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" title="${esc(`${titleOf(s)} — ${statusText(s)}`)}"><span class="dot ${s.status}"></span>${esc(s.provider === 'claude' ? 'Claude' : 'Codex')} <span class="muted">${esc(titleOf(s).slice(0, 26))}</span></span>`)
            .join('')}${sessions.length > 12 ? `<span class="muted">+${sessions.length - 12}</span>` : ''}</div></div>`;
        })
        .join('')}</div>`;
    })
    .join('');
}

/** Swimlanes for sessions active in the last 24 hours. */
export function gantt(d: WsData, st: WsState, limit = 60): string {
  const t0 = d.now - DAY;
  const recent = d.sessions.filter(s => !s.isWorker && (s.lastActivityAt ?? 0) >= t0);
  // Probe-like sessions (ended, < 3 min, no edit, no commit) fold into one line so real work stays readable.
  const brief = (s: AgentSessionSnapshot) => !isLive(s) && (s.lastActivityAt ?? 0) - (s.startedAt ?? 0) < 180_000 && !s.changedFiles.length && !s.commits.length;
  const folded = recent.filter(brief);
  const list = recent.filter(s => !brief(s)).sort((a, b) => order(a) - order(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (!recent.length) return `<div class="empty">No session active in the last 24 hours.</div>`;
  if (!list.length) list.push(...folded.splice(0));
  const from = Math.max(t0, Math.min(...list.map(s => s.startedAt ?? d.now)));
  const lo = Math.floor(from / 3600_000) * 3600_000, hi = Math.max(lo + 3600_000, d.now);
  const pct = (t: number) => ((Math.min(Math.max(t, lo), hi) - lo) / (hi - lo)) * 100;
  const hours: number[] = [];
  for (let t = lo; t <= hi; t += 3600_000) hours.push(t);
  const step = hours.length > 16 ? 3 : hours.length > 8 ? 2 : 1;
  let h = `<div class="gantt"><div class="gh"><span></span><div class="track">${hours.filter((_, i) => i % step === 0).map(t => `<span class="tick" style="left:${pct(t)}%">${String(new Date(t).getHours()).padStart(2, '0')}</span>`).join('')}<span class="now" style="left:${pct(d.now)}%"></span></div></div>`;
  for (const s of list.slice(0, limit)) {
    const a = pct(s.startedAt ?? lo), b = pct(isLive(s) ? d.now : (s.lastActivityAt ?? lo));
    const marks = [...s.commits.filter(c => c.at >= lo).map(c => `<i class="mk commit" style="left:${pct(c.at)}%" title="${esc(`commit ${c.sha.slice(0, 7)} ${c.subject}`)}"></i>`), ...s.tests.filter(t => t.at >= lo).map(t => `<i class="mk test ${t.outcome}" style="left:${pct(t.at)}%" title="${esc(`${t.outcome} ${t.command}`)}"></i>`)].join('');
    h += `<div class="gr${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}"><span class="gl"><span class="dot ${s.status}"></span>${esc(titleOf(s).slice(0, 34))}</span><div class="track"><span class="bar2 ${s.provider}${isLive(s) ? ' live' : ''}" style="left:${a}%;width:${Math.max(0.6, b - a)}%;--id:${identityColor(repoOf(s))}"></span>${marks}</div></div>`;
  }
  if (list.length > limit) h += `<div class="muted">… ${list.length - limit} more sessions in the last 24 hours</div>`;
  if (folded.length) h += `<div class="gr"><span class="gl muted">+ ${folded.length} short sessions (&lt; 3 min, no edit)</span><div class="track">${folded.map(s => `<i class="mk test UNKNOWN" style="left:${pct(s.startedAt ?? lo)}%" title="${esc(titleOf(s))}"></i>`).join('')}</div></div>`;
  return h + `<div class="legend"><span class="bar2 claude sample"></span> Claude <span class="bar2 codex sample"></span> Codex <i class="mk commit sample"></i> commit <i class="mk test PASS sample"></i> test pass <i class="mk test FAIL sample"></i> test fail · bars span first→last observed activity</div></div>`;
}

function verify(d: WsData, st: WsState): string {
  const rows = d.sessions.flatMap(s => s.tests.map(t => ({ s, t }))).sort((a, b) => b.t.at - a.t.at);
  const today = d.now - DAY;
  const td = rows.filter(r => r.t.at >= today);
  const failingNow = d.sessions.filter(s => isLive(s) && s.tests[s.tests.length - 1]?.outcome === 'FAIL');
  let h = `<div class="kpis">${kpi(td.length, 'Runs 24 h')}${kpi(td.filter(r => r.t.outcome === 'PASS').length, 'Pass', 'k-run')}${kpi(td.filter(r => r.t.outcome === 'FAIL').length, 'Fail', td.some(r => r.t.outcome === 'FAIL') ? 'k-fail' : '')}${kpi(failingNow.length, 'Live, last failed', failingNow.length ? 'k-fail' : '')}${kpi(rows.filter(r => r.t.source === 'provider-exit-code').length, 'With exit code', '', 'outcome from the recorded process exit code (Codex); the rest come from the provider tool error flag (Claude)')}</div>`;
  if (!rows.length) return h + `<div class="empty">No test or build command observed. Agent never parses phrases like "tests passed" as proof.</div>`;
  h += `<table class="vt"><tr><th>When</th><th>Session</th><th>Repo</th><th>Command</th><th>Result</th><th>Source</th></tr>${rows
    .slice(0, 150)
    .map(({ s, t }) => `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}"><td>${t.at >= dayStart(d.now) ? hhmm(t.at) : esc(new Date(t.at).toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + hhmm(t.at))}</td><td>${esc(titleOf(s).slice(0, 30))}</td><td><span class="sw" style="--id:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td><code>${esc(t.command)}</code></td><td class="${t.outcome === 'PASS' ? 'pass' : t.outcome === 'FAIL' ? 'fail' : 'muted'}">${t.outcome}${t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ''}</td><td class="muted">${t.source === 'provider-exit-code' ? 'exit code' : 'tool status'}</td></tr>`)
    .join('')}</table>`;
  return h;
}

function activity(d: WsData): string {
  const days = weekly(d.sessions, d.now);
  const max = Math.max(1, ...days.map(x => x.sessions));
  let h = `<div class="week">${days
    .map(x => `<div class="wd"><div class="stack" title="${esc(`Claude ${x.byProvider.claude} · Codex ${x.byProvider.codex}`)}"><i class="codex" style="height:${(x.byProvider.codex / max) * 100}%"></i><i class="claude" style="height:${(x.byProvider.claude / max) * 100}%"></i></div><b>${x.sessions}</b><span>${esc(x.label)}</span><span class="muted">${x.commits}c · ${x.tests}t</span></div>`)
    .join('')}</div>`;
  const grid = hourly(d.events, d.now);
  const hmax = Math.max(1, ...grid.flatMap(r => r.counts));
  h += `<h2>Observed events per hour</h2><div class="heat"><span></span>${Array.from({ length: 24 }, (_, i) => `<span class="hx">${i % 3 === 0 ? String(i).padStart(2, '0') : ''}</span>`).join('')}${grid
    .map(r => `<span class="hy">${esc(new Date(r.day).toLocaleDateString(undefined, { weekday: 'short' }))}</span>${r.counts.map((c, i) => `<i style="opacity:${c ? 0.18 + 0.82 * (c / hmax) : 0.06}" title="${esc(`${new Date(r.day).toDateString()} ${i}:00 — ${c} events`)}"></i>`).join('')}`)
    .join('')}</div><div class="foot">Commands, file edits, tests, commits and worker starts. Turn and tool chatter are excluded.</div>`;
  h += `<h2>Per day</h2><table><tr><th>Day</th><th>Sessions</th><th>Workers</th><th>Observed</th><th>Commits</th><th>Files</th><th>Tests</th><th>Repos</th></tr>${days
    .map(x => `<tr><td>${esc(x.label)} <span class="muted">${esc(x.day.slice(5))}</span></td><td>${x.sessions}</td><td>${x.workers}</td><td>${duration(x.durationMin * 60_000)}</td><td>${x.commits}</td><td>${x.filesChanged}</td><td>${x.tests}</td><td title="${esc(x.repos.join(', '))}">${x.repos.length}</td></tr>`)
    .join('')}</table>`;
  return h;
}

const MATRIX: [string, string, string][] = [
  ['Session id, start, last activity', 'transcript records', 'rollout records'],
  ['cwd / branch', 'record .cwd, .gitBranch, worktree-state', 'session_meta / turn_context .cwd'],
  ['Model / effort', 'assistant .model, record .effort', 'turn_context .model, .effort'],
  ['Live status', '~/.claude/sessions registry busy/idle', 'open turn + recency (INFERRED)'],
  ['Tests', 'command + tool error flag', 'command + exit code'],
  ['File edits', 'Edit/Write tool inputs', 'FileChange items'],
  ['Workers', 'subagents/ transcripts + meta', 'parent_thread_id, agent nickname'],
  ['Tokens', 'assistant .usage per message', 'token_count (cumulative)'],
  ['Context window', 'not recorded', 'token_count .model_context_window'],
  ['Cost', 'cost-state .totalCostUSD', 'not recorded'],
  ['HEAD before', 'git log before start (DERIVED)', 'session_meta git.commit_hash'],
];

function providersView(d: WsData, st: WsState): string {
  const src = sources(d);
  let h = `<h2>Collectors</h2><table class="src"><tr><th></th><th>Source</th><th>Status</th><th>Items</th><th>Detail</th><th>Collected</th></tr>${src
    .map(x => `<tr><td><span class="sd ${x.status}"></span></td><td>${esc(x.label)}</td><td class="st-${x.status}">${esc(x.status)}</td><td class="num">${x.count ?? ''}</td><td class="muted">${esc(x.detail)}</td><td class="muted">${hhmm(x.at)}</td></tr>`)
    .join('')}</table>`;
  // Storage: provider artifacts in the loaded window.
  const withSize = d.sessions.filter(s => s.artifactBytes);
  const per = (p: string) => withSize.filter(s => s.provider === p).reduce((n, s) => n + (s.artifactBytes ?? 0), 0);
  const total = per('claude') + per('codex');
  h += `<h2>Storage · provider logs in the loaded history</h2><div class="kpis">${kpi(bytes(total), 'Total')}${kpi(bytes(per('claude')), 'Claude Code')}${kpi(bytes(per('codex')), 'Codex')}${kpi(withSize.length, 'Artifacts')}</div>`;
  if (total) h += `<div class="split"><i class="claude" style="width:${(100 * per('claude')) / total}%"></i><i class="codex" style="width:${(100 * per('codex')) / total}%"></i></div>`;
  const largest = [...withSize].sort((x, y) => (y.artifactBytes ?? 0) - (x.artifactBytes ?? 0)).slice(0, 10);
  const max = largest[0]?.artifactBytes ?? 1;
  if (largest.length) h += `<table class="vt">${largest.map(s => `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}"><td class="num">${bytes(s.artifactBytes ?? 0)}</td><td style="width:30%"><span class="szbar ${s.provider}" style="width:${Math.max(2, (100 * (s.artifactBytes ?? 0)) / max)}%"></span></td><td>${esc(titleOf(s).slice(0, 48))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted">${esc(repoOf(s))}</td><td><button class="link" data-cmd="openArtifactFolder" data-key="${esc(s.key)}">Reveal</button></td></tr>`).join('')}</table>`;
  h += `<div class="foot">Sizes are the provider's own log files for sessions in the loaded window (\`agent.historyDays\`). Agent reads them incrementally and never copies, compacts or deletes them.</div>`;
  h += `<h2>Providers</h2><div class="grid">${d.providers
    .map(p => {
      const ss = d.sessions.filter(s => s.provider === p.provider);
      return `<div class="card" style="--id:${p.provider === 'claude' ? 'var(--claude)' : 'var(--codex)'}"><div class="ct"><span class="dot ${p.detected ? 'RUNNING' : 'UNKNOWN'}"></span><b>${esc(PROV[p.provider])}</b><span class="right">${p.version ? esc(p.version) : ''}</span></div><div class="cl muted">${esc(p.detected ? 'detected' : 'not detected')}${p.versionSource ? ` · version from ${esc(p.versionSource)}` : ''}</div><div class="cl">${ss.filter(s => !s.isWorker).length} sessions · ${ss.filter(s => s.isWorker).length} workers · ${ss.filter(isLive).length} live</div>${p.diagnostics.slice(0, 5).map(x => `<div class="cl basis">${esc(x)}</div>`).join('')}</div>`;
    })
    .join('')}</div>`;
  h += `<h2>Observability matrix</h2><table><tr><th>Fact</th><th>Claude Code</th><th>Codex</th></tr>${MATRIX.map(r => `<tr><td>${esc(r[0])}</td><td class="muted">${esc(r[1])}</td><td class="muted">${esc(r[2])}</td></tr>`).join('')}</table><div class="foot">Agent reads provider files only. It never uploads transcripts, never edits provider files and never controls sessions.</div>`;
  return h;
}

// ---------------------------------------------------------------- selection pane

export function side(d: WsData, key: string | undefined): string {
  const s = key ? d.sessions.find(x => x.key === key) : undefined;
  if (!s) return `<div class="empty">Select a session to see its result card.</div>`;
  const kids = d.sessions.filter(c => c.parentSessionId === s.key);
  const parent = s.parentSessionId ? d.sessions.find(x => x.key === s.parentSessionId) : undefined;
  let h = `<div class="sideh" style="--id:${identityColor(repoOf(s))}"><div class="muted">${esc(PROV[s.provider])}${s.isWorker ? ` · worker ${esc(workerRole(s))}` : ''}</div><h3>${esc(titleOf(s))}</h3><div><span class="dot ${s.status}"></span> ${esc(statusText(s))} <span class="muted">· ${esc(s.statusReason)}</span></div></div>`;
  return h + resultCard(s, d.now) + sideRest(d, s, kids, parent);
}

/** Session result: duration, model, HEAD before→after, commits, files, lines, tests, tokens, cost, context, stages. */
export function resultCard(s: AgentSessionSnapshot, now: number): string {
  const pass = s.tests.filter(t => t.outcome === 'PASS').length, fail = s.tests.filter(t => t.outcome === 'FAIL').length;
  const live = isLive(s);
  const cell = (label: string, v: string, cls = '') => `<div class="rc ${cls}"><span>${esc(label)}</span><b>${v}</b></div>`;
  const u = s.usage;
  let h = '';
  h += `<div class="rcard">${cell('Duration', esc(duration((live ? now : (s.lastActivityAt ?? now)) - (s.startedAt ?? now))))}${cell('Model', esc([prettyModel(s.model), s.effort].filter(Boolean).join(' · ') || '—'))}${cell('HEAD', `<code>${esc(s.headBefore?.slice(0, 7) ?? '?')}</code> → <code>${esc(s.headAfter?.slice(0, 7) ?? '?')}</code>`)}${cell('Commits', String(s.commits.length), s.commits.length ? 'ok' : '')}${cell('Files', String(s.changedFiles.length))}${cell('Lines', s.linesAdded !== undefined ? `<span class="pass">+${s.linesAdded}</span> <span class="fail">−${s.linesRemoved ?? 0}</span>` : '—')}${cell('Tests', s.tests.length ? `<span class="pass">${pass}✓</span> <span class="fail">${fail}✗</span>` : '—', fail && s.tests[s.tests.length - 1].outcome === 'FAIL' ? 'bad' : '')}${cell('Tokens', u ? esc(compact(u.totalTokens)) : '—')}${u?.costUSD !== undefined ? cell('Cost (recorded)', `$${u.costUSD.toFixed(2)}`) : ''}${u?.contextTokens ? cell('Context', esc(u.contextWindow ? `${Math.round((100 * u.contextTokens) / u.contextWindow)}%` : compact(u.contextTokens))) : ''}</div>${ctxBar(s)}`;
  h += `<div class="sidestages">${stageStrip(s)}</div>`;
  return h;
}

function sideRest(d: WsData, s: AgentSessionSnapshot, kids: AgentSessionSnapshot[], parent: AgentSessionSnapshot | undefined): string {
  let h = `<div class="sloc"><div><span class="muted">repo</span> ${esc(repoOf(s))}</div><div><span class="muted">branch</span> ${esc(s.branch ?? (s.detachedHead ? 'detached HEAD' : 'not exposed'))}</div>${s.isLinkedWorktree ? `<div><span class="muted">worktree</span> ${esc(base(s.worktree))}</div>` : ''}${s.lastAction ? `<div><span class="muted">last</span> ${esc(s.lastAction)} <span class="muted">${esc(ago(d.now, s.lastActionAt))}</span></div>` : ''}</div>`;
  h += `<div class="acts"><button class="btn" data-open="${esc(s.key)}">Open inspector</button><button class="link" data-cmd="openTimeline" data-key="${esc(s.key)}">Timeline</button><button class="link" data-cmd="revealWorktree" data-key="${esc(s.key)}">Reveal</button><button class="link" data-cmd="copySessionId" data-key="${esc(s.key)}">Copy id</button>${d.ternAvailable ? `<button class="link" data-cmd="openInTern" data-key="${esc(s.key)}">Tern</button>` : ''}</div>`;
  if (parent) h += `<h2>Parent</h2><div class="mini" data-select="${esc(parent.key)}"><span class="dot ${parent.status}"></span>${esc(titleOf(parent))}</div>`;
  if (kids.length) h += `<h2>Workers · ${kids.length}</h2>${kids.slice(-10).map(k => `<div class="mini" data-select="${esc(k.key)}"><span class="dot ${k.status}"></span>${esc(titleOf(k).slice(0, 40))}</div>`).join('')}${kids.length > 10 ? `<button class="link" data-nav="team">all in Team →</button>` : ''}`;
  if (s.commits.length) h += `<h2>Commits</h2>${s.commits.slice(-6).map(c => `<div class="mini"><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}<div class="basis">${c.attribution === 'session-ran-git-commit' ? 'session ran git commit' : 'commit observed during session'}</div></div>`).join('')}`;
  const ev = d.events.filter(e => e.sessionKey === s.key && e.type !== 'TOOL_ACTIVITY' && e.type !== 'SESSION_ACTIVITY').slice(-10).reverse();
  if (ev.length) h += `<h2>Recent</h2>${ev.map(e => `<div class="tl2"><span class="muted">${hhmm(e.at)}</span> ${esc(e.label)}</div>`).join('')}`;
  return h;
}

// ---------------------------------------------------------------- shell

/** Scope key of a session: lowercase repository (or cwd) folder name. Toolbar values are lowercase. */
export const scopeKey = (s: AgentSessionSnapshot) => repoOf(s).toLowerCase();

/** Applies the `scope` option (a scopeKey from the Projects screen) to every screen. */
export function scoped(d: WsData, scope: string | undefined): WsData {
  if (!scope) return d;
  const keep = new Set(d.sessions.filter(s => scopeKey(s) === scope).map(s => s.key));
  return { ...d, sessions: d.sessions.filter(s => keep.has(s.key)), events: d.events.filter(e => keep.has(e.sessionKey)) };
}

export function attentionCount(d: WsData): number {
  return attention(d.sessions, d.now, d).filter(a => a.severity !== 'low').length;
}

function collectorSummary(d: WsData): string {
  const src = sources(d);
  if (!src.length) return '';
  const n = (k: string) => src.filter(s => s.status === k).length;
  const parts = [['ready', n('ready')], ['partial', n('partial')], ['missing', n('missing')], ['off', n('off')]].filter(([, c]) => c) as [string, number][];
  return `<button class="link cs" data-nav="providers" title="Collectors">${parts.map(([k, c]) => `<span class="sd ${k}"></span>${c} ${k}`).join(' · ')}</button>`;
}

/** Bottom strip: refresh cost and a ticker of repositories with live sessions (status dot per session). */
export function statusStrip(d: WsData): string {
  const live = d.sessions.filter(s => isLive(s));
  const byRepo = new Map<string, AgentSessionSnapshot[]>();
  for (const s of live) byRepo.set(repoOf(s), [...(byRepo.get(repoOf(s)) ?? []), s]);
  const ticker = [...byRepo].sort((a, b) => b[1].length - a[1].length).map(([r, ss]) => `<span class="tk" title="${esc(`${r}: ${ss.length} live (${ss.filter(x => x.isWorker).length} workers)`)}"><span class="sw" style="background:${identityColor(r)}"></span>${esc(r)} ${ss.map(x => `<span class="sd ${x.status}" title="${esc(`${titleOf(x)} · ${statusText(x)}`)}"></span>`).join('')}</span>`).join('');
  const st = d.stats;
  const cost = st ? `<span title="Last refresh pass (DERIVED, host-measured)">refresh ${st.refreshMs} ms · git ${st.gitMs} ms · read ${bytes(st.bytesRead)} of ${st.artifacts} artifacts · heap ${st.heapMB} MB · ${hhmm(st.at)}</span>` : '';
  return `<footer class="strip"><span class="tkr">${live.length ? `<b>${live.length} live</b> ${ticker}` : '<span class="muted">nothing live</span>'}</span><span class="muted">${cost}</span></footer>`;
}

const RAIL_GROUPS = ['Now', 'Sessions', 'Time', 'Git', 'Usage', 'Quality', 'System'];
const CORE_GROUP: Record<string, string> = { overview: 'Now', attention: 'Now', board: 'Sessions', team: 'Sessions', gantt: 'Time', worktrees: 'Git', activity: 'Usage', flow: 'Usage', verify: 'Quality', providers: 'System' };
/** Reading order inside groups; screens not listed go last in their group. */
const RAIL_ORDER = ['overview', 'attention', 'live', 'workflows', 'codex', 'projects', 'board', 'team', 'topology', 'roles', 'transcript', 'replay', 'gantt', 'week', 'runs', 'forecast', 'history', 'worktrees', 'repos', 'changes', 'review', 'pipelines', 'tokens', 'limits', 'explore', 'activity', 'flow', 'verify', 'signals', 'health', 'backlog', 'providers', 'settings', 'catalog', 'audit', 'launcher'];

export function renderWorkspace(d0: WsData, st0: WsState): string {
  let st = st0;
  const d = scoped(d0, st0.opts?.scope);
  const top = d.sessions.filter(s => !s.isWorker);
  const badge: Record<string, string> = {
    attention: String(attentionCount(d) || ''),
    board: String(top.filter(isLive).length || ''),
    team: String(d.sessions.filter(s => s.isWorker && isLive(s)).length || ''),
    verify: String(d.sessions.filter(s => isLive(s) && s.tests[s.tests.length - 1]?.outcome === 'FAIL').length || ''),
  };
  for (const x of extraViews()) if (x.badge) badge[x.id] = x.badge(d);
  const ext = new Map(extraViews().map(x => [x.id, x]));
  const label = (v: string) => (VIEW_LABEL as Record<string, string>)[v] ?? ext.get(v)?.label ?? v;
  const hint = (v: string) => (VIEW_HINT as Record<string, string>)[v] ?? ext.get(v)?.hint ?? '';
  const navBtn = (v: string) => `<button class="nav${st.view === v ? ' on' : ''}" data-nav="${esc(v)}">${esc(label(v))}${badge[v] ? `<span class="nb${v === 'attention' || v === 'verify' ? ' hot' : ''}">${esc(badge[v])}</span>` : ''}</button>`;
  // Rail: every screen (core + add-on) in one of the groups, in a fixed reading order; groups collapse.
  const groupOf = (v: string) => CORE_GROUP[v] ?? ext.get(v)?.group ?? 'System';
  const all = [...WS_VIEWS, ...extraViews().map(x => x.id)];
  const rank = (v: string) => (RAIL_ORDER.indexOf(v) < 0 ? 999 : RAIL_ORDER.indexOf(v));
  const groups = RAIL_GROUPS.map(g => [g, all.filter(v => groupOf(v) === g).sort((a, b) => rank(a) - rank(b))] as const).filter(([, vs]) => vs.length);
  const railGroup = ([g, vs]: readonly [string, string[]]) => {
    const name = `rail.${g.toLowerCase()}`;
    const closed = st.opts?.[name] === 'closed' && !vs.includes(st.view);
    const hot = vs.reduce((n, v) => n + (Number(badge[v]) || 0), 0);
    return `<div class="rg${closed ? ' closed' : ''}"><button class="railg" data-opt="${name}" data-val="${closed ? '' : 'closed'}" title="${closed ? 'Expand' : 'Collapse'} ${esc(g)}"><span class="chev">${closed ? '▸' : '▾'}</span>${esc(g)}<span class="rgc">${closed && hot ? esc(String(hot)) : vs.length}</span></button>${closed ? '' : vs.map(navBtn).join('')}</div>`;
  };
  const rail = `<nav class="rail"><div class="brand">Agent <button class="link" data-cmd="openWorkspaceNewTab" title="Open another Agent tab (own screen and scope)">+ tab</button></div>${groups.map(railGroup).join('')}<div class="railfoot">${d.providers.map(p => `<div><span class="dot ${p.detected ? 'RUNNING' : 'UNKNOWN'}"></span> ${esc(PROV[p.provider])} ${esc(p.version ?? '')}</div>`).join('')}${collectorSummary(d)}<div class="muted">local · read-only</div></div></nav>`;
  const body: Record<string, () => string> = {
    overview: () => overview(d, st), attention: () => attentionView(d, st), board: () => board(d, st), team: () => team(d, st), flow: () => flowView(d, st), worktrees: () => worktrees(d, st), gantt: () => gantt(d, st), verify: () => verify(d, st), activity: () => activity(d), providers: () => providersView(d, st),
  };
  for (const x of extraViews()) body[x.id] = () => x.render(d, st);
  if (!body[st.view]) st = { ...st, view: 'overview' };
  const keys = `<div class="keys"><b>1–0</b> screens <b>j/k</b> move <b>Enter</b> inspect <b>/</b> filter <b>Esc</b> clear <b>r</b> refresh <b>?</b> keys</div>`;
  const main = `<main class="mainw"><header class="mh"><h1>${esc(label(st.view))}</h1>${st.opts?.scope ? `<button class="link scope" data-opt="scope" data-val="" title="Clear scope">scope: ${esc(st.opts.scope)} ✕</button>` : ""}<span class="muted">${esc(hint(st.view))}</span><span class="right"><span class="muted">updated ${hhmm(d.now)}</span> <button class="link" data-cmd="refresh">Refresh</button></span></header>${body[st.view]()}${keys}${statusStrip(d)}</main>`;
  return `<div class="ws">${rail}${main}<aside class="side">${side(d, st.selected)}</aside></div>`;
}

