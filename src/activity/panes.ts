// Panes screen logic: which layout and which screens fill the cells. Pure functions of the option map,
// so the renderer (render/extra/panes.ts) and the panel (ui/workspace.ts, feeds and actions) agree.

export const PANES_ID = 'panes';
/** '1p2' is the 1 + 2 layout (option values cannot hold '+'). */
export const LAYOUTS = ['2col', '2row', '2x2', '1p2'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const DEFAULT_LAYOUT: Layout = '2x2';
/** Default screen per cell (p0..p3). */
export const DEFAULT_PANES = ['live', 'workflows', 'limits', 'backlog'] as const;
export const MAX_PANES = 4;

const COUNT: Record<Layout, number> = { '2col': 2, '2row': 2, '2x2': 4, '1p2': 3 };

export function layoutOf(opts: Record<string, string> | undefined): Layout {
  const v = opts?.['panes.layout'];
  return (LAYOUTS as readonly string[]).includes(v ?? '') ? (v as Layout) : DEFAULT_LAYOUT;
}

export function paneCount(layout: Layout): number {
  return COUNT[layout];
}

/**
 * Screen ids of the visible cells. A cell's choice (`panes.p<i>`) is kept when it names an available screen
 * other than the panes screen itself (no recursion); otherwise the cell's default, then the first available
 * screen not shown yet. Duplicates chosen on purpose are allowed (the user may compare two options).
 */
export function paneViews(opts: Record<string, string> | undefined, available: readonly string[]): string[] {
  const ok = available.filter(v => v !== PANES_ID);
  if (!ok.length) return [];
  const n = paneCount(layoutOf(opts));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pick = opts?.[`panes.p${i}`];
    if (pick && ok.includes(pick)) {
      out.push(pick);
      continue;
    }
    const def = DEFAULT_PANES[i];
    out.push(ok.includes(def) && !out.includes(def) ? def : ok.find(v => !out.includes(v)) ?? ok[0]);
  }
  return out;
}

/** Screens whose data must be live in the panel: the visible screen, or every cell when it is the panes screen. */
export function visibleViews(view: string, opts: Record<string, string> | undefined, available: readonly string[]): string[] {
  if (view !== PANES_ID) return [view];
  return [...new Set(paneViews(opts, available))];
}
