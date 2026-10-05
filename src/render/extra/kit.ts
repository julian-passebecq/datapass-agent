// Shared contract and small controls for add-on workspace screens (src/render/extra/*.ts).
// A screen is a pure function of snapshots; it escapes everything it prints.
import type { WsData, WsState } from '../workspace';
import { esc } from '../html';
import type { Feed } from './feeds';

/** Host services an add-on screen action may use. Implemented by the workspace panel with the VS Code API. */
export interface ActCtx {
  /** Opens a file in an editor (read-only preview unless the user edits). */
  openFile(path: string): Promise<void>;
  revealInOs(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  info(message: string): void;
  /** Modal yes / no. Every action that writes or starts something asks first. */
  confirm(message: string, yes: string): Promise<boolean>;
  /** Save dialog, then writes text. Returns the path or undefined if cancelled. */
  saveText(defaultName: string, content: string): Promise<string | undefined>;
  /** New VS Code terminal owned by Agent; returns an id usable with closeTerminal. */
  openTerminal(name: string, cwd: string, command: string): string;
  closeTerminal(id: string): void;
  runCommand(id: string, ...args: unknown[]): Promise<unknown>;
  /** Re-pump this screen's feeds now. */
  refreshFeeds(): void;
  /** Current sessions (after scope). */
  sessions(): import('../../model').AgentSessionSnapshot[];
}

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
  /** Async data loaded while this screen is visible (see feeds.ts). */
  feeds?: Feed[];
  /**
   * Buttons with data-act="<name>" data-arg="<string ≤ 1000>" call actions[name](arg, ctx).
   * Validate arg inside the action (it comes from the webview).
   */
  actions?: Record<string, (arg: string, ctx: ActCtx) => Promise<void> | void>;
}

/** Button that triggers an action of the current screen. */
export function actBtn(name: string, arg: string, label: string, title = '', cls = 'link'): string {
  return `<button class="${esc(cls)}" data-act="${esc(name)}" data-arg="${esc(arg)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
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

/** Seconds before a loading marker turns into a timeout note with a Retry button (the webview counts, see html.ts). */
export const LOAD_TIMEOUT_S = 60;

/**
 * Loading marker for a feed that has no value yet. The webview shows the elapsed seconds next to the text and,
 * after `timeoutS`, a "no answer" note and a Retry button. Evidence: UNKNOWN (nothing read yet).
 * `retry` names a screen action (data-act) that re-pumps the feeds; without it Retry posts the global refresh.
 */
export function loading(id: string, text: string, o: { retry?: string; timeoutS?: number; inline?: boolean } = {}): string {
  const tag = o.inline ? 'span' : 'div';
  const t = Math.max(1, Math.round(o.timeoutS ?? LOAD_TIMEOUT_S));
  return `<${tag} class="${o.inline ? 'muted' : 'empty'} ld" data-loading="${esc(id)}" data-timeout="${t}" role="status" aria-live="polite"><span class="ld-x">${esc(text)}</span><span class="ld-t"></span> <span class="chip ev UNKNOWN" title="UNKNOWN: no value read yet">UNKNOWN</span> ${retryBtn(o.retry, 'ld-retry')}</${tag}>`;
}

/** Error state for a feed that failed: the message, an UNKNOWN chip and a Retry button. */
export function loadError(text: string, retry?: string): string {
  return `<div class="empty ld-err" role="alert"><span class="ld-x">${esc(text)}</span> <span class="chip ev UNKNOWN" title="UNKNOWN: the source could not be read">UNKNOWN</span> ${retryBtn(retry, '')}</div>`;
}

function retryBtn(act: string | undefined, cls: string): string {
  const c = cls ? `link ${cls}` : 'link';
  return act ? actBtn(act, '', 'Retry', 'Read the source again now', c) : `<button class="${c}" data-cmd="refresh" title="Refresh now">Retry</button>`;
}

export const KIT_CSS = `
.ld .ld-retry { display: none; } .ld.ld-late .ld-retry { display: inline; } .ld.ld-late .ld-t { color: var(--vscode-foreground); }
.ld-err .ld-x { color: color-mix(in srgb, var(--bad) 70%, var(--vscode-foreground)); }
.tb { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 2px 0 8px; font-size: 11px; }
.seg { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.seg button { background: none; border: none; border-right: 1px solid var(--line); color: var(--vscode-descriptionForeground); padding: 2px 8px; cursor: pointer; font: inherit; }
.seg button:last-child { border-right: none; }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.railg { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 8px 0 2px 6px; }
`;
