// View logic for the Transcript screen: filters, the page window (follow / jump to time), the time strip and
// spawn → worker links. Pure functions over entries from src/providers/transcript.ts.
import type { AgentSessionSnapshot, EvidenceKind } from '../model';
import type { Entry, EntryKind } from '../providers/transcript';

export type Mode = 'chat' | 'log' | 'tools';
export type Only = 'all' | 'talk' | 'errors' | 'spawns' | 'prompts';

export interface ViewOpts {
  mode: Mode;
  only: Only;
  /** Tool name slug ('' = all tools). */
  tool: string;
  thinking: boolean;
  meta: boolean;
}

export const toolSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 40);

const TALK: ReadonlySet<EntryKind> = new Set(['prompt', 'reply', 'command']);
const ALWAYS: ReadonlySet<EntryKind> = new Set(['compact', 'error']);

export function isError(e: Entry): boolean {
  return e.kind === 'error' || !!e.result?.error;
}

export function visible(e: Entry, o: ViewOpts): boolean {
  if (o.tool && !((e.kind === 'tool' || e.kind === 'spawn') && toolSlug(e.name ?? '') === o.tool)) return false;
  if (o.only === 'errors') return isError(e);
  if (o.only === 'spawns') return e.kind === 'spawn';
  if (o.only === 'prompts') return e.kind === 'prompt' || e.kind === 'command';
  if (o.mode === 'tools') return e.kind === 'tool' || e.kind === 'spawn' || e.kind === 'error';
  if (o.only === 'talk') return TALK.has(e.kind) || ALWAYS.has(e.kind);
  if (e.kind === 'thinking') return o.thinking;
  if (e.kind === 'meta' || e.kind === 'turn') return o.meta;
  return true;
}

export interface Window {
  items: Entry[];
  /** Index range [start, end) in the filtered list. */
  start: number;
  end: number;
  total: number;
  /** Anchor time of the previous / next page ('' when there is none). */
  older?: number;
  newer?: number;
  following: boolean;
}

/**
 * Page of the filtered entries. Without an anchor the page holds the latest entries (follow mode);
 * with an anchor it starts at the first entry at or after that time.
 */
export function pageOf(list: Entry[], size: number, anchor?: number): Window {
  const total = list.length;
  let start: number;
  if (anchor === undefined || !isFinite(anchor)) start = Math.max(0, total - size);
  else {
    start = list.findIndex(e => e.at >= anchor);
    if (start < 0) start = Math.max(0, total - size);
  }
  const end = Math.min(total, start + size);
  const following = anchor === undefined || end >= total;
  return {
    items: list.slice(start, end),
    start,
    end,
    total,
    older: start > 0 ? list[Math.max(0, start - size)].at : undefined,
    newer: end < total ? list[end].at : undefined,
    following,
  };
}

export interface Bucket {
  t0: number;
  t1: number;
  n: number;
  prompts: number;
  tools: number;
  errors: number;
}

/** Activity strip across the loaded span (equal time buckets). */
export function strip(list: Entry[], buckets = 60): Bucket[] {
  if (!list.length) return [];
  // Record order is kept, so times are only nearly sorted (nested items carry their start time).
  let a = Infinity, b = -Infinity;
  for (const e of list) {
    if (e.at > 0 && e.at < a) a = e.at;
    if (e.at > b) b = e.at;
  }
  if (!isFinite(a) || !isFinite(b)) return [];
  const span = Math.max(1, b - a);
  const n = Math.max(1, Math.min(buckets, list.length));
  const out: Bucket[] = Array.from({ length: n }, (_, i) => ({ t0: a + Math.floor((i * span) / n), t1: a + Math.floor(((i + 1) * span) / n), n: 0, prompts: 0, tools: 0, errors: 0 }));
  for (const e of list) {
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.at - a) / span) * n)));
    const k = out[i];
    k.n++;
    if (e.kind === 'prompt' || e.kind === 'command') k.prompts++;
    if (e.kind === 'tool' || e.kind === 'spawn') k.tools++;
    if (isError(e)) k.errors++;
  }
  return out;
}

export interface Counts {
  prompts: number;
  replies: number;
  tools: number;
  errors: number;
  thinking: number;
  thinkingChars: number;
  compactions: number;
  spawns: number;
}

export function counts(list: Entry[]): Counts {
  const c: Counts = { prompts: 0, replies: 0, tools: 0, errors: 0, thinking: 0, thinkingChars: 0, compactions: 0, spawns: 0 };
  for (const e of list) {
    if (e.kind === 'prompt') c.prompts++;
    else if (e.kind === 'reply') c.replies++;
    else if (e.kind === 'tool') c.tools++;
    else if (e.kind === 'spawn') c.spawns++;
    else if (e.kind === 'compact') c.compactions++;
    else if (e.kind === 'thinking') {
      c.thinking++;
      c.thinkingChars += e.chars ?? 0;
    }
    if (isError(e)) c.errors++;
  }
  return c;
}

/** Tool names by calls, most used first. */
export function toolNames(list: Entry[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of list) if ((e.kind === 'tool' || e.kind === 'spawn') && e.name) m.set(e.name, (m.get(e.name) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface WorkerLink {
  key: string;
  kind: EvidenceKind;
  basis: string;
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Links spawn entries to worker sessions (children of the session). First pass: worker title or label equals
 * the spawn description (OBSERVED, both come from the provider). Second pass: the next unused worker that
 * started within 2 minutes after the spawn (INFERRED).
 */
export function workerLinks(spawns: Entry[], children: AgentSessionSnapshot[]): Map<number, WorkerLink> {
  const out = new Map<number, WorkerLink>();
  const used = new Set<string>();
  for (const e of spawns) {
    const d = norm(e.spawn?.description);
    if (!d) continue;
    const c = children.find(k => !used.has(k.key) && (norm(k.title) === d || norm(k.workerLabel) === d));
    if (c) {
      used.add(c.key);
      out.set(e.id, { key: c.key, kind: 'OBSERVED', basis: 'worker description equals the spawn description' });
    }
  }
  const byStart = [...children].filter(k => k.startedAt !== undefined).sort((a, b) => a.startedAt! - b.startedAt!);
  for (const e of spawns) {
    if (out.has(e.id)) continue;
    const c = byStart.find(k => !used.has(k.key) && k.startedAt! >= e.at - 5_000 && k.startedAt! <= e.at + 120_000);
    if (c) {
      used.add(c.key);
      out.set(e.id, { key: c.key, kind: 'INFERRED', basis: 'first unlinked worker that started within 2 min after the spawn' });
    }
  }
  return out;
}
