// Add-on screen "Pipelines": GitHub Actions and GitLab CI runs for the repositories agents touch.
// Data: src/feeds/pipelines.ts (opt-in, trusted only, read-only gh / glab API GETs). Rendering is pure.
import type { ActCtx, ExtraView } from './kit';
import { actBtn, opt, seg, toolbar } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';
import { esc } from '../html';
import { ago, kpi, titleOf, WsData, WsState } from '../workspace';
import { identityColor } from '../../activity/insights';
import { hhmm } from '../views';
import type { AgentSessionSnapshot } from '../../model';
import { ACTIVE, Blocker, blockers, CiJob, CiReport, CiRun, CiStatus, durationOf, linkSessions, loadPipelines, pipelineRoots, runnerUse } from '../../feeds/pipelines';

const FEED_ID = 'pipelines.ci';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Reads `agent.pipelines.<name>`; accepts both full and section-relative keys from the host. */
function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.pipelines.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`pipelines.${name}`, fallback);
}
const clampInt = (v: unknown, lo: number, hi: number, def: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || def));
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

let lastActive = false;
export const pipelinesFeed: Feed<CiReport> = {
  id: FEED_ID,
  /** 30 s while something runs or waits, 60 s otherwise. */
  get intervalMs() {
    return lastActive ? 30_000 : 60_000;
  },
  async load(ctx) {
    if (!cfg<boolean>(ctx, 'enabled', false)) return { state: 'off', at: ctx.now, repos: [], calls: 0, noRemote: 0 };
    if (!ctx.trusted) return { state: 'untrusted', at: ctx.now, repos: [], calls: 0, noRemote: 0 };
    const report = await loadPipelines({
      roots: pipelineRoots(ctx.sessions, strings(cfg<unknown>(ctx, 'extraRepos', [])), clampInt(cfg(ctx, 'maxRepos', 12), 1, 50, 12)),
      runsPerRepo: clampInt(cfg(ctx, 'runsPerRepo', 20), 1, 100, 20),
      jobRuns: clampInt(cfg(ctx, 'jobRuns', 4), 0, 20, 4),
      gitlabHosts: strings(cfg<unknown>(ctx, 'gitlabHosts', [])),
      now: ctx.now,
    });
    lastActive = report.repos.some(r => r.runs.some(x => ACTIVE.has(x.status)));
    return report;
  },
};

// ---------------------------------------------------------------- helpers

const ST_LABEL: Record<CiStatus, string> = { success: 'passed', failed: 'failed', running: 'running', pending: 'queued', blocked: 'waiting for a person', canceled: 'canceled', skipped: 'skipped', unknown: 'unknown' };
const ST_ICON: Record<CiStatus, string> = { success: '✓', failed: '✕', running: '●', pending: '◷', blocked: '⏸', canceled: '⊘', skipped: '»', unknown: '?' };

function dur(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const runOpt = (r: CiRun) => `${r.provider === 'github' ? 'gh' : 'gl'}-${r.id}`.slice(0, 40);
const when = (now: number, t?: number) => (t ? `<span class="muted" title="${esc(new Date(t).toLocaleString())}">${esc(ago(now, t))}</span>` : '');
const st = (s: CiStatus, extra = '') => `<span class="pl-st pl-${s}" title="${esc(`OBSERVED: ${ST_LABEL[s]}${extra ? ' · ' + extra : ''}`)}">${ST_ICON[s]}</span>`;
const provTag = (r: CiRun) => `<span class="pl-pv pl-${r.provider}" title="${esc(`${r.provider === 'github' ? 'GitHub Actions' : 'GitLab CI'} · ${r.host}/${r.slug}`)}">${r.provider === 'github' ? 'GH' : 'GL'}</span>`;
const repoSw = (r: CiRun) => `<span class="pl-sw" style="background:${identityColor(r.repo)}"></span>`;
const link = (url: string | undefined, label = '↗') => (url ? actBtn('open', url, label, 'Open in the browser') : '');

function runnerTag(j: CiJob): string {
  if (!j.runner && j.runnerKind === 'unknown') return '<span class="muted">—</span>';
  const k = j.runnerKind;
  return `<span class="pl-rn pl-rk-${k}" title="${esc(`${j.runner ?? '(unnamed)'} · ${k} runner (INFERRED: ${j.runnerBasis ?? 'unknown basis'})${j.labels?.length ? ' · labels ' + j.labels.join(', ') : ''}`)}">${k === 'local' ? '⌂' : k === 'cloud' ? '☁' : '?'} ${esc((j.runner ?? k).slice(0, 34))}</span>`;
}

function sessionChips(keys: [string, 'commit' | 'branch'][] | undefined, by: Map<string, AgentSessionSnapshot>, sel?: string): string {
  if (!keys?.length) return '';
  return keys
    .map(([k, basis]) => {
      const s = by.get(k);
      if (!s) return '';
      return `<span class="pl-ses${sel === k ? ' sel' : ''}" data-select="${esc(k)}" tabindex="0" title="${esc(`${basis === 'commit' ? 'OBSERVED: session saw this commit' : 'INFERRED: same repo and branch'} · ${titleOf(s)}`)}"><span class="dot ${esc(s.status)}"></span>${esc(titleOf(s).slice(0, 28))}</span>`;
    })
    .join('');
}

function jobDots(r: CiRun): string {
  if (!r.jobs) return r.jobsError ? `<span class="muted" title="${esc(r.jobsError)}">jobs n/a</span>` : '<span class="muted" title="Jobs are loaded for the newest and active runs only (agent.pipelines.jobRuns)">·</span>';
  return `<span class="pl-jd">${r.jobs
    .slice(0, 40)
    .map(j => `<i class="pl-bg-${j.status}" title="${esc(`${j.stage ? j.stage + ' · ' : ''}${j.name}: ${ST_LABEL[j.status]}${j.allowFailure ? ' (allowed to fail)' : ''}`)}"></i>`)
    .join('')}</span>`;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function groupKey(r: CiRun, by: string): string {
  if (by === 'branch') return `${r.repo} · ${r.ref || '(no ref)'}`;
  if (by === 'workflow') return `${r.repo} · ${r.workflow ?? (r.provider === 'gitlab' ? 'pipeline' : '(workflow)')}`;
  return `${r.repo} · ${r.provider === 'github' ? 'GitHub' : 'GitLab'}`;
}

function groups(runs: CiRun[], by: string): [string, CiRun[]][] {
  const m = new Map<string, CiRun[]>();
  for (const r of runs) {
    const k = groupKey(r, by);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].sort((a, b) => b[1][0].createdAt - a[1][0].createdAt);
}

function ticks(from: number, to: number, x: (t: number) => number): string {
  const span = to - from;
  const step = span <= 20 * 60_000 ? 2 * 60_000 : span <= 2 * HOUR ? 15 * 60_000 : span <= 8 * HOUR ? HOUR : span <= 2 * DAY ? 3 * HOUR : DAY;
  let h = '';
  const off = new Date(from).getTimezoneOffset() * 60_000;
  for (let t = Math.ceil((from - off) / step) * step + off; t < to; t += step) {
    const d = new Date(t);
    const lab = step >= DAY ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : hhmm(t);
    h += `<span class="pl-tk" style="left:${x(t).toFixed(2)}%">${esc(lab)}</span>`;
  }
  return h;
}

// ---------------------------------------------------------------- tabs

const AGE: Record<string, number> = { '24h': DAY, '3d': 3 * DAY, all: Infinity };
const KIND_LABEL: Record<Blocker['kind'], string> = { failed: 'Failing', blocked: 'Needs a person', pending: 'Queued', running: 'Running' };

function blocksTab(all: CiRun[], d: WsData, stt: WsState, links: Map<string, [string, 'commit' | 'branch'][]>, by: Map<string, AgentSessionSnapshot>): string {
  const show = opt(stt, 'pipelines.show', 'stuck');
  const age = AGE[opt(stt, 'pipelines.age', '3d')] ?? 3 * DAY;
  const fresh = blockers(all, d.now).filter(b => d.now - b.run.createdAt <= age);
  const bl = show === 'stuck' ? fresh.filter(b => b.kind !== 'running') : fresh;
  const counts = (['failed', 'blocked', 'pending', 'running'] as const).map(k => [k, fresh.filter(b => b.kind === k).length] as const);
  const tb = toolbar(
    seg(stt, 'pipelines.show', [['stuck', 'Stuck only'], ['all', 'With running']], 'stuck', 'Show running jobs too'),
    seg(stt, 'pipelines.age', [['24h', '24 h'], ['3d', '3 d'], ['all', 'Any age']], '3d', 'Only runs created in this window (older failing branches are often abandoned)'),
    `<span class="pl-cnt">${counts.map(([k, n]) => `<span class="pl-c pl-ck-${k}" title="${esc(`${KIND_LABEL[k]} in the latest run of each repo · ref · workflow`)}">${esc(KIND_LABEL[k])} <b>${n}</b></span>`).join('')}</span>`,
  );
  if (!bl.length) return tb + `<div class="empty pl-green">${st('success')} Nothing blocks: the latest run of every repo · branch · workflow is green, canceled or skipped${show === 'stuck' ? ' (running ones hidden)' : ''}.</div>`;
  const rows = bl
    .slice(0, 120)
    .map(b => {
      const r = b.run;
      const what = b.job ? `<b>${esc(b.job.name)}</b>${b.job.stage ? ` <span class="muted">${esc(b.job.stage)}</span>` : ''}` : `<span class="muted">(whole run)</span>`;
      const waited = d.now - b.since;
      const hot = (b.kind === 'pending' && waited > 15 * 60_000) || (b.kind === 'blocked' && waited > HOUR);
      return `<tr class="pl-k-${b.kind}"><td><span class="pl-kd pl-kd-${b.kind}">${esc(KIND_LABEL[b.kind])}</span></td><td class="pl-nw">${repoSw(r)}${esc(r.repo)} ${provTag(r)}</td><td class="pl-ref" title="${esc(r.ref)}">${esc(r.ref)}</td><td class="pl-tt">${what}</td><td class="pl-det" title="${esc(`${b.detail} · ${b.evidence}${b.evidence === 'INFERRED' ? ': runner busy elsewhere and the job asks for a local runner' : ''}`)}">${esc(b.detail)}${b.evidence === 'INFERRED' ? ' <sup class="muted">inf.</sup>' : ''}</td><td class="r ${hot ? 'pl-hot' : ''}" title="${esc(`since ${new Date(b.since).toLocaleString()} (DERIVED)`)}">${esc(dur(waited))}</td><td>${b.job ? runnerTag(b.job) : ''}</td><td>${sessionChips(links.get(r.key), by, stt.selected)}</td><td>${link(b.job?.url ?? r.url)}</td></tr>`;
    })
    .join('');
  return tb + `<table class="pl-t"><thead><tr><th>State</th><th>Repo</th><th>Ref</th><th>Job</th><th>Detail</th><th class="r" title="How long it has been in this state">For</th><th>Runner</th><th>Sessions</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function runsTab(runs: CiRun[], d: WsData, stt: WsState, links: Map<string, [string, 'commit' | 'branch'][]>, by: Map<string, AgentSessionSnapshot>): string {
  const view = opt(stt, 'pipelines.runs', 'table');
  const groupBy = opt(stt, 'pipelines.group', 'repo');
  const orient = opt(stt, 'pipelines.orient', 'v');
  const tb = toolbar(
    seg(stt, 'pipelines.runs', [['table', 'Table'], ['strip', 'Strip'], ['bars', 'Durations']], 'table', 'Chart type'),
    seg(stt, 'pipelines.group', [['repo', 'Repo'], ['branch', 'Branch'], ['workflow', 'Workflow']], 'repo', 'Group by'),
    view === 'bars' ? seg(stt, 'pipelines.orient', [['v', '▥ Vertical'], ['h', '▤ Horizontal']], 'v', 'Bar orientation') : '',
  );
  if (!runs.length) return tb + '<div class="empty">No run in this period.</div>';
  const gs = groups(runs, groupBy);
  const sel = opt(stt, 'pipelines.run', '');
  let body = '';
  if (view === 'strip') {
    body = `<div class="pl-strips">${gs
      .map(([k, rs]) => {
        const ordered = [...rs].reverse();
        const maxD = Math.max(1, ...ordered.map(r => durationOf(r, d.now) ?? 0));
        const done = rs.filter(r => r.status === 'success' || r.status === 'failed');
        const rate = done.length ? Math.round((100 * done.filter(r => r.status === 'success').length) / done.length) : undefined;
        return `<div class="pl-sr"><span class="pl-sl" title="${esc(k)}">${repoSw(rs[0])}${esc(k)}</span><span class="pl-sq">${ordered
          .map(r => {
            const h = 30 + Math.round((70 * (durationOf(r, d.now) ?? 0)) / maxD);
            return `<i class="pl-bg-${r.status}${runOpt(r) === sel ? ' on' : ''}" style="height:${h}%" data-opt="pipelines.run" data-val="${esc(runOpt(r))}" title="${esc(`${r.title} · ${r.ref} · ${ST_LABEL[r.status]} · ${dur(durationOf(r, d.now))} · ${new Date(r.createdAt).toLocaleString()}`)}"></i>`;
          })
          .join('')}</span><span class="pl-sn">${rate === undefined ? '' : `<b class="${rate >= 80 ? 'pl-ok' : rate >= 50 ? 'pl-wn' : 'pl-bd'}">${rate}%</b> pass`} · ${rs.length} runs · med ${esc(dur(median(rs.map(r => durationOf(r, d.now) ?? 0))))}</span></div>`;
      })
      .join('')}</div><div class="legend">oldest → newest · height = duration relative to the longest run of the row · click a run to open its jobs in Gantt</div>`;
  } else if (view === 'bars') {
    const maxD = Math.max(1, ...runs.map(r => durationOf(r, d.now) ?? 0));
    body = gs
      .map(([k, rs]) => {
        const ordered = [...rs].reverse().slice(-60);
        const bars = ordered
          .map(r => {
            const v = durationOf(r, d.now) ?? 0;
            const pc = ((100 * v) / maxD).toFixed(1);
            const t = esc(`${r.title} · ${r.ref} · ${ST_LABEL[r.status]} · ${dur(v)}`);
            return orient === 'h'
              ? `<div class="pl-hb" data-opt="pipelines.run" data-val="${esc(runOpt(r))}" title="${t}"><span class="pl-hl">${esc(hhmm(r.createdAt))} ${esc(r.ref.slice(0, 22))}</span><span class="pl-ht"><i class="pl-bg-${r.status}" style="width:${pc}%"></i></span><span class="pl-hv">${esc(dur(v))}</span></div>`
              : `<span class="pl-vb" data-opt="pipelines.run" data-val="${esc(runOpt(r))}" title="${t}"><i class="pl-bg-${r.status}" style="height:${pc}%"></i></span>`;
          })
          .join('');
        return `<div class="pl-bgp"><div class="pl-bgh">${repoSw(rs[0])}${esc(k)} <span class="muted">${rs.length} runs · median ${esc(dur(median(rs.map(r => durationOf(r, d.now) ?? 0))))}</span></div>${orient === 'h' ? `<div class="pl-hbs">${bars}</div>` : `<div class="pl-vbs">${bars}</div>`}</div>`;
      })
      .join('') + `<div class="legend">duration per run (DERIVED: end − start; running runs grow until now) · same scale for all groups · max ${esc(dur(maxD))}</div>`;
  } else {
    body = gs
      .map(
        ([k, rs]) =>
          `<tr class="pl-gh"><td colspan="9">${repoSw(rs[0])}<b>${esc(k)}</b> <span class="muted">${rs.length} run(s)</span></td></tr>` +
          rs
            .slice(0, 40)
            .map(
              r =>
                `<tr class="pl-rr${runOpt(r) === sel ? ' on' : ''}" data-opt="pipelines.run" data-val="${esc(runOpt(r))}"><td>${st(r.status, r.raw)}</td><td class="pl-tt" title="${esc(r.title)}">${r.number ? `<span class="muted">#${r.number}</span> ` : ''}${esc(r.title)}</td><td class="muted pl-wf" title="${esc(r.workflow ?? '')}">${esc(r.workflow ?? '')}</td><td class="pl-ref" title="${esc(r.ref)}">${esc(r.ref)}</td><td class="muted pl-nw">${esc(r.event ?? '')}${r.attempt && r.attempt > 1 ? ` · try ${r.attempt}` : ''}</td><td class="r">${when(d.now, r.createdAt)}</td><td class="r" title="DERIVED: end − start">${esc(dur(durationOf(r, d.now)))}</td><td>${jobDots(r)} ${sessionChips(links.get(r.key), by, stt.selected)}</td><td>${link(r.url)}</td></tr>`,
            )
            .join(''),
      )
      .join('');
    body = `<table class="pl-t"><thead><tr><th></th><th>Run</th><th>Workflow</th><th>Ref</th><th>Event</th><th class="r">Created</th><th class="r">Duration</th><th>Jobs · sessions</th><th></th></tr></thead><tbody>${body}</tbody></table><div class="legend">click a row to see its jobs as a Gantt</div>`;
  }
  return tb + body;
}

function ganttTab(runs: CiRun[], d: WsData, stt: WsState): string {
  const level = opt(stt, 'pipelines.level', 'jobs');
  const tb0 = seg(stt, 'pipelines.level', [['jobs', 'Jobs of one run'], ['runs', 'All runs']], 'jobs', 'Gantt level');
  if (level === 'runs') {
    const lane = opt(stt, 'pipelines.lane', 'repo');
    const winKey = opt(stt, 'pipelines.win', '6h');
    const win = winKey === '1h' ? HOUR : winKey === '24h' ? DAY : winKey === '7d' ? 7 * DAY : 6 * HOUR;
    const tb = toolbar(tb0, seg(stt, 'pipelines.win', [['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h'], ['7d', '7 d']], '6h', 'Time window (zoom)'), seg(stt, 'pipelines.lane', [['repo', 'By repo'], ['time', 'By start']], 'repo', 'Row order'));
    const from = d.now - win;
    const to = d.now;
    const list = runs.filter(r => (r.endedAt ?? d.now) >= from).slice(0, 150);
    if (!list.length) return tb + `<div class="empty">No run in the last ${esc(winKey)}.</div>`;
    const span = Math.max(60_000, to - from);
    const x = (t: number) => (100 * (t - from)) / span;
    const ordered = lane === 'time' ? [...list].sort((a, b) => a.createdAt - b.createdAt) : groups(list, 'repo').flatMap(([, rs]) => [...rs].sort((a, b) => a.createdAt - b.createdAt));
    let prev = '';
    const rows = ordered
      .map(r => {
        const head = lane === 'repo' && r.repo + r.provider !== prev ? `<div class="pl-gr pl-grh"><span class="pl-gl">${repoSw(r)}<b>${esc(groupKey(r, 'repo'))}</b></span><span></span><span></span></div>` : '';
        prev = r.repo + r.provider;
        const q0 = Math.max(from, r.createdAt), s0 = Math.max(from, r.startedAt ?? r.createdAt), e0 = r.endedAt ?? d.now;
        return `${head}<div class="pl-gr" data-opt="pipelines.run" data-val="${esc(runOpt(r))}"><span class="pl-gl" title="${esc(r.title)}">${st(r.status)} ${esc(r.ref.slice(0, 24))} <span class="muted">${esc((r.workflow ?? r.title).slice(0, 26))}</span></span><span class="pl-gt">${s0 > q0 ? `<i class="pl-q" style="left:${x(q0).toFixed(2)}%;width:${Math.max(0.15, x(s0) - x(q0)).toFixed(2)}%"></i>` : ''}<i class="pl-b pl-bg-${r.status}" style="left:${x(s0).toFixed(2)}%;width:${Math.max(0.3, x(e0) - x(s0)).toFixed(2)}%" title="${esc(`${r.title} · ${ST_LABEL[r.status]} · ${hhmm(s0)}–${r.endedAt ? hhmm(e0) : 'now'} · ${dur(e0 - s0)}`)}"></i></span><span class="pl-gd">${esc(dur(durationOf(r, d.now)))}</span></div>`;
      })
      .join('');
    return tb + `<div class="pl-gantt"><div class="pl-gr pl-gax"><span></span><span class="pl-gt">${ticks(from, to, x)}</span><span></span></div>${rows}</div><div class="legend"><i class="pl-lq"></i> queued (created → started) · coloured bar = run (started → ended, DERIVED) · ${list.length} run(s)</div>`;
  }
  // jobs of one run
  const withJobs = runs.filter(r => r.jobs?.length);
  const sel = opt(stt, 'pipelines.run', '');
  const pick = runs.find(r => runOpt(r) === sel) ?? withJobs.find(r => ACTIVE.has(r.status)) ?? withJobs[0];
  const picker = withJobs.slice(0, 16).map(r => `<button class="${r === pick ? 'on' : ''}" data-opt="pipelines.run" data-val="${esc(runOpt(r))}" title="${esc(`${r.repo} · ${r.title}`)}">${ST_ICON[r.status]} ${esc(r.repo.slice(0, 14))} ${esc(r.ref.slice(0, 14))}</button>`).join('');
  const groupBy = opt(stt, 'pipelines.jgroup', 'stage');
  const tb = toolbar(tb0, picker ? `<span class="seg pl-pick">${picker}</span>` : '', seg(stt, 'pipelines.jgroup', [['stage', 'By stage'], ['runner', 'By runner'], ['none', 'Start order']], 'stage', 'Group jobs'));
  if (!pick) return tb + '<div class="empty">No run with loaded jobs. Jobs are loaded for active runs and the newest ones (agent.pipelines.jobRuns).</div>';
  const head = `<div class="pl-rh">${st(pick.status, pick.raw)} ${repoSw(pick)}<b>${esc(pick.repo)}</b> ${provTag(pick)} <span class="pl-ref">${esc(pick.ref)}</span> ${esc(pick.title)} <span class="muted">${esc(pick.workflow ?? '')} · ${esc(pick.event ?? '')} · created ${esc(ago(d.now, pick.createdAt))} · ${esc(dur(durationOf(pick, d.now)))}</span> ${link(pick.url, 'Open run ↗')}</div>`;
  if (!pick.jobs?.length) return tb + head + `<div class="empty">${pick.jobsError ? `Jobs could not be read: ${esc(pick.jobsError)}` : 'Jobs not loaded for this run (only active and newest runs are, see agent.pipelines.jobRuns).'}</div>`;
  const jobs = pick.jobs;
  const from = Math.min(pick.createdAt, ...jobs.map(j => j.createdAt ?? j.startedAt ?? pick.createdAt));
  const to = Math.max(from + 30_000, ...jobs.map(j => j.endedAt ?? (j.startedAt || ACTIVE.has(j.status) ? d.now : (j.createdAt ?? from))), pick.endedAt ?? 0);
  const span = to - from;
  const x = (t: number) => (100 * (t - from)) / span;
  const gk = (j: CiJob) => (groupBy === 'stage' ? (j.stage ?? '') : groupBy === 'runner' ? (j.runner ?? (j.startedAt ? j.runnerKind : 'not started')) : '');
  const order: string[] = [];
  for (const j of jobs) if (!order.includes(gk(j))) order.push(gk(j));
  const sorted = groupBy === 'none' ? [...jobs].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity)) : order.flatMap(g => jobs.filter(j => gk(j) === g));
  let prev: string | undefined;
  const rows = sorted
    .map(j => {
      const g = gk(j);
      const h = groupBy !== 'none' && g !== prev && g ? `<div class="pl-gr pl-grh"><span class="pl-gl"><b>${esc(g)}</b></span><span></span><span></span></div>` : '';
      prev = g;
      const q0 = j.createdAt ?? pick.createdAt;
      const s0 = j.startedAt;
      const e0 = j.endedAt ?? (s0 !== undefined ? d.now : undefined);
      const queueEnd = s0 ?? (ACTIVE.has(j.status) ? d.now : q0);
      const bar =
        (queueEnd > q0 ? `<i class="pl-q" style="left:${x(q0).toFixed(2)}%;width:${Math.max(0.15, x(queueEnd) - x(q0)).toFixed(2)}%" title="${esc(`queued ${dur(queueEnd - q0)}${s0 ? '' : ' so far'}`)}"></i>` : '') +
        (s0 !== undefined && e0 !== undefined ? `<i class="pl-b pl-bg-${j.status}${j.allowFailure ? ' pl-af' : ''}" style="left:${x(s0).toFixed(2)}%;width:${Math.max(0.3, x(e0) - x(s0)).toFixed(2)}%" title="${esc(`${j.name} · ${ST_LABEL[j.status]} · ${hhmm(s0)}–${j.endedAt ? hhmm(e0) : 'now'} · ${dur(e0 - s0)}${j.failedStep ? ' · ' + j.failedStep : ''}`)}"></i>` : '');
      return `${h}<div class="pl-gr"><span class="pl-gl" title="${esc(`${j.name}${j.failedStep ? ' · ' + j.failedStep : ''}`)}">${st(j.status, j.raw)} ${esc(j.name)}${j.failedStep ? ` <span class="pl-fs">${esc(j.failedStep)}</span>` : ''}</span><span class="pl-gt">${bar}</span><span class="pl-gd">${esc(s0 !== undefined && e0 !== undefined ? dur(e0 - s0) : ST_LABEL[j.status])} ${runnerTag(j)} ${link(j.url)}</span></div>`;
    })
    .join('');
  const waits = jobs.filter(j => j.startedAt && j.createdAt).map(j => j.startedAt! - j.createdAt!);
  return (
    tb +
    head +
    `<div class="pl-gantt pl-jobs"><div class="pl-gr pl-gax"><span></span><span class="pl-gt">${ticks(from, to, x)}</span><span></span></div>${rows}</div><div class="legend"><i class="pl-lq"></i> queued · bar = job running (OBSERVED start / end) · dashed = allowed to fail · ${jobs.length} job(s) · queue wait median ${esc(dur(median(waits)))}, max ${esc(dur(waits.length ? Math.max(...waits) : undefined))}</div>`
  );
}

function runnersTab(runs: CiRun[], d: WsData, stt: WsState): string {
  const gran = opt(stt, 'pipelines.gran', 'hour');
  const chart = opt(stt, 'pipelines.rchart', 'bars');
  const step = gran === 'day' ? DAY : gran === '15m' ? 15 * 60_000 : HOUR;
  const n = gran === 'day' ? 14 : gran === '15m' ? 48 : 36;
  const end = Math.ceil(d.now / step) * step;
  const from = end - n * step;
  const tb = toolbar(
    seg(stt, 'pipelines.gran', [['15m', '15 min'], ['hour', 'Hour'], ['day', 'Day']], 'hour', 'Bucket size'),
    seg(stt, 'pipelines.rchart', [['bars', '▥ Columns'], ['heat', 'Heat strip'], ['table', 'Table']], 'bars', 'Chart type'),
  );
  const u = runnerUse(runs, from, end, step);
  if (!u.runners.length) return tb + '<div class="empty">No job with a runner in this window. Runner data comes from the runs whose jobs are loaded (active and newest, agent.pipelines.jobRuns).</div>';
  const waitsBy = new Map<string, number[]>();
  for (const r of runs) for (const j of r.jobs ?? []) if (j.startedAt && j.createdAt && j.runner) waitsBy.set(j.runner, [...(waitsBy.get(j.runner) ?? []), j.startedAt - j.createdAt]);
  const kindTag = (k: string, basis?: string) => `<span class="pl-rk pl-rk-${k}" title="${esc(`INFERRED: ${basis ?? ''}`)}">${k === 'local' ? '⌂ local' : k === 'cloud' ? '☁ cloud' : '? unknown'}</span>`;
  const lab = (t: number) => (gran === 'day' ? new Date(t).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) : hhmm(t));
  const every = Math.ceil(n / 12);
  const table = `<table class="pl-t"><thead><tr><th>Runner</th><th>Kind</th><th>Now</th><th class="r">Jobs</th><th class="r">Failed</th><th class="r" title="DERIVED: summed job run time in the window">Busy</th><th class="r" title="DERIVED: busy time / window">Use</th><th class="r" title="DERIVED: created → started">Queue median</th></tr></thead><tbody>${u.runners
    .map(
      r =>
        `<tr><td><b>${esc(r.name)}</b></td><td>${kindTag(r.kind, r.basis)}</td><td>${r.current ? `${st('running')} ${esc(r.current.run.repo)} · ${esc(r.current.job.name)} <span class="muted">${esc(dur(d.now - (r.current.job.startedAt ?? d.now)))}</span>` : '<span class="muted">idle</span>'}</td><td class="r">${r.jobs}</td><td class="r ${r.failed ? 'pl-bd' : ''}">${r.failed}</td><td class="r">${esc(dur(r.busyMs))}</td><td class="r">${((100 * r.busyMs) / (end - from)).toFixed(1)} %</td><td class="r">${esc(dur(median(waitsBy.get(r.name) ?? [])))}</td></tr>`,
    )
    .join('')}</tbody></table>`;
  if (chart === 'table') return tb + table;
  const rows = u.runners
    .slice(0, 12)
    .map(r => {
      const cells = r.perBucket
        .map((v, i) => {
          const pc = Math.min(100, (100 * v) / step);
          const t = esc(`${r.name} · ${lab(u.buckets[i])}: busy ${dur(v)} (${pc.toFixed(0)} %)`);
          return chart === 'heat'
            ? `<i style="background:${v ? `color-mix(in srgb, var(--${r.kind === 'local' ? 'warn' : 'accent'}) ${(15 + 0.85 * pc).toFixed(0)}%, transparent)` : 'transparent'}" title="${t}"></i>`
            : `<span title="${t}"><i class="pl-rk-${r.kind}" style="height:${pc.toFixed(1)}%"></i></span>`;
        })
        .join('');
      return `<div class="pl-ur"><span class="pl-ul" title="${esc(r.name)}">${kindTag(r.kind, r.basis)} ${esc(r.name)}</span><span class="${chart === 'heat' ? 'pl-heat' : 'pl-cols'}" style="grid-template-columns:repeat(${n},1fr)">${cells}</span><span class="pl-uv">${((100 * r.busyMs) / (end - from)).toFixed(0)} %</span></div>`;
    })
    .join('');
  const axis = `<div class="pl-ur pl-uax"><span></span><span class="pl-cols" style="grid-template-columns:repeat(${n},1fr)">${u.buckets.map((t, i) => `<b>${i % every === 0 ? esc(lab(t)) : ''}</b>`).join('')}</span><span></span></div>`;
  return tb + `<div class="pl-use">${rows}${axis}</div><div class="legend">busy share of each ${esc(gran === '15m' ? '15 minutes' : gran)} per runner (DERIVED from loaded jobs; runs without loaded jobs are not counted) · ⌂ local / self-hosted, ☁ cloud (INFERRED from runner group, labels or shared flag)</div>` + table;
}

// ---------------------------------------------------------------- screen

function offState(r: CiReport | undefined, d: WsData, error?: string): string {
  if (r?.state === 'untrusted') return `<div class="empty">Pipelines are off in untrusted workspaces: reading CI needs the gh / glab CLIs.</div>`;
  if (error) return `<div class="empty">Pipelines could not be read: ${esc(error)}</div>`;
  if (!r) return `<div class="empty">Reading pipelines…</div>`;
  return `<div class="pl-off"><h2>Pipelines are off</h2><p>This screen reads GitHub Actions and GitLab CI runs for the ${esc(String(d.sessions.length ? new Set(d.sessions.map(s => s.repository ?? s.cwd)).size : 0))} repositories agents touched, with the CLIs you are already logged in to (<code>gh api</code>, <code>glab api</code>, GET only). It calls the network, so it is opt-in.</p><p>Turn on <code>agent.pipelines.enabled</code>. Nothing is sent anywhere except the read requests to your own GitHub / GitLab host.</p><p>${actBtn('settings', '', 'Open Pipelines settings', 'Open the agent.pipelines settings', 'btn')}</p></div>`;
}

function render(d: WsData, stt: WsState): string {
  const fs = feedValue<CiReport>(FEED_ID);
  const report = fs.value;
  if (!report || report.state !== 'ok') return `<div class="pl">${offState(report, d, fs.error)}</div>`;
  const tab = opt(stt, 'pipelines.tab', 'blocks');
  const periodKey = opt(stt, 'pipelines.period', '7d');
  const period = periodKey === '24h' ? DAY : periodKey === '7d' ? 7 * DAY : Infinity;
  const prov = opt(stt, 'pipelines.prov', 'all');
  const allRuns = report.repos.flatMap(r => r.runs).filter(r => prov === 'all' || r.provider === prov);
  const runs = allRuns.filter(r => d.now - r.createdAt <= period).sort((a, b) => b.createdAt - a.createdAt);
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const links = linkSessions(allRuns, d.sessions);
  // Same age window as the "What blocks" tab, so tab label, KPIs and badge agree.
  const age = AGE[opt(stt, 'pipelines.age', '3d')] ?? 3 * DAY;
  const bl = blockers(allRuns, d.now).filter(b => d.now - b.run.createdAt <= age);
  const done = runs.filter(r => r.status === 'success' || r.status === 'failed');
  const pass = done.length ? Math.round((100 * done.filter(r => r.status === 'success').length) / done.length) : undefined;
  const jobsAll = allRuns.flatMap(r => r.jobs ?? []);
  const localBusy = jobsAll.filter(j => j.status === 'running' && j.runnerKind === 'local').length;
  const cloudBusy = jobsAll.filter(j => j.status === 'running' && j.runnerKind === 'cloud').length;
  const kpis = `<div class="kpis big pl-k">${kpi(runs.length, 'Runs', '', `OBSERVED: runs created in the period (${report.repos.length} repos, up to agent.pipelines.runsPerRepo each)`)}${kpi(allRuns.filter(r => r.status === 'running').length, 'Running', 'k-run', 'OBSERVED: runs in progress')}${kpi(allRuns.filter(r => r.status === 'pending').length + bl.filter(b => b.kind === 'pending' && b.job).length, 'Queued', bl.some(b => b.kind === 'pending') ? 'k-need' : '', 'OBSERVED: queued runs + queued jobs in active runs')}${kpi(bl.filter(b => b.kind === 'failed').length, 'Failing now', bl.some(b => b.kind === 'failed') ? 'k-fail' : '', 'DERIVED: failing jobs in the latest run of each repo · ref · workflow, within the What blocks age window')}${kpi(bl.filter(b => b.kind === 'blocked').length, 'Need a person', bl.some(b => b.kind === 'blocked') ? 'k-need' : '', 'OBSERVED: manual jobs / approvals')}${kpi(pass === undefined ? '—' : `${pass} %`, 'Pass rate', '', 'DERIVED: passed / (passed + failed) runs in the period')}${kpi(dur(median(done.map(r => durationOf(r, d.now) ?? 0))), 'Median run', '', 'DERIVED: end − start of finished runs in the period')}${kpi(`${localBusy} · ${cloudBusy}`, 'Local · cloud busy', '', 'OBSERVED jobs running now on local (self-hosted) and cloud runners; kind INFERRED')}</div>`;
  const tb = toolbar(
    seg(stt, 'pipelines.tab', [['blocks', `What blocks${bl.filter(b => b.kind !== 'running').length ? ' ' + bl.filter(b => b.kind !== 'running').length : ''}`], ['runs', 'Runs'], ['gantt', 'Gantt'], ['runners', 'Runners']], 'blocks', 'Section'),
    tab !== 'blocks' && tab !== 'runners' ? seg(stt, 'pipelines.period', [['24h', '24 h'], ['7d', '7 d'], ['all', 'All loaded']], '7d', 'Period (run creation time)') : '',
    report.repos.some(r => r.remotes.some(x => x.provider === 'github')) && report.repos.some(r => r.remotes.some(x => x.provider === 'gitlab')) ? seg(stt, 'pipelines.prov', [['all', 'All'], ['github', 'GitHub'], ['gitlab', 'GitLab']], 'all', 'Provider') : '',
    `<span class="muted" title="${esc(`${report.calls} CLI calls · ${new Date(report.at).toLocaleString()}`)}">read ${esc(ago(d.now, report.at))}${fs.ms !== undefined ? ` in ${(fs.ms / 1000).toFixed(1)} s` : ''}${fs.running ? ' · refreshing…' : ''}</span>`,
    actBtn('refresh', '', 'Refresh', 'Read the pipelines again now'),
  );
  const errs = report.repos.flatMap(r => r.errors);
  const errLine = errs.length ? `<div class="pl-err" title="${esc(errs.join('\n'))}">⚠ ${errs.length} remote(s) could not be read: ${esc(errs[0])}${errs.length > 1 ? ' …' : ''}</div>` : '';
  if (!report.repos.length)
    return `<div class="pl">${tb}<div class="empty">No GitHub or GitLab remote found in the ${esc(String(report.noRemote))} repositories agents touched. Add repositories with <code>agent.pipelines.extraRepos</code>; self-managed GitLab hosts with <code>agent.pipelines.gitlabHosts</code>.</div>${errLine}</div>`;
  const body = tab === 'runs' ? runsTab(runs, d, stt, links, by) : tab === 'gantt' ? ganttTab(runs, d, stt) : tab === 'runners' ? runnersTab(allRuns, d, stt) : blocksTab(allRuns, d, stt, links, by);
  const repoLine = `<div class="pl-repos">${report.repos.map(r => `<span title="${esc(`${r.root}\n${r.remotes.map(x => `${x.name}: ${x.host}/${x.slug}`).join('\n')}\nread in ${r.ms} ms`)}">${`<span class="pl-sw" style="background:${identityColor(r.name)}"></span>`}${esc(r.name)} <span class="muted">${r.remotes.map(x => (x.provider === 'github' ? 'GH' : 'GL')).join('+')} · ${r.runs.length}</span></span>`).join('')}</div>`;
  return `<div class="pl">${tb}${kpis}${errLine}${body}${repoLine}<div class="foot">Read-only: <code>gh api</code> / <code>glab api</code> GET with your existing CLI login, 5 s timeout, opt-in. Statuses and times OBSERVED from the CI host; durations, pass rate and "what blocks" DERIVED; runner kind (local / cloud) and session links by branch INFERRED, by commit OBSERVED. Links open https pages on the remote's host only.</div></div>`;
}

function allowedUrl(arg: string): string {
  const r = feedValue<CiReport>(FEED_ID).value;
  const ok = r?.repos.some(x => x.runs.some(run => run.url === arg || run.jobs?.some(j => j.url === arg)));
  if (!ok || !/^https:\/\//.test(arg)) throw new Error('Unknown pipeline link.');
  return arg;
}

const CSS = `
.pl .tb { margin: 0 0 6px; }
.pl .pl-k { margin: 6px 0 10px; }
.pl .pl-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
.pl .pl-st { display: inline-block; width: 14px; text-align: center; font-weight: 700; }
.pl .pl-success { color: var(--ok); } .pl .pl-failed { color: var(--bad); } .pl .pl-running { color: var(--accent); } .pl .pl-pending, .pl .pl-blocked { color: var(--warn); } .pl .pl-canceled, .pl .pl-skipped, .pl .pl-unknown { color: var(--quiet); }
.pl .pl-bg-success { background: var(--ok); } .pl .pl-bg-failed { background: var(--bad); } .pl .pl-bg-running { background: var(--accent); } .pl .pl-bg-pending { background: var(--warn); opacity: .75; }
.pl .pl-bg-blocked { background: repeating-linear-gradient(45deg, var(--warn) 0 3px, transparent 3px 6px); border: 1px solid var(--warn); box-sizing: border-box; }
.pl .pl-bg-canceled, .pl .pl-bg-skipped, .pl .pl-bg-unknown { background: var(--quiet); opacity: .6; }
.pl .pl-pv { font-size: 9px; font-weight: 700; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); vertical-align: 1px; }
.pl .pl-pv.pl-gitlab { border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.pl table.pl-t { font-size: 12px; max-width: 1400px; margin-bottom: 8px; }
.pl table.pl-t th { white-space: nowrap; }
.pl table.pl-t td.r, .pl table.pl-t th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pl table.pl-t tr:hover td { background: var(--vscode-list-hoverBackground); }
.pl tr.pl-rr { cursor: pointer; } .pl tr.pl-rr.on td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.pl tr.pl-gh td { border-bottom: 1px solid var(--line); padding-top: 8px; background: none !important; }
.pl .pl-nw { white-space: nowrap; }
.pl .pl-wf { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-det { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-tt { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-ref { font-family: var(--vscode-editor-font-family); font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-jd { display: inline-flex; gap: 1px; vertical-align: middle; flex-wrap: wrap; max-width: 220px; } .pl .pl-jd i { width: 6px; height: 10px; border-radius: 1px; }
.pl .pl-ses { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; padding: 0 5px; border: 1px solid var(--line); border-radius: 8px; margin: 0 2px; cursor: pointer; white-space: nowrap; }
.pl .pl-ses:hover, .pl .pl-ses.sel { border-color: var(--vscode-focusBorder); }
.pl .pl-rn, .pl .pl-rk { font-size: 10px; white-space: nowrap; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); }
.pl .pl-rk-local.pl-rn, .pl .pl-rk.pl-rk-local { border-color: color-mix(in srgb, var(--warn) 70%, transparent); }
.pl .pl-rk-cloud.pl-rn, .pl .pl-rk.pl-rk-cloud { border-color: color-mix(in srgb, var(--accent) 70%, transparent); }
.pl .pl-cnt { display: inline-flex; gap: 6px; } .pl .pl-c { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--line); }
.pl .pl-ck-failed b { color: var(--bad); } .pl .pl-ck-blocked b, .pl .pl-ck-pending b { color: var(--warn); } .pl .pl-ck-running b { color: var(--accent); }
.pl .pl-kd { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; white-space: nowrap; border: 1px solid; }
.pl .pl-kd-failed { color: var(--bad); border-color: var(--bad); } .pl .pl-kd-blocked, .pl .pl-kd-pending { color: var(--warn); border-color: var(--warn); } .pl .pl-kd-running { color: var(--accent); border-color: var(--accent); }
.pl .pl-hot { color: var(--bad); font-weight: 700; }
.pl .pl-green { color: var(--ok); }
.pl .pl-ok { color: var(--ok); } .pl .pl-wn { color: var(--warn); } .pl .pl-bd { color: var(--bad); }
.pl .pl-err { font-size: 11px; color: var(--warn); margin: 0 0 6px; }
.pl .pl-strips { display: grid; gap: 3px; max-width: 1300px; }
.pl .pl-sr { display: grid; grid-template-columns: minmax(140px, 260px) minmax(0, 1fr) 190px; gap: 8px; align-items: center; font-size: 12px; }
.pl .pl-sl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-sq { display: flex; align-items: flex-end; gap: 2px; height: 22px; }
.pl .pl-sq i { flex: 0 0 9px; border-radius: 2px; cursor: pointer; } .pl .pl-sq i.on, .pl .pl-sq i:hover { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.pl .pl-sn { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; white-space: nowrap; }
.pl .pl-bgp { margin-bottom: 10px; max-width: 1300px; } .pl .pl-bgh { font-size: 12px; margin-bottom: 3px; }
.pl .pl-vbs { display: flex; align-items: flex-end; gap: 2px; height: 90px; border-bottom: 1px solid var(--line); }
.pl .pl-vb { flex: 0 1 14px; min-width: 4px; height: 100%; display: flex; align-items: flex-end; cursor: pointer; } .pl .pl-vb i { width: 100%; border-radius: 2px 2px 0 0; min-height: 2px; } .pl .pl-vb:hover { background: var(--vscode-list-hoverBackground); }
.pl .pl-hbs { display: grid; gap: 1px; }
.pl .pl-hb { display: grid; grid-template-columns: 170px minmax(0, 1fr) 52px; gap: 6px; align-items: center; font-size: 11px; cursor: pointer; } .pl .pl-hb:hover { background: var(--vscode-list-hoverBackground); }
.pl .pl-hl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
.pl .pl-ht { height: 9px; background: var(--raise); border-radius: 2px; } .pl .pl-ht i { display: block; height: 100%; border-radius: 2px; min-width: 2px; }
.pl .pl-hv { text-align: right; font-variant-numeric: tabular-nums; }
.pl .pl-gantt { display: grid; gap: 1px; max-width: 1400px; font-size: 11px; margin-bottom: 4px; }
.pl .pl-gr { display: grid; grid-template-columns: minmax(160px, 300px) minmax(0, 1fr) minmax(110px, 260px); gap: 8px; align-items: center; min-height: 17px; }
.pl .pl-gr[data-opt] { cursor: pointer; } .pl .pl-gr[data-opt]:hover { background: var(--vscode-list-hoverBackground); }
.pl .pl-grh { margin-top: 4px; border-bottom: 1px solid var(--line); }
.pl .pl-gl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-gt { position: relative; height: 13px; background: color-mix(in srgb, var(--raise) 70%, transparent); border-radius: 2px; }
.pl .pl-gax .pl-gt { background: none; height: 14px; }
.pl .pl-gt i { position: absolute; top: 2px; height: 9px; border-radius: 2px; }
.pl .pl-gt i.pl-q, .pl .pl-lq { background: repeating-linear-gradient(90deg, var(--quiet) 0 2px, transparent 2px 4px); opacity: .7; }
.pl .pl-lq { display: inline-block; width: 18px; height: 8px; vertical-align: 0; }
.pl .pl-gt i.pl-af { outline: 1px dashed var(--vscode-foreground); outline-offset: -1px; }
.pl .pl-gd { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.pl .pl-tk { position: absolute; top: 0; transform: translateX(-50%); font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.pl .pl-fs { color: var(--bad); font-size: 10px; }
.pl .pl-rh { font-size: 12px; margin: 2px 0 6px; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.pl .pl-pick { flex-wrap: wrap; } .pl .pl-pick button { white-space: nowrap; }
.pl .pl-use { display: grid; gap: 3px; max-width: 1400px; margin-bottom: 10px; }
.pl .pl-ur { display: grid; grid-template-columns: minmax(160px, 280px) minmax(0, 1fr) 44px; gap: 8px; align-items: center; font-size: 11px; }
.pl .pl-ul { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .pl-uv { text-align: right; font-variant-numeric: tabular-nums; }
.pl .pl-cols { display: grid; gap: 1px; height: 30px; align-items: end; border-bottom: 1px solid var(--line); }
.pl .pl-cols span { height: 100%; display: flex; align-items: flex-end; } .pl .pl-cols span:hover { background: var(--vscode-list-hoverBackground); }
.pl .pl-cols i { display: block; width: 100%; border-radius: 1px 1px 0 0; }
.pl .pl-cols i.pl-rk-local { background: var(--warn); } .pl .pl-cols i.pl-rk-cloud { background: var(--accent); } .pl .pl-cols i.pl-rk-unknown { background: var(--quiet); }
.pl .pl-uax .pl-cols { height: auto; border: none; } .pl .pl-uax b { font-weight: 400; font-size: 9px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: visible; }
.pl .pl-heat { display: grid; gap: 1px; height: 16px; } .pl .pl-heat i { border: 1px solid var(--line); border-radius: 2px; }
.pl .pl-repos { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; margin-top: 10px; }
.pl .pl-off { max-width: 680px; line-height: 1.5; } .pl .pl-off code, .pl .foot code, .pl .empty code { font-size: 11px; }
`;

export const pipelinesView: ExtraView = {
  id: 'pipelines',
  label: 'Pipelines',
  group: 'Git',
  hint: 'GitHub Actions and GitLab pipelines for the repositories agents touch: what blocks, runs, jobs as a Gantt, runners (opt-in, read-only CLI).',
  ready: true,
  feeds: [pipelinesFeed as Feed],
  render,
  css: CSS,
  badge: (d: WsData) => {
    const r = feedValue<CiReport>(FEED_ID).value;
    if (r?.state !== 'ok') return '';
    // Same default as the "What blocks" tab: runs of the last 3 days.
    const n = blockers(r.repos.flatMap(x => x.runs), d.now).filter(b => (b.kind === 'failed' || b.kind === 'blocked') && d.now - b.run.createdAt <= AGE['3d']).length;
    return n ? String(n) : '';
  },
  actions: {
    open: (arg: string, ctx: ActCtx) => ctx.openUrl(allowedUrl(arg)),
    refresh: (_arg: string, ctx: ActCtx) => ctx.refreshFeeds(),
    settings: async (_arg: string, ctx: ActCtx) => void (await ctx.runCommand('workbench.action.openSettings', 'agent.pipelines')),
  },
};
