// Backlog: parse plan files (handoff/PLAN.md, ROADMAP.md, PLAN.md, TODO.md) into items with a state, and link
// them to sessions that mention the item id. Pure functions: no fs, no process. Everything returned is bounded
// and redacted; the caller escapes on render.
//
// Items come from four shapes found in real plans:
//   - checklists          "- [ ] text" / "- [x] text"                      state OBSERVED (box)
//   - tables              a header with an id/package column AND a state / status / done column
//   - bold leads          "- **P1 · Week calendar** — …" / "**V1-SURF**: …" (id-like token first)
//   - id headings         "### § V1-SURF" / "## P3 · Replay"
// The state of tables, bold leads and headings is DERIVED from keywords (done / merged / ✓, running, blocked …).
import type { AgentSessionSnapshot } from '../model';
import { bounded } from '../util/redact';

export type ItemState = 'open' | 'active' | 'blocked' | 'done' | 'dropped';
export const STATES: ItemState[] = ['open', 'active', 'blocked', 'done', 'dropped'];
export const STATE_LABEL: Record<ItemState, string> = { open: 'Open', active: 'Active', blocked: 'Blocked', done: 'Done', dropped: 'Dropped' };

export type ItemShape = 'check' | 'table' | 'bold' | 'heading';
export const SHAPE_LABEL: Record<ItemShape, string> = { check: 'checklist box', table: 'table row', bold: 'bold lead line', heading: 'heading' };

export interface BacklogItem {
  /** Package id when the item has one (P1, V1-SURF, HUB-1, data …). */
  id?: string;
  title: string;
  state: ItemState;
  /** How the state was read: "box [x]" (OBSERVED) or the matched keyword (DERIVED). */
  stateBasis: string;
  shape: ItemShape;
  /** Nearest heading above the item. */
  section: string;
  /** 1-based line in the file. */
  line: number;
  /** Date written on the item line or its nearest dated heading (epoch ms, local midnight). */
  dated?: number;
  /** Item line itself carries the date (vs inherited from a heading). */
  datedOwn?: boolean;
  /** Indentation depth for checklists (0 = top). */
  depth: number;
}

export interface PlanFile {
  root: string;
  repo: string;
  /** Path relative to root, forward slashes. */
  rel: string;
  file: string;
  bytes: number;
  mtime: number;
  /** Under handoff/archive: counted in the weekly archive only. */
  archive: boolean;
  /** Set instead of items when the file was skipped (too large, unreadable). */
  skipped?: string;
  items: BacklogItem[];
}

export interface BacklogReport {
  at: number;
  roots: string[];
  files: PlanFile[];
  /** Repos scanned that have no plan file. */
  empty: string[];
}

// ---------------------------------------------------------------- state keywords

const KW: [ItemState, RegExp][] = [
  ['blocked', /\b(blocked|blocker|bloqu[ée]e?s?|stuck|waiting on|attend)\b|⛔|🚫/i],
  ['active', /\b(running|in progress|in-progress|wip|ongoing|active|started|en cours|in review|open pr|pr open|mr open|reviewing)\b|🔄|⏳/i],
  ['done', /\b(done|merged|shipped|released|closed|complete|completed|finished|fait|termin[ée]e?s?|landed)\b|✓|✔|✅|☑/i],
  ['dropped', /\b(dropped|skipped|cancell?ed|abandoned|won'?t do|wontfix|obsolete|superseded|retired)\b|❌/i],
  ['open', /\b(open|todo|to do|queued|planned|next|pending|not started|à faire|backlog|ready)\b|⬜/i],
];

/** State from free text (a state cell, or the lead of a line). Priority: blocked > active > done > dropped > open. */
export function stateOf(text: string): { state: ItemState; basis: string } | undefined {
  const t = text.replace(/`[^`]*`/g, ' ');
  if (/^\s*~~.*~~\s*$/.test(t)) return { state: 'dropped', basis: '~~struck~~' };
  for (const [state, re] of KW) {
    const m = re.exec(t);
    if (m) return { state, basis: m[0].trim() };
  }
  return undefined;
}

/**
 * State marker on a prose line (heading or bold lead): only explicit markers count, so a description that
 * merely contains "review" or "open" stays unclassified. "— done", "(merged #12)", "[running]", "state: blocked", ✓.
 */
export function markerOf(text: string): { state: ItemState; basis: string } | undefined {
  const t = text.replace(/`[^`]*`/g, ' ');
  if (/^\s*~~.*~~/.test(t)) return { state: 'dropped', basis: '~~struck~~' };
  const emo = /✅|✓|✔|☑|⛔|🚫|🔄|⏳|❌/.exec(t);
  const word = /(?:^|[—–(\[|·,;]|\s-\s|\b(?:state|status|état|statut)\s*[:=])\s*(done|merged|shipped|released|landed|complete|completed|running|in progress|wip|blocked|bloqué|dropped|skipped|cancell?ed|superseded|queued|todo|planned|pending)\b/i.exec(t);
  const hits = [emo, word].filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index);
  const hit = hits[0];
  if (!hit) return undefined;
  const raw = hit === word ? word[1] : hit[0];
  const st = stateOf(raw);
  return st ? { state: st.state, basis: raw.trim() } : undefined;
}

// ---------------------------------------------------------------- ids and dates

/** Id-like token: starts with a capital or digit, contains a digit or a dash, ≤ 24 chars (P1, V1-SURF, HUB-1, V1.0.x-QATMP). */
const ID_RE = /^(?:§\s*)?((?:[A-Z][A-Za-z0-9]*|[0-9][A-Za-z0-9]*)(?:[-.][A-Za-z0-9]+)*)/;

export function idLike(tok: string): boolean {
  return tok.length >= 2 && tok.length <= 24 && /[A-Z0-9]/.test(tok[0]) && (/\d/.test(tok) || /[A-Za-z0-9]-[A-Za-z0-9]/.test(tok)) && !/^\d+([-.]\d+)*$/.test(tok) && !/^\d{4}-\d{2}/.test(tok);
}

/** Splits "P1 · Week calendar" into id + title when the text starts with an id-like token. */
export function splitId(text: string): { id?: string; title: string } {
  const s = text.trim();
  const m = ID_RE.exec(s);
  // the id must end the token: "QA-1/2/3 merged" or "V1_x" are prose, not an id followed by a title
  if (m && idLike(m[1]) && !/^[/\\_@#&+=*%'"’`]/.test(s.slice(m[0].length))) {
    const rest = s.slice(m[0].length).replace(/^[\s·:—–\-|)(]+/, '').trim();
    return { id: m[1], title: rest || m[1] };
  }
  return { title: s };
}

const DATE_RE = /\b(20\d{2})-(\d{2})-(\d{2})\b/;

export function dateIn(text: string): number | undefined {
  const m = DATE_RE.exec(text);
  if (!m) return undefined;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? t : undefined;
}

/** Inline markdown → plain text (links, bold, code ticks, html tags), single line, bounded and redacted. */
export function plain(md: string, max = 160): string {
  const t = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return bounded(t, max);
}

// ---------------------------------------------------------------- parser

const ID_COL = /^(id|#|package|packages|pkg|lot|lots|item|task|ticket|milestone|step|phase)$/i;
const TITLE_COL = /^(scope|title|milestone|what|description|desc|summary|package|packages|task|item|name|goal|objective)$/i;
const STATE_COL = /^(state|status|done|état|etat|statut|result)$/i;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
const isSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

interface Table {
  idCol: number;
  titleCol: number;
  stateCol: number;
}

/** Items from one markdown file. Ignores fenced code blocks. Caps at `max` items. */
export function parsePlan(text: string, max = 1500): BacklogItem[] {
  const lines = text.split(/\r?\n/);
  const items: BacklogItem[] = [];
  const heads: { level: number; text: string; dated?: number }[] = [];
  let fence = false;
  let table: Table | undefined;
  let pkgSection = false;
  const section = () => heads.map(h => h.text).slice(-2).join(' › ');
  const inherited = () => {
    for (let i = heads.length - 1; i >= 0; i--) if (heads[i].dated !== undefined) return heads[i].dated;
    return undefined;
  };
  const push = (it: Omit<BacklogItem, 'section' | 'dated' | 'datedOwn'>, raw: string) => {
    if (items.length >= max) return;
    const own = dateIn(raw);
    items.push({ ...it, section: bounded(section(), 120), dated: own ?? inherited(), datedOwn: own !== undefined });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    // headings
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      table = undefined;
      const level = h[1].length;
      while (heads.length && heads[heads.length - 1].level >= level) heads.pop();
      const txt = plain(h[2], 100);
      heads.push({ level, text: txt, dated: dateIn(h[2]) });
      pkgSection = /\b(packages?|lots?|wave|backlog|tasks?|todo|items?|milestones?)\b/i.test(h[2]);
      const sp = splitId(txt.replace(/^§\s*/, ''));
      const sepAfter = sp.id ? /^\s*[·:—–|-]\s/.test(txt.replace(/^§\s*/, '').slice(sp.id.length)) : false;
      if (level >= 2 && sp.id && sp.title !== sp.id && sepAfter) {
        const st = markerOf(h[2].slice(h[2].indexOf(sp.id) + sp.id.length));
        push({ id: sp.id, title: plain(sp.title), state: st?.state ?? 'open', stateBasis: st?.basis ?? 'no state keyword', shape: 'heading', line: i + 1, depth: 0 }, h[2]);
      } else if (level >= 3 && /^§\s*/.test(h[2]) && sp.id) {
        push({ id: sp.id, title: sp.id, state: 'open', stateBasis: 'no state keyword', shape: 'heading', line: i + 1, depth: 0 }, h[2]);
      }
      continue;
    }

    // tables
    if (/^\s*\|/.test(line)) {
      if (!table && i + 1 < lines.length && isSep(lines[i + 1])) {
        const hdr = cells(line).map(c => plain(c, 40));
        const stateCol = hdr.findIndex(c => STATE_COL.test(c));
        const idCol = hdr.findIndex(c => ID_COL.test(c));
        let titleCol = hdr.findIndex((c, k) => k !== idCol && TITLE_COL.test(c));
        if (titleCol < 0) titleCol = idCol >= 0 ? idCol : -1;
        table = stateCol >= 0 && (idCol >= 0 || titleCol >= 0) ? { idCol: idCol >= 0 ? idCol : titleCol, titleCol, stateCol } : undefined;
        if (!table) table = { idCol: -1, titleCol: -1, stateCol: -1 }; // a table we read past
        i++; // skip separator
        continue;
      }
      if (table && table.stateCol >= 0) {
        const c = cells(line);
        const idCell = plain(c[table.idCol] ?? '', 200);
        const titleCell = plain(c[table.titleCol] ?? '', 200);
        const stateCell = c[table.stateCol] ?? '';
        if (!idCell && !titleCell) continue;
        const sp = splitId(idCell);
        let id = sp.id;
        let title = table.titleCol !== table.idCol ? titleCell : sp.title;
        if (!id && table.titleCol === table.idCol) title = idCell;
        if (!id && table.titleCol !== table.idCol) title = [idCell, titleCell].filter(Boolean).join(' · ');
        const st = stateOf(stateCell);
        const empty = !plain(stateCell, 40) || /^[—–-]$/.test(plain(stateCell, 40));
        push({ id, title: bounded(title, 160), state: st?.state ?? 'open', stateBasis: st ? st.basis : empty ? 'empty state cell' : `"${plain(stateCell, 30)}"`, shape: 'table', line: i + 1, depth: 0 }, line);
      }
      continue;
    }
    table = undefined;

    // checklists
    const ck = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~\-/!>])\]\s+(.*)$/.exec(line);
    if (ck) {
      const box = ck[2];
      const body = ck[3];
      const state: ItemState = box === 'x' || box === 'X' ? 'done' : box === '~' || box === '/' || box === '>' ? 'active' : box === '!' ? 'blocked' : box === '-' ? 'dropped' : /^~~.*~~$/.test(body.trim()) ? 'dropped' : 'open';
      const sp = splitId(plain(body.replace(/^\*\*([^*]+)\*\*/, '$1'), 200));
      push({ id: sp.id, title: plain(sp.title), state, stateBasis: `box [${box}]`, shape: 'check', line: i + 1, depth: Math.min(4, Math.floor(ck[1].replace(/\t/g, '  ').length / 2)) }, body);
      continue;
    }

    // bold leads: "- **P1 · Week** — …", "**V1-SURF**: …", "- **data**: …" (lowercase ids only under a packages heading)
    const bd = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(~~)?\*\*([^*]{1,90})\*\*(~~)?\s*(.*)$/.exec(line);
    if (bd) {
      const inner = bd[2].replace(/[:：]\s*$/, '').trim();
      const rest = bd[4] ?? '';
      let sp = splitId(inner.replace(/^§\s*/, ''));
      const isList = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
      if (!sp.id && isList && pkgSection && /^[a-z][a-z0-9-]{1,23}$/.test(inner)) sp = { id: inner, title: '' };
      if (sp.id) {
        const lead = rest.replace(/^[\s:—–-]+/, '');
        const title = plain(sp.title && sp.title !== sp.id ? sp.title : lead.split(/(?<=[.;])\s/)[0] || sp.id);
        const st = bd[1] && bd[3] ? { state: 'dropped' as ItemState, basis: '~~struck~~' } : markerOf(`${inner.slice(sp.id.length)} ${lead.slice(0, 200)}`);
        push({ id: sp.id, title, state: st?.state ?? 'open', stateBasis: st?.basis ?? 'no state keyword', shape: 'bold', line: i + 1, depth: 0 }, `${inner} ${rest}`);
      }
    }
  }
  // a heading named after an id listed elsewhere in the file is that item's spec section, not a second item
  const listed = new Set(items.filter(it => it.shape !== 'heading' && it.id).map(it => it.id!.toLowerCase()));
  return items.filter(it => it.shape !== 'heading' || !listed.has(it.id!.toLowerCase()));
}

// ---------------------------------------------------------------- linking items to sessions

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Greedy prefix: cuts at the LAST worktree folder, so a repo that itself lives in a worktree keeps its path. */
const WT = /^(.*)[\\/](?:\.claude[\\/]worktrees|\.worktrees|worktrees)[\\/][^\\/]+(?:[\\/].*)?$/i;

/** Main repository folder of a session, original casing: git root when known, else cwd minus a linked-worktree suffix. */
export function repoRootOf(s: AgentSessionSnapshot): string | undefined {
  if (s.repository) return s.repository;
  if (!s.cwd) return undefined;
  const m = WT.exec(s.cwd.replace(/[\\/]+$/, ''));
  return m ? m[1].replace(/[\\/]\.claude$/i, '') : s.cwd;
}

/** Normalised (lowercase, forward slashes) repoRootOf, for comparisons. */
export function sessionRoot(s: AgentSessionSnapshot): string | undefined {
  const p = repoRootOf(s);
  return p ? norm(p) : undefined;
}

/** Text the provider recorded about a session that may name a package (title, branch, worker, last action, spawn descriptions). */
export function haystack(s: AgentSessionSnapshot): { text: string; branches: string[] } {
  const wt = s.worktree ?? s.cwd ?? '';
  const wtName = [...wt.matchAll(/[\\/](?:\.claude[\\/]worktrees|\.worktrees|worktrees)[\\/]([^\\/]+)/gi)].pop()?.[1];
  const branches = [s.branch, s.facts?.recordedBranch, wtName].filter((b): b is string => !!b);
  const text = [s.title, s.workerLabel, s.lastAction, ...branches, ...(s.facts?.spawns ?? []).map(x => x.description)].filter(Boolean).join(' \n ');
  return { text, branches };
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a session mentions the id. Lowercase word ids match only a branch / worktree name segment (night/data, claude-data). */
export function mentions(id: string, h: { text: string; branches: string[] }): 'branch' | 'text' | undefined {
  const lid = id.toLowerCase();
  const seg = (b: string) => b.toLowerCase().split(/[/\\]/).some(x => x === lid || x.endsWith('-' + lid) || x.endsWith('_' + lid) || x.startsWith(lid + '-'));
  if (h.branches.some(seg)) return 'branch';
  if (!idLike(id)) return undefined;
  const re = new RegExp(`(?<![A-Za-z0-9])${esc(id)}(?![A-Za-z0-9]|[-.][A-Za-z0-9])`, 'i');
  if (h.branches.some(b => re.test(b))) return 'branch';
  return re.test(h.text) ? 'text' : undefined;
}

export interface Link {
  key: string;
  via: 'branch' | 'text';
}

/** For every file item with an id: sessions of the same repository that mention it. Key = `${file}#${line}`. */
export function linkSessions(files: PlanFile[], sessions: AgentSessionSnapshot[]): Map<string, Link[]> {
  const out = new Map<string, Link[]>();
  const byRoot = new Map<string, { s: AgentSessionSnapshot; h: ReturnType<typeof haystack> }[]>();
  for (const s of sessions) {
    const r = sessionRoot(s);
    if (!r) continue;
    const list = byRoot.get(r) ?? [];
    list.push({ s, h: haystack(s) });
    byRoot.set(r, list);
  }
  for (const f of files) {
    const cands = byRoot.get(norm(f.root));
    if (!cands?.length) continue;
    for (const it of f.items) {
      if (!it.id) continue;
      const links: Link[] = [];
      for (const c of cands) {
        const via = mentions(it.id, c.h);
        if (via) links.push({ key: c.s.key, via });
      }
      if (links.length) out.set(`${f.file}#${it.line}`, links);
    }
  }
  return out;
}

// ---------------------------------------------------------------- weeks

/** Monday 00:00 local of the week holding t. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** ISO week label "2026-W41". */
export function isoWeek(t: number): string {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const y = d.getFullYear();
  const jan4 = new Date(y, 0, 4);
  const w = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export type WhenBasis = 'session' | 'dated' | 'file';
export const WHEN_LABEL: Record<WhenBasis, string> = {
  session: 'INFERRED: last activity of the latest ended session that mentions the id',
  dated: 'DERIVED: date written on the item or its nearest heading',
  file: 'OBSERVED: plan file last modified (no better date)',
};

/** When a done item most plausibly closed: latest linked ended session, else its written date, else file mtime. */
export function closedAt(it: BacklogItem, f: PlanFile, links: Link[] | undefined, byKey: Map<string, AgentSessionSnapshot>): { at: number; basis: WhenBasis } {
  let best = 0;
  for (const l of links ?? []) {
    const s = byKey.get(l.key);
    if (s && s.status === 'ENDED') best = Math.max(best, s.endedAt ?? s.lastActivityAt ?? 0);
  }
  if (best) return { at: best, basis: 'session' };
  if (it.dated !== undefined) return { at: it.dated, basis: 'dated' };
  return { at: f.mtime, basis: 'file' };
}

export interface WeekBucket {
  start: number;
  label: string;
  done: { f: PlanFile; it: BacklogItem; at: number; basis: WhenBasis }[];
  /** Items dated (written) in that week that are still pending. */
  added: number;
  sessions: Set<string>;
}

/** Done items grouped per week (newest first), `weeks` buckets ending at now's week. Archive files included. */
export function weekly(files: PlanFile[], links: Map<string, Link[]>, byKey: Map<string, AgentSessionSnapshot>, now: number, weeks = 8, gran: 'week' | 'day' = 'week'): WeekBucket[] {
  const step = gran === 'day' ? 86_400_000 : 7 * 86_400_000;
  const start0 = gran === 'day' ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() : weekStart(now);
  const buckets: WeekBucket[] = [];
  for (let k = 0; k < weeks; k++) {
    // step back with calendar dates so DST shifts don't drift the boundary
    const d = new Date(start0);
    d.setDate(d.getDate() - k * (gran === 'day' ? 1 : 7));
    const s = d.getTime();
    buckets.push({ start: s, label: gran === 'day' ? d.toISOString().slice(0, 10) : isoWeek(s), done: [], added: 0, sessions: new Set() });
  }
  const find = (t: number) => buckets.find(b => t >= b.start && t < b.start + step + 3_600_000 && (gran === 'day' ? new Date(t).toDateString() === new Date(b.start).toDateString() : weekStart(t) === b.start));
  for (const f of files) {
    for (const it of f.items) {
      const ls = links.get(`${f.file}#${it.line}`);
      if (it.state === 'done') {
        const c = closedAt(it, f, ls, byKey);
        const b = find(c.at);
        if (!b) continue;
        b.done.push({ f, it, at: c.at, basis: c.basis });
        for (const l of ls ?? []) b.sessions.add(l.key);
      } else if (it.state !== 'dropped' && it.datedOwn && it.dated !== undefined) {
        const b = find(it.dated);
        if (b) b.added++;
      }
    }
  }
  for (const b of buckets) b.done.sort((x, y) => y.at - x.at);
  return buckets;
}

/** Short stable key for a path, usable as a toggle value ([a-z0-9]). */
export function fileKey(p: string): string {
  let h = 0x811c9dc5;
  const s = norm(p);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
