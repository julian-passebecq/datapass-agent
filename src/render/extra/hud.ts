// Add-on screen "Session HUD": one compact terminal-style card per live session (plus one pinned session):
// plan / permission mode, subagents running / idle / ended, todo progress with the checklist, tests, CI state,
// context use, lessons rules count of the repository, and a tail of the session's last events.
// Logic in src/activity/hud.ts, file reads in src/feeds/lessons.ts (feed), CI from the Pipelines feed (opt-in).
// Pure rendering; every dynamic string goes through esc().
import type { AgentSessionSnapshot, EvidenceKind } from '../../model';
import { ciFor, CiState, HudWorker, hudSessions, LessonsInfo, logTail, LogLine, testSummary, todoProgress, workersOf } from '../../activity/hud';
import { ctxInfo, ctxLabel, DEFAULT_WINDOW } from '../../activity/health';
import { identityColor, isLive } from '../../activity/insights';
import type { CiReport } from '../../feeds/pipelines';
import { loadLessons } from '../../feeds/lessons';
import { esc } from '../html';
import { ago, ctxBar, prettyModel, repoOf, titleOf, WsData, WsState } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';
import { sessTok } from './lifecycle';
import { statusEvidenceOf } from '../../sessions/classify';
import { pipelinesFeed } from './pipelines';

const LESSONS_FEED = 'hud.lessons';
const MAX_CARDS = 12;
const MAX_PICK = 16;
const MAX_WORKERS = 8;
const LOG_LINES = 8;

const EV_SHORT: Record<EvidenceKind, string> = { OBSERVED: 'obs', DERIVED: 'der', INFERRED: 'inf', UNKNOWN: 'unk' };

/** Repository roots of live sessions first, then the most recent ones (the pinned one is usually among them). */
export function lessonRoots(sessions: AgentSessionSnapshot[], max = 24): string[] {
  const sorted = [...sessions].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const out: string[] = [];
  for (const s of sorted) {
    if (s.repository && !out.includes(s.repository)) out.push(s.repository);
    if (out.length >= max) break;
  }
  return out;
}

const lessonsFeed: Feed<Record<string, LessonsInfo>> = {
  id: LESSONS_FEED,
  intervalMs: 60_000,
  load: ctx => loadLessons(lessonRoots(ctx.sessions)),
};

// ---- small parts ---------------------------------------------------------------------------------------------

function ev(kind: EvidenceKind, basis: string): string {
  return `<sup class="hud-ev hud-ev-${kind.toLowerCase()}" title="${esc(`${kind}: ${basis}`)}">${EV_SHORT[kind]}</sup>`;
}

function bar(frac: number, cls = ''): string {
  const p = Math.max(0, Math.min(100, Math.round(frac * 100)));
  return `<span class="hud-bar ${cls}"><i style="width:${p}%"></i></span>`;
}

function row(label: string, value: string, extra = ''): string {
  return `<div class="hud-r"><span class="hud-k">${esc(label)}</span><span class="hud-v">${value}</span></div>${extra}`;
}

const hms = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function modeRow(s: AgentSessionSnapshot): string {
  const m = s.facts?.permissionMode;
  if (s.provider === 'claude') {
    if (!m) return row('plan mode', `<span class="muted">unknown</span>${ev('UNKNOWN', 'no permissionMode recorded in the transcript')}`);
    const on = m === 'plan';
    return row('plan mode', `<span class="hud-tag ${on ? 'on' : ''}">[${on ? 'ON' : 'off'}]</span>${on ? '' : ` <span class="muted">${esc(m)}</span>`}${ev('OBSERVED', 'transcript permissionMode (latest)')}`);
  }
  const parts = [m && `approval ${m}`, s.facts?.sandbox && `sandbox ${s.facts.sandbox}`].filter(Boolean).join(' · ');
  return row('mode', parts ? `<span class="hud-tag">${esc(parts)}</span>${ev('OBSERVED', 'rollout turn_context approval_policy / sandbox_policy')} <span class="muted" title="Codex has no plan mode">plan n/a</span>` : `<span class="muted">unknown</span>${ev('UNKNOWN', 'no turn_context recorded')}`);
}

const W_ICON: Record<HudWorker['state'], string> = { run: '●', needs: '!', idle: '◌', ended: '✓', unknown: '?' };
const W_TEXT: Record<HudWorker['state'], string> = { run: 'run', needs: 'needs input', idle: 'idle', ended: 'ended', unknown: 'unknown' };

function workersRow(s: AgentSessionSnapshot, ws: HudWorker[], d: WsData): string {
  const spawns = s.facts?.spawns?.length ?? 0;
  if (!ws.length) {
    const txt = spawns ? `${spawns} spawned, none loaded as a session` : 'none';
    return row('subagents', `<span class="muted">${esc(txt)}</span>${ev(spawns ? 'OBSERVED' : 'DERIVED', spawns ? 'spawn calls in the transcript / rollout' : 'no child session with this parent')}`);
  }
  const run = ws.filter(w => w.state === 'run').length;
  const idle = ws.filter(w => w.state === 'idle').length;
  const needs = ws.filter(w => w.state === 'needs').length;
  const head = `<b>${run}</b>/${ws.length} running${needs ? ` · <span class="hud-need">${needs} needs input</span>` : ''}${idle ? ` · ${idle} idle` : ''}${ev('DERIVED', 'child sessions (parentSessionId); run / needs input / idle / ended from each child status')}`;
  const list = ws
    .slice(0, MAX_WORKERS)
    .map(w => `<div class="hud-w hud-w-${w.state}" data-select="${esc(w.s.key)}" tabindex="0" title="${esc(`${titleOf(w.s)} · ${w.s.status} · ${w.s.statusReason}`)}"><span class="hud-wi">${W_ICON[w.state]}</span><span class="hud-wn">${esc((w.s.workerLabel ?? titleOf(w.s)).slice(0, 48))}</span><span class="hud-ws">${esc(W_TEXT[w.state])}</span><span class="muted">${esc(ago(d.now, w.s.lastActivityAt))}</span></div>`)
    .join('');
  return row('subagents', head, `<div class="hud-sub">${list}${ws.length > MAX_WORKERS ? `<div class="muted">… ${ws.length - MAX_WORKERS} more</div>` : ''}</div>`);
}

function todoRow(s: AgentSessionSnapshot, d: WsData, full: boolean): string {
  const tp = todoProgress(s);
  if (!tp) {
    const why = s.provider === 'claude' ? 'no TodoWrite / TaskCreate call recorded' : 'no update_plan call recorded';
    return row('todo', `<span class="muted">—</span>${ev('UNKNOWN', why)}`);
  }
  const byOrder = /^Task(Create|Update)/i.test(tp.list.source);
  const head = `${bar(tp.total ? tp.done / tp.total : 0, 'ok')} <b>${tp.done}/${tp.total}</b> <span class="muted">${esc(tp.list.source)} · ${esc(ago(d.now, tp.list.at))}</span>${byOrder ? ev('DERIVED', `${tp.list.source} calls; task ids numbered by creation order (not recorded)`) : ev('OBSERVED', `latest ${tp.list.source} call input`)}`;
  const items = full ? tp.list.items : tp.list.items.filter(i => i.status !== 'completed').slice(0, 6);
  const mark = { completed: '[x]', in_progress: '[>]', pending: '[ ]' } as const;
  const list = items.map(i => `<div class="hud-td hud-td-${i.status}"><span class="hud-tm">${mark[i.status]}</span> ${esc(i.text)}</div>`).join('');
  const more = tp.list.items.length - items.length + (tp.list.dropped ?? 0);
  return row('todo', head, items.length || more ? `<div class="hud-sub">${list}${more ? `<div class="muted">… ${more} more${full ? ' (cap 30)' : ' (done or hidden: switch Checklist to "All")'}</div>` : ''}</div>` : '');
}

function testsRow(s: AgentSessionSnapshot, d: WsData): string {
  const t = testSummary(s);
  if (!t) return row('tests', `<span class="muted">none observed</span>${ev('DERIVED', 'no test command in the loaded records (transcript may be capped; builds, lints and type checks are not tests)')}`);
  const cls = t.failed ? 'bad' : t.unknown ? 'warn' : 'ok';
  const last = t.last ? ` <span class="muted" title="${esc(`last: ${t.last.outcome} ${t.last.command} (${t.last.source})`)}">last ${esc(t.last.outcome)} ${esc(ago(d.now, t.last.at))}</span>` : '';
  return row('tests', `${bar(t.total ? t.passed / t.total : 0, cls)} <b>${t.passed}/${t.total}</b> passed${t.failed ? ` · <span class="hud-bad">${t.failed} failing</span>` : ''}${t.unknown ? ` · ${t.unknown} no outcome` : ''}${last}${ev('OBSERVED', `distinct test commands, latest outcome each (${t.runs} run(s)); outcome from exit code or tool error flag; a chained or piped command with only a tool error flag counts as no outcome`)}`);
}

const CI_TXT: Record<string, [string, string]> = {
  success: ['passing', 'ok'], failed: ['failing', 'bad'], running: ['running', 'warn'], pending: ['queued', 'warn'], blocked: ['waiting for a person', 'warn'], canceled: ['canceled', 'quiet'], skipped: ['skipped', 'quiet'], unknown: ['unknown', 'quiet'],
};

function ciRow(s: AgentSessionSnapshot, report: CiReport | undefined, enabled: boolean): string {
  if (!enabled) return row('CI', `<span class="muted" title="Opt-in setting agent.pipelines.enabled (network via gh / glab)">not enabled</span>${ev('UNKNOWN', 'Pipelines feed is off')}`);
  const c: CiState | 'off' | 'none' = ciFor(s, report);
  if (c === 'off') return row('CI', `<span class="muted">${report?.state === 'untrusted' ? 'untrusted workspace' : 'loading…'}</span>${ev('UNKNOWN', 'Pipelines feed has no data yet')}`);
  if (c === 'none') return row('CI', `<span class="muted">no run found for this repository</span>${ev('UNKNOWN', 'no CI run in the Pipelines feed for the session repository')}`);
  const [txt, cls] = CI_TXT[c.status] ?? CI_TXT.unknown;
  return row('CI', `<span class="hud-ci ${c.basis === 'repo' ? 'quiet' : cls}">${esc(txt)}</span> <span class="muted">${esc(c.ref)}${c.basis === 'repo' ? ' (latest of repo, none on this branch)' : ''}</span>${c.basis === 'repo' ? ev('INFERRED', `newest run of the repository, not of this branch (CI API via the Pipelines feed: ${c.title})`) : ev('OBSERVED', `CI API via the Pipelines feed: ${c.title}`)}`);
}

function ctxRow(s: AgentSessionSnapshot, marker: number): string {
  const c = ctxInfo(s, marker);
  if (c.now === undefined) return row('context', `<span class="muted">—</span>${ev('UNKNOWN', 'no token usage recorded')}`);
  const pct = c.pct ?? 0;
  const meter = c.windowSource === 'OBSERVED' ? `<span class="hud-cb">${ctxBar(s)}</span>` : bar(pct, pct >= 0.8 ? 'bad' : pct >= 0.5 ? 'warn' : 'ok');
  const basis = c.windowSource === 'OBSERVED' ? 'prompt size of the latest model call / window recorded by the provider' : `prompt size of the latest model call (OBSERVED) / reference window ${marker} from agent.health.contextWindow (provider records none)`;
  return row('context', `${meter} <b>${Math.round(pct * 100)} %</b> used <span class="muted">${esc(ctxLabel(c))}${c.compactions ? ` · ⟲${c.compactions}` : ''}</span>${ev(c.windowSource === 'OBSERVED' ? 'OBSERVED' : 'DERIVED', basis)}`);
}

function lessonsRow(s: AgentSessionSnapshot, lessons: Record<string, LessonsInfo> | undefined): string {
  if (!s.repository) return row('lessons', `<span class="muted">no repository</span>${ev('UNKNOWN', 'session has no git repository root')}`);
  const l = lessons?.[s.repository];
  if (!l) return row('lessons', `<span class="muted">${lessons ? 'not loaded (repository not among the 24 most recent)' : 'loading…'}</span>${ev('UNKNOWN', 'lessons feed')}`);
  if (!l.file) return row('lessons', `<span class="muted">no handoff/MEMORY.md, tasks/lessons.md or CLAUDE.md Lessons section</span>${ev('DERIVED', 'files looked up in the repository root')}`);
  const fill = Math.min(1, l.rules / 50);
  return row('lessons', `${bar(fill, 'acc')} <b>${l.rules}</b> rules <span class="muted">${esc(l.file)}${l.truncated ? ' (first 256 KB)' : ''}</span>${ev('DERIVED', `bullet / numbered lines in ${l.file}${l.file === 'CLAUDE.md' ? ' under a "Lessons" heading' : ''}; bar full at 50`)}`);
}

const LOG_CLS: Record<string, string> = { TEST: 'test', COMMIT: 'commit', GIT_CHANGE: 'commit', FILE_CHANGE: 'edit', WORKER_STARTED: 'worker', WORKER_ENDED: 'worker', SESSION_ENDED: 'end', SESSION_STARTED: 'start' };

function logBlock(s: AgentSessionSnapshot, d: WsData): string {
  const lines: LogLine[] = d.timeline ? d.timeline(s.key, LOG_LINES).map(e => ({ at: e.at, type: e.type, label: e.label, kind: e.kind, child: e.sessionKey !== s.key })) : logTail(s.key, d.events, LOG_LINES);
  const body = lines.length
    ? lines
        .map(l => {
          const fail = l.type === 'TEST' && /^FAIL\b/.test(l.label);
          return `<div class="hud-l hud-l-${LOG_CLS[l.type] ?? 'tool'}${fail ? ' fail' : ''}" title="${esc(`${l.type} · ${l.kind}`)}"><span class="hud-lt">${esc(hms(l.at))}</span> ${l.child ? '<span class="muted">↳</span> ' : ''}${esc(l.label)}</div>`;
        })
        .join('')
    : '<div class="muted">no events loaded</div>';
  return `<div class="hud-log"><div class="hud-lh">$ tail -f session.log <span class="muted">· last ${LOG_LINES} events (lead + workers), OBSERVED / DERIVED per line</span></div>${body}</div>`;
}

function hudCard(s: AgentSessionSnapshot, d: WsData, st: WsState, pinned: boolean, lessons: Record<string, LessonsInfo> | undefined, ci: CiReport | undefined, ciOn: boolean, marker: number, full: boolean): string {
  const ws = workersOf(s, d.sessions);
  const who = [s.provider, prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
  const where = [repoOf(s), s.branch ?? s.facts?.recordedBranch].filter(Boolean).join(' · ');
  const stE = statusEvidenceOf(s);
  const cur = s.facts?.currentTool;
  const now = isLive(s) && cur ? `<div class="hud-now">▸ ${esc(cur.name)} ${esc(cur.detail)} <span class="muted">${esc(ago(d.now, cur.startedAt))}</span>${ev('OBSERVED', 'tool call with no recorded result yet')}</div>` : '';
  return `<section class="hud-c${st.selected === s.key ? ' sel' : ''}" style="--id:${identityColor(repoOf(s))};--pv:var(--${esc(s.provider)})">
<div class="hud-h" data-select="${esc(s.key)}" tabindex="0" title="${esc(`${s.key} · ${s.statusReason}`)}"><span class="dot ${esc(s.status)}"></span><b class="hud-t">${esc(titleOf(s))}</b>${pinned ? '<span class="hud-pin" title="Pinned">📌</span>' : ''}<span class="hud-st hud-st-${esc(stE.kind)}" title="${esc(`${stE.kind}: ${stE.basis}`)}">${esc(stE.text)}${stE.kind === 'OBSERVED' ? '' : ` <span class="hud-ev">${EV_SHORT[stE.kind]}</span>`}</span></div>
<div class="hud-meta muted">${esc(who)} · ${esc(where)} · ${esc(ago(d.now, s.lastActivityAt))}</div>${now}
<div class="hud-body">${modeRow(s)}${workersRow(s, ws, d)}${todoRow(s, d, full)}${testsRow(s, d)}${ciRow(s, ci, ciOn)}${ctxRow(s, marker)}${lessonsRow(s, lessons)}</div>
${logBlock(s, d)}</section>`;
}

// ---- screen --------------------------------------------------------------------------------------------------

export function renderHud(d: WsData, st: WsState): string {
  const pinTok = opt(st, 'hud.pin', '');
  const cols = opt(st, 'hud.cols', 'auto');
  const full = opt(st, 'hud.todo', 'open') === 'all';
  const recent = [...d.sessions].filter(s => !s.isWorker).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const pinned = pinTok ? d.sessions.find(s => sessTok(s) === pinTok) : undefined;
  const cards = hudSessions(d.sessions, pinned, MAX_CARDS);
  const cands = recent.slice(0, MAX_PICK);
  if (pinned && !cands.includes(pinned)) cands.unshift(pinned);
  const picker = cands.length
    ? `<div class="hud-pick"><span class="muted">Pin:</span>${cands
        .map(s => {
          const on = s === pinned;
          return `<button class="hud-pb${on ? ' on' : ''}" data-opt="hud.pin" data-val="${esc(on ? '' : sessTok(s))}" title="${esc(`${on ? 'Unpin' : 'Pin'} ${titleOf(s)} · ${repoOf(s)} · ${s.status}`)}"><span class="hud-pv" style="--pv:var(--${esc(s.provider)})"></span>${esc(titleOf(s).slice(0, 26))}</button>`;
        })
        .join('')}</div>`
    : '';
  const bar0 = toolbar(
    seg(st, 'hud.cols', [['auto', 'Auto'], ['1', '1 column'], ['2', '2 columns']], 'auto', 'Card layout'),
    seg(st, 'hud.todo', [['open', 'Open items'], ['all', 'All items']], 'open', 'Checklist: open items only, or every item'),
  );
  const ciOn = d.config?.<boolean>('agent.pipelines.enabled', false) === true;
  const ci = ciOn ? feedValue<CiReport>(pipelinesFeed.id).value : undefined;
  const lessons = feedValue<Record<string, LessonsInfo>>(LESSONS_FEED).value;
  const mk = Number(d.config?.<number>('agent.health.contextWindow', DEFAULT_WINDOW));
  const marker = Number.isFinite(mk) && mk >= 1000 ? mk : DEFAULT_WINDOW;
  const body = cards.length
    ? `<div class="hud-grid hud-cols-${esc(cols)}">${cards.map(s => hudCard(s, d, st, s === pinned, lessons, ci, ciOn, marker, full)).join('')}</div>`
    : '<div class="muted hud-empty">No live session. Pin a session above to watch it here.</div>';
  const foot = `<div class="legend hud-foot">One card per live lead session (workers fold into their lead) plus the pinned one. Evidence per value: <b>obs</b> read from the provider record · <b>der</b> computed (child sessions, counts, percentages) · <b>inf</b> heuristic · <b>unk</b> not exposed. Todo = the latest TodoWrite / TaskCreate list (Claude) or update_plan (Codex), ≤ 30 items × 120 chars, redacted. Lessons = bullet lines of handoff/MEMORY.md, tasks/lessons.md or the CLAUDE.md "Lessons" section. CI needs <code>agent.pipelines.enabled</code>.</div>`;
  return `${bar0}${picker}${body}${foot}`;
}

export const hudView: ExtraView = {
  id: 'hud',
  label: 'Session HUD',
  group: 'Now',
  hint: 'Terminal-style panel per live session: plan mode, subagents, todo checklist, tests, CI, context, lessons and a log tail.',
  ready: true,
  feeds: [lessonsFeed as Feed, pipelinesFeed as Feed],
  render: (d, st) => `<div class="hud">${renderHud(d, st)}</div>`,
  badge: d => {
    const n = d.sessions.filter(s => isLive(s) && !s.isWorker).length;
    return n ? String(n) : '';
  },
  css: `
.hud { font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace); font-size: 12px; }
.hud .hud-pick { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 11px; margin: 0 0 8px; }
.hud .hud-pb { background: none; border: 1px solid var(--line); border-radius: 3px; color: var(--vscode-foreground); padding: 1px 6px; cursor: pointer; font: inherit; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud .hud-pb.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.hud .hud-pv { display: inline-block; width: 3px; height: 10px; margin-right: 4px; background: var(--pv); vertical-align: middle; }
.hud .hud-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
.hud .hud-grid.hud-cols-1 { grid-template-columns: 1fr; }
.hud .hud-grid.hud-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.hud .hud-c { border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 4px; background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); padding: 6px 8px; min-width: 0; }
.hud .hud-c.sel { outline: 1px solid var(--accent); }
.hud .hud-h { display: flex; gap: 6px; align-items: center; cursor: pointer; }
.hud .hud-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.hud .hud-st { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.hud .hud-pin { font-size: 10px; }
.hud .hud-meta { font-size: 10px; margin: 1px 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 2px solid var(--pv); padding-left: 4px; }
.hud .hud-now { font-size: 11px; color: var(--vscode-terminal-ansiCyan, var(--accent)); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud .hud-body { border-top: 1px dashed var(--line); padding-top: 4px; }
.hud .hud-r { display: flex; gap: 8px; align-items: baseline; line-height: 1.6; }
.hud .hud-k { flex: 0 0 82px; color: var(--vscode-terminal-ansiBlue, var(--vscode-descriptionForeground)); }
.hud .hud-v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.hud .hud-sub { margin: 0 0 4px 90px; font-size: 11px; }
.hud .hud-tag { border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.hud .hud-tag.on { color: var(--vscode-terminal-ansiGreen, var(--ok)); border-color: var(--ok); font-weight: 600; }
.hud .hud-bar { display: inline-block; width: 90px; height: 7px; border: 1px solid var(--line); border-radius: 2px; overflow: hidden; vertical-align: middle; background: color-mix(in srgb, var(--line) 35%, transparent); }
.hud .hud-bar i { display: block; height: 100%; background: var(--ok); }
.hud .hud-bar.warn i { background: var(--warn); }
.hud .hud-bar.bad i { background: var(--bad); }
.hud .hud-bar.acc i { background: var(--accent); }
.hud .hud-cb { display: inline-block; width: 90px; vertical-align: middle; }
.hud .hud-bad { color: var(--bad); }
.hud .hud-ci { font-weight: 600; }
.hud .hud-ci.ok { color: var(--ok); } .hud .hud-ci.bad { color: var(--bad); } .hud .hud-ci.warn { color: var(--warn); } .hud .hud-ci.quiet { color: var(--quiet); }
.hud .hud-w { display: flex; gap: 6px; cursor: pointer; white-space: nowrap; }
.hud .hud-w:hover, .hud .hud-h:hover { background: var(--vscode-list-hoverBackground); }
.hud .hud-wi { width: 12px; text-align: center; }
.hud .hud-w-needs .hud-wi, .hud .hud-need { color: var(--warn); font-weight: 600; }
.hud .hud-st-INFERRED, .hud .hud-st-UNKNOWN { border-style: dashed; }
.hud .hud-w-run .hud-wi { color: var(--ok); } .hud .hud-w-idle .hud-wi { color: var(--warn); } .hud .hud-w-ended .hud-wi { color: var(--quiet); }
.hud .hud-wn { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.hud .hud-ws { color: var(--vscode-descriptionForeground); }
.hud .hud-td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud .hud-td-completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.hud .hud-td-in_progress { color: var(--vscode-terminal-ansiYellow, var(--warn)); }
.hud .hud-tm { color: var(--vscode-descriptionForeground); }
.hud .hud-ev { font-size: 8px; margin-left: 3px; color: var(--vscode-descriptionForeground); cursor: help; }
.hud .hud-ev-observed { color: var(--ok); } .hud .hud-ev-inferred { color: var(--warn); } .hud .hud-ev-unknown { color: var(--quiet); }
.hud .hud-log { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 3px; font-size: 11px; }
.hud .hud-lh { color: var(--vscode-terminal-ansiGreen, var(--ok)); margin-bottom: 2px; }
.hud .hud-l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud .hud-lt { color: var(--vscode-descriptionForeground); }
.hud .hud-l-test { color: var(--vscode-terminal-ansiGreen, var(--ok)); } .hud .hud-l.fail { color: var(--bad); }
.hud .hud-l-commit { color: var(--vscode-terminal-ansiMagenta, var(--accent)); }
.hud .hud-l-edit { color: var(--vscode-terminal-ansiYellow, var(--warn)); }
.hud .hud-l-worker { color: var(--vscode-terminal-ansiCyan, var(--accent)); }
.hud .hud-l-end { color: var(--quiet); }
.hud .hud-empty { margin: 8px 0; }
.hud .hud-foot { margin-top: 10px; line-height: 1.5; font-family: var(--vscode-font-family); }
`,
};
