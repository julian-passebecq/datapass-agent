// Add-on screen "Signals": failure signals with an observed basis (src/activity/signals.ts).
// Table / matrix / stacked-bar views, grouped by repo, provider, day or session. Pure rendering; all text escaped.
import type { AgentSessionSnapshot, EvidenceKind } from '../../model';
import { allSignals, Signal, SignalKind, SIGNAL_KINDS, SIGNAL_META, signals } from '../../activity/signals';
import { base, dayStart, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const DAY = 86400_000;
const MAX_ROWS = 300;

const KIND_COLOR: Record<SignalKind, string> = {
  unsolved: 'var(--warn)',
  blocked: 'var(--bad)',
  permissions: 'var(--vscode-charts-purple, #b180d7)',
  swallowed: 'var(--vscode-charts-yellow, #cca700)',
  looping: 'var(--accent)',
};

const EVIDENCE_HINT: Record<EvidenceKind, string> = {
  OBSERVED: 'OBSERVED: read from a provider record (exit code, tool error flag, status, API error record).',
  DERIVED: 'DERIVED: computed from observed records (command repeats, missing re-run, edits vs commits).',
  INFERRED: 'INFERRED: the session end is assumed from inactivity (no end event exposed).',
  UNKNOWN: 'UNKNOWN: not exposed.',
};

const PERIOD: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, all: Infinity };
const PROV: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

// Same as workspace.ts repoOf / titleOf; kept local so this module has no runtime import cycle with the registry.
const repoOf = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';
const titleOf = (s: AgentSessionSnapshot) => s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8);
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

interface Row {
  sig: Signal;
  s: AgentSessionSnapshot;
}

function when(t: number, now: number): string {
  if (t >= dayStart(now)) return hhmm(t);
  return `${new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} ${hhmm(t)}`;
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(t: number, now: number): string {
  if (t >= dayStart(now)) return 'Today';
  if (t >= dayStart(now) - DAY) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Rows for the current options, newest first. */
function collect(d: WsData, st: WsState): { rows: Row[]; all: Row[] } {
  const loopMin = Number(opt(st, 'signals.loop', '4')) || 4;
  const since = d.now - (PERIOD[opt(st, 'signals.period', '7d')] ?? 7 * DAY);
  const workers = opt(st, 'signals.workers', 'all') === 'all';
  const sessions = d.sessions.filter(s => (workers || !s.isWorker) && (s.lastActivityAt ?? s.startedAt ?? 0) >= since);
  const events = d.timeline ? d.timeline(undefined, 200_000) : d.events;
  const by = new Map(sessions.map(s => [s.key, s]));
  const all = allSignals(sessions, events, { now: d.now, loopMin })
    .filter(x => x.at >= since)
    .map(sig => ({ sig, s: by.get(sig.key)! }));
  const kind = opt(st, 'signals.kind', 'all');
  return { rows: kind === 'all' ? all : all.filter(r => r.sig.kind === kind), all };
}

type Group = { id: string; label: string; color?: string; select?: string; rows: Row[] };

function groups(rows: Row[], by: string, now: number): Group[] {
  if (by === 'none') return [{ id: 'all', label: 'All signals', rows }];
  const m = new Map<string, Group>();
  for (const r of rows) {
    let id: string, label: string, color: string | undefined, select: string | undefined;
    if (by === 'provider') [id, label] = [r.s.provider, PROV[r.s.provider] ?? r.s.provider];
    else if (by === 'day') [id, label] = [dayKey(r.sig.at), dayLabel(r.sig.at, now)];
    else if (by === 'session') [id, label, select] = [r.s.key, titleOf(r.s), r.s.key];
    else [id, label, color] = [repoOf(r.s), repoOf(r.s), identityColor(repoOf(r.s))];
    const g = m.get(id) ?? { id, label, color, select, rows: [] };
    g.rows.push(r);
    m.set(id, g);
  }
  const list = [...m.values()];
  return by === 'day' ? list.sort((a, b) => (a.id < b.id ? 1 : -1)) : list.sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}

const count = (rows: Row[], k: SignalKind) => rows.filter(r => r.sig.kind === k).length;

function badge(k: SignalKind): string {
  return `<span class="sg-b" style="--k:${KIND_COLOR[k]}" title="${esc(SIGNAL_META[k].rule)}">${esc(SIGNAL_META[k].label)}</span>`;
}

function kpis(all: Row[], st: WsState): string {
  const cur = opt(st, 'signals.kind', 'all');
  const btn = (val: string, n: number, label: string, color: string, title: string) =>
    `<button class="sg-k${cur === val ? ' on' : ''}" style="--k:${color}" data-opt="signals.kind" data-val="${esc(val)}" title="${esc(title)}"><b>${n}</b><span>${esc(label)}</span></button>`;
  return `<div class="sg-ks">${btn('all', all.length, 'All signals', 'var(--vscode-foreground)', 'Every signal in the period. Click a kind to filter.')}${SIGNAL_KINDS.map(k => btn(k, count(all, k), SIGNAL_META[k].label, KIND_COLOR[k], SIGNAL_META[k].rule)).join('')}</div>`;
}

function tableRows(rows: Row[], d: WsData, st: WsState): string {
  return rows
    .map(({ sig, s }) => {
      const times = sig.times.map(t => `<span class="sg-t">${esc(when(t, d.now))}</span>`).join('');
      return `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}"><td class="sg-when">${esc(when(sig.at, d.now))}</td><td>${badge(sig.kind)}</td><td class="sg-sess"><span class="dot ${s.status}"></span>${esc(titleOf(s).slice(0, 48))}${s.isWorker ? '<span class="chip">worker</span>' : ''}</td><td class="sg-repo"><span class="sw" style="--id:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td class="sg-prov ${s.provider}">${esc(PROV[s.provider] ?? s.provider)}</td><td class="sg-why"><div>${esc(sig.reason)}</div><div class="basis">${esc(sig.basis)}</div></td><td class="sg-ts">${times}</td><td><span class="sg-ev ${sig.evidence}" title="${esc(EVIDENCE_HINT[sig.evidence])}">${esc(sig.evidence.toLowerCase())}</span></td></tr>`;
    })
    .join('');
}

function table(gs: Group[], d: WsData, st: WsState, grouped: boolean): string {
  const head = `<tr><th>When</th><th>Signal</th><th>Session</th><th>Repo</th><th>Provider</th><th>What · basis</th><th>Event times</th><th>Evidence</th></tr>`;
  let shown = 0;
  let h = `<table class="sg-tab">${head}`;
  for (const g of gs) {
    if (shown >= MAX_ROWS) break;
    const rows = g.rows.slice(0, MAX_ROWS - shown);
    shown += rows.length;
    if (grouped) {
      const mini = SIGNAL_KINDS.filter(k => count(g.rows, k)).map(k => `<span class="sg-mini" style="--k:${KIND_COLOR[k]}" title="${esc(SIGNAL_META[k].label)}">${count(g.rows, k)} ${esc(SIGNAL_META[k].label.toLowerCase())}</span>`).join('');
      h += `<tr class="sg-gh"><td colspan="8">${g.color ? `<span class="sw" style="--id:${g.color}"></span>` : ''}<b>${esc(g.label)}</b> <span class="muted">${g.rows.length}</span> ${mini}</td></tr>`;
    }
    h += tableRows(rows, d, st);
  }
  const total = gs.reduce((n, g) => n + g.rows.length, 0);
  return h + `</table>${total > shown ? `<div class="muted">… ${total - shown} more signals; narrow the period or the kind.</div>` : ''}`;
}

function matrix(gs: Group[]): string {
  const max = Math.max(1, ...gs.flatMap(g => SIGNAL_KINDS.map(k => count(g.rows, k))));
  let h = `<table class="sg-mx"><tr><th></th>${SIGNAL_KINDS.map(k => `<th>${badge(k)}</th>`).join('')}<th>Total</th></tr>`;
  for (const g of gs.slice(0, 80)) {
    const cells = SIGNAL_KINDS.map(k => {
      const n = count(g.rows, k);
      const pct = n ? Math.round(15 + (60 * n) / max) : 0;
      return `<td class="num" style="--k:${KIND_COLOR[k]};--p:${pct}%" title="${esc(`${g.label}: ${n} ${SIGNAL_META[k].label.toLowerCase()}`)}">${n || '<span class="muted">·</span>'}</td>`;
    }).join('');
    h += `<tr${g.select ? ` data-select="${esc(g.select)}"` : ''}><td class="sg-gl">${g.color ? `<span class="sw" style="--id:${g.color}"></span>` : ''}${esc(g.label.slice(0, 48))}</td>${cells}<td class="num"><b>${g.rows.length}</b></td></tr>`;
  }
  return h + `</table>${gs.length > 80 ? `<div class="muted">… ${gs.length - 80} more groups</div>` : ''}`;
}

function chart(gs: Group[], vertical: boolean): string {
  const max = Math.max(1, ...gs.map(g => g.rows.length));
  const list = gs.slice(0, vertical ? 40 : 60);
  const segs = (g: Group) =>
    SIGNAL_KINDS.map(k => {
      const n = count(g.rows, k);
      return n ? `<i style="--k:${KIND_COLOR[k]};${vertical ? 'height' : 'width'}:${(100 * n) / max}%" title="${esc(`${g.label} · ${SIGNAL_META[k].label}: ${n}`)}"></i>` : '';
    }).join('');
  const attrs = (g: Group) => (g.select ? ` data-select="${esc(g.select)}"` : '');
  const legend = `<div class="legend">${SIGNAL_KINDS.map(k => `<span class="sg-mini" style="--k:${KIND_COLOR[k]}">${esc(SIGNAL_META[k].label)}</span>`).join(' ')} · bar length = signal count</div>`;
  if (vertical)
    return `<div class="sg-vc">${list.map(g => `<div class="sg-col"${attrs(g)} title="${esc(`${g.label}: ${g.rows.length}`)}"><span class="num">${g.rows.length}</span><div class="sg-stack">${segs(g)}</div><span class="sg-cl">${esc(g.label.slice(0, 14))}</span></div>`).join('')}</div>${legend}`;
  return `<div class="sg-hc">${list.map(g => `<div class="sg-hr"${attrs(g)}><span class="sg-gl">${g.color ? `<span class="sw" style="--id:${g.color}"></span>` : ''}${esc(g.label.slice(0, 40))}</span><div class="sg-bar">${segs(g)}</div><span class="num">${g.rows.length}</span></div>`).join('')}</div>${legend}`;
}

function render(d: WsData, st: WsState): string {
  const view = opt(st, 'signals.view', 'table');
  const group = opt(st, 'signals.group', view === 'table' ? 'none' : 'repo');
  const tb = toolbar(
    seg(st, 'signals.period', [['24h', '24 h'], ['7d', '7 days'], ['all', 'All loaded']], '7d', 'Period (signal time)'),
    seg(st, 'signals.view', [['table', 'Table'], ['matrix', 'Matrix'], ['chart', 'Bars']], 'table', 'View'),
    seg(st, 'signals.group', [['none', 'No group'], ['repo', 'Repo'], ['provider', 'Provider'], ['day', 'Day'], ['session', 'Session']], view === 'table' ? 'none' : 'repo', 'Group by'),
    view === 'chart' ? seg(st, 'signals.orient', [['h', 'Horizontal'], ['v', 'Vertical']], group === 'day' ? 'v' : 'h', 'Bar orientation') : '',
    seg(st, 'signals.workers', [['all', 'Sessions + workers'], ['top', 'Sessions only']], 'all', 'Include worker sessions'),
    seg(st, 'signals.loop', [['3', 'Loop ≥ 3'], ['4', '≥ 4'], ['6', '≥ 6']], '4', 'Looping threshold: same command this many times without a file change'),
  );
  const { rows, all } = collect(d, st);
  let h = `<div class="sg">${tb}${kpis(all, st)}`;
  if (!rows.length) {
    h += `<div class="empty">No ${opt(st, 'signals.kind', 'all') === 'all' ? '' : esc(SIGNAL_META[opt(st, 'signals.kind', 'all') as SignalKind]?.label.toLowerCase() ?? '') + ' '}signal in this period.</div>`;
  } else {
    const gs = groups(rows, view !== 'table' && group === 'none' ? 'repo' : group, d.now);
    h += view === 'matrix' ? matrix(gs) : view === 'chart' ? chart(gs, opt(st, 'signals.orient', group === 'day' ? 'v' : 'h') === 'v') : table(gs, d, st, group !== 'none');
  }
  h += `<details class="sg-rules"><summary>How signals are derived</summary><ul>${SIGNAL_KINDS.map(k => `<li>${badge(k)} ${esc(SIGNAL_META[k].rule)}</li>`).join('')}<li>${(['OBSERVED', 'DERIVED', 'INFERRED'] as EvidenceKind[]).map(k => `<span class="sg-ev ${k}">${k.toLowerCase()}</span> ${esc(EVIDENCE_HINT[k].replace(/^\w+: /, ''))}`).join('<br>')}</li><li class="muted">Not covered: invented, unhappy, unsafe (they would need a judgement of the text). Agent never reads message text to raise a signal.</li></ul></details>`;
  return h + '</div>';
}

/** Rail badge: signals of the last 24 h on live sessions (what can still be acted on). */
function badgeCount(d: WsData): string {
  const since = d.now - DAY;
  let n = 0;
  for (const s of d.sessions) {
    if (!isLive(s) || (s.lastActivityAt ?? 0) < since) continue;
    const ev = d.timeline ? d.timeline(s.key, 400) : d.events;
    n += signals(s, ev, { now: d.now }).filter(x => x.at >= since).length;
  }
  return n ? String(n) : '';
}

const CSS = `
.sg-ks { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 10px; }
.sg-k { display: flex; flex-direction: column; align-items: flex-start; min-width: 78px; padding: 4px 10px; border: 1px solid var(--line); border-top: 3px solid var(--k); border-radius: 5px; background: var(--raise); color: var(--vscode-foreground); font: inherit; cursor: pointer; text-align: left; }
.sg-k b { font-size: 18px; font-variant-numeric: tabular-nums; line-height: 1.2; }
.sg-k span { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.sg-k.on { outline: 1px solid var(--vscode-focusBorder); background: color-mix(in srgb, var(--k) 14%, var(--raise)); }
.sg-b { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--k) 70%, transparent); background: color-mix(in srgb, var(--k) 18%, transparent); color: var(--vscode-foreground); white-space: nowrap; }
.sg-mini { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
.sg-mini::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--k); }
.sg-tab, .sg-mx { border-collapse: collapse; width: 100%; font-size: 12px; }
.sg-tab th, .sg-mx th { text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); padding: 3px 6px; border-bottom: 1px solid var(--line); }
.sg-tab td, .sg-mx td { padding: 3px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); vertical-align: top; }
.sg-tab tr[data-select], .sg-mx tr[data-select], .sg-hr[data-select], .sg-col[data-select] { cursor: pointer; }
.sg-tab tr[data-select]:hover, .sg-mx tr:hover { background: var(--vscode-list-hoverBackground); }
.sg-tab .sg-gh td { padding-top: 10px; border-bottom: 1px solid var(--line); background: none; }
.sg-when, .sg-repo, .sg-prov { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sg-sess { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-prov.claude { color: var(--claude); } .sg-prov.codex { color: var(--codex); }
.sg-why { min-width: 240px; overflow-wrap: anywhere; }
.sg-ts { max-width: 220px; }
.sg-t { display: inline-block; font-size: 10px; font-variant-numeric: tabular-nums; padding: 0 4px; margin: 0 3px 2px 0; border: 1px solid var(--line); border-radius: 3px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.sg-ev { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); white-space: nowrap; }
.sg-ev.OBSERVED { border-color: var(--ok); } .sg-ev.DERIVED { border-color: var(--accent); } .sg-ev.INFERRED { border-style: dashed; border-color: var(--warn); }
.sg-mx td.num { text-align: center; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--k, transparent) var(--p, 0%), transparent); }
.sg-mx th:not(:first-child) { text-align: center; }
.sg-gl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-hc { display: grid; gap: 3px; margin: 4px 0; }
.sg-hr { display: grid; grid-template-columns: minmax(120px, 220px) 1fr 40px; gap: 8px; align-items: center; font-size: 12px; }
.sg-hr:hover { background: var(--vscode-list-hoverBackground); }
.sg-bar { display: flex; height: 12px; background: color-mix(in srgb, var(--line) 35%, transparent); border-radius: 2px; overflow: hidden; }
.sg-bar i, .sg-stack i { display: block; background: var(--k); }
.sg-bar i + i { border-left: 1px solid var(--vscode-editor-background); }
.sg-hr .num, .sg-col .num { font-variant-numeric: tabular-nums; font-size: 11px; }
.sg-vc { display: flex; align-items: flex-end; gap: 6px; height: 220px; padding: 4px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.sg-col { display: flex; flex-direction: column; align-items: center; gap: 2px; height: 100%; min-width: 34px; flex: 1 0 34px; max-width: 70px; }
.sg-stack { flex: 1; width: 70%; display: flex; flex-direction: column-reverse; justify-content: flex-start; }
.sg-stack i + i { border-bottom: 1px solid var(--vscode-editor-background); }
.sg-cl { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.sg-rules { margin-top: 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.sg-rules summary { cursor: pointer; }
.sg-rules ul { margin: 6px 0; padding-left: 16px; } .sg-rules li { margin: 3px 0; }
`;

export const signalsView: ExtraView = {
  id: 'signals',
  label: 'Signals',
  group: 'Verify',
  hint: 'Failure signals with an observed basis: unsolved, blocked, permissions, swallowed, looping.',
  ready: true,
  render,
  css: CSS,
  badge: badgeCount,
};
