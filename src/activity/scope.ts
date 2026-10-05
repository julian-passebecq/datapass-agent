// Scope map: the plan files Backlog already parsed (src/activity/backlog.ts), regrouped per project → milestone
// → section → item, with done / left counts and the state changes since an older archive snapshot. Pure
// functions: no fs, no process. Milestones are headings (level 2+) the parser recorded on each item.
import type { BacklogItem, ItemState, Link, PlanFile } from './backlog';

/** Map state: Backlog's "open" is shown as pending. Dropped items stay visible but out of the totals. */
export type MapState = 'done' | 'active' | 'pending' | 'blocked' | 'dropped';
export const MAP_STATES: MapState[] = ['done', 'active', 'blocked', 'pending', 'dropped'];
export const MAP_LABEL: Record<MapState, string> = { done: 'Done', active: 'Active', pending: 'Pending', blocked: 'Blocked', dropped: 'Dropped' };

export const toMap = (s: ItemState): MapState => (s === 'open' ? 'pending' : s);

export const UNSORTED = 'Unsorted';
/** Heading words that name a milestone; the first matching heading of an item's trail wins, else its outermost heading. */
export const MILESTONE_RE = /\b(milestones?|jalons?|waves?|vagues?|phases?|sprints?|releases?|versions?|stages?|iterations?|v\d+(?:\.\d+)*(?:\.x)?|m\d+)\b/i;

export const MAX_MILESTONES = 60;
export const MAX_PROJECTS = 60;

export interface Change {
  /** State in the baseline snapshot; 'new' when the item was not in it. */
  from: ItemState | 'new';
  to: ItemState;
}

export interface MapItem {
  f: PlanFile;
  it: BacklogItem;
  state: MapState;
  links: Link[];
  change?: Change;
}

export interface Counts {
  done: number;
  active: number;
  blocked: number;
  pending: number;
  dropped: number;
}

export interface MapGroup {
  name: string;
  items: MapItem[];
}

export interface Milestone {
  /** Stable within a project: file + heading. */
  key: string;
  name: string;
  file: PlanFile;
  /** Line of the first item (for ordering and opening). */
  line: number;
  groups: MapGroup[];
  counts: Counts;
  /** done + active + blocked + pending (dropped excluded). */
  total: number;
  /** active + blocked + pending. */
  left: number;
  changed: number;
}

export interface ProjectMap {
  root: string;
  repo: string;
  files: PlanFile[];
  milestones: Milestone[];
  counts: Counts;
  total: number;
  left: number;
  changed: number;
  /** Distinct linked session keys. */
  sessions: Set<string>;
  /** Milestones cut by MAX_MILESTONES. */
  more: number;
}

export function emptyCounts(): Counts {
  return { done: 0, active: 0, blocked: 0, pending: 0, dropped: 0 };
}

export const totalOf = (c: Counts) => c.done + c.active + c.blocked + c.pending;
export const leftOf = (c: Counts) => c.active + c.blocked + c.pending;

/** Milestone and section of an item from its heading trail (or its "a › b" section when the trail is absent). */
export function milestoneOf(it: Pick<BacklogItem, 'trail' | 'section'>): { milestone: string; group: string } {
  const trail = it.trail?.length ? it.trail : [];
  if (!trail.length) return { milestone: UNSORTED, group: '' };
  let k = trail.findIndex(t => MILESTONE_RE.test(t));
  if (k < 0) k = 0;
  return { milestone: trail[k], group: trail.slice(k + 1).join(' › ') };
}

const nk = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Per project (repository root): milestones in file order, items grouped by the section below the milestone.
 * `baseline` maps keyOf(file, item) → state in an older snapshot; when given, items whose state differs (or
 * that are new) carry a change.
 */
export function buildMaps(
  files: PlanFile[],
  links: Map<string, Link[]>,
  baseline?: { states: Map<string, ItemState>; keyOf: (f: PlanFile, it: BacklogItem) => string },
): ProjectMap[] {
  const projects = new Map<string, ProjectMap>();
  const ms = new Map<string, Map<string, Milestone>>();
  for (const f of files) {
    if (f.archive || f.skipped) continue;
    const pk = nk(f.root);
    let p = projects.get(pk);
    if (!p) {
      if (projects.size >= MAX_PROJECTS) continue;
      projects.set(pk, (p = { root: f.root, repo: f.repo, files: [], milestones: [], counts: emptyCounts(), total: 0, left: 0, changed: 0, sessions: new Set(), more: 0 }));
      ms.set(pk, new Map());
    }
    p.files.push(f);
    const pm = ms.get(pk)!;
    for (const it of f.items) {
      const { milestone, group } = milestoneOf(it);
      const mk = `${f.rel}\u0000${milestone}`;
      let m = pm.get(mk);
      if (!m) {
        if (pm.size >= MAX_MILESTONES) {
          p.more++;
          continue;
        }
        pm.set(mk, (m = { key: mk, name: milestone, file: f, line: it.line, groups: [], counts: emptyCounts(), total: 0, left: 0, changed: 0 }));
      }
      let g = m.groups.find(x => x.name === group);
      if (!g) m.groups.push((g = { name: group, items: [] }));
      const ls = links.get(`${f.file}#${it.line}`) ?? [];
      const mi: MapItem = { f, it, state: toMap(it.state), links: ls };
      if (baseline) {
        const from = baseline.states.get(baseline.keyOf(f, it));
        if (from === undefined) mi.change = { from: 'new', to: it.state };
        else if (from !== it.state) mi.change = { from, to: it.state };
      }
      g.items.push(mi);
      m.counts[mi.state]++;
      if (mi.change) m.changed++;
      for (const l of ls) p.sessions.add(l.key);
    }
  }
  for (const [pk, p] of projects) {
    p.milestones = [...ms.get(pk)!.values()];
    for (const m of p.milestones) {
      m.total = totalOf(m.counts);
      m.left = leftOf(m.counts);
      for (const s of MAP_STATES) p.counts[s] += m.counts[s];
      p.changed += m.changed;
    }
    p.total = totalOf(p.counts);
    p.left = leftOf(p.counts);
  }
  return [...projects.values()];
}

/** Share of done over items not dropped, 0..1 (DERIVED). */
export const progress = (c: Counts) => (totalOf(c) ? c.done / totalOf(c) : 0);

// ---------------------------------------------------------------- baseline snapshot choice

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d: string) => new Date(`${d}T12:00:00`).getTime();

/**
 * Baseline for "changes since": the newest snapshot at least 7 days before `today` (the previous weekly
 * snapshot); else the oldest snapshot before today. Undefined when there is none.
 */
export function pickBaseline(days: string[], today: string): string | undefined {
  const ok = days.filter(d => DAY.test(d) && d < today).sort();
  if (!ok.length) return undefined;
  const cut = dayMs(today) - 7 * 86_400_000;
  const week = ok.filter(d => dayMs(d) <= cut + 3_600_000);
  return week.length ? week[week.length - 1] : ok[0];
}
