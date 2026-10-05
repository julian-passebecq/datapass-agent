// Shared contract and small controls for add-on workspace screens (src/render/extra/*.ts).
// A screen is a pure function of snapshots; it escapes everything it prints.
import type { WsData, WsState } from '../workspace';
import { esc } from '../html';

export interface ExtraView {
  /** Stable id: lowercase letters, digits and dashes. Used in data-nav and the message allow-list. */
  id: string;
  label: string;
  hint: string;
  /** Rail group. */
  group: 'Now' | 'Sessions' | 'Time' | 'Git' | 'Usage' | 'Quality' | 'System';
  render(d: WsData, st: WsState): string;
  /** Scoped CSS for this screen (prefix every selector with a class unique to the screen). */
  css?: string;
  badge?(d: WsData): string;
  /** false keeps a planned screen out of the rail until its package lands. */
  ready?: boolean;
}

/** Current value of a per-screen option (granularity, orientation, chart type …). */
export function opt(st: WsState, name: string, fallback: string): string {
  return st.opts?.[name] ?? fallback;
}

/**
 * Segmented toggle: clicking posts {type:'opt', name, value}. Host stores it in WsState.opts.
 * Names: [a-z0-9.-]{1,40}; values: [a-z0-9._:-]{0,40}.
 */
export function seg(st: WsState, name: string, choices: [value: string, label: string][], fallback: string, title = ''): string {
  const cur = opt(st, name, fallback);
  return `<span class="seg" role="group"${title ? ` title="${esc(title)}"` : ''}>${choices.map(([v, l]) => `<button class="${v === cur ? 'on' : ''}" data-opt="${esc(name)}" data-val="${esc(v)}">${esc(l)}</button>`).join('')}</span>`;
}

/** A row of toggles above a screen. */
export function toolbar(...parts: string[]): string {
  return `<div class="tb">${parts.filter(Boolean).join('')}</div>`;
}

export const KIT_CSS = `
.tb { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 2px 0 8px; font-size: 11px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.seg button { background: none; border: none; border-right: 1px solid var(--line); color: var(--vscode-descriptionForeground); padding: 2px 8px; cursor: pointer; font: inherit; }
.seg button:last-child { border-right: none; }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.railg { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 8px 0 2px 6px; }
`;
