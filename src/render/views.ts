import { AgentSessionSnapshot, EvidenceKind, ProviderState, TimelineEvent } from '../model';
import { DayActivity, duration, summarize } from '../activity/activity';
import { esc } from './html';
import { resultCard } from './workspace';
import { attention, isLive } from '../activity/insights';
import { endInferred, statusEvidenceOf, testVerdict } from '../sessions/classify';
import { buildDispatches } from '../activity/dispatch';
import { commandMarks, matchPrs, prLinkOf } from '../activity/review';
import { ciFor } from '../activity/hud';
import { feedValue } from './extra/feeds';
import type { WorkflowsSnapshot } from '../providers/claude/workflows';
import type { PrReport } from '../feeds/review';
import type { CiReport } from '../feeds/pipelines';

/** Feed ids of the add-on screens whose cached values the Inspector reuses (no loading from here). */
const WORKFLOWS_FEED = 'workflows.scan';
const PRS_FEED = 'review.prs';
const CI_FEED = 'pipelines.ci';

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

export function base(p: string | undefined): string {
  return p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '';
}

export function hhmm(t: number | undefined): string {
  if (!t) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function statusText(s: AgentSessionSnapshot): string {
  // An end inferred from the live registry entry being gone is not a recorded end.
  if (endInferred(s)) return `No longer active (inferred)${s.commits.length === 0 ? ' — no commit observed' : ''}`;
  if (s.status === 'ENDED' && s.commits.length === 0) return 'Ended — no commit observed';
  return { RUNNING: 'Running', IDLE: 'Idle', NEEDS_INPUT: 'Needs input', ENDED: 'Ended', UNKNOWN: 'Unknown' }[s.status];
}

function where(s: AgentSessionSnapshot): string {
  const repo = base(s.repository) || base(s.cwd) || 'no repo';
  const br = s.branch ?? (s.detachedHead ? 'detached HEAD' : '');
  const wt = s.isLinkedWorktree ? ` · wt ${base(s.worktree)}` : '';
  return `${repo}${br ? ' · ' + br : ''}${wt}`;
}

function testsBadge(s: AgentSessionSnapshot): string {
  if (!s.tests.length) return '';
  const last = s.tests[s.tests.length - 1];
  const cls = last.outcome === 'PASS' ? 'pass' : last.outcome === 'FAIL' ? 'fail' : 'muted';
  return ` · tests <span class="${cls}">${last.outcome}</span>`;
}

function row(s: AgentSessionSnapshot, now: number, workers: number): string {
  const live = s.status === 'RUNNING' || s.status === 'IDLE' || s.status === 'NEEDS_INPUT';
  const dur = live ? duration(now - (s.startedAt ?? now)) : endInferred(s) ? `inactive since ${hhmm(s.lastActivityAt)}` : `ended ${hhmm(s.endedAt ?? s.lastActivityAt)}`;
  const title = s.title ? esc(s.title) : `<span class="muted">${esc(s.sessionId.slice(0, 8))}</span>`;
  const sub = `${esc(where(s))}${s.commits.length ? ` · ${s.commits.length} commit${s.commits.length > 1 ? 's' : ''}` : ''}${s.changedFiles.length ? ` · ${s.changedFiles.length} files` : ''}${testsBadge(s)}${workers ? ` · ${workers} worker${workers > 1 ? 's' : ''}` : ''}`;
  return `<div class="row" tabindex="0" role="button" data-open="${esc(s.key)}" title="${esc(statusText(s) + ' — ' + s.statusReason)}"><span class="dot ${s.status}"></span><span class="main">${title}</span><span class="right">${esc(dur)}</span><span class="sub">${sub}</span></div>`;
}

export function renderCockpit(sessions: AgentSessionSnapshot[], providers: ProviderState[], now: number): string {
  const sum = summarize(sessions, now);
  const top = sessions.filter(s => !s.isWorker);
  const workersOf = (k: string) => sessions.filter(s => s.parentSessionId === k).length;
  const att = attention(sessions, now).filter(a => a.severity !== 'low');
  const byKey = new Map(sessions.map(s => [s.key, s]));
  let h = `<div style="display:flex;gap:8px;align-items:center;margin:2px 0 4px"><button class="btn" data-cmd="openWorkspace">Open Agent workspace</button><button class="btn" data-cmd="knowledge">DataPass: Start here</button><button class="btn" data-cmd="exportConversations">Export conversations</button></div><div class="kpis"><div class="kpi"><b>${sum.active}</b><span>Active</span></div><div class="kpi"><b>${sum.idle}</b><span>Idle</span></div>${sum.needsInput ? `<div class="kpi"><b>${sum.needsInput}</b><span>Needs input</span></div>` : ''}<div class="kpi"><b>${sum.endedToday}</b><span>Ended today</span></div></div>`;
  if (att.length) h += `<h2>Needs attention · ${att.length}</h2>${att.slice(0, 4).map(a => { const s = byKey.get(a.key)!; return `<div class="row" tabindex="0" role="button" data-open="${esc(s.key)}" title="${esc(a.basis)}"><span class="dot ${a.severity === 'high' ? 'NEEDS_INPUT' : 'IDLE'}"></span><span class="main">${esc(a.reason)}</span><span class="right">${esc(s.provider)}</span><span class="sub">${esc((s.title ?? s.sessionId).slice(0, 60))}</span></div>`; }).join('')}${att.length > 4 ? `<button class="link" data-nav="attention">all ${att.length} →</button>` : ''}`;
  for (const p of ['claude', 'codex'] as const) {
    const st = providers.find(x => x.provider === p);
    const live = top.filter(s => s.provider === p && (s.status === 'RUNNING' || s.status === 'NEEDS_INPUT' || s.status === 'IDLE'));
    h += `<div class="prov">${PROV[p]}${st?.version ? ` <span class="chip">${esc(st.version)}</span>` : ''}</div>`;
    if (!st?.detected) h += `<div class="empty">not detected</div>`;
    else if (!live.length) h += `<div class="empty">no live session</div>`;
    else h += live.sort((a, b) => order(a) - order(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map(s => row(s, now, workersOf(s.key))).join('');
  }
  const recent = top.filter(s => s.status === 'ENDED' || s.status === 'UNKNOWN').slice(0, 6);
  if (recent.length) h += `<h2>Recent</h2>${recent.map(s => row(s, now, workersOf(s.key))).join('')}`;
  return h;
}

function order(s: AgentSessionSnapshot): number {
  return s.status === 'NEEDS_INPUT' ? 0 : s.status === 'RUNNING' ? 1 : 2;
}

const TYPE_LABEL: Record<string, string> = {
  SESSION_STARTED: 'started', SESSION_ACTIVITY: 'activity', TOOL_ACTIVITY: 'tool', PROCESS_ACTIVITY: 'command', FILE_CHANGE: 'file',
  GIT_CHANGE: 'git', COMMIT: 'commit', TEST: 'test', WORKER_STARTED: 'worker ▸', WORKER_ENDED: 'worker ◂', SESSION_ENDED: 'ended',
};

export interface TimelineOptions {
  focus?: AgentSessionSnapshot;
  hideNoise?: boolean;
}

export function renderTimeline(events: TimelineEvent[], sessions: Map<string, AgentSessionSnapshot>, opts: TimelineOptions): string {
  const noisy = new Set(['TOOL_ACTIVITY', 'SESSION_ACTIVITY']);
  const shown = opts.hideNoise !== false ? events.filter(e => !noisy.has(e.type) || e.label.startsWith('turn aborted')) : events;
  let h = `<div class="filter">${opts.focus ? `<span>Session <b>${esc(opts.focus.title ?? opts.focus.sessionId.slice(0, 8))}</b></span><button class="link" data-cmd="timelineAll">all sessions</button>` : '<span>All sessions</span>'}<span class="muted">· ${shown.length} events</span></div>`;
  if (!shown.length) return h + `<div class="empty">No observed activity in the loaded history.</div>`;
  let lastDay = '';
  for (const e of shown.slice(-250)) {
    const d = new Date(e.at).toDateString();
    if (d !== lastDay) {
      h += `<h2>${esc(d)}</h2>`;
      lastDay = d;
    }
    const s = sessions.get(e.sessionKey);
    const who = !opts.focus && s ? `<span class="muted">${esc((s.title ?? s.sessionId).slice(0, 24))} · </span>` : '';
    h += `<div class="tl ${e.type}" data-open="${esc(e.sessionKey)}" title="${esc(e.kind)}"><span class="t">${hhmm(e.at)}</span><span class="k">${esc(e.provider)} ${esc(TYPE_LABEL[e.type] ?? e.type)}</span><span class="l">${who}${esc(e.label)}</span></div>`;
  }
  return h;
}

export function renderActivity(days: DayActivity[], sessions: AgentSessionSnapshot[]): string {
  const max = Math.max(1, ...days.map(d => d.sessions));
  let h = `<h2>Last 7 days</h2><table><tr><th>Day</th><th>Sessions</th><th>Workers</th><th>Observed</th><th>Commits</th><th>Files</th><th>Tests</th><th>Repos</th></tr>`;
  for (const d of days) {
    const wc = Math.round((d.byProvider.claude / max) * 60), wx = Math.round((d.byProvider.codex / max) * 60);
    h += `<tr><td>${esc(d.label)} <span class="muted">${esc(d.day.slice(5))}</span></td><td><span class="bar" style="width:${wc}px" title="Claude ${d.byProvider.claude}"></span><span class="bar codex" style="width:${wx}px" title="Codex ${d.byProvider.codex}"></span> ${d.sessions}</td><td>${d.workers}</td><td>${duration(d.durationMin * 60_000)}</td><td>${d.commits}</td><td>${d.filesChanged}</td><td>${d.tests}</td><td title="${esc(d.repos.join(', '))}">${d.repos.length}</td></tr>`;
  }
  h += `</table><div class="muted" style="font-size:11px;margin-top:4px"><span class="bar" style="width:10px"></span> Claude <span class="bar codex" style="width:10px"></span> Codex · "Observed" sums first→last recorded activity per session; it is not a productivity measure. History beyond the loaded window shows as 0.</div>`;
  h += `<h2>Session graph</h2>` + renderGraph(sessions);
  return h;
}

/** Provider → repo → session → workers. Parent/child edges only where the provider exposed them. */
export function renderGraph(sessions: AgentSessionSnapshot[]): string {
  const live = sessions.filter(s => s.status !== 'ENDED' || sessions.some(c => c.parentSessionId === s.key && c.status !== 'ENDED'));
  const scope = live.length ? live : sessions.slice(0, 10);
  const keys = new Set(sessions.map(s => s.key));
  let out = '';
  for (const p of ['claude', 'codex'] as const) {
    const roots = scope.filter(s => s.provider === p && (!s.parentSessionId || !keys.has(s.parentSessionId)));
    if (!roots.length) continue;
    out += `${esc(PROV[p])}\n`;
    const byRepo = new Map<string, AgentSessionSnapshot[]>();
    for (const s of roots) {
      const r = base(s.repository) || base(s.cwd) || '(no repo)';
      byRepo.set(r, [...(byRepo.get(r) ?? []), s]);
    }
    const repos = [...byRepo];
    repos.forEach(([repo, list], ri) => {
      const lastR = ri === repos.length - 1;
      out += `${lastR ? '└─' : '├─'} ${esc(repo)}\n`;
      list.forEach((s, si) => {
        const lastS = si === list.length - 1;
        const pre = `${lastR ? '   ' : '│  '}${lastS ? '└─' : '├─'}`;
        out += `${pre} <a data-open="${esc(s.key)}">${esc(s.status === 'RUNNING' ? '●' : s.status === 'IDLE' ? '◐' : '○')} ${esc((s.title ?? s.sessionId).slice(0, 40))}</a> <span class="muted">${esc(s.branch ?? '')}</span>\n`;
        const kids = sessions.filter(c => c.parentSessionId === s.key);
        kids.slice(0, 12).forEach((c, ci) => {
          out += `${lastR ? '   ' : '│  '}${lastS ? '   ' : '│  '}${ci === Math.min(kids.length, 12) - 1 ? '└─' : '├─'} <a data-open="${esc(c.key)}" title="${esc(statusText(c))}">${esc(c.status === 'RUNNING' ? '●' : c.status === 'IDLE' ? '◐' : '○')} ${esc((c.workerLabel ?? c.title ?? c.sessionId).slice(0, 40))}</a>\n`;
        });
        if (kids.length > 12) out += `${lastR ? '   ' : '│  '}${lastS ? '   ' : '│  '}   … ${kids.length - 12} more workers\n`;
      });
    });
  }
  return out ? `<div class="tree">${out}</div>` : `<div class="empty">No sessions in the loaded history.</div>`;
}

const kindChip = (kind: EvidenceKind, basis: string) => ` <span class="chip" title="${esc(basis)}">${esc(kind)}</span>`;

function usageBlock(s: AgentSessionSnapshot, now: number, dd: (label: string, value: unknown, field?: string) => string, locale?: string): string {
  const u = s.usage;
  const f = s.facts;
  const per = f?.modelTokens ? Object.entries(f.modelTokens).sort((a, b) => b[1] - a[1]) : [];
  const ctxPct = u?.contextTokens && u.contextWindow ? Math.round((100 * u.contextTokens) / u.contextWindow) : undefined;
  const wall = s.startedAt !== undefined ? (isLive(s) ? now : (s.lastActivityAt ?? now)) - s.startedAt : undefined;
  let h = '<dl>';
  h += u
    ? dd('Tokens (provider-recorded)', `${u.totalTokens.toLocaleString(locale)} total · ${u.outputTokens.toLocaleString(locale)} output · ${u.cachedInputTokens.toLocaleString(locale)} cached input`, 'usage')
    : `<dt>Tokens</dt><dd><span class="muted">not recorded</span>${kindChip('UNKNOWN', 'the provider recorded no token usage for this session')}</dd>`;
  if (per.length > 1) h += `<dt>Tokens per model</dt><dd>${per.map(([m, n]) => `${esc(m)} ${n.toLocaleString(locale)}`).join(' · ')}${kindChip('OBSERVED', 'tokens per model as the provider recorded them')}</dd>`;
  if (u?.contextTokens) h += `<dt>Context (latest call)</dt><dd>${esc(`${u.contextTokens.toLocaleString(locale)} tokens${u.contextWindow ? ` of ${u.contextWindow.toLocaleString(locale)} (${ctxPct} %)` : ''}`)}${u.contextWindow ? kindChip('OBSERVED', 'prompt size of the latest call / window recorded by the provider') : kindChip('OBSERVED', 'prompt size of the latest call; the provider records no window size, so no % here (Health uses a reference window)')}</dd>`;
  else h += `<dt>Context (latest call)</dt><dd><span class="muted">not recorded</span>${kindChip('UNKNOWN', 'no prompt size recorded')}</dd>`;
  if (u?.costUSD !== undefined) h += dd('Cost (recorded by provider)', `$${u.costUSD.toFixed(4)}`, 'costUSD');
  h += `<dt>Wall time</dt><dd>${wall === undefined ? '<span class="muted">not exposed</span>' : `${esc(duration(wall))}${isLive(s) ? ' so far' : ''}`}${kindChip('DERIVED', 'first record → last activity (live: → now)')}</dd>`;
  if (f?.activeMs !== undefined) h += `<dt>Active time</dt><dd>${esc(duration(f.activeMs))}${kindChip('DERIVED', 'sum of gaps < 5 min between recorded events')}</dd>`;
  if (f?.waitTotalMs !== undefined) h += `<dt>Waiting on you</dt><dd>${esc(duration(f.waitTotalMs))}${f.waitMaxMs !== undefined ? ` · longest ${esc(duration(f.waitMaxMs))}` : ''}${kindChip('DERIVED', 'time between a reply and the next user prompt')}</dd>`;
  return `${h}</dl>`;
}

const DISPATCH_TEXT: Record<string, string> = { live: 'running', verified: 'verified', unverified: 'finished, unverified', failed: 'failed', unknown: 'end not observed' };

function relatedBlock(s: AgentSessionSnapshot, children: AgentSessionSnapshot[], parent: AgentSessionSnapshot | undefined, events: TimelineEvent[], now: number): string {
  const rows: string[] = [];
  const item = (label: string, value: string, kind: EvidenceKind, basis: string) => rows.push(`<dt>${esc(label)}</dt><dd>${value}${kindChip(kind, basis)}</dd>`);
  const link = (x: AgentSessionSnapshot) => `<a class="link" data-open="${esc(x.key)}">${esc(x.title ?? x.workerLabel ?? x.sessionId.slice(0, 8))}</a>`;
  if (parent) item('Parent', link(parent), 'OBSERVED', 'parent recorded by the provider (subagent transcript / parent_thread_id)');
  else if (s.parentSessionId) item('Parent', `<span class="muted">${esc(s.parentSessionId)} (not loaded)</span>`, 'OBSERVED', 'parent id recorded by the provider; its session is outside the loaded history');
  if (children.length) {
    const live = children.filter(c => isLive(c)).length;
    item('Workers', `${children.length}${live ? ` (${live} live)` : ''}: ${children.slice(0, 8).map(link).join(', ')}${children.length > 8 ? ` … ${children.length - 8} more` : ''}`, 'OBSERVED', 'child sessions whose recorded parent is this session');
  }
  const wf = feedValue<WorkflowsSnapshot>(WORKFLOWS_FEED).value;
  const loaded = [s, ...(parent ? [parent] : []), ...children];
  const ds = buildDispatches(loaded, wf, now);
  const mine = ds.find(d => d.key === s.key);
  if (mine) item('Dispatch', `${esc(DISPATCH_TEXT[mine.state] ?? mine.state)} · ${esc(mine.type)}${mine.description ? ` · “${esc(mine.description)}”` : ''}${mine.spawnMatched ? '' : ' <span class="muted">(no spawn call matched)</span>'}${mine.reasons.length ? `<div class="muted">${esc(mine.reasons.join('; '))}</div>` : ''}`, 'DERIVED', 'Dispatches screen row: outcome from this worker\u2019s own test / git commit and its observed end; spawn call matched by time');
  const kids = ds.filter(d => d.parentKey === s.key);
  if (kids.length) {
    const c = (st: string) => kids.filter(d => d.state === st).length;
    item('Dispatches', `${kids.length}: ${c('verified')} verified · ${c('unverified')} finished, unverified · ${c('failed')} failed${c('live') ? ` · ${c('live')} running` : ''}${c('unknown') ? ` · ${c('unknown')} end not observed` : ''}`, 'DERIVED', 'Dispatches screen rows of this session\u2019s workers');
  }
  if (wf) {
    const runs = wf.runs.filter(r => r.parentKey === s.key);
    const asAgent = wf.runs.find(r => r.agents.some(a => a.sessionKey === s.key));
    if (asAgent) item('Workflow', `agent of run “${esc(asAgent.name ?? asAgent.runId)}” (${esc(asAgent.status)})`, 'OBSERVED', 'workflow journal');
    if (runs.length) item('Workflows', runs.slice(0, 5).map(r => `“${esc(r.name ?? r.runId)}” ${esc(r.status)}`).join(' · '), 'OBSERVED', 'workflow runs this session started (journal)');
  }
  const pr = feedValue<PrReport>(PRS_FEED).value;
  if (pr?.state === 'ok') {
    const marks = commandMarks(events).get(s.key) ?? [];
    const prs = pr.repos.flatMap(r => r.prs);
    const m = matchPrs(s, marks, prs);
    const p = m.find(x => x.state === 'open' || x.state === 'draft') ?? m[0];
    if (p) {
      const l = prLinkOf(s, marks, p);
      item('PR', `${p.forge === 'gitlab' ? 'MR !' : 'PR #'}${p.number} ${esc(p.state)} · ${esc(p.head)} → ${esc(p.base)} · CI ${esc(p.ci)}${l.kind === 'INFERRED' ? ' <span class="muted">(linked by branch)</span>' : ''}`, l.kind, `${l.basis}; PR state from the forge (OBSERVED)`);
    } else item('PR', '<span class="muted">none found for this session\u2019s branch</span>', 'DERIVED', 'PR / MR list of the forge, matched by branch');
  } else item('PR', '<span class="muted">not loaded</span>', 'UNKNOWN', 'opt-in setting agent.review.prState (network via gh / glab), or not loaded yet');
  const ci = feedValue<CiReport>(CI_FEED).value;
  const c = ciFor(s, ci);
  if (typeof c === 'object') item('CI', `${esc(c.status)} · ${esc(c.ref)}${c.basis === 'repo' ? ' <span class="muted">(latest of repo, none on this branch)</span>' : ''}`, c.basis === 'repo' ? 'INFERRED' : 'OBSERVED', `CI API via the Pipelines feed: ${c.title}`);
  else item('CI', `<span class="muted">${c === 'none' ? 'no run found for this repository' : 'not loaded'}</span>`, 'UNKNOWN', c === 'none' ? 'Pipelines feed has no run for the session repository' : 'opt-in setting agent.pipelines.enabled, or not loaded yet');
  return `<dl>${rows.join('')}</dl>`;
}

export function renderInspector(s: AgentSessionSnapshot, children: AgentSessionSnapshot[], parent: AgentSessionSnapshot | undefined, events: TimelineEvent[], ternAvailable: boolean, now = Date.now(), locale?: string): string {
  const ev = (field: string) => {
    const e = s.evidence.filter(x => x.field === field).pop();
    return e ? ` <span class="chip" title="${esc(e.source)}">${esc(e.kind)}</span>` : '';
  };
  const dd = (label: string, value: unknown, field?: string) => `<dt>${esc(label)}</dt><dd>${value === undefined || value === '' ? '<span class="muted">not exposed</span>' : esc(value)}${field ? ev(field) : ''}</dd>`;
  const live = s.status !== 'ENDED';
  const stE = statusEvidenceOf(s);
  let h = `<h1 style="font-size:15px;margin:6px 0 2px">${esc(s.title ?? s.sessionId)}</h1><div class="muted">${esc(PROV[s.provider])} · <span class="dot ${s.status}"></span> ${esc(statusText(s))} <span class="chip" title="${esc(`${stE.kind}: ${stE.basis}`)}">${esc(stE.kind)}</span> <span class="chip" title="${esc(s.statusReason)}">${esc(s.statusReason)}</span></div>`;
  h += `<div style="margin:6px 0"><button class="link" data-cmd="copySessionId" data-key="${esc(s.key)}">Copy session id</button> · <button class="link" data-cmd="revealWorktree" data-key="${esc(s.key)}">Reveal worktree</button> · <button class="link" data-cmd="openTimeline" data-key="${esc(s.key)}">Show in Timeline</button> · <button class="link" data-cmd="readTranscript" data-key="${esc(s.key)}">Read transcript</button> · <button class="link" data-cmd="openArtifactFolder" data-key="${esc(s.key)}">Open provider session folder</button>${ternAvailable ? ` · <button class="link" data-cmd="openInTern" data-key="${esc(s.key)}">Open in Tern</button>` : ''}</div>`;
  h += `<h2>Result</h2>${resultCard(s, now)}`;
  const cur = s.facts?.currentTool;
  const pm = s.facts?.permissionMode;
  const endValue = endInferred(s) ? s.lastActivityAt && `${new Date(s.lastActivityAt).toLocaleString()} (last record; no end recorded)` : s.endedAt && new Date(s.endedAt).toLocaleString();
  h += `<h2>State</h2><dl>${dd('Session id', s.sessionId)}${dd('Provider version', s.providerVersion, 'providerVersion')}${dd('Model', s.model, 'model')}${dd('Effort', s.effort, 'effort')}`
    + `<dt>Status</dt><dd>${esc(stE.text)}${kindChip(stE.kind, stE.basis)}</dd>`
    + `<dt>${s.provider === 'codex' ? 'Approval / sandbox' : 'Permission mode'}</dt><dd>${pm || s.facts?.sandbox ? esc([pm, s.facts?.sandbox && `sandbox ${s.facts.sandbox}`].filter(Boolean).join(' · ')) + kindChip('OBSERVED', s.provider === 'codex' ? 'rollout turn_context approval_policy / sandbox_policy' : 'transcript permissionMode (latest)') : `<span class="muted">not recorded</span>${kindChip('UNKNOWN', 'no permission mode recorded')}`}</dd>`
    + `<dt>Current tool</dt><dd>${cur && isLive(s) ? `${esc(cur.name)} ${esc(cur.detail)} <span class="muted">since ${esc(hhmm(cur.startedAt))}</span>${kindChip('OBSERVED', 'tool call with no recorded result yet')}` : `<span class="muted">none</span>${kindChip('DERIVED', isLive(s) ? 'every recorded tool call has a result' : 'session not live')}`}</dd>`
    + `${dd('Started', s.startedAt && new Date(s.startedAt).toLocaleString())}${dd('Last activity', s.lastActivityAt && new Date(s.lastActivityAt).toLocaleString(), 'lastActivityAt')}${live ? dd('Duration', duration(now - (s.startedAt ?? now))) : endInferred(s) ? `<dt>Inactive since</dt><dd>${esc(endValue ?? '—')}${kindChip('INFERRED', s.statusReason)}</dd>` : dd('Ended', endValue, 'endedAt')}${dd('Turns / tools / commands', `${s.counts.turns} / ${s.counts.tools} / ${s.counts.commands}`)}</dl>`;
  h += `<h2>Location</h2><dl>${dd('cwd', s.cwd, 'cwd')}${dd('Repository', s.repository, 'repository')}${dd('Worktree', s.worktree ? `${s.worktree}${s.isLinkedWorktree ? ' (linked worktree)' : ''}` : undefined, 'worktree')}${dd('Branch', s.branch ?? (s.detachedHead ? 'detached HEAD' : undefined), 'branch')}</dl>`;
  const lines = s.linesAdded !== undefined ? `+${s.linesAdded} / -${s.linesRemoved ?? 0}` : undefined;
  h += `<h2>Change</h2><dl>${dd('HEAD before', s.headBefore?.slice(0, 12), 'headBefore')}${dd('HEAD after', s.headAfter?.slice(0, 12), 'headAfter')}${dd('Lines', lines, 'linesAdded')}${dd('Working tree', s.dirty === undefined ? undefined : s.dirty ? 'uncommitted changes' : 'clean')}</dl>`;
  if (s.commits.length) h += `<table>${s.commits.map(c => `<tr><td><code>${esc(c.sha.slice(0, 7))}</code></td><td>${esc(hhmm(c.at))}</td><td>${esc(c.subject)}</td><td class="muted">${c.attribution === 'session-ran-git-commit' ? 'session ran git commit (OBSERVED)' : 'in the session window (DERIVED, not proof the session made it)'}</td></tr>`).join('')}</table>`;
  else h += `<div class="muted">No commit observed during this session${ev('commits')}.</div>`;
  if (s.changedFiles.length) h += `<details><summary>${s.changedFiles.length} files changed during session</summary><div class="tree">${s.changedFiles.slice(0, 200).map(esc).join('\n')}</div></details>`;
  h += `<h2>Verification</h2>`;
  h += s.tests.length
    ? `<table><tr><th>When</th><th>Command</th><th>Result</th><th>Source</th></tr>${s.tests.slice(-30).map(t => {
        const v = testVerdict(t);
        const shown = v.outcome === 'UNKNOWN' && t.outcome !== 'UNKNOWN' ? `UNKNOWN (recorded ${t.outcome})` : t.outcome === 'UNKNOWN' ? 'ran, outcome not recorded' : t.outcome;
        return `<tr><td>${hhmm(t.at)}</td><td><code>${esc(t.command)}</code></td><td class="${v.outcome === 'PASS' ? 'pass' : v.outcome === 'FAIL' ? 'fail' : 'muted'}" title="${esc(`${v.kind}: ${v.basis}`)}">${esc(shown)}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ''}</td><td class="muted">${esc(v.basis)}</td></tr>`;
      }).join('')}</table>`
    : `<div class="muted">No test command observed${kindChip('DERIVED', 'none in the loaded records (transcript may be capped); builds, lints and type checks are not tests')}.</div>`;
  h += `<h2>Usage</h2>${usageBlock(s, now, dd, locale)}`;
  h += `<h2>Workers</h2>`;
  if (parent) h += `<div>Parent: <a class="link" data-open="${esc(parent.key)}">${esc(parent.title ?? parent.sessionId)}</a>${ev('parentSessionId')}</div>`;
  if (children.length) h += children.map(c => `<div class="row" data-open="${esc(c.key)}"><span class="dot ${c.status}"></span><span class="main">${esc(c.workerLabel ?? c.title ?? c.sessionId)}</span><span class="right">${esc(statusText(c))}</span></div>`).join('');
  else if (!parent) h += `<div class="muted">No worker sessions observed for this session.${s.provider === 'claude' ? ' (Claude exposes subagents as subagents/ transcripts.)' : ' (Codex exposes subagents via parent_thread_id.)'}</div>`;
  h += `<h2>Activity</h2>` + renderTimeline(events, new Map([[s.key, s], ...children.map(c => [c.key, c] as [string, AgentSessionSnapshot])]), { focus: s, hideNoise: true }).replace(/<div class="filter">[\s\S]*?<\/div>/, '');
  h += `<h2>Evidence</h2><table><tr><th>Field</th><th>Kind</th><th>Source</th></tr>${dedupeEvidence(s).map(e => `<tr><td>${esc(e.field)}</td><td>${esc(e.kind)}</td><td class="muted">${esc(e.source)}</td></tr>`).join('')}</table>`;
  h += `<h2>Related</h2>${relatedBlock(s, children, parent, events, now)}`;
  if (s.diagnostics.length) h += `<h2>Diagnostics</h2>${s.diagnostics.map(d => `<div class="muted">${esc(d)}</div>`).join('')}`;
  return h;
}

function dedupeEvidence(s: AgentSessionSnapshot) {
  const m = new Map<string, (typeof s.evidence)[number]>();
  for (const e of s.evidence) m.set(e.field, e);
  return [...m.values()];
}
