// Add-on screen "Panes": 2 to 4 other screens side by side in one tab (a dev-workspace layout). Each cell
// renders the existing renderer of its screen from the same scoped snapshot, so every value keeps the
// evidence label its own screen gives it; this screen adds no number of its own. Logic in src/activity/panes.ts.
import { LAYOUTS, layoutOf, PANES_ID, paneViews } from '../../activity/panes';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { allViews, renderView, viewHint, viewLabel } from '../workspace';
import { ExtraView, seg, toolbar } from './kit';

const LAYOUT_LABEL: Record<string, string> = { '2col': '2 columns', '2row': '2 rows', '2x2': '2 × 2', '1p2': '1 + 2' };

function picker(i: number, cur: string, choices: string[]): string {
  const opts = choices.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(viewLabel(v))}</option>`).join('');
  return `<select class="pn-sel" data-opt="panes.p${i}" aria-label="${esc(`Screen in pane ${i + 1}`)}" title="Screen shown in this pane">${opts}</select>`;
}

export function renderPanes(d: WsData, st: WsState): string {
  const available = allViews().filter(v => v !== PANES_ID);
  const layout = layoutOf(st.opts);
  const views = paneViews(st.opts, available);
  let h = toolbar(seg(st, 'panes.layout', LAYOUTS.map(l => [l, LAYOUT_LABEL[l]] as [string, string]), layout, 'Pane layout'), '<span class="muted">Each pane is the full screen, scrollable in its cell; evidence labels are those of the screen itself. Two panes of the same screen share its options.</span>');
  if (!views.length) return h + '<div class="empty">No screen to show.</div>';
  h += `<div class="pn pn-${esc(layout)}">`;
  views.forEach((v, i) => {
    let body: string;
    try {
      body = renderView(d, st, v);
    } catch (e) {
      body = `<div class="empty">This screen failed to render: ${esc(String((e as Error)?.message ?? e).slice(0, 200))}</div>`;
    }
    h += `<section class="pn-c pn-c${i}" aria-label="${esc(viewLabel(v))}"><header class="pn-h">${picker(i, v, available)}<span class="muted pn-hint" title="${esc(viewHint(v))}">${esc(viewHint(v))}</span><button class="link pn-full" data-nav="${esc(v)}" title="Open this screen full size">open full ↗</button></header><div class="pn-b">${body || '<div class="empty">Empty.</div>'}</div></section>`;
  });
  return h + '</div>';
}

const CSS = `
.pn { display: grid; gap: 8px; height: calc(100vh - 150px); min-height: 360px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); }
.pn-2row { grid-template-columns: minmax(0, 1fr); }
.pn-1p2 { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
.pn-1p2 .pn-c0 { grid-row: 1 / span 2; }
.pn-c { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
.pn-h { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-bottom: 1px solid var(--line); background: var(--raise); font-size: 11px; flex: none; min-width: 0; }
.pn-sel { font: inherit; font-size: 11px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, transparent); border: 1px solid var(--vscode-dropdown-border, var(--line)); border-radius: 3px; padding: 1px 4px; }
.pn-hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pn-full { white-space: nowrap; font-size: 11px; }
.pn-b { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 4px 8px 8px; }
@media (max-width: 900px) { .pn, .pn-1p2 { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-auto-rows: minmax(320px, 60vh); height: auto; } .pn-1p2 .pn-c0 { grid-row: auto; } }
`;

export const panesView: ExtraView = {
  id: PANES_ID,
  label: 'Panes',
  group: 'Now',
  hint: '2 to 4 screens side by side in one tab; pick the layout and the screen of each pane.',
  ready: true,
  render: renderPanes,
  css: CSS,
};
