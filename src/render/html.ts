// Shared webview shell: strict CSP (nonce scripts, no remote), theme variables only.

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function csp(cspSource: string, n: string): string {
  return `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${cspSource};`;
}

export const STYLE = `
:root { --gap: 6px; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: transparent; padding: 4px 8px 12px; margin: 0; line-height: 1.35; }
h2 { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 12px 0 4px; }
.kpis { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 6px; }
.kpi { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 8px; min-width: 52px; }
.kpi b { display: block; font-size: 16px; font-variant-numeric: tabular-nums; }
.kpi span { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
.row { display: grid; grid-template-columns: 12px 1fr auto; gap: 2px 6px; padding: 3px 4px; border-radius: 3px; cursor: pointer; align-items: baseline; }
.row:hover, .row:focus { background: var(--vscode-list-hoverBackground); outline: none; }
.row .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub { grid-column: 2 / 4; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .right { color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.RUNNING { background: var(--vscode-charts-green); } .IDLE { background: var(--vscode-charts-yellow); } .NEEDS_INPUT { background: var(--vscode-charts-orange); }
.ENDED { background: var(--vscode-disabledForeground, #888); } .UNKNOWN { background: transparent; border: 1px solid var(--vscode-descriptionForeground); box-sizing: border-box; }
.prov { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 8px 0 2px; }
.muted { color: var(--vscode-descriptionForeground); }
.pass { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); } .fail { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td, th { padding: 2px 4px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 11px; }
.tl { display: grid; grid-template-columns: 42px 92px 1fr; gap: 0 6px; font-size: 12px; padding: 1px 0; }
.tl .t { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.tl .k { font-size: 10px; letter-spacing: .03em; color: var(--vscode-descriptionForeground); }
.tl .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl.COMMIT .l, .tl.SESSION_STARTED .l, .tl.SESSION_ENDED .l, .tl.WORKER_STARTED .l, .tl.WORKER_ENDED .l { font-weight: 600; }
.bar { height: 8px; background: var(--vscode-charts-blue); border-radius: 2px; display: inline-block; vertical-align: middle; }
.bar.codex { background: var(--vscode-charts-purple); }
.tree { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; overflow-x: auto; }
.tree a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.chip { display: inline-block; font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground)); color: var(--vscode-descriptionForeground); margin-left: 4px; }
.ev { font-size: 10px; } .OBSERVED { }
.section { margin-bottom: 10px; }
dl { display: grid; grid-template-columns: 110px 1fr; gap: 2px 8px; margin: 0; }
dt { color: var(--vscode-descriptionForeground); } dd { margin: 0; overflow-wrap: anywhere; }
button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; }
.filter { display: flex; gap: 6px; align-items: center; margin: 2px 0 6px; font-size: 11px; }
.empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
`;

/** Client script: renders host-escaped HTML into #root (keeps scroll), forwards clicks on [data-open]/[data-cmd]. */
const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
window.addEventListener('message', e => {
  const m = e.data;
  if (m && m.type === 'render' && typeof m.html === 'string') root.innerHTML = m.html;
});
vscode.postMessage({ type: 'ready', key: '' });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-open],[data-cmd]');
  if (!el) return;
  if (el.dataset.open) vscode.postMessage({ type: 'open', key: el.dataset.open });
  else vscode.postMessage({ type: 'cmd', cmd: el.dataset.cmd, key: el.dataset.key || '' });
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.open) vscode.postMessage({ type: 'open', key: e.target.dataset.open }); });
`;

export function page(cspSource: string, body: string): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(cspSource, n)}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLE}</style></head><body><div id="root">${body}</div><script nonce="${n}">${SCRIPT}</script></body></html>`;
}

export type WebviewMessage = { type: 'ready'; key: '' } | { type: 'open'; key: string } | { type: 'cmd'; cmd: 'refresh' | 'timelineAll' | 'revealWorktree' | 'copySessionId' | 'openTimeline' | 'openInTern' | 'openArtifactFolder'; key: string };

const CMDS = new Set(['refresh', 'timelineAll', 'revealWorktree', 'copySessionId', 'openTimeline', 'openInTern', 'openArtifactFolder']);

/** Strict validation of anything a webview posts back. Unknown shapes are dropped. */
export function validateMessage(m: unknown, knownKey: (k: string) => boolean): WebviewMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const key = typeof o.key === 'string' && o.key.length <= 200 ? o.key : undefined;
  if (key === undefined) return undefined;
  if (o.type === 'ready' && key === '') return { type: 'ready', key: '' };
  if (o.type === 'open' && knownKey(key)) return { type: 'open', key };
  if (o.type === 'cmd' && typeof o.cmd === 'string' && CMDS.has(o.cmd) && (key === '' || knownKey(key))) return { type: 'cmd', cmd: o.cmd as any, key };
  return undefined;
}
