// Add-on screen "Review" (P5 + P10): where each piece of agent work stands, from "working" to "merged".
// Lanes come from src/activity/review.ts (sessions + recorded push / PR commands); PR / MR state from the
// opt-in feed in src/feeds/review.ts (gh / glab, read-only, default off). Everything printed is escaped.
import type { AgentSessionSnapshot } from '../../model';
import { Lane, LANE_HINT, LANE_LABEL, LANES, ReviewItem, reviewItems, Step, unlinkedPrs } from '../../activity/review';
import { execRunner, loadPrs, PrInfo, PrReport, reposOf } from '../../feeds/review';
import { identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import { ago, prettyModel, repoOf, titleOf, WsData, WsState } from '../workspace';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';

const FEED_ID = 'review.prs';

/** Reads `agent.review.<name>`; accepts both full and section-relative keys from the host. */
function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.review.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`review.${name}`, fallback);
}

const prFeed: Feed<PrReport> = {
  id: FEED_ID,
  intervalMs: 60_000,
  async load(ctx) {
    if (!cfg<boolean>(ctx, 'prState', false)) return { state: 'off', at: ctx.now, repos: [] };
    if (!ctx.trusted) return { state: 'untrusted', at: ctx.now, repos: [] };
    const max = Math.max(1, Math.min(40, Number(cfg<number>(ctx, 'maxRepos', 12)) || 12));
    const limit = Math.max(5, Math.min(100, Number(cfg<number>(ctx, 'limit', 30)) || 30));
    return loadPrs(reposOf(ctx.sessions, max), execRunner, limit, ctx.now);
  },
};

// ---------------------------------------------------------------- helpers

const LANE_CLS: Record<Lane, string> = { needs: 'rv-l-needs', working: 'rv-l-working', cifail: 'rv-l-cifail', review: 'rv-l-review', ready: 'rv-l-ready', local: 'rv-l-local', merged: 'rv-l-merged', quiet: 'rv-l-quiet' };
const PROV: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const DAY = 86400_000;
const PERIOD: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, all: Infinity };

function short(now: number, t: number): string {
  const s = Math.max(0, now - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const prRef = (p: PrInfo) => `${p.forge === 'gitlab' ? '!' : '#'}${p.number}`;

const CI_TXT: Record<string, string> = { pass: '✓', fail: '✗', pending: '●', none: '–' };

function prChip(p: PrInfo, now: number): string {
  const title = `OBSERVED (${p.forge === 'gitlab' ? 'glab mr list / view' : 'gh pr list'}): ${p.forge === 'gitlab' ? 'MR' : 'PR'} ${prRef(p)} ${p.state} · ${p.head} → ${p.base} · ${p.slug} via ${p.remote}\nCI: ${p.ci}${p.failing.length ? ' · failing ' + p.failing.join(', ') : ''}${p.pending.length ? ' · pending ' + p.pending.join(', ') : ''}\nreview: ${p.review} · mergeable: ${p.mergeDetail ?? p.mergeable}${p.updatedAt ? `\nupdated ${ago(now, p.updatedAt)}` : ''}\n${p.title}`;
  const inner = `<span class="rv-pst rv-ps-${p.state}">${esc(p.state)}</span>${esc(prRef(p))}<span class="rv-ci rv-ci-${p.ci}">${CI_TXT[p.ci]}</span>`;
  return p.url
    ? `<button class="rv-pr" data-act="open" data-arg="${esc(p.url)}" title="${esc(title + '\nClick to open in the browser')}">${inner}</button>`
    : `<span class="rv-pr" title="${esc(title)}">${inner}</span>`;
}

function stepStrip(steps: Step[]): string {
  return `<span class="rv-steps">${steps.map(g => `<span class="rv-st rv-st-${g.state}" title="${esc(`${g.label}: ${g.detail} · ${g.kind}`)}">${esc(g.label)}</span>`).join('')}</span>`;
}

function who(s: AgentSessionSnapshot): string {
  return [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
}

function card(it: ReviewItem, d: WsData, st: WsState, compactCards: boolean): string {
  const s = it.s;
  const repo = repoOf(s);
  const br = it.branch ? `<span class="rv-br" title="${esc(`branch ${it.branch}${s.isLinkedWorktree ? ' · linked worktree' : ''}`)}">⎇ ${esc(it.branch)}</span>` : '';
  const wk = it.workers ? `<span class="chip" title="DERIVED: worker sessions rolled into this item (files, tests, live state)">${it.workers} worker${it.workers > 1 ? 's' : ''}${it.liveWorkers ? ` · ${it.liveWorkers} live` : ''}</span>` : '';
  const prs = it.pr ? prChip(it.pr, d.now) + it.otherPrs.slice(0, 2).map(p => prChip(p, d.now)).join('') : '';
  const copy = it.branch ? actBtn('copy', it.branch, 'copy branch', 'Copy the branch name', 'link rv-mini') : '';
  return `<div class="rv-card ${LANE_CLS[it.lane]}${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" tabindex="0" style="--id:${identityColor(repo)}">
<div class="rv-ct"><span class="dot ${esc(s.status)}" title="${esc(`${s.status}: ${s.statusReason}`)}"></span><b class="rv-ti">${esc(titleOf(s).slice(0, 90))}</b>${s.isWorker ? '<span class="chip">worker</span>' : ''}<span class="rv-age" title="${esc(new Date(it.at).toLocaleString())}">${esc(short(d.now, it.at))}</span></div>
<div class="rv-sub"><span class="rv-repo">${esc(repo)}</span>${br}<span class="muted rv-who">${esc(who(s))}</span></div>
<div class="rv-why" title="${esc(`${it.kind}: ${it.basis}`)}">${esc(it.reason)}</div>
${compactCards ? '' : `<div class="rv-foot">${stepStrip(it.steps)}</div>`}${prs || wk || copy ? `<div class="rv-acts">${prs}${wk}${copy}</div>` : ''}</div>`;
}

function groupKey(it: ReviewItem, by: string): string {
  if (by === 'repo') return repoOf(it.s);
  if (by === 'provider') return PROV[it.s.provider] ?? it.s.provider;
  return '';
}

function grouped(items: ReviewItem[], by: string, fn: (xs: ReviewItem[]) => string): string {
  if (by === 'none') return fn(items);
  const g = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const k = groupKey(it, by);
    g.set(k, [...(g.get(k) ?? []), it]);
  }
  return [...g.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k, xs]) => `<div class="rv-gh"><span class="rv-sw" style="background:${by === 'provider' ? (k === 'Codex' ? 'var(--codex)' : 'var(--claude)') : identityColor(k)}"></span>${esc(k)} <span class="muted">${xs.length}</span></div>${fn(xs)}`)
    .join('');
}

// ---------------------------------------------------------------- layouts

function board(lanes: Lane[], by: Map<Lane, ReviewItem[]>, d: WsData, st: WsState, group: string, compactCards: boolean): string {
  return `<div class="rv-board" style="grid-template-columns:repeat(${lanes.length}, minmax(210px, 1fr))">${lanes
    .map(l => {
      const xs = by.get(l) ?? [];
      return `<section class="rv-col ${LANE_CLS[l]}"><header title="${esc(LANE_HINT[l])}"><span class="rv-lt">${esc(LANE_LABEL[l])}</span><span class="rv-n">${xs.length}</span></header><div class="rv-cards">${xs.length ? grouped(xs, group, ys => ys.map(it => card(it, d, st, compactCards)).join('')) : '<div class="rv-none">—</div>'}</div></section>`;
    })
    .join('')}</div>`;
}

function swimlanes(lanes: Lane[], by: Map<Lane, ReviewItem[]>, d: WsData, st: WsState, compactCards: boolean): string {
  return `<div class="rv-swim">${lanes
    .map(l => {
      const xs = by.get(l) ?? [];
      return `<div class="rv-row ${LANE_CLS[l]}"><div class="rv-rh" title="${esc(LANE_HINT[l])}"><span class="rv-lt">${esc(LANE_LABEL[l])}</span><span class="rv-n">${xs.length}</span></div><div class="rv-rc">${xs.length ? xs.map(it => card(it, d, st, compactCards)).join('') : '<span class="rv-none">—</span>'}</div></div>`;
    })
    .join('')}</div>`;
}

function table(items: ReviewItem[], d: WsData, st: WsState, group: string): string {
  const rows = (xs: ReviewItem[]) =>
    xs
      .map(it => {
        const s = it.s;
        const p = it.pr;
        return `<tr class="${LANE_CLS[it.lane]}${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" tabindex="0"><td><span class="rv-lane" title="${esc(LANE_HINT[it.lane])}">${esc(LANE_LABEL[it.lane])}</span></td><td class="rv-tt"><span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 70))}${it.workers ? ` <span class="muted">+${it.workers}w</span>` : ''}</td><td><span class="rv-sw" style="background:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td class="rv-brc" title="${esc(it.branch ?? '')}">${esc(it.branch ?? '')}</td><td>${stepStrip(it.steps)}</td><td>${p ? prChip(p, d.now) : ''}</td><td class="rv-whyc" title="${esc(`${it.kind}: ${it.basis}`)}">${esc(it.reason)}</td><td class="r muted" title="${esc(new Date(it.at).toLocaleString())}">${esc(short(d.now, it.at))}</td></tr>`;
      })
      .join('');
  const head = '<tr><th>Lane</th><th>Session</th><th>Repo</th><th>Branch</th><th title="Edit · Test · Commit · Push · PR · CI · Review · Merge (hover a step for its evidence)">Pipeline</th><th>PR / MR</th><th>Why</th><th class="r">Last</th></tr>';
  if (group === 'none') return `<table class="rv-t">${head}${rows(items)}</table>`;
  const g = new Map<string, ReviewItem[]>();
  for (const it of items) g.set(groupKey(it, group), [...(g.get(groupKey(it, group)) ?? []), it]);
  return `<table class="rv-t">${head}${[...g.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k, xs]) => `<tr class="rv-tg"><td colspan="8">${esc(k)} <span class="muted">${xs.length}</span></td></tr>${rows(xs)}`)
    .join('')}</table>`;
}

function prTable(prs: PrInfo[], d: WsData, title: string): string {
  if (!prs.length) return '';
  return `<h2 class="rv-h2">${esc(title)} <span class="muted">${prs.length}</span></h2><table class="rv-t rv-prt"><tr><th>Repo</th><th>PR / MR</th><th>Title</th><th>Head → base</th><th>CI</th><th>Review</th><th>Mergeable</th><th class="r">Updated</th></tr>${prs
    .slice(0, 40)
    .map(p => {
      const repo = p.repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p.repo;
      return `<tr><td><span class="rv-sw" style="background:${identityColor(repo)}"></span>${esc(repo)} <span class="muted">${esc(p.remote)}</span></td><td>${prChip(p, d.now)}</td><td class="rv-tt" title="${esc(p.title)}">${esc(p.title)}</td><td class="rv-brc">${esc(p.head)} → ${esc(p.base)}</td><td class="rv-ci-${p.ci}" title="${esc([...p.failing, ...p.pending].join(', '))}">${esc(p.ci)}</td><td>${esc(p.review === 'none' ? '—' : p.review)}</td><td title="${esc(p.mergeDetail ?? '')}">${esc(p.mergeable)}</td><td class="r muted">${p.updatedAt ? esc(short(d.now, p.updatedAt)) : ''}</td></tr>`;
    })
    .join('')}</table>`;
}

function feedLine(f: ReturnType<typeof feedValue<PrReport>>, d: WsData): string {
  const v = f.value;
  const refresh = actBtn('refresh', '', '↻ refresh', 'Reload PR / MR state now', 'link rv-mini');
  if (f.running && !v) return `<div class="rv-feed"><span class="sd partial"></span>PR / MR state: loading (gh / glab)…</div>`;
  if (f.error) return `<div class="rv-feed"><span class="sd missing"></span>PR / MR state: ${esc(f.error)} ${refresh}</div>`;
  if (!v) return `<div class="rv-feed"><span class="sd off"></span>PR / MR state not loaded yet.</div>`;
  if (v.state === 'off')
    return `<div class="rv-feed"><span class="sd off"></span>PR / MR state <b>off</b>: lanes use sessions and the push / PR commands they recorded. Turn on <code>agent.review.prState</code> to read open PRs and CI with <code>gh</code> / <code>glab</code> (read-only, network).</div>`;
  if (v.state === 'untrusted') return `<div class="rv-feed"><span class="sd off"></span>PR / MR state off in an untrusted workspace (no process is started).</div>`;
  const n = v.repos.reduce((a, r) => a + r.prs.length, 0);
  const errs = v.repos.flatMap(r => r.errors.map(e => `${r.repo.split(/[\\/]/).pop()}: ${e}`));
  const ms = v.repos.reduce((a, r) => Math.max(a, r.ms), 0);
  const noRemote = v.repos.filter(r => !r.remotes.length && !r.errors.length).length;
  return `<div class="rv-feed"><span class="sd ${errs.length ? 'partial' : 'ready'}"></span>PR / MR state: ${v.repos.length} repo(s) · ${n} PR / MR · slowest ${ms} ms · ${esc(ago(d.now, v.at) || 'now')}${noRemote ? ` · ${noRemote} without a GitHub / GitLab remote` : ''} ${refresh}${errs.length ? `<details class="rv-err"><summary>${errs.length} error(s)</summary>${errs.slice(0, 12).map(e => `<div>${esc(e)}</div>`).join('')}</details>` : ''}</div>`;
}

// ---------------------------------------------------------------- screen

function render(d: WsData, st: WsState): string {
  const layout = opt(st, 'review.layout', 'board');
  const group = opt(st, 'review.group', 'none');
  const period = opt(st, 'review.period', '7d');
  const show = opt(st, 'review.show', 'active');
  const detail = opt(st, 'review.detail', 'full');
  const pick = opt(st, 'review.lane', '');
  const prsMode = opt(st, 'review.prs', 'unlinked');

  const f = feedValue<PrReport>(FEED_ID);
  const prs = f.value?.state === 'ok' ? f.value.repos.flatMap(r => r.prs) : undefined;
  const events = d.timeline ? d.timeline(undefined, 100_000) : d.events;
  const all = reviewItems(d.sessions, events, d.now, { idleAlertMinutes: d.idleAlertMinutes, prs });
  const since = d.now - (PERIOD[period] ?? PERIOD['7d']);
  const inPeriod = all.filter(it => it.at >= since || isLive(it.s) || (it.pr && (it.pr.state === 'open' || it.pr.state === 'draft')));

  const counts = new Map<Lane, number>(LANES.map(l => [l, 0]));
  for (const it of inPeriod) counts.set(it.lane, (counts.get(it.lane) ?? 0) + 1);
  const hiddenLanes = new Set<Lane>(show === 'all' ? [] : ['quiet', 'merged']);
  let lanes = LANES.filter(l => !hiddenLanes.has(l));
  if (pick && (LANES as string[]).includes(pick)) lanes = [pick as Lane];
  const items = inPeriod.filter(it => lanes.includes(it.lane));
  const by = new Map<Lane, ReviewItem[]>();
  for (const it of items) by.set(it.lane, [...(by.get(it.lane) ?? []), it]);

  const tb1 = toolbar(
    seg(st, 'review.layout', [['board', '▥ Board'], ['lanes', '▤ Lanes'], ['table', 'Table']], 'board', 'Board: one column per lane (vertical) · Lanes: one row per lane (horizontal) · Table: dense list'),
    seg(st, 'review.period', [['24h', '24 h'], ['7d', '7 d'], ['all', 'All loaded']], '7d', 'Sessions active in the period (live sessions and open PRs always shown)'),
    seg(st, 'review.show', [['active', 'Open work'], ['all', 'All lanes']], 'active', 'Open work hides the Merged and No change lanes'),
    layout !== 'lanes' ? seg(st, 'review.group', [['none', 'No grouping'], ['repo', 'By repo'], ['provider', 'By provider']], 'none', 'Group cards / rows') : '',
    layout !== 'table' ? seg(st, 'review.detail', [['full', 'Full cards'], ['compact', 'Compact']], 'full', 'Compact hides the pipeline strip') : '',
    seg(st, 'review.prs', [['unlinked', 'Other open PRs'], ['all', 'All PRs'], ['none', 'No PR list']], 'unlinked', 'PR / MR list below the lanes (needs agent.review.prState)'),
  );
  const kpis = `<div class="kpis rv-k">${LANES.filter(l => show === 'all' || !hiddenLanes.has(l) || counts.get(l))
    .map(l => `<button class="kpi rv-kp ${LANE_CLS[l]}${pick === l ? ' on' : ''}${hiddenLanes.has(l) ? ' rv-dim' : ''}" data-opt="review.lane" data-val="${pick === l ? '' : l}" title="${esc(`${LANE_HINT[l]} Click to show only this lane.`)}"><b>${counts.get(l) ?? 0}</b><span>${esc(LANE_LABEL[l])}</span></button>`)
    .join('')}${pick ? `<button class="link rv-mini" data-opt="review.lane" data-val="">show every lane</button>` : ''}</div>`;

  let body: string;
  if (!inPeriod.length) body = `<div class="empty">No session in this period. Try 7 d or All loaded (history follows <code>agent.historyDays</code>).</div>`;
  else if (layout === 'table') body = items.length ? table(items, d, st, group) : `<div class="empty">No item in the shown lanes.</div>`;
  else if (layout === 'lanes') body = swimlanes(lanes, by, d, st, detail === 'compact');
  else body = board(lanes, by, d, st, group, detail === 'compact');

  let prList = '';
  if (prs && prsMode !== 'none') {
    if (prsMode === 'all') prList = prTable([...prs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), d, 'All PRs / MRs loaded');
    else prList = prTable(unlinkedPrs(all, prs), d, 'Open PRs / MRs without a session in view');
  }

  const legend = `<div class="legend rv-leg">Pipeline: <span class="rv-st rv-st-done">done</span><span class="rv-st rv-st-live">in progress</span><span class="rv-st rv-st-fail">failed</span><span class="rv-st rv-st-none">not seen</span> · CI <span class="rv-ci rv-ci-pass">✓</span> pass <span class="rv-ci rv-ci-fail">✗</span> fail <span class="rv-ci rv-ci-pending">●</span> running · hover any value for its evidence (OBSERVED / DERIVED / INFERRED / UNKNOWN).</div>`;
  const foot = `<div class="foot">Lanes come from session status, git commits in the session window, and push / <code>gh pr create</code> / <code>glab mr create</code> / merge commands the sessions recorded (OBSERVED). PR / MR, CI and review state come from the forge only when <code>agent.review.prState</code> is on. Workers roll into their lead unless they have their own branch PR or push. No merge, comment or approval is ever sent from here.</div>`;
  return `<div class="rv">${tb1}${feedLine(f, d)}${kpis}${body}${legend}${prList}${foot}</div>`;
}

const CSS = `
.rv { --rv-needs: var(--warn); --rv-working: var(--accent); --rv-cifail: var(--bad); --rv-review: var(--vscode-charts-yellow, #cca700); --rv-ready: var(--ok); --rv-local: var(--vscode-descriptionForeground); --rv-merged: var(--vscode-charts-purple, #a07ce0); --rv-quiet: var(--quiet); }
.rv .rv-l-needs { --lc: var(--rv-needs); } .rv .rv-l-working { --lc: var(--rv-working); } .rv .rv-l-cifail { --lc: var(--rv-cifail); } .rv .rv-l-review { --lc: var(--rv-review); }
.rv .rv-l-ready { --lc: var(--rv-ready); } .rv .rv-l-local { --lc: var(--rv-local); } .rv .rv-l-merged { --lc: var(--rv-merged); } .rv .rv-l-quiet { --lc: var(--rv-quiet); }
.rv .tb { margin: 0 0 6px; }
.rv .rv-feed { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.rv .rv-feed code { font-size: 10.5px; }
.rv .rv-err { width: 100%; } .rv .rv-err summary { cursor: pointer; color: var(--warn); } .rv .rv-err div { font-family: var(--vscode-editor-font-family); font-size: 10.5px; padding-left: 12px; }
.rv .rv-k { margin: 2px 0 10px; }
.rv .rv-kp { background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; border-top: 3px solid var(--lc); }
.rv .rv-kp b { color: var(--lc); } .rv .rv-kp.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); } .rv .rv-kp.rv-dim { opacity: .55; }
.rv .rv-mini { font-size: 10.5px; }
.rv .rv-board { display: grid; gap: 8px; overflow-x: auto; align-items: start; padding-bottom: 4px; }
.rv .rv-col { background: var(--raise); border: 1px solid var(--line); border-top: 3px solid var(--lc); border-radius: 5px; min-width: 0; }
.rv .rv-col > header, .rv .rv-rh { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.rv .rv-lt { color: var(--vscode-foreground); } .rv .rv-n { margin-left: auto; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--lc) 22%, transparent); color: var(--vscode-foreground); border-radius: 8px; padding: 0 6px; }
.rv .rv-cards { display: flex; flex-direction: column; gap: 5px; padding: 0 6px 6px; max-height: 70vh; overflow-y: auto; }
.rv .rv-none { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 2px 4px; }
.rv .rv-gh { font-size: 10.5px; color: var(--vscode-descriptionForeground); margin: 4px 0 0; display: flex; align-items: center; gap: 4px; }
.rv .rv-sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; flex: none; }
.rv .rv-card { background: var(--vscode-editor-background); border: 1px solid var(--line); border-left: 3px solid var(--id, var(--lc)); border-radius: 4px; padding: 5px 7px; font-size: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rv .rv-card:hover, .rv .rv-card:focus { background: var(--vscode-list-hoverBackground); outline: none; }
.rv .rv-card.sel { outline: 1px solid var(--vscode-focusBorder); }
.rv .rv-ct { display: flex; align-items: center; gap: 5px; min-width: 0; }
.rv .rv-ti { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; font-weight: 600; }
.rv .rv-age { color: var(--vscode-descriptionForeground); font-size: 10.5px; font-variant-numeric: tabular-nums; flex: none; }
.rv .rv-sub { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 11px; min-width: 0; }
.rv .rv-repo { font-weight: 600; color: var(--vscode-foreground); }
.rv .rv-br { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.rv .rv-why { font-size: 11px; color: var(--vscode-foreground); border-left: 2px solid var(--lc); padding-left: 5px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.rv .rv-foot { margin-top: 2px; }
.rv .rv-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 2px; }
.rv .rv-steps { display: inline-flex; gap: 1px; flex-wrap: nowrap; }
.rv .rv-st { font-size: 9.5px; padding: 0 4px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); line-height: 14px; }
.rv .rv-st:first-child { border-radius: 3px 0 0 3px; } .rv .rv-st:last-child { border-radius: 0 3px 3px 0; }
.rv .rv-leg .rv-st { border-radius: 3px; }
.rv .rv-st-done { background: color-mix(in srgb, var(--ok) 22%, transparent); border-color: color-mix(in srgb, var(--ok) 55%, transparent); color: var(--vscode-foreground); }
.rv .rv-st-live { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--vscode-foreground); }
.rv .rv-st-fail { background: color-mix(in srgb, var(--bad) 25%, transparent); border-color: var(--bad); color: var(--vscode-foreground); }
.rv .rv-st-none { opacity: .55; }
.rv .rv-pr { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 10.5px; border: 1px solid var(--line); border-radius: 10px; padding: 0 6px 0 2px; background: none; color: var(--vscode-foreground); cursor: pointer; line-height: 16px; }
.rv .rv-pr:hover { border-color: var(--vscode-focusBorder); }
.rv .rv-pst { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; border-radius: 8px; padding: 0 5px; color: #fff; }
.rv .rv-ps-open { background: var(--ok); } .rv .rv-ps-draft { background: var(--quiet); } .rv .rv-ps-merged { background: var(--rv-merged); } .rv .rv-ps-closed { background: var(--bad); }
.rv .rv-ci { font-weight: 700; } .rv .rv-ci-pass { color: var(--ok); } .rv .rv-ci-fail { color: var(--bad); } .rv .rv-ci-pending { color: var(--accent); } .rv .rv-ci-none { color: var(--vscode-descriptionForeground); }
.rv .rv-swim { display: flex; flex-direction: column; gap: 6px; }
.rv .rv-row { display: grid; grid-template-columns: 130px minmax(0, 1fr); border: 1px solid var(--line); border-left: 3px solid var(--lc); border-radius: 5px; background: var(--raise); }
.rv .rv-rh { align-items: flex-start; flex-direction: column; gap: 3px; border-right: 1px solid var(--line); }
.rv .rv-rh .rv-n { margin-left: 0; }
.rv .rv-rc { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 5px; padding: 6px; align-items: start; min-width: 0; }
.rv table.rv-t { font-size: 12px; max-width: 1400px; table-layout: auto; }
.rv table.rv-t td { vertical-align: middle; }
.rv table.rv-t tr[data-select] { cursor: pointer; }
.rv table.rv-t tr[data-select]:hover { background: var(--vscode-list-hoverBackground); }
.rv table.rv-t tr.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.rv table.rv-t td.r, .rv table.rv-t th.r { text-align: right; white-space: nowrap; }
.rv .rv-lane { display: inline-block; font-size: 10px; border-radius: 3px; padding: 0 5px; white-space: nowrap; background: color-mix(in srgb, var(--lc) 22%, transparent); border-left: 3px solid var(--lc); color: var(--vscode-foreground); }
.rv .rv-tt { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv .rv-brc { font-family: var(--vscode-editor-font-family); font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.rv .rv-whyc { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv .rv-tg td { font-size: 11px; font-weight: 600; padding-top: 8px; border-bottom: 1px solid var(--line); }
.rv .rv-h2 { font-size: 12px; margin: 14px 0 4px; }
.rv .rv-leg { margin-top: 8px; }
`;

const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;

/** URLs the last feed load produced: the only links the open action accepts. */
function knownUrls(): Set<string> {
  const v = feedValue<PrReport>(FEED_ID).value;
  return new Set((v?.repos ?? []).flatMap(r => r.prs.map(p => p.url)).filter((u): u is string => !!u));
}

export const reviewView: ExtraView = {
  id: 'review',
  label: 'Review',
  group: 'Git',
  hint: 'Working / Needs you / In review / Ready to merge / CI failed: sessions with their branch, push and PR / MR state (forge state opt-in).',
  ready: true,
  render,
  css: CSS,
  feeds: [prFeed as Feed],
  actions: {
    async open(arg, ctx) {
      if (!/^https:\/\//.test(arg) || !knownUrls().has(arg)) {
        ctx.info('Review: unknown link.');
        return;
      }
      await ctx.openUrl(arg);
    },
    async copy(arg, ctx) {
      if (!BRANCH.test(arg)) return;
      await ctx.copy(arg);
      ctx.info(`Review: copied ${arg}`);
    },
    refresh(_arg, ctx) {
      ctx.refreshFeeds();
    },
  },
};
