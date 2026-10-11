// Add-on screen "Transcript": read one session (Claude transcript, Codex rollout, worker transcript) as a
// conversation. Reading lives in src/providers/transcript.ts (tail-read, incremental, redacted); view logic in
// src/activity/transcript.ts. This file only renders (escaped) and wires the actions.
import * as path from 'path';
import type { AgentSessionSnapshot } from '../../model';
import { counts, isError, Mode, Only, pageOf, strip, toolNames, toolSlug, ViewOpts, visible, workerLinks } from '../../activity/transcript';
import { compact, identityColor, isLive } from '../../activity/insights';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, Entry, readTranscript, Transcript } from '../../providers/transcript';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ago, bytes, prettyModel, repoOf, titleOf } from '../workspace';
import type { Feed, FeedCtx } from './feeds';
import { redact } from '../../util/redact';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';
import { modeHtml } from './live';

interface Settings {
  maxBytes: number;
  maxEntries: number;
  pageSize: number;
}

/** Settings land through the feed (the only place with config access); defaults until then. */
let SETTINGS: Settings = { maxBytes: DEFAULT_MAX_BYTES, maxEntries: DEFAULT_MAX_ENTRIES, pageSize: 150 };

function num(ctx: FeedCtx, name: string, def: number, lo: number, hi: number): number {
  // The panel reads keys relative to the "agent" section; accept the full key too in case that changes.
  const v = ctx.config<number>(`agent.transcript.${name}`, ctx.config<number>(`transcript.${name}`, def));
  return typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
}

const settingsFeed: Feed<Settings> = {
  id: 'transcript.settings',
  intervalMs: 30_000,
  async load(ctx) {
    SETTINGS = {
      maxBytes: num(ctx, 'maxBytes', DEFAULT_MAX_BYTES, 256 * 1024, 64 * 1024 * 1024),
      maxEntries: num(ctx, 'maxRecords', DEFAULT_MAX_ENTRIES, 100, 20_000),
      pageSize: num(ctx, 'pageSize', 150, 20, 1000),
    };
    return SETTINGS;
  },
};

/** Test hook. */
export function setTranscriptSettings(s: Partial<Settings>): void {
  SETTINGS = { ...SETTINGS, ...s };
}

interface Cfg extends ViewOpts {
  order: 'old' | 'new';
  results: 'hide' | 'short' | 'full';
  anchor?: number;
  open: string;
}

function cfg(st: WsState): Cfg {
  const mode = opt(st, 'transcript.mode', 'chat');
  const only = opt(st, 'transcript.only', 'all');
  const at = opt(st, 'transcript.at', '');
  const res = opt(st, 'transcript.results', 'short');
  return {
    mode: (['chat', 'log', 'tools'].includes(mode) ? mode : 'chat') as Mode,
    only: (['all', 'talk', 'errors', 'spawns', 'prompts'].includes(only) ? only : 'all') as Only,
    tool: opt(st, 'transcript.tool', ''),
    thinking: opt(st, 'transcript.thinking', 'show') === 'show',
    meta: opt(st, 'transcript.meta', 'hide') === 'show',
    order: opt(st, 'transcript.order', 'old') === 'new' ? 'new' : 'old',
    results: (['hide', 'short', 'full'].includes(res) ? res : 'short') as Cfg['results'],
    anchor: /^\d{10,15}$/.test(at) ? Number(at) : undefined,
    open: opt(st, 'transcript.open', ''),
  };
}

// ---------------------------------------------------------------- small formatters

const pad = (n: number) => String(n).padStart(2, '0');
const hms = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const stamp = (t: number) => new Date(t).toLocaleString();
const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
function dur(ms: number | undefined): string {
  if (ms === undefined || ms < 0 || !isFinite(ms)) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
  return `${Math.floor(ms / 3600_000)} h ${Math.round((ms % 3600_000) / 60_000)} m`;
}
const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

function openAttr(c: Cfg, e: Entry): string {
  const id = `e${e.id}`;
  return ` data-opt="transcript.open" data-val="${c.open === id ? '' : id}"`;
}

const ICON: Record<string, string> = { prompt: '›', reply: '◆', thinking: '…', tool: '⚙', spawn: '⑂', error: '!', compact: '⇕', command: '/', meta: '·', turn: '—' };

// ---------------------------------------------------------------- pieces

function resultBlock(c: Cfg, e: Entry, force = false): string {
  const r = e.result;
  if (!r) return '';
  const open = force || c.open === `e${e.id}` || c.results === 'full';
  if (!open && c.results === 'hide') return '';
  if (!r.text) return '';
  if (open) return `<pre class="tx-res${r.error ? ' err' : ''}">${esc(r.text)}${r.chars > r.text.length ? `\n<span class="muted">… preview capped at 2 KB of ${esc(compact(r.chars))} chars</span>` : ''}</pre>`;
  const lines = r.text.split('\n');
  const short = lines.slice(0, 3).join('\n').slice(0, 280);
  const more = short.length < r.text.length;
  return `<pre class="tx-res short${r.error ? ' err' : ''}">${esc(short)}${more ? `<button class="link tx-more"${openAttr(c, e)}> … more (${esc(compact(r.chars))} chars)</button>` : ''}</pre>`;
}

function statusChip(e: Entry): string {
  const r = e.result;
  if (e.kind === 'error') return `<span class="tx-st bad" title="OBSERVED: error recorded by the provider">error</span>`;
  if (!r) return e.kind === 'tool' || e.kind === 'spawn' ? `<span class="tx-st run" title="OBSERVED: no result recorded yet (still running, interrupted, or result outside the loaded window)">no result</span>` : '';
  const d = r.durationMs ?? (r.at > e.at ? r.at - e.at : undefined);
  const code = r.exitCode !== undefined ? ` · exit ${r.exitCode}` : '';
  return `<span class="tx-st ${r.error ? 'bad' : 'ok'}" title="${esc(`OBSERVED: ${r.error ? 'result flagged as error' : 'result recorded'}${code}${d !== undefined ? ` · DERIVED duration ${dur(d)}` : ''}`)}">${r.error ? 'error' : 'ok'}${esc(code)}${d !== undefined ? ` · ${esc(dur(d))}` : ''}</span>`;
}

function spawnLink(e: Entry, links: Map<number, { key: string; kind: string; basis: string }>, byKey: Map<string, AgentSessionSnapshot>): string {
  const l = links.get(e.id);
  if (!l) return `<span class="muted" title="UNKNOWN: no worker session matched this spawn">worker not linked</span>`;
  const w = byKey.get(l.key);
  return `<button class="link tx-wk" data-select="${esc(l.key)}" title="${esc(`${l.kind}: ${l.basis}. Click to read the worker's transcript.`)}"><span class="dot ${esc(w?.status ?? 'UNKNOWN')}"></span> ${esc(w ? titleOf(w).slice(0, 48) : l.key.slice(0, 20))} →</button>`;
}

function longText(c: Cfg, e: Entry, max = 1600): string {
  const t = e.text;
  if (t.length <= max || c.open === `e${e.id}`) return `<div class="tx-tx">${esc(t)}</div>${t.length > max ? `<button class="link tx-more"${openAttr(c, e)}>show less</button>` : ''}`;
  return `<div class="tx-tx">${esc(t.slice(0, max))}…</div><button class="link tx-more"${openAttr(c, e)}>show all (${esc(compact(t.length))} chars)</button>`;
}

interface Ctx {
  c: Cfg;
  s: AgentSessionSnapshot;
  key: string;
  links: Map<number, { key: string; kind: string; basis: string }>;
  byKey: Map<string, AgentSessionSnapshot>;
}

function toolRow(x: Ctx, e: Entry): string {
  const cls = `tx-tl${e.sub ? ' sub' : ''}${isError(e) ? ' err' : ''}${e.kind === 'spawn' ? ' spawn' : ''}`;
  const name = e.kind === 'spawn' ? `${e.name} · ${e.spawn?.type ?? ''}` : e.name ?? 'tool';
  return `<div class="${cls}" data-select="${esc(x.key)}"><div class="tx-tlh"><span class="tx-ic">${e.sub ? '↳' : ICON[e.kind]}</span><b class="tx-tn"${e.result?.text ? openAttr(x.c, e) : ''} title="${esc(e.result?.text ? 'Click to expand / collapse the result' : name)}">${esc(name)}</b><code class="tx-in" title="${esc(e.text)}">${esc(e.text || '—')}</code>${statusChip(e)}<span class="tx-t" title="${esc(stamp(e.at))}">${hms(e.at)}</span></div>${e.kind === 'spawn' ? `<div class="tx-sp">${e.spawn?.description ? `<span>${esc(e.spawn.description)}</span>` : ''}${spawnLink(e, x.links, x.byKey)}</div>` : ''}${resultBlock(x.c, e)}</div>`;
}

function chatEntry(x: Ctx, e: Entry): string {
  const t = `<span class="tx-t" title="${esc(stamp(e.at))}">${hms(e.at)}</span>`;
  switch (e.kind) {
    case 'prompt':
      return `<div class="tx-m user" data-select="${esc(x.key)}"><div class="tx-mh"><b>You</b>${t}</div>${longText(x.c, e)}</div>`;
    case 'reply':
      return `<div class="tx-m bot ${x.s.provider}" data-select="${esc(x.key)}"><div class="tx-mh"><b>${esc(PROV[x.s.provider])}</b>${e.model ? `<span class="muted">${esc(prettyModel(e.model))}</span>` : ''}${e.phase ? `<span class="tx-ph">${esc(e.phase.replace(/_/g, ' '))}</span>` : ''}${t}</div>${longText(x.c, e)}</div>`;
    case 'thinking':
      return `<div class="tx-th" data-select="${esc(x.key)}" title="OBSERVED: a thinking / reasoning block exists; its content is never shown">thinking (${esc(e.chars ? `${e.chars.toLocaleString()} chars` : 'length not recorded')}${e.text === 'encrypted' ? ', encrypted' : ''}) ${t}</div>`;
    case 'tool':
    case 'spawn':
      return toolRow(x, e);
    case 'error':
      return `<div class="tx-er" data-select="${esc(x.key)}"><b>! ${esc(e.name ?? 'error')}</b> <span>${esc(e.text)}</span> ${t}</div>`;
    case 'compact':
      return `<div class="tx-div cmp" data-select="${esc(x.key)}"><span>⇕ ${esc(e.text)} · ${hms(e.at)}</span></div>`;
    case 'turn':
      return `<div class="tx-div turn" data-select="${esc(x.key)}"><span>${esc(e.text)} · ${hms(e.at)}</span></div>`;
    case 'command':
      return `<div class="tx-cmd" data-select="${esc(x.key)}"><code>${esc(e.name ?? '')}</code> <span class="muted">${esc(e.text)}</span> ${t}</div>`;
    default:
      return `<div class="tx-meta" data-select="${esc(x.key)}">${esc(e.text)} ${t}</div>`;
  }
}

function chat(x: Ctx, items: Entry[]): string {
  let h = '';
  let day = '';
  let group: string[] = [];
  const flush = () => {
    if (group.length) h += `<div class="tx-tg">${group.join('')}</div>`;
    group = [];
  };
  for (const e of items) {
    const dd = dayOf(e.at);
    if (dd !== day) {
      flush();
      if (day) h += `<div class="tx-div day"><span>${esc(dd)}</span></div>`;
      day = dd;
    }
    if (e.kind === 'tool' || e.kind === 'spawn') group.push(toolRow(x, e));
    else {
      flush();
      h += chatEntry(x, e);
    }
  }
  flush();
  return `<div class="tx-chat">${h}</div>`;
}

function log(x: Ctx, items: Entry[]): string {
  return `<div class="tx-log">${items
    .map(e => {
      const what = e.kind === 'tool' || e.kind === 'spawn' ? `<b>${esc(e.name ?? '')}</b> <code>${esc(e.text)}</code>` : e.kind === 'thinking' ? `<span class="muted">thinking (${esc(e.chars ? `${e.chars.toLocaleString()} chars` : 'length not recorded')})</span>` : e.kind === 'command' ? `<code>${esc(e.name ?? '')}</code> ${esc(e.text)}` : esc(e.text.replace(/\s+/g, ' ').slice(0, 400));
      const open = (e.kind === 'tool' || e.kind === 'spawn') && (x.c.open === `e${e.id}` || x.c.results === 'full');
      return `<div class="tx-lr k-${e.kind}${isError(e) ? ' err' : ''}${e.sub ? ' sub' : ''}" data-select="${esc(x.key)}"><span class="tx-t" title="${esc(stamp(e.at))}">${hms(e.at)}</span><span class="tx-kd"${e.result?.text ? openAttr(x.c, e) : ''}>${esc(e.kind)}</span><span class="tx-w">${what}</span>${statusChip(e)}</div>${open ? resultBlock(x.c, e, true) : ''}${e.kind === 'spawn' ? `<div class="tx-lr sub"><span></span><span></span><span class="tx-w">${spawnLink(e, x.links, x.byKey)}</span></div>` : ''}`;
    })
    .join('')}</div>`;
}

function tools(x: Ctx, items: Entry[]): string {
  const rows = items.filter(e => e.kind === 'tool' || e.kind === 'spawn' || e.kind === 'error');
  if (!rows.length) return `<div class="empty">No tool call in this page.</div>`;
  return `<table class="tx-tt"><tr><th>Time</th><th>Tool</th><th>Input</th><th>Status</th><th class="r" title="DERIVED: result time minus call time, or the duration the provider recorded">Took</th><th class="r" title="OBSERVED: result length before the 2 KB preview cut">Result</th></tr>${rows
    .map(e => {
      const r = e.result;
      const d = r ? r.durationMs ?? (r.at > e.at ? r.at - e.at : undefined) : undefined;
      const open = x.c.open === `e${e.id}` || x.c.results === 'full';
      const head = `<tr class="${isError(e) ? 'err' : ''}${e.sub ? ' sub' : ''}" data-select="${esc(x.key)}"><td class="tx-t" title="${esc(stamp(e.at))}">${hms(e.at)}</td><td><b${r?.text ? openAttr(x.c, e) : ''} class="tx-tn">${e.sub ? '↳ ' : ''}${esc(e.kind === 'error' ? `error · ${e.name ?? ''}` : e.name ?? '')}</b></td><td class="tx-in"><code title="${esc(e.text)}">${esc(e.text || '—')}</code>${e.kind === 'spawn' ? ` ${spawnLink(e, x.links, x.byKey)}` : ''}</td><td>${statusChip(e)}</td><td class="r">${esc(dur(d))}</td><td class="r muted">${r ? esc(compact(r.chars)) : ''}</td></tr>`;
      return head + (open && r?.text ? `<tr class="tx-rr"><td></td><td colspan="5">${resultBlock(x.c, e, true)}</td></tr>` : '');
    })
    .join('')}</table>`;
}

function stripHtml(list: Entry[], c: Cfg, first?: number, last?: number): string {
  const bs = strip(list, 72);
  if (bs.length < 2) return '';
  const max = Math.max(...bs.map(b => b.n), 1);
  return `<div class="tx-strip" role="group" aria-label="Jump to a time">${bs
    .map(b => {
      const inWin = first !== undefined && last !== undefined && b.t1 >= first && b.t0 <= last;
      const h = b.n ? Math.max(8, (100 * b.n) / max) : 0;
      const tip = `${hms(b.t0)} – ${hms(b.t1)} · ${b.n} entries · ${b.prompts} prompt(s) · ${b.tools} tool call(s)${b.errors ? ` · ${b.errors} error(s)` : ''} · click to jump`;
      return `<span class="tx-b${inWin ? ' in' : ''}" data-opt="transcript.at" data-val="${b.t0}" title="${esc(tip)}"><i style="height:${h.toFixed(1)}%"></i>${b.errors ? `<em style="height:${Math.max(10, (100 * b.errors) / max).toFixed(1)}%"></em>` : ''}${b.prompts ? '<u></u>' : ''}</span>`;
    })
    .join('')}</div><div class="tx-sx muted"><span>${esc(stamp(bs[0].t0))}</span><span>bars: entries per slice · red: errors · tick: prompt · highlighted: this page · ${esc(c.anchor === undefined ? 'following the latest' : 'pinned to a time')}</span><span>${esc(stamp(bs[bs.length - 1].t1))}</span></div>`;
}

// ---------------------------------------------------------------- picker and header

function picker(d: WsData, current?: string): string {
  const sorted = [...d.sessions].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const pick = sorted.filter(s => !s.isWorker || isLive(s)).slice(0, 10);
  const cur = current ? d.sessions.find(s => s.key === current) : undefined;
  if (cur && !pick.some(s => s.key === cur.key)) pick.unshift(cur);
  if (!pick.length) return '';
  return `<div class="tx-pick">${pick.map(s => `<button class="pill${s.key === current ? ' on' : ''}" data-select="${esc(s.key)}" style="--id:${identityColor(repoOf(s))}" title="${esc(`${PROV[s.provider]} · ${repoOf(s)} · ${s.status} · ${ago(d.now, s.lastActivityAt)}`)}"><span class="dot ${esc(s.status)}"></span>${esc(titleOf(s).slice(0, 28))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</button>`).join('')}</div>`;
}

function chooser(d: WsData): string {
  const list = [...d.sessions].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 40);
  if (!list.length) return `<div class="empty">No session loaded yet.</div>`;
  return `<h2>Pick a session to read</h2><table class="tx-tt tx-ch">${list
    .map(s => `<tr data-select="${esc(s.key)}" tabindex="0"><td><span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 70))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td><span class="tx-sw" style="background:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td class="muted">${esc(PROV[s.provider])}</td><td class="r muted">${s.artifactBytes !== undefined ? esc(bytes(s.artifactBytes)) : ''}</td><td class="muted">${esc(ago(d.now, s.lastActivityAt))}</td></tr>`)
    .join('')}</table>`;
}

function header(d: WsData, s: AgentSessionSnapshot, t: Transcript, c: Cfg): string {
  const parent = s.parentSessionId ? d.sessions.find(p => p.key === s.parentSessionId) : undefined;
  const kids = d.sessions.filter(k => k.parentSessionId === s.key).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const live = isLive(s);
  const window = t.from > 0 ? `last ${bytes(t.size - t.from)} of ${bytes(t.size)}` : `${bytes(t.size)}`;
  const follow = live ? (c.anchor === undefined ? `<span class="tx-live" title="INFERRED: session is live; this page follows new records on each refresh">● following live</span>` : `<button class="link tx-live off" data-opt="transcript.at" data-val="" title="Jump to the latest entries and follow">▶ follow live</button>`) : '';
  const mode = modeHtml(s);
  const meta = [PROV[s.provider], s.model ? prettyModel(s.model) : '', s.effort ? `effort ${s.effort}` : ''].filter(Boolean).map(m => esc(m));
  if (mode) meta.push(`<span class="tx-mode" title="Claude permission mode; Codex approval policy and collaboration mode (plan = Codex plan mode); sandbox">${mode}</span>`);
  meta.push(...[repoOf(s), s.branch ?? s.facts?.recordedBranch ?? ''].filter(Boolean).map(m => esc(m)));
  const exportControl=!d.cockpitInputs?.panelContext || d.cockpitInputs.panelContext.exportAllowed===true?actBtn('export', s.key, 'Export markdown', 'Save the loaded transcript as redacted markdown (no thinking, no images)'):'<span class="muted">Export requires an export-enabled reviewed scope</span>';
  let h = `<div class="tx-h" style="--id:${identityColor(repoOf(s))}"><div class="tx-h1"><span class="dot ${esc(s.status)}"></span><b>${esc(titleOf(s))}</b>${s.isWorker ? `<span class="tx-tag">worker${s.workerLabel ? ` · ${esc(s.workerLabel)}` : ''}</span>` : ''}${follow}<span class="tx-acts">${exportControl} · ${actBtn('reveal', s.key, 'Reveal file', 'Show the transcript file in the OS file manager')}</span></div><div class="tx-h2 muted">${meta.join(' · ')} · <span title="${esc(`OBSERVED: ${t.path}`)}">${esc(path.basename(t.path))}</span> · <span title="Loaded window (tail-read, incremental). Older records are not read; raise agent.transcript.maxBytes to read more.">${esc(window)}</span> · ${t.records.toLocaleString()} records${t.bad ? ` · ${t.bad} unreadable line(s)` : ''}${t.dropped ? ` · ${t.dropped.toLocaleString()} older entries dropped (cap)` : ''} · ${esc(ago(d.now, s.lastActivityAt))}</div>`;
  if (parent || kids.length) {
    h += `<div class="tx-rel">${parent ? `<span class="muted">parent</span> <button class="pill" data-select="${esc(parent.key)}" style="--id:${identityColor(repoOf(parent))}"><span class="dot ${esc(parent.status)}"></span>${esc(titleOf(parent).slice(0, 36))}</button>` : ''}${kids.length ? `<span class="muted">workers · ${kids.length}</span> ${kids.slice(-12).map(k => `<button class="pill" data-select="${esc(k.key)}" style="--id:${identityColor(repoOf(k))}" title="${esc(`${k.workerLabel ?? ''} · ${k.status}`)}"><span class="dot ${esc(k.status)}"></span>${esc(titleOf(k).slice(0, 30))}</button>`).join('')}${kids.length > 12 ? `<span class="muted">+${kids.length - 12}</span>` : ''}` : ''}</div>`;
  }
  return h + '</div>';
}

// ---------------------------------------------------------------- screen

export function loadFor(s: AgentSessionSnapshot): Transcript {
  return readTranscript(s.artifactPath, s.provider, { maxBytes: SETTINGS.maxBytes, maxEntries: SETTINGS.maxEntries });
}

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const s = st.selected ? d.sessions.find(x => x.key === st.selected) : undefined;
  if (!s) return `<div class="tx">${chooser(d)}<div class="foot">Select a session anywhere in Agent (or here) to read it. Transcripts are read on demand from local files, tail first, and redacted.</div></div>`;
  const t = loadFor(s);
  if (t.error && !t.entries.length) return `<div class="tx">${picker(d, s.key)}<div class="empty">${esc(t.error)} <span class="muted">${esc(s.artifactPath)}</span></div></div>`;

  const all = t.entries;
  const list = all.filter(e => visible(e, c));
  const size = SETTINGS.pageSize;
  const w = pageOf(list, size, c.anchor);
  const items = c.order === 'new' ? [...w.items].reverse() : w.items;
  const n = counts(all);
  const kids = d.sessions.filter(k => k.parentSessionId === s.key);
  const byKey = new Map(d.sessions.map(x => [x.key, x]));
  const links = workerLinks(all.filter(e => e.kind === 'spawn'), kids);
  const x: Ctx = { c, s, key: s.key, links, byKey };

  const names = toolNames(all);
  const tb1 = toolbar(
    seg(st, 'transcript.mode', [['chat', 'Chat'], ['log', 'Compact log'], ['tools', 'Tools only']], 'chat', 'Layout'),
    seg(st, 'transcript.order', [['old', 'Oldest first'], ['new', 'Newest first']], 'old', 'Order inside the page'),
    seg(st, 'transcript.only', [['all', 'All'], ['talk', 'Conversation'], ['prompts', 'Prompts'], ['errors', `Errors${n.errors ? ` ${n.errors}` : ''}`], ['spawns', `Spawns${n.spawns ? ` ${n.spawns}` : ''}`]], 'all', 'Show'),
    seg(st, 'transcript.results', [['hide', 'Results off'], ['short', 'Short'], ['full', 'Full']], 'short', 'Tool result previews (≤ 2 KB each)'),
    c.mode !== 'tools' ? seg(st, 'transcript.thinking', [['show', 'Thinking'], ['hide', 'No thinking']], 'show', 'Thinking blocks are shown as their length only') : '',
    c.mode !== 'tools' ? seg(st, 'transcript.meta', [['hide', 'No meta'], ['show', 'Meta + turns']], 'hide', 'Session meta, turn context changes, turn boundaries, injected context') : '',
  );
  const tb2 = names.length
    ? toolbar(`<span class="muted">tool</span>`, seg(st, 'transcript.tool', [['', 'Any'], ...names.slice(0, 10).map(([nm, k]) => [toolSlug(nm), `${nm} ${k}`] as [string, string])], '', 'Only calls of this tool'))
    : '';
  const kpis = `<div class="kpis tx-k">${[
    [n.prompts, 'Prompts'],
    [n.replies, 'Replies'],
    [n.tools, 'Tool calls'],
    [n.errors, 'Errors', n.errors ? 'bad' : ''],
    [n.spawns, 'Spawns'],
    [n.compactions, 'Compactions'],
    [n.thinking ? `${n.thinking} · ${compact(n.thinkingChars)}` : 0, 'Thinking · chars'],
  ]
    .map(([v, l, cls]) => `<div class="kpi ${cls ?? ''}" title="DERIVED: counted over the loaded window (${esc(String(all.length))} entries)"><b>${esc(String(v))}</b><span>${esc(String(l))}</span></div>`)
    .join('')}</div>`;

  const first = w.items[0]?.at, last = w.items[w.items.length - 1]?.at;
  const nav = `<div class="tx-nav">${w.older !== undefined ? `<button class="link" data-opt="transcript.at" data-val="${w.older}">◀ older</button>` : '<span class="muted">◀ older</span>'}<span>${w.total ? `entries ${w.start + 1}–${w.end} of ${w.total}${first !== undefined ? ` · ${esc(hms(first))} → ${esc(hms(last!))}` : ''}` : 'nothing to show with these filters'}</span>${w.newer !== undefined ? `<button class="link" data-opt="transcript.at" data-val="${w.newer}">newer ▶</button><button class="link" data-opt="transcript.at" data-val="">latest ⇥</button>` : '<span class="muted">newer ▶</span>'}</div>`;

  let body: string;
  if (!all.length) body = `<div class="empty">No readable conversation records in the loaded window yet.</div>`;
  else if (!items.length) body = `<div class="empty">Nothing matches these filters. <button class="link" data-opt="transcript.only" data-val="all">Show all</button></div>`;
  else if (c.mode === 'log') body = log(x, items);
  else if (c.mode === 'tools') body = tools(x, items);
  else body = chat(x, items);

  const foot = [
    `<b>OBSERVED</b>: read from the provider file on demand (tail-read, only new bytes on refresh), nothing is stored or sent.`,
    'All text is redacted (keys, tokens, credentials); images and encoded data are never shown; thinking appears as its length only; tool results are previews capped at 2 KB.',
    'Worker links: OBSERVED when the worker description equals the spawn description, INFERRED when matched by start time.',
    'Type <b>/</b> to filter the visible entries by text.',
  ].join(' ');
  return `<div class="tx">${picker(d, s.key)}${header(d, s, t, c)}${tb1}${tb2}${kpis}${stripHtml(list.length ? list : all, c, first, last)}${nav}${body}${w.total > size ? nav : ''}<div class="foot">${foot}</div></div>`;
}

// ---------------------------------------------------------------- export

export function toMarkdown(s: AgentSessionSnapshot, t: Transcript): string {
  const out: string[] = [`# ${titleOf(s)}`, '', `${PROV[s.provider]} · ${repoOf(s)} · ${s.model ?? ''} · ${path.basename(t.path)}`, '', '_Redacted export: no thinking content, no images, tool results capped at 2 KB._', ''];
  for (const e of t.entries) {
    const at = stamp(e.at);
    if (e.kind === 'prompt') out.push(`## You · ${at}`, '', e.text, '');
    else if (e.kind === 'reply') out.push(`## ${PROV[s.provider]}${e.model ? ` (${e.model})` : ''} · ${at}`, '', e.text, '');
    else if (e.kind === 'tool' || e.kind === 'spawn') {
      out.push(`- \`${e.name}\` ${e.text ? `\`${e.text.replace(/`/g, "'")}\`` : ''}${e.result ? ` → ${e.result.error ? 'error' : 'ok'}${e.result.exitCode !== undefined ? ` (exit ${e.result.exitCode})` : ''}` : ''}`);
      if (e.result?.text) out.push('', '  ```', ...e.result.text.split('\n').slice(0, 20).map(l => `  ${l}`), '  ```', '');
    } else if (e.kind === 'thinking') out.push(`- _thinking (${e.chars ?? 0} chars)_`);
    else if (e.kind === 'error') out.push(`- **error** ${e.name ?? ''}: ${e.text}`);
    else if (e.kind === 'compact') out.push('', `---`, `_${e.text} · ${at}_`, '');
    else if (e.kind === 'command') out.push(`- command \`${e.name}\` ${e.text}`);
  }
  // Final pass through the one redaction layer: title, repo path and anything a future line adds.
  return redact(out.join('\n')) + '\n';
}

const CSS = `
.tx .tb { margin: 0 0 6px; }
.tx .tx-pick { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.tx .tx-h { border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 4px; padding: 6px 10px; margin: 0 0 8px; background: var(--raise); }
.tx .tx-h1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.tx .tx-h2 { font-size: 11px; margin-top: 2px; }
.tx .tx-acts { margin-left: auto; font-size: 11px; }
.tx .tx-tag { font-size: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; color: var(--vscode-descriptionForeground); }
.tx .tx-live { font-size: 11px; color: var(--ok); } .tx .tx-live.off { color: var(--vscode-textLink-foreground); }
.tx .tx-rel { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; font-size: 11px; }
.tx .tx-k { margin: 4px 0 6px; } .tx .tx-k .kpi.bad b { color: var(--bad); }
.tx .tx-strip { display: flex; align-items: flex-end; gap: 1px; height: 34px; max-width: 1100px; border-bottom: 1px solid var(--line); }
.tx .tx-b { flex: 1; height: 100%; position: relative; cursor: pointer; display: flex; align-items: flex-end; border-radius: 2px 2px 0 0; }
.tx .tx-b:hover { background: var(--vscode-list-hoverBackground); }
.tx .tx-b.in { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.tx .tx-b i { display: block; width: 100%; background: color-mix(in srgb, var(--accent) 70%, transparent); border-radius: 1px 1px 0 0; }
.tx .tx-b em { position: absolute; left: 0; right: 0; bottom: 0; background: var(--bad); opacity: .85; }
.tx .tx-b u { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--warn); text-decoration: none; }
.tx .tx-sx { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; max-width: 1100px; margin: 2px 0 6px; }
.tx .tx-nav { display: flex; gap: 12px; align-items: center; font-size: 11px; margin: 4px 0 6px; color: var(--vscode-descriptionForeground); }
.tx .tx-t { font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tx .tx-chat { display: flex; flex-direction: column; gap: 6px; max-width: 1100px; }
.tx .tx-m { border-radius: 6px; padding: 6px 10px; border: 1px solid var(--line); }
.tx .tx-m.user { background: color-mix(in srgb, var(--accent) 10%, transparent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); margin-right: 8%; }
.tx .tx-m.bot { border-left: 3px solid var(--quiet); margin-left: 2%; }
.tx .tx-m.bot.claude { border-left-color: var(--claude); } .tx .tx-m.bot.codex { border-left-color: var(--codex); }
.tx .tx-mh { display: flex; gap: 8px; align-items: baseline; font-size: 11px; margin-bottom: 2px; } .tx .tx-mh .tx-t { margin-left: auto; }
.tx .tx-ph { font-size: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 0 5px; color: var(--vscode-descriptionForeground); }
.tx .tx-tx { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.45; }
.tx .tx-more { font-size: 11px; }
.tx .tx-th { font-size: 11px; font-style: italic; color: var(--vscode-descriptionForeground); margin-left: 2%; }
.tx .tx-tg { margin-left: 2%; border-left: 2px solid var(--line); padding-left: 6px; display: flex; flex-direction: column; gap: 1px; }
.tx .tx-tl { font-size: 11.5px; border-radius: 3px; padding: 1px 4px; }
.tx .tx-tl:hover { background: var(--vscode-list-hoverBackground); }
.tx .tx-tl.sub { margin-left: 16px; opacity: .92; }
.tx .tx-tl.err { background: color-mix(in srgb, var(--bad) 9%, transparent); }
.tx .tx-tl.spawn { border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--line)); }
.tx .tx-tlh { display: grid; grid-template-columns: 14px max-content minmax(0, 1fr) max-content max-content; gap: 6px; align-items: baseline; }
.tx .tx-ic { color: var(--vscode-descriptionForeground); text-align: center; }
.tx .tx-tn { white-space: nowrap; }
.tx [data-opt="transcript.open"] { cursor: pointer; }
.tx .tx-in { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--vscode-foreground); background: none; }
.tx .tx-st { font-size: 10px; border-radius: 8px; padding: 0 6px; white-space: nowrap; border: 1px solid var(--line); }
.tx .tx-st.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.tx .tx-st.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 55%, transparent); }
.tx .tx-st.run { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.tx .tx-sp { display: flex; gap: 10px; align-items: center; margin: 1px 0 1px 20px; font-size: 11px; flex-wrap: wrap; }
.tx .tx-wk { font-size: 11px; }
.tx pre.tx-res { margin: 2px 0 3px 20px; padding: 4px 8px; font-size: 11px; line-height: 1.35; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; background: var(--vscode-textCodeBlock-background, var(--raise)); border-radius: 3px; border-left: 2px solid var(--line); }
.tx pre.tx-res.short { max-height: none; color: var(--vscode-descriptionForeground); }
.tx pre.tx-res.err { border-left-color: var(--bad); }
.tx .tx-er { font-size: 12px; color: var(--bad); padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--bad) 50%, transparent); border-radius: 4px; }
.tx .tx-er span { color: var(--vscode-foreground); }
.tx .tx-div { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--vscode-descriptionForeground); margin: 4px 0; }
.tx .tx-div::before, .tx .tx-div::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
.tx .tx-div.cmp { color: var(--warn); } .tx .tx-div.cmp::before, .tx .tx-div.cmp::after { border-top-style: dashed; border-color: var(--warn); }
.tx .tx-cmd { font-size: 11.5px; margin-right: 8%; }
.tx .tx-meta { font-size: 10.5px; color: var(--vscode-descriptionForeground); }
.tx .tx-log { font-size: 11.5px; max-width: 1200px; }
.tx .tx-lr { display: grid; grid-template-columns: 58px 62px minmax(0, 1fr) max-content; gap: 6px; padding: 1px 4px; align-items: baseline; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); }
.tx .tx-lr:hover { background: var(--vscode-list-hoverBackground); }
.tx .tx-lr.err { background: color-mix(in srgb, var(--bad) 8%, transparent); }
.tx .tx-lr.sub .tx-w { padding-left: 14px; }
.tx .tx-w { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx .tx-w code { font-size: 11px; }
.tx .tx-kd { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
.tx .k-prompt .tx-kd { color: var(--accent); } .tx .k-reply .tx-kd { color: var(--ok); } .tx .k-error .tx-kd, .tx .tx-lr.err .tx-kd { color: var(--bad); } .tx .k-compact .tx-kd { color: var(--warn); }
.tx table.tx-tt { font-size: 11.5px; max-width: 1200px; width: 100%; border-collapse: collapse; table-layout: fixed; }
.tx table.tx-tt th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 2px 6px; }
.tx table.tx-tt td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx table.tx-tt th:nth-child(1) { width: 64px; } .tx table.tx-tt th:nth-child(2) { width: 150px; } .tx table.tx-tt th:nth-child(4) { width: 110px; } .tx table.tx-tt th:nth-child(5), .tx table.tx-tt th:nth-child(6) { width: 64px; }
.tx table.tx-ch { table-layout: auto; } .tx table.tx-ch th { width: auto !important; }
.tx table.tx-tt tr[data-select]:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
.tx table.tx-tt tr.err { background: color-mix(in srgb, var(--bad) 8%, transparent); }
.tx table.tx-tt tr.sub td:nth-child(2) { padding-left: 14px; }
.tx table.tx-tt tr.tx-rr td { white-space: normal; }
.tx table.tx-tt .r { text-align: right; }
.tx .tx-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
`;

function sessionFor(arg: string, ctx: { sessions(): AgentSessionSnapshot[] }): AgentSessionSnapshot | undefined {
  if (!/^(claude|codex):/.test(arg) || arg.length > 300) return undefined;
  return ctx.sessions().find(s => s.key === arg);
}

export const transcriptView: ExtraView = {
  id: 'transcript',
  label: 'Transcript',
  group: 'Agents',
  hint: 'Read a session as a conversation: prompts, replies and tool calls, live, redacted, local only.',
  ready: true,
  render,
  css: CSS,
  feeds: [settingsFeed as Feed],
  actions: {
    async export(arg, ctx) {
      const s = sessionFor(arg, ctx);
      if (!s) return ctx.info('Transcript: session not found in the current scope.');
      const t = loadFor(s);
      const saved = await ctx.saveText(`agent-transcript-${s.provider}-${s.sessionId.slice(0, 8)}.md`, toMarkdown(s, t));
      if (saved) ctx.info(`Transcript: saved ${saved}`);
    },
    async reveal(arg, ctx) {
      const s = sessionFor(arg, ctx);
      if (!s) return ctx.info('Transcript: session not found in the current scope.');
      await ctx.revealInOs(s.artifactPath);
    },
  },
};
