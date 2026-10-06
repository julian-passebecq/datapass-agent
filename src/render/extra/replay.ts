// Add-on screen "Replay": step through one session's recorded events with play / pause / speed while a diagram
// (session → workers → tools / commands / files / tests / git → repository) lights each node as its event plays.
// The animation is CSS only: the host keeps the transport (src/activity/replay.ts) and every render re-anchors the
// animations with negative delays, so a re-render (store refresh) continues the playback instead of restarting it.
import type { AgentSessionSnapshot, TimelineEvent } from '../../model';
import { duration } from '../../activity/activity';
import { base, identityColor, isLive } from '../../activity/insights';
import {
  Cat, CAT_LABEL, clock, countsUpTo, gapText, indexAt, pause, play, Plan, plan, position, seek, setTransport, Show, SPEEDS,
  Step, Timing, touchesRepo, transportOf, withSpeed,
} from '../../activity/replay';
import { esc } from '../html';
import { hhmm } from '../views';
import { prettyModel, repoOf, titleOf, WsData, WsState } from '../workspace';
import { actBtn, ActCtx, ExtraView, opt, seg, toolbar } from './kit';

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const ROW = 20;
const LEAD_ROWS = 4;
const VIEW_ROWS = 14;
const FLASH_S = 0.9;
const GRAPH_CATS: Cat[] = ['tools', 'cmds', 'files', 'tests', 'git'];

interface Cfg {
  chart: 'graph' | 'lanes';
  orient: 'horizontal' | 'vertical';
  timing: Timing;
  show: Show;
  workers: boolean;
  limit: number;
  follow: boolean;
  layout: 'split' | 'stacked';
}

function cfg(st: WsState): Cfg {
  const pick = <T extends string>(name: string, ok: readonly T[], fb: T): T => {
    const v = opt(st, `replay.${name}`, fb) as T;
    return ok.includes(v) ? v : fb;
  };
  return {
    chart: pick('chart', ['graph', 'lanes'] as const, 'graph'),
    orient: pick('orient', ['horizontal', 'vertical'] as const, 'horizontal'),
    timing: pick('timing', ['gaps', 'even', 'real'] as const, 'gaps'),
    show: pick('show', ['work', 'all', 'milestones'] as const, 'work'),
    workers: pick('depth', ['workers', 'lead'] as const, 'workers') === 'workers',
    limit: Number(pick('n', ['100', '300', '1000'] as const, '300')),
    follow: pick('follow', ['on', 'off'] as const, 'on') === 'on',
    layout: pick('layout', ['split', 'stacked'] as const, 'split'),
  };
}

const CAT_COLOR: Record<Cat, string> = {
  life: 'var(--quiet)', tools: 'var(--accent)', cmds: '#d39a45', files: '#4fb08a', tests: 'var(--ok)', git: '#a07ce0',
};

function stepColor(s: Step): string {
  if (s.cat === 'tests') return s.outcome === 'FAIL' ? 'var(--bad)' : s.outcome === 'PASS' ? 'var(--ok)' : 'var(--quiet)';
  return CAT_COLOR[s.cat];
}

const T_KIND: Record<string, string> = {
  OBSERVED: 'OBSERVED: recorded by the provider',
  DERIVED: 'DERIVED: computed by Agent (session start / end, commit seen in git during the session window)',
  INFERRED: 'INFERRED: heuristic',
  UNKNOWN: 'UNKNOWN',
};

/** Session to replay: the selection, else the most recently active top-level session. */
export function replayRoot(d: WsData, selected?: string): AgentSessionSnapshot | undefined {
  const sel = selected ? d.sessions.find(s => s.key === selected) : undefined;
  if (sel) return sel;
  return d.sessions.filter(s => !s.isWorker && s.lastActivityAt).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
}

function eventsFor(d: WsData, root: AgentSessionSnapshot): TimelineEvent[] {
  if (d.timeline) return d.timeline(root.key, 5000);
  const kids = new Set(d.sessions.filter(s => s.parentSessionId === root.key).map(s => s.key));
  return d.events.filter(e => e.sessionKey === root.key || kids.has(e.sessionKey));
}

const sec = (x: number) => `${(Math.round(x * 1000) / 1000).toString()}s`;

interface Anim {
  /** Real seconds per playback second (1 / speed). */
  k: number;
  pos: number;
  paused: boolean;
  /** Delay (real s) of a playback position. */
  d(p: number): string;
  /** Visibility window (real s) of step i: until the next step. */
  w(i: number): string;
}

function anim(pl: Plan, pos: number, speed: number, paused: boolean): Anim {
  const k = 1 / speed;
  return {
    k, pos, paused,
    d: p => sec((p - pos) * k),
    w: i => sec(Math.max(0.05, ((i + 1 < pl.steps.length ? pl.steps[i + 1].p : pl.total) - pl.steps[i].p) * k)),
  };
}

// ---------------------------------------------------------------- render

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const root = replayRoot(d, st.selected);
  const picker = pickerRow(d, root);
  if (!root) return `<div class="rp">${picker}<div class="empty">No session in the loaded history. Replay plays one session's recorded events.</div></div>`;
  const pl = plan(root, eventsFor(d, root), d.sessions, { timing: c.timing, show: c.show, workers: c.workers, limit: c.limit });
  if (!pl.steps.length) return `<div class="rp">${picker}${head(root, pl, d)}<div class="empty">No recorded events for this session${c.show !== 'all' ? ' with this filter (try “all events”)' : ''}.</div></div>`;
  const t = transportOf(root.key);
  const ps = position(t, pl, d.now);
  const cur = indexAt(pl.steps, ps.pos);
  const a = anim(pl, ps.pos, ps.speed, ps.paused);
  const total = pl.total * a.k;
  const vars = `--T:${sec(total)};--d0:${sec(-ps.pos * a.k)}`;

  const tb1 = transport(root, pl, cur, ps);
  const tb2 = toolbar(
    seg(st, 'replay.chart', [['graph', 'Diagram'], ['lanes', 'Lanes']], 'graph', 'Chart: node diagram that lights up, or one lane per event kind along playback time'),
    c.chart === 'graph' ? seg(st, 'replay.orient', [['horizontal', '→ Horizontal'], ['vertical', '↓ Vertical']], 'horizontal', 'Diagram orientation') : '',
    seg(st, 'replay.timing', [['gaps', 'Compressed gaps'], ['even', 'Even steps'], ['real', 'Real time']], 'gaps', 'Playback timing (DERIVED from event times). Compressed: log of the real gap. Even: same length per step. Real: 1 min recorded = 1 s at 1×, idle gaps capped at 5 s'),
    seg(st, 'replay.show', [['work', 'Work'], ['milestones', 'Milestones'], ['all', 'All events']], 'work', 'Work: everything but plain activity ticks. Milestones: files, tests, git, workers, start / end'),
    seg(st, 'replay.depth', [['workers', '+ Workers'], ['lead', 'Lead only']], 'workers', 'Include events of the workers this session spawned (recorded parent links)'),
    seg(st, 'replay.n', [['100', '100'], ['300', '300'], ['1000', '1000']], '300', 'Replay the latest n events'),
    seg(st, 'replay.follow', [['on', 'Follow'], ['off', 'Scroll']], 'on', 'Follow: the log scrolls with the playback. Scroll: browse the log yourself'),
    seg(st, 'replay.layout', [['split', 'Side by side'], ['stacked', 'Stacked']], 'split', 'Layout of diagram and log'),
  );
  const chart = c.chart === 'graph' ? graph(pl, a, cur, c, root) : lanes(pl, a, root);
  const body = `<div class="rp-main ${c.layout === 'split' ? 'rp-split' : ''}"><div class="rp-left">${now(pl, a)}${chart}${scrub(pl, a, root)}</div><div class="rp-right">${log(pl, a, cur, c, root)}</div></div>`;
  const style = c.follow ? followKeyframes(pl) : '';
  return `<div class="rp${a.paused ? ' paused' : ''}" style="${vars}">${style}${picker}${head(root, pl, d)}${tb1}${tb2}${body}${legend(pl)}</div>`;
}

function pickerRow(d: WsData, root?: AgentSessionSnapshot): string {
  const recent = d.sessions.filter(s => !s.isWorker && s.lastActivityAt).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 10);
  if (root && !recent.some(s => s.key === root.key)) recent.unshift(root);
  if (!recent.length) return '';
  return `<div class="rp-pick">${recent.map(s => `<button class="rp-pill${root?.key === s.key ? ' on' : ''}" data-select="${esc(s.key)}" style="--id:${identityColor(repoOf(s))}" title="${esc(`${PROV[s.provider]} · ${repoOf(s)} · ${hhmm(s.startedAt)}–${hhmm(s.lastActivityAt)}`)}"><span class="dot ${s.status}"></span>${esc(titleOf(s).slice(0, 34))}</button>`).join('')}</div>`;
}

function head(s: AgentSessionSnapshot, pl: Plan, d: WsData): string {
  const st = pl.steps;
  const span = st.length > 1 ? st[st.length - 1].at - st[0].at : 0;
  const workers = d.sessions.filter(k => k.parentSessionId === s.key).length;
  const who = [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
  const where = [repoOf(s), s.branch ?? s.facts?.recordedBranch, s.isLinkedWorktree ? `wt ${base(s.worktree)}` : ''].filter(Boolean).join(' · ');
  const n = countsUpTo(st, st.length - 1, pl.actors.length);
  const kv = (v: string, l: string, t: string) => `<span class="rp-kv" title="${esc(t)}"><b>${esc(v)}</b> ${esc(l)}</span>`;
  return `<div class="rp-head"><div class="rp-ttl"><span class="dot ${s.status}"></span><b>${esc(titleOf(s))}</b><span class="muted">${esc(who)}</span><span class="muted">${esc(where)}</span>${s.isWorker ? '<span class="chip">worker</span>' : ''}${isLive(s) ? '<span class="chip rp-live">live</span>' : ''}</div>
<div class="rp-kvs">${kv(`${st.length}`, `of ${pl.available} events`, 'events replayed / events recorded for this session and its workers (OBSERVED, plus DERIVED start / end / commits)')}${kv(st.length ? `${hhmm(st[0].at)}–${hhmm(st[st.length - 1].at)}` : '—', `· ${duration(span)}`, 'first → last replayed event (OBSERVED times)')}${s.facts?.activeMs !== undefined ? kv(duration(s.facts.activeMs), 'active', 'DERIVED: sum of gaps < 5 min between events') : ''}${workers ? kv(String(workers), 'workers', 'workers with this session as recorded parent (OBSERVED)') : ''}${kv(String(n.cat.files), 'file events', 'FILE_CHANGE events in the replay')}${n.pass + n.fail ? kv(`${n.pass}/${n.pass + n.fail}`, 'tests pass', 'TEST events with recorded outcome') : ''}${n.cat.git ? kv(String(n.cat.git), 'git events', 'git commit commands (OBSERVED) and commits seen in the session window (DERIVED)') : ''}${pl.skipped ? kv(String(pl.skipped), 'idle gaps capped', 'real-time playback caps gaps longer than 5 min of recorded time at 5 s') : ''}</div></div>`;
}

function transport(root: AgentSessionSnapshot, pl: Plan, cur: number, ps: { paused: boolean; speed: number; ended: boolean }): string {
  const k = root.key;
  const st = pl.steps;
  const anchor = (i: number) => `${k}|${st[i].at}|${st[i].ord}`;
  const prev = Math.max(0, cur - 1);
  const next = Math.min(st.length - 1, cur + 1);
  const btn = (name: string, arg: string, label: string, title: string, cls = 'rp-b') => actBtn(name, arg, label, title, cls);
  const main = ps.paused
    ? btn('rp-play', `${k}|${st[0].at}|${ps.ended ? 1 : 0}`, ps.ended ? '▶ Play from start' : '▶ Play', ps.ended ? 'Replay from the first event' : 'Continue playing', 'rp-b rp-main-b')
    : btn('rp-pause', k, '❚❚ Pause', 'Pause; then step with ◀ ▶', 'rp-b rp-main-b');
  const speeds = `<span class="seg" role="group" title="Playback speed">${SPEEDS.map(n => actBtn('rp-speed', `${k}|${n}`, `${n}×`, '', n === ps.speed ? 'on' : '')).join('')}</span>`;
  const pos = cur < 0 ? 'before first event' : `step ${cur + 1} / ${st.length}`;
  return toolbar(
    `<span class="rp-tr">${btn('rp-step', anchor(0), '⏮', 'First event')}${btn('rp-step', anchor(prev), '◀', 'Previous event')}${main}${btn('rp-step', anchor(next), '▶|', 'Next event')}${btn('rp-step', anchor(st.length - 1), '⏭', 'Last event (whole session lit)')}</span>`,
    speeds,
    `<span class="muted rp-pos">${ps.paused ? esc(pos) : 'playing'}</span>`,
  );
}

/** "Now" caption: one line per step, each visible only while its step is the current one. */
function now(pl: Plan, a: Anim): string {
  const first = pl.steps[0].at;
  const lines = pl.steps.map((s, i) => `<div class="rp-cap" style="--d:${a.d(s.p)};--w:${a.w(i)};--c:${stepColor(s)}"><span class="rp-ct">${esc(hhmm(s.at))} · t+${esc(clock(s.at - first))}</span><span class="rp-cb">${esc(CAT_LABEL[s.cat])}</span><b>${esc(s.label)}</b><span class="muted">${esc(pl.actors[s.actor]?.label ?? '')}</span></div>`).join('');
  return `<div class="rp-now" title="current event: time · offset from the first replayed event">${lines}</div>`;
}

// ---------------------------------------------------------------- diagram

interface Box { x: number; y: number; w: number; h: number }

function graph(pl: Plan, a: Anim, cur: number, c: Cfg, root: AgentSessionSnapshot): string {
  const A = pl.actors.length;
  const H_NODE = 34;
  const actorBox: Box[] = [];
  const catBox = new Map<Cat, Box>();
  let repo: Box;
  let W: number;
  let H: number;
  if (c.orient === 'horizontal') {
    const rows = Math.max(A, GRAPH_CATS.length);
    H = 16 + rows * 44;
    W = 760;
    const off = (n: number) => 8 + ((rows - n) * 44) / 2;
    for (let i = 0; i < A; i++) actorBox.push(i === 0 ? { x: 8, y: off(A) + i * 44, w: 190, h: H_NODE } : { x: 30, y: off(A) + i * 44, w: 168, h: H_NODE });
    GRAPH_CATS.forEach((k, i) => catBox.set(k, { x: 300, y: off(GRAPH_CATS.length) + i * 44, w: 170, h: H_NODE }));
    repo = { x: 570, y: H / 2 - 26, w: 182, h: 52 };
  } else {
    W = Math.max(760, A * 134 + 16);
    H = 290;
    const cw = (W - 16) / A;
    for (let i = 0; i < A; i++) actorBox.push({ x: 8 + i * cw + 4, y: 8, w: cw - 8, h: H_NODE });
    const gw = (W - 16) / GRAPH_CATS.length;
    GRAPH_CATS.forEach((k, i) => catBox.set(k, { x: 8 + i * gw + 6, y: 120, w: gw - 12, h: H_NODE }));
    repo = { x: W / 2 - 120, y: 226, w: 240, h: 52 };
  }
  const horiz = c.orient === 'horizontal';
  const edge = (from: Box, to: Box): string => {
    if (horiz) {
      const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x, y2 = to.y + to.h / 2, mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    const x1 = from.x + from.w / 2, y1 = from.y + from.h, x2 = to.x + to.w / 2, y2 = to.y, my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  };
  const spawnEdge = (to: Box): string => {
    const r = actorBox[0];
    if (horiz) return `M${r.x + 10},${r.y + r.h} V${to.y + to.h / 2} H${to.x}`;
    const yb = r.y + r.h + 14;
    return `M${r.x + r.w / 2},${r.y + r.h} V${yb} H${to.x + to.w / 2} V${to.y + to.h}`;
  };

  // Static structure: edges that occur at least once, first-use time for the "visited" reveal.
  const firstEdge = new Map<string, number>();
  const firstNode = new Map<string, number>();
  const mark = (m: Map<string, number>, id: string, p: number) => { if (!m.has(id)) m.set(id, p); };
  for (const s of pl.steps) {
    mark(firstNode, `a${s.actor}`, s.p);
    if (s.cat !== 'life') {
      mark(firstNode, `c${s.cat}`, s.p);
      mark(firstEdge, `a${s.actor}-${s.cat}`, s.p);
      if (touchesRepo(s.cat)) {
        mark(firstNode, 'repo', s.p);
        mark(firstEdge, `${s.cat}-repo`, s.p);
      }
    }
    if (s.spawn !== undefined) mark(firstEdge, `sp${s.spawn}`, s.p);
  }
  const so = countsUpTo(pl.steps, a.paused ? cur : pl.steps.length - 1, A);
  const tot = countsUpTo(pl.steps, pl.steps.length - 1, A);
  const cnt = (now: number, all: number) => (a.paused && now !== all ? `${now} / ${all}` : String(all));

  let edges = '';
  for (let i = 1; i < A; i++) edges += `<path class="rp-e rp-sp" d="${spawnEdge(actorBox[i])}" style="--d:${a.d(firstEdge.get(`sp${i}`) ?? firstNode.get(`a${i}`) ?? 0)}"><title>${esc(`${pl.actors[0].label} → ${pl.actors[i].label}: recorded parent link (OBSERVED)`)}</title></path>`;
  for (const [id, p] of firstEdge) {
    const m = /^a(\d+)-(\w+)$/.exec(id);
    if (m) edges += `<path class="rp-e" d="${edge(actorBox[+m[1]], catBox.get(m[2] as Cat)!)}" style="--d:${a.d(p)}"/>`;
    const r = /^(\w+)-repo$/.exec(id);
    if (r) edges += `<path class="rp-e" d="${edge(catBox.get(r[1] as Cat)!, repo)}" style="--d:${a.d(p)}"/>`;
  }
  let flashE = '';
  let flashN = '';
  const rect = (b: Box, col: string, d: string, cls = 'rp-fl') => `<rect class="${cls}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" style="--d:${d};--c:${col}"/>`;
  for (const s of pl.steps) {
    const col = stepColor(s);
    const d = a.d(s.p);
    flashN += rect(actorBox[s.actor], col, d);
    if (s.cat !== 'life') {
      const cb = catBox.get(s.cat)!;
      flashE += `<path class="rp-fe" d="${edge(actorBox[s.actor], cb)}" style="--d:${d};--c:${col}"/>`;
      flashN += rect(cb, col, d);
      if (touchesRepo(s.cat)) {
        flashE += `<path class="rp-fe" d="${edge(cb, repo)}" style="--d:${d};--c:${col}"/>`;
        flashN += rect(repo, col, d);
      }
    }
    if (s.spawn !== undefined) {
      flashE += `<path class="rp-fe" d="${spawnEdge(actorBox[s.spawn])}" style="--d:${d};--c:${col}"/>`;
      flashN += rect(actorBox[s.spawn], col, d);
    }
  }
  const node = (b: Box, id: string, col: string, tip: string) => {
    const p = firstNode.get(id);
    return `<g class="rp-node${p === undefined ? ' rp-unv' : ''}"${p === undefined ? '' : ` style="--d:${a.d(p)}"`}><rect class="rp-nb" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" style="--c:${col}"/><title>${esc(tip)}</title></g>`;
  };
  const label = (b: Box, title: string, sub: string) => {
    const max = Math.max(6, Math.floor((b.w - 14) / 6.6));
    const t = title.length > max ? `${title.slice(0, max - 1)}…` : title;
    return `<text class="rp-nt" x="${b.x + 8}" y="${b.y + (sub ? 14 : b.h / 2 + 4)}">${esc(t)}</text>${sub ? `<text class="rp-ns" x="${b.x + 8}" y="${b.y + 27}">${esc(sub)}</text>` : ''}`;
  };
  let nodes = '';
  let labels = '';
  pl.actors.forEach((ac, i) => {
    const col = i === 0 ? 'var(--accent)' : identityColor(ac.label);
    const title = i === 0 ? titleOf(root) : ac.label;
    const sub = `${cnt(so.actor[i], tot.actor[i])} events${i === 0 ? ` · ${PROV[root.provider]}` : ''}`;
    nodes += node(actorBox[i], `a${i}`, col, `${i === 0 ? 'replayed session' : 'worker (recorded parent link, OBSERVED)'}: ${title}`);
    labels += label(actorBox[i], title, sub);
  });
  for (const k of GRAPH_CATS) {
    const b = catBox.get(k)!;
    const sub = k === 'tests' && tot.pass + tot.fail ? `${cnt(so.cat.tests, tot.cat.tests)} · ${a.paused ? so.pass : tot.pass} pass · ${a.paused ? so.fail : tot.fail} fail` : cnt(so.cat[k], tot.cat[k]);
    nodes += node(b, `c${k}`, CAT_COLOR[k], `${CAT_LABEL[k]}: events of this kind (OBSERVED)`);
    labels += label(b, CAT_LABEL[k], sub);
  }
  const repoTitle = [repoOf(root), root.branch ?? root.facts?.recordedBranch].filter(Boolean).join(' · ');
  const repoSub = root.isLinkedWorktree ? `worktree ${base(root.worktree)}` : 'repository';
  nodes += node(repo, 'repo', 'var(--quiet)', `repository / worktree where files and git events land (OBSERVED cwd / git)`);
  labels += label(repo, repoTitle, repoSub);

  return `<svg class="rp-g" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" style="max-width:${W}px" role="img" aria-label="Session diagram: nodes light as events play">${edges}${flashE}${nodes}${flashN}${labels}</svg>`;
}

// ---------------------------------------------------------------- lanes

function lanes(pl: Plan, a: Anim, root: AgentSessionSnapshot): string {
  const rows = (['life', 'tools', 'cmds', 'files', 'tests', 'git'] as Cat[]).filter(k => pl.steps.some(s => s.cat === k));
  const k = root.key;
  const lane = (cat: Cat) => {
    const dots = pl.steps.filter(s => s.cat === cat).map(s => `<i class="rp-dot" data-act="rp-seek" data-arg="${esc(`${k}|${s.at}|${s.ord}`)}" style="left:${pct(s.p, pl.total)};--d:${a.d(s.p)};--c:${stepColor(s)};--a:${s.actor === 0 ? 'transparent' : identityColor(pl.actors[s.actor].label)}" title="${esc(`${hhmm(s.at)} · ${pl.actors[s.actor].label} · ${s.label}`)}"></i>`).join('');
    return `<div class="rp-ln"><span class="rp-lh" style="--c:${CAT_COLOR[cat]}">${esc(CAT_LABEL[cat])} <span class="muted">${pl.steps.filter(s => s.cat === cat).length}</span></span><div class="rp-lt">${dots}</div></div>`;
  };
  return `<div class="rp-lanes${pl.steps.length > 150 ? ' dense' : ''}"><div class="rp-lbody">${rows.map(lane).join('')}<div class="rp-ph-w"><div class="rp-ph"></div></div></div></div>`;
}

function pct(p: number, total: number): string {
  return `${((100 * p) / Math.max(1e-6, total)).toFixed(3)}%`;
}

/** Scrubber: one tick per event along playback time, clickable to seek; clock labels at a few steps. */
function scrub(pl: Plan, a: Anim, root: AgentSessionSnapshot): string {
  const k = root.key;
  const ticks = pl.steps.map(s => `<i class="rp-tk" data-act="rp-seek" data-arg="${esc(`${k}|${s.at}|${s.ord}`)}" style="left:${pct(s.p, pl.total)};--d:${a.d(s.p)};--c:${stepColor(s)}" title="${esc(`${hhmm(s.at)} ${CAT_LABEL[s.cat]}: ${s.label}`)}"></i>`).join('');
  const labels: string[] = [];
  const n = Math.min(6, pl.steps.length);
  let lastPct = -100;
  for (let j = 0; j < n; j++) {
    const s = pl.steps[Math.round((j * (pl.steps.length - 1)) / Math.max(1, n - 1))];
    const x = (100 * s.p) / pl.total;
    if (x - lastPct < 12) continue;
    lastPct = x;
    labels.push(`<span class="rp-sl" style="left:${x.toFixed(2)}%">${esc(hhmm(s.at))}</span>`);
  }
  return `<div class="rp-scrub" title="Playback position. Ticks are events (click to jump); clock labels are the recorded times"><div class="rp-bar"><i></i></div><div class="rp-tks">${ticks}<div class="rp-ph-w"><div class="rp-ph"></div></div></div><div class="rp-sls">${labels.join('')}</div></div>`;
}

// ---------------------------------------------------------------- log

function log(pl: Plan, a: Anim, cur: number, c: Cfg, root: AgentSessionSnapshot): string {
  const first = pl.steps[0].at;
  const k = root.key;
  const rows = pl.steps.map((s, i) => {
    const ac = pl.actors[s.actor];
    const chip = s.actor === 0 ? '' : `<span class="rp-ac" style="--c:${identityColor(ac.label)}" title="worker">${esc(ac.label.slice(0, 18))}</span>`;
    return `<div class="rp-r${i <= cur ? ' past' : ''}${i === cur && a.paused ? ' cur' : ''}" data-act="rp-seek" data-arg="${esc(`${k}|${s.at}|${s.ord}`)}" style="--d:${a.d(s.p)};--w:${a.w(i)}" title="${esc(`${hhmm(s.at)} · ${s.type} · ${T_KIND[s.kind] ?? s.kind} — click to jump here`)}"><span class="rp-t">${esc(clock(s.at - first))}</span><span class="rp-gap">${esc(gapText(s.gapMs))}</span><span class="rp-ty" style="--c:${stepColor(s)}">${esc(CAT_LABEL[s.cat])}</span><span class="rp-l">${chip}${esc(s.label)}</span><span class="rp-k">${esc(s.kind[0])}</span></div>`;
  }).join('');
  return `<div class="rp-log${c.follow ? ' follow' : ''}"><div class="rp-lhd"><span>t+</span><span>gap</span><span>kind</span><span>event</span><span title="evidence: O observed · D derived · I inferred">ev</span></div><div class="rp-vp"><div class="rp-list">${rows}</div></div></div>`;
}

/** Keyframes that keep the current log row in view: hold, then glide one row at each step. */
function followKeyframes(pl: Plan): string {
  const T = pl.total;
  // Keep the viewport full: never scroll past the last screenful.
  const maxTop = Math.max(0, pl.steps.length - VIEW_ROWS);
  const y = (i: number) => -Math.min(maxTop, Math.max(0, i - LEAD_ROWS)) * ROW;
  const stops: string[] = ['0%{transform:translateY(0)}'];
  let last = 0;
  for (let i = 0; i < pl.steps.length; i++) {
    const target = y(i);
    if (target === last) continue;
    const p = pl.steps[i].p;
    const glide = Math.min(0.2, (p - (pl.steps[i - 1]?.p ?? 0)) / 2);
    stops.push(`${((100 * (p - glide)) / T).toFixed(4)}%{transform:translateY(${last}px)}`);
    stops.push(`${((100 * p) / T).toFixed(4)}%{transform:translateY(${target}px)}`);
    last = target;
  }
  stops.push(`100%{transform:translateY(${last}px)}`);
  return `<style>@keyframes rp-follow{${stops.join('')}}</style>`;
}

function legend(pl: Plan): string {
  const used = new Set(pl.steps.map(s => s.cat));
  const items = (['tools', 'cmds', 'files', 'tests', 'git', 'life'] as Cat[]).filter(k => used.has(k)).map(k => `<span><i class="rp-sw" style="--c:${CAT_COLOR[k]}"></i>${esc(CAT_LABEL[k])}</span>`).join('');
  return `<div class="legend rp-leg">${items}<span><i class="rp-sw" style="--c:var(--bad)"></i>test failed</span></div><div class="foot">Events are the session's recorded timeline (OBSERVED; session start / end and commits seen in git are DERIVED). Playback time is DERIVED from the event times by the timing rule; spawn → worker links are INFERRED (nearest worker start after the spawn call), worker lanes come from recorded parent links. Nodes light while their event plays; motion is reduced when the system asks for it.</div>`;
}

const CSS = `
.rp { --row: ${ROW}px; }
.rp .rp-pick { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.rp .rp-pill { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); border-left: 3px solid var(--id); background: var(--raise); color: var(--vscode-foreground); cursor: pointer; max-width: 260px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rp .rp-pill.on { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.rp .rp-head { margin: 2px 0 6px; }
.rp .rp-ttl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
.rp .rp-live { border-color: var(--ok); color: var(--ok); }
.rp .rp-kvs { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.rp .rp-kv b { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
.rp .rp-tr { display: inline-flex; gap: 2px; }
.rp .rp-b { font: inherit; font-size: 12px; min-width: 28px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--raise); color: var(--vscode-foreground); cursor: pointer; }
.rp .rp-b:hover { background: var(--vscode-list-hoverBackground); }
.rp .rp-main-b { min-width: 110px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
.rp .rp-pos { font-variant-numeric: tabular-nums; }
.rp .rp-main { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
.rp .rp-main.rp-split { grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr); }
@media (max-width: 1100px) { .rp .rp-main.rp-split { grid-template-columns: minmax(0, 1fr); } }
.rp .rp-left, .rp .rp-right { min-width: 0; }
.rp .rp-now { position: relative; height: 40px; border: 1px solid var(--line); border-radius: 5px; background: var(--raise); margin-bottom: 6px; overflow: hidden; }
.rp .rp-cap { position: absolute; inset: 0; padding: 3px 8px; display: grid; grid-template-columns: auto auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; font-size: 12px; border-left: 3px solid var(--c, var(--line)); visibility: hidden; animation: rp-vis var(--w) linear var(--d) 1 none; }
.rp .rp-cap b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.rp .rp-cap .muted { grid-column: 1 / 4; font-size: 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rp .rp-cap:last-child { animation-fill-mode: forwards; }
.rp .rp-ct { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: 11px; }
.rp .rp-cb { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--c) 25%, transparent); border: 1px solid color-mix(in srgb, var(--c) 60%, transparent); }
.rp svg.rp-g { width: 100%; height: auto; display: block; }
.rp .rp-e { fill: none; stroke: var(--line); stroke-width: 1.5; opacity: .3; animation: rp-rv .25s linear var(--d) both; }
.rp .rp-sp { stroke-dasharray: 3 3; }
.rp .rp-fe { fill: none; stroke: var(--c); stroke-width: 3; stroke-linecap: round; opacity: 0; animation: rp-fl ${FLASH_S}s ease-out var(--d) both; }
.rp .rp-nb { fill: var(--vscode-editor-background, #1f1f1f); stroke: var(--c); stroke-width: 1.5; }
.rp .rp-node { opacity: .38; animation: rp-rv .25s linear var(--d) both; }
.rp .rp-node.rp-unv { animation: none; opacity: .3; }
.rp .rp-fl { fill: var(--c); opacity: 0; animation: rp-fl ${FLASH_S}s ease-out var(--d) both; }
.rp .rp-nt { fill: var(--vscode-foreground); font-size: 12px; font-weight: 600; pointer-events: none; }
.rp .rp-ns { fill: var(--vscode-descriptionForeground); font-size: 10px; font-variant-numeric: tabular-nums; pointer-events: none; }
.rp .rp-lanes { border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; }
.rp .rp-lbody { position: relative; overflow: clip; overflow-clip-margin: 4px; }
.rp .rp-ln { display: grid; grid-template-columns: 112px minmax(0, 1fr); align-items: center; height: 26px; }
.rp .rp-lh { font-size: 11px; border-left: 3px solid var(--c); padding-left: 6px; white-space: nowrap; }
.rp .rp-lt { position: relative; height: 18px; border-bottom: 1px dashed var(--line); }
.rp .rp-dot { position: absolute; top: 4px; width: 9px; height: 9px; margin-left: -4px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 2px var(--a); opacity: .22; cursor: pointer; animation: rp-pop .6s ease-out var(--d) both; }
.rp .rp-lanes.dense .rp-dot { width: 6px; height: 6px; top: 6px; margin-left: -3px; box-shadow: 0 0 0 1px var(--a); }
.rp .rp-lbody > .rp-ph-w { left: 112px; }
.rp .rp-ph-w { position: absolute; top: 0; bottom: 0; left: 0; right: 0; pointer-events: none; animation: rp-move var(--T) linear var(--d0) both; }
.rp .rp-ph { position: absolute; top: -2px; bottom: -2px; left: -1px; width: 2px; background: var(--bad); }
.rp .rp-scrub { margin-top: 8px; }
.rp .rp-bar { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; }
.rp .rp-bar i { display: block; height: 100%; background: var(--accent); transform-origin: left; animation: rp-grow var(--T) linear var(--d0) both; }
.rp .rp-tks { position: relative; height: 16px; margin-top: 2px; overflow: clip; overflow-clip-margin: 4px; }
.rp .rp-tk { position: absolute; top: 2px; width: 3px; height: 12px; margin-left: -1px; background: var(--c); opacity: .25; cursor: pointer; animation: rp-rv .2s linear var(--d) both; }
.rp .rp-tk:hover { outline: 1px solid var(--vscode-focusBorder); }
.rp .rp-sls { position: relative; height: 14px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.rp .rp-sl { position: absolute; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
.rp .rp-sl:first-child { transform: none; }
.rp .rp-log { border: 1px solid var(--line); border-radius: 5px; font-size: 12px; }
.rp .rp-lhd, .rp .rp-r { display: grid; grid-template-columns: 54px 36px 80px minmax(0, 1fr) 16px; gap: 6px; align-items: center; padding: 0 6px; }
.rp .rp-lhd { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); height: 20px; }
.rp .rp-vp { max-height: calc(var(--row) * ${VIEW_ROWS * 2}); overflow-y: auto; }
.rp .rp-log.follow .rp-vp { height: calc(var(--row) * ${VIEW_ROWS}); overflow: hidden; }
.rp .rp-log.follow .rp-list { animation: rp-follow var(--T) linear var(--d0) both; }
.rp .rp-r { height: var(--row); cursor: pointer; opacity: .35; white-space: nowrap; animation: rp-rv .2s linear var(--d) both, rp-cur var(--w) linear var(--d) 1 none; }
.rp .rp-r.cur { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
.rp .rp-r:hover { background: var(--vscode-list-hoverBackground); }
.rp .rp-t, .rp .rp-gap { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: 11px; text-align: right; }
.rp .rp-ty { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; border-left: 3px solid var(--c); padding-left: 4px; overflow: hidden; text-overflow: ellipsis; }
.rp .rp-l { overflow: hidden; text-overflow: ellipsis; }
.rp .rp-k { font-size: 9px; color: var(--vscode-descriptionForeground); text-align: center; }
.rp .rp-ac { display: inline-block; font-size: 10px; padding: 0 4px; margin-right: 4px; border-radius: 3px; border: 1px solid var(--c); color: var(--vscode-foreground); }
.rp .rp-leg .rp-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: var(--c); margin-right: 4px; vertical-align: -1px; }
.rp .rp-leg > span { margin-right: 8px; }
.rp.paused *, .rp.paused { animation-play-state: paused !important; }
@keyframes rp-rv { from { opacity: var(--dim, .35); } to { opacity: 1; } }
@keyframes rp-fl { 0% { opacity: 0; } 12% { opacity: .55; } 100% { opacity: 0; } }
@keyframes rp-pop { 0% { opacity: .22; transform: scale(1); } 15% { opacity: 1; transform: scale(1.8); } 100% { opacity: 1; transform: scale(1); } }
@keyframes rp-cur { from, to { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 2px 0 0 var(--accent); opacity: 1; } }
@keyframes rp-vis { from, to { visibility: visible; } }
@keyframes rp-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes rp-move { from { transform: translateX(0); } to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .rp .rp-fl, .rp .rp-fe { animation: none; opacity: 0; }
  .rp .rp-dot { animation-name: rp-rv; }
  .rp .rp-log.follow .rp-list { animation-timing-function: steps(1, end); }
}
`;

// ---------------------------------------------------------------- actions

const KEY_RE = /^(claude|codex):[A-Za-z0-9._-]{1,120}$/;

function known(key: string, ctx: ActCtx): boolean {
  return KEY_RE.test(key) && ctx.sessions().some(s => s.key === key);
}

function parse(arg: string, ctx: ActCtx, nums: number): { key: string; n: number[] } | undefined {
  const parts = arg.split('|');
  const key = parts[0] ?? '';
  if (parts.length !== nums + 1 || !known(key, ctx)) return undefined;
  const n = parts.slice(1).map(Number);
  if (n.some(x => !Number.isFinite(x) || x < 0 || x > 1e14)) return undefined;
  return { key, n };
}

export const replayView: ExtraView = {
  id: 'replay',
  label: 'Replay',
  group: 'Time',
  hint: "Step through one session's recorded events: play / pause / speed, the diagram lights each node as its event plays.",
  ready: true,
  render,
  css: CSS,
  actions: {
    'rp-play'(arg, ctx) {
      const p = parse(arg, ctx, 2);
      if (!p) return;
      const [firstAt, ended] = p.n;
      setTransport(p.key, play(transportOf(p.key), firstAt, Date.now(), undefined, ended === 1));
    },
    'rp-pause'(arg, ctx) {
      if (!known(arg, ctx)) return;
      const t = pause(transportOf(arg), Date.now());
      if (t) setTransport(arg, t);
    },
    'rp-seek'(arg, ctx) {
      const p = parse(arg, ctx, 2);
      if (!p || !Number.isInteger(p.n[1])) return;
      setTransport(p.key, seek(transportOf(p.key), p.n[0], p.n[1], Date.now(), true));
    },
    'rp-step'(arg, ctx) {
      const p = parse(arg, ctx, 2);
      if (!p || !Number.isInteger(p.n[1])) return;
      setTransport(p.key, seek(transportOf(p.key), p.n[0], p.n[1], Date.now(), false));
    },
    'rp-speed'(arg, ctx) {
      const p = parse(arg, ctx, 1);
      if (!p || !SPEEDS.includes(p.n[0])) return;
      const t = transportOf(p.key);
      // Without a transport the replay sits at its end; keep it there at the new speed.
      setTransport(p.key, withSpeed(t, p.n[0], Date.now(), Number.MAX_SAFE_INTEGER));
    },
  },
};

/** Test hook: the step a session's replay currently shows. */
export function replayCursor(d: WsData, st: WsState): { key: string; index: number; paused: boolean } | undefined {
  const root = replayRoot(d, st.selected);
  if (!root) return undefined;
  const c = cfg(st);
  const pl = plan(root, eventsFor(d, root), d.sessions, { timing: c.timing, show: c.show, workers: c.workers, limit: c.limit });
  const ps = position(transportOf(root.key), pl, d.now);
  return { key: root.key, index: indexAt(pl.steps, ps.pos), paused: ps.paused };
}

