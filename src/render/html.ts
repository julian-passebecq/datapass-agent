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
:root { --gap: 6px; --ok: var(--vscode-charts-green, #4caf50); --warn: var(--vscode-charts-orange, #d18616); --bad: var(--vscode-charts-red, #e5534b); --accent: var(--vscode-charts-blue, #4f9fd9); --quiet: var(--vscode-disabledForeground, #888); --claude: #d97757; --codex: #8b7cf6; --line: var(--vscode-widget-border, var(--vscode-panel-border, #8884)); --raise: var(--vscode-editorWidget-background, #8881); }
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
/* ---- workspace ---- */
.ws { display: grid; grid-template-columns: 150px minmax(0, 1fr) 300px; min-height: calc(100vh - 16px); margin: -4px -8px -12px; }
.rail { border-right: 1px solid var(--line); padding: 10px 6px; display: flex; flex-direction: column; gap: 1px; position: sticky; top: 0; height: calc(100vh - 20px); }
.brand { font-weight: 700; font-size: 14px; padding: 2px 8px 10px; letter-spacing: .02em; }
.nav { display: flex; justify-content: space-between; align-items: center; text-align: left; background: none; border: none; color: var(--vscode-foreground); padding: 5px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
.nav:hover { background: var(--vscode-list-hoverBackground); } .nav.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.nb { font-size: 10px; min-width: 16px; text-align: center; border-radius: 8px; padding: 0 5px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); } .nb.hot { background: var(--bad); color: #fff; }
.rail { overflow-y: auto; } .rg { display: flex; flex-direction: column; gap: 1px; margin-bottom: 4px; }
.rail .railg { display: flex; align-items: center; gap: 4px; width: 100%; background: none; border: none; cursor: pointer; font: inherit; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 6px 0 2px; padding: 2px 4px; border-radius: 3px; }
.rail .railg:hover { background: var(--vscode-list-hoverBackground); } .rail .chev { width: 10px; } .rail .rgc { margin-left: auto; font-size: 10px; opacity: .7; }
.rail .nav { padding: 4px 8px 4px 18px; }
.railfoot { margin-top: auto; font-size: 11px; padding: 8px; display: grid; gap: 3px; }
.mainw { padding: 10px 16px 24px; min-width: 0; }
.mh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; } .mh h1 { font-size: 18px; margin: 0; } .mh .right { margin-left: auto; font-size: 11px; }
.side { border-left: 1px solid var(--line); padding: 10px 12px; position: sticky; top: 0; height: calc(100vh - 20px); overflow-y: auto; }
.kpis.big .kpi { min-width: 78px; padding: 6px 10px; border-radius: 6px; background: var(--raise); } .kpis.big .kpi b { font-size: 20px; }
.k-run b { color: var(--ok); } .k-need b { color: var(--warn); } .k-fail b { color: var(--bad); } .k-idle b { color: var(--vscode-charts-yellow); }
.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 2fr); gap: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.card { border: 1px solid var(--line); border-left: 3px solid var(--id, var(--accent)); border-radius: 6px; padding: 7px 9px; background: var(--raise); cursor: pointer; display: grid; gap: 2px; min-width: 0; }
.card:hover { border-color: var(--vscode-focusBorder); border-left-color: var(--id); }
.card.sel, .att.sel, .gr.sel, tr.sel, .agent.sel { outline: 1px solid var(--vscode-focusBorder); }
.ct { display: flex; align-items: center; gap: 6px; } .ct b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; } .ct .right { color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.cl { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .cl.num { font-variant-numeric: tabular-nums; } .cl .who { color: var(--id); font-weight: 600; } .cl.act { color: var(--vscode-foreground); }
.meter { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin: 2px 0; } .meter i { display: block; height: 100%; background: var(--ok); } .meter.warm i { background: var(--vscode-charts-yellow); } .meter.hot i { background: var(--bad); }
.stages { display: inline-flex; flex-wrap: wrap; gap: 2px; margin-top: 3px; } .stg { font-size: 9px; letter-spacing: .04em; text-transform: uppercase; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.stg.done { background: color-mix(in srgb, var(--ok) 22%, transparent); border-color: color-mix(in srgb, var(--ok) 55%, transparent); color: var(--vscode-foreground); }
.stg.fail { background: color-mix(in srgb, var(--bad) 25%, transparent); border-color: var(--bad); color: var(--vscode-foreground); }
.stg.live { background: color-mix(in srgb, var(--accent) 25%, transparent); border-color: var(--accent); color: var(--vscode-foreground); }
.att { display: grid; grid-template-columns: 54px 1fr auto; gap: 8px; align-items: start; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; cursor: pointer; background: var(--raise); }
.att .sev { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; text-align: center; border-radius: 3px; padding: 1px 0; } .att.high .sev { background: var(--bad); color: #fff; } .att.medium .sev { background: var(--warn); color: #fff; } .att.low .sev { border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.att > div { min-width: 0; overflow-wrap: anywhere; } .basis { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; }
.board { display: grid; grid-template-columns: repeat(5, minmax(190px, 1fr)); gap: 10px; overflow-x: auto; align-items: start; } .col { display: grid; gap: 6px; min-width: 0; } .col > *, .grid > * { min-width: 0; } .card { overflow: hidden; }
.colh { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); } .colh .n { margin-left: auto; }
.pick { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.pill { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); border-left: 3px solid var(--id); border-radius: 12px; background: none; color: var(--vscode-foreground); padding: 2px 9px; cursor: pointer; font: inherit; font-size: 11px; } .pill.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.org .lead { max-width: 380px; margin: 0 auto; } .org .lead::after { content: ''; display: block; width: 2px; height: 14px; background: var(--line); margin: 0 auto; }
.lanes { border-top: 2px solid var(--line); padding-top: 12px; display: grid; gap: 12px; } .lane { border-left: 3px solid var(--id); padding-left: 10px; } .laneh { margin-bottom: 5px; } .laneh b { color: var(--id); text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
svg.flow { width: 100%; height: auto; max-height: 70vh; } svg.flow text { fill: var(--vscode-foreground); font-size: 12px; } svg.flow text.halo { paint-order: stroke; stroke: var(--vscode-editor-background, #1f1f1f); stroke-width: 4px; stroke-linejoin: round; } svg.flow tspan.muted { fill: var(--vscode-descriptionForeground); } svg.flow path:hover { opacity: .8; }
.repo { border: 1px solid var(--line); border-top: 3px solid var(--id); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; background: var(--raise); } .repoh { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; } .repoh b { font-size: 13px; }
.sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: var(--id); margin-right: 4px; }
.wt { display: grid; grid-template-columns: minmax(160px, 260px) 1fr; gap: 8px; padding: 4px 0; border-top: 1px dashed var(--line); align-items: start; } .wtn { font-family: var(--vscode-editor-font-family); font-size: 12px; } .br { color: var(--id); font-weight: 600; } .wt .who { display: flex; flex-wrap: wrap; gap: 4px; }
.agent { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 10px; padding: 0 7px; font-size: 11px; cursor: pointer; }
.gantt { display: grid; gap: 2px; } .gh, .gr { display: grid; grid-template-columns: 220px 1fr; gap: 8px; align-items: center; } .gr { cursor: pointer; border-radius: 3px; } .gr:hover { background: var(--vscode-list-hoverBackground); }
.gl { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 5px; align-items: center; }
.track { position: relative; height: 16px; border-left: 1px solid var(--line); }
.gh .track { height: 14px; border: none; } .tick { position: absolute; font-size: 10px; color: var(--vscode-descriptionForeground); transform: translateX(-50%); } .now { position: absolute; top: 0; height: 14px; width: 2px; background: var(--bad); }
.bar2 { position: absolute; top: 3px; height: 10px; border-radius: 3px; background: var(--claude); opacity: .8; box-shadow: inset 3px 0 0 var(--id, transparent); } .bar2.codex { background: var(--codex); } .bar2.live { opacity: 1; }
.mk { position: absolute; top: 4px; width: 7px; height: 7px; transform: translateX(-50%) rotate(45deg); background: var(--vscode-foreground); } .mk.test { transform: translateX(-50%); width: 3px; height: 12px; top: 2px; } .mk.test.PASS { background: var(--ok); } .mk.test.FAIL { background: var(--bad); } .mk.test.UNKNOWN { background: var(--quiet); }
.legend { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; } .legend .sample { position: relative; display: inline-block; top: 0; left: 0; transform: none; } .legend .bar2.sample { width: 18px; height: 8px; } .legend .mk.commit.sample { transform: rotate(45deg); }
table.vt tr { cursor: pointer; } table.vt td:nth-child(1), table.vt td:nth-child(5), table.vt td:nth-child(6) { white-space: nowrap; } table.vt td:nth-child(2) { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } table.vt td:nth-child(3) { white-space: nowrap; } table.vt td:nth-child(4) code { display: block; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } table.vt tr:hover { background: var(--vscode-list-hoverBackground); } code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
.week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 8px; } .wd { display: grid; justify-items: center; gap: 2px; font-size: 11px; } .wd b { font-size: 14px; }
.stack { height: 90px; width: 26px; display: flex; flex-direction: column-reverse; border-radius: 4px; overflow: hidden; background: var(--raise); border: 1px solid var(--line); } .stack i { display: block; width: 100%; } .stack i.claude { background: var(--claude); } .stack i.codex { background: var(--codex); }
.heat { display: grid; grid-template-columns: 34px repeat(24, 1fr); gap: 2px; font-size: 10px; } .heat i { display: block; height: 15px; border-radius: 2px; background: var(--accent); } .hx, .hy { color: var(--vscode-descriptionForeground); }
.sd { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; } .sd.ready { background: var(--ok); } .sd.partial { background: var(--warn); } .sd.missing { background: var(--bad); } .sd.off { border: 1px solid var(--quiet); } .sd.RUNNING { background: var(--ok); } .sd.NEEDS_INPUT { background: var(--warn); } .sd.IDLE { background: var(--accent); } .sd.UNKNOWN, .sd.ENDED { background: var(--quiet); }
.st-ready { color: var(--ok); } .st-partial { color: var(--warn); } .st-missing { color: var(--bad); } .st-off { color: var(--quiet); } td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.split { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 2px 0 8px; } .split i.claude { background: var(--claude); } .split i.codex { background: var(--codex); }
.szbar { display: block; height: 8px; border-radius: 2px; background: var(--claude); } .szbar.codex { background: var(--codex); }
.cs { font-size: 11px; text-align: left; color: var(--vscode-descriptionForeground); }
.keys { position: sticky; bottom: 0; margin: 14px -16px -24px; padding: 4px 16px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background, #1f1f1f); border-top: 1px solid var(--line); } .keys b { color: var(--vscode-foreground); font-weight: 600; margin-left: 8px; } .keys b:first-child { margin-left: 0; }
.q { position: fixed; top: 6px; right: 316px; z-index: 5; width: 200px; padding: 3px 8px; font: inherit; font-size: 12px; color: var(--vscode-input-foreground, var(--vscode-foreground)); background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px; } .q:focus { outline: 1px solid var(--vscode-focusBorder); }
.hide { display: none !important; }
.foot { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
.sideh { border-left: 3px solid var(--id); padding-left: 8px; margin-bottom: 8px; } .sideh h3 { margin: 2px 0; font-size: 14px; overflow-wrap: anywhere; }
.rcard { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 4px; margin: 6px 0; } .rc { border: 1px solid var(--line); border-radius: 5px; padding: 3px 7px; background: var(--raise); min-width: 0; }
.rc span { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); } .rc b { font-weight: 600; font-variant-numeric: tabular-nums; font-size: 12px; overflow-wrap: anywhere; } .rc.ok { border-color: var(--ok); } .rc.bad { border-color: var(--bad); }
.sidestages { margin: 4px 0 8px; } .sloc { font-size: 12px; display: grid; gap: 2px; overflow-wrap: anywhere; } .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 3px 10px; cursor: pointer; font: inherit; } .btn:hover { background: var(--vscode-button-hoverBackground); }
.mini { font-size: 12px; padding: 2px 4px; border-radius: 3px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; } .mini:hover { background: var(--vscode-list-hoverBackground); } .tl2 { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) { .q { right: 12px; } .ws { grid-template-columns: 130px minmax(0, 1fr); } .side { grid-column: 1 / -1; position: static; height: auto; border-left: none; border-top: 1px solid var(--line); } .cols { grid-template-columns: 1fr; } }
@media (max-width: 700px) { .ws { grid-template-columns: 1fr; } .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; border-right: none; } .railfoot { display: none; } .board { grid-template-columns: repeat(5, 200px); } .gh, .gr { grid-template-columns: 120px 1fr; } }
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
footer.strip { position: sticky; bottom: 0; display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 3px 8px; margin: 8px -8px -12px; border-top: 1px solid var(--line); background: var(--vscode-editor-background); font-size: 11px; font-variant-numeric: tabular-nums; }
footer.strip .tkr { display: flex; gap: 10px; overflow: hidden; white-space: nowrap; min-width: 0; } footer.strip .tk { display: inline-flex; gap: 3px; align-items: center; }
footer.strip .sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; } footer.strip > .muted { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
svg .fl { opacity: .4; cursor: pointer; } svg .fl:hover, svg .fl.on { opacity: .8; }
svg .fn { cursor: pointer; } svg .fn.on rect { stroke: var(--vscode-focusBorder); stroke-width: 2; }
svg .fh { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; fill: var(--vscode-descriptionForeground); }
table.ft { width: 100%; border-collapse: collapse; font-size: 12px; } table.ft th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; }
table.ft td { padding: 3px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; } table.ft tr[data-select] { cursor: pointer; } table.ft tr[data-select]:hover, table.ft tr.sel { background: var(--vscode-list-hoverBackground); }
`;

/** Client script: renders host-escaped HTML into #root (keeps scroll), forwards clicks on [data-open]/[data-cmd]. */
const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
window.addEventListener('message', e => {
  const m = e.data;
  if (m && m.type === 'render' && typeof m.html === 'string') { root.innerHTML = m.html; if (m.top) window.scrollTo(0, 0); applyFilter(); }
});
const q = document.getElementById('q');
function applyFilter() {
  if (!q) return;
  const t = q.value.trim().toLowerCase();
  for (const el of root.querySelectorAll('main [data-select]')) el.classList.toggle('hide', !!t && !el.textContent.toLowerCase().includes(t));
}
if (q) q.addEventListener('input', applyFilter);
function items() { return [...root.querySelectorAll('main [data-select]')].filter(e => !e.classList.contains('hide')); }
document.addEventListener('keydown', e => {
  if (!root.querySelector('.ws')) return;
  if (e.target === q) { if (e.key === 'Escape') { q.value = ''; applyFilter(); q.blur(); } return; }
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target.tagName === 'INPUT')) return;
  const navs = [...root.querySelectorAll('[data-nav].nav')];
  if (/^[0-9]$/.test(e.key)) { const n = navs[e.key === '0' ? 9 : +e.key - 1]; if (n) { n.click(); e.preventDefault(); } return; }
  if (e.key === '/' && q) { q.focus(); e.preventDefault(); return; }
  if (e.key === 'r') { vscode.postMessage({ type: 'cmd', cmd: 'refresh', key: '' }); return; }
  if (e.key === '?') { root.querySelector('.keys')?.scrollIntoView({ block: 'end' }); return; }
  if (e.key === 'Escape' && q && q.value) { q.value = ''; applyFilter(); return; }
  if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    const list = items();
    if (!list.length) return;
    const i = list.findIndex(x => x.classList.contains('sel'));
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
    next.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'select', key: next.dataset.select });
    e.preventDefault();
  }
});
vscode.postMessage({ type: 'ready', key: '' });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-open],[data-cmd],[data-nav],[data-select],[data-opt],[data-act]');
  if (!el) return;
  if (el.dataset.act) vscode.postMessage({ type: 'act', name: el.dataset.act, arg: el.dataset.arg || '', key: '' });
  else if (el.dataset.opt) vscode.postMessage({ type: 'opt', name: el.dataset.opt, value: el.dataset.val || '', key: el.dataset.key || '' });
  else if (el.dataset.nav) vscode.postMessage({ type: 'nav', view: el.dataset.nav, key: '' });
  else if (el.dataset.select) vscode.postMessage({ type: 'select', key: el.dataset.select });
  else if (el.dataset.open) vscode.postMessage({ type: 'open', key: el.dataset.open });
  else vscode.postMessage({ type: 'cmd', cmd: el.dataset.cmd, key: el.dataset.key || '' });
});
document.addEventListener('keydown', e => {
  const d = e.target.dataset;
  if (e.key !== 'Enter' || !d) return;
  if (d.select || d.open) vscode.postMessage({ type: 'open', key: d.select || d.open });
});
document.addEventListener('dblclick', e => { const el = e.target.closest('[data-select]'); if (el) vscode.postMessage({ type: 'open', key: el.dataset.select }); });
`;

export function page(cspSource: string, body: string, opts: { filter?: boolean; css?: string } = {}): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(cspSource, n)}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLE}${opts.css ?? ''}</style></head><body>${opts.filter ? '<input id="q" class="q" type="search" placeholder="Filter sessions  ( / )" aria-label="Filter sessions">' : ''}<div id="root">${body}</div><script nonce="${n}">${SCRIPT}</script></body></html>`;
}

/** Kept in sync with WS_VIEWS (render/workspace.ts); duplicated so validation has no UI dependency. */
export const NAV_VIEWS = ['overview', 'attention', 'board', 'team', 'flow', 'worktrees', 'gantt', 'verify', 'activity', 'providers'] as const;
/** Add-on screen ids (render/extra) accepted by nav validation; filled by the workspace panel. */
export const EXTRA_NAV = new Set<string>();

export type WebviewMessage =
  | { type: 'ready'; key: '' }
  | { type: 'open'; key: string }
  | { type: 'select'; key: string }
  | { type: 'nav'; view: string; key: '' }
  | { type: 'opt'; name: string; value: string; key: string }
  | { type: 'act'; name: string; arg: string; key: '' }
  | { type: 'cmd'; cmd: 'refresh' | 'timelineAll' | 'revealWorktree' | 'copySessionId' | 'openTimeline' | 'openInTern' | 'openArtifactFolder' | 'openWorkspace' | 'openWorkspaceNewTab' | 'readTranscript'; key: string };

const CMDS = new Set(['refresh', 'timelineAll', 'revealWorktree', 'copySessionId', 'openTimeline', 'openInTern', 'openArtifactFolder', 'openWorkspace', 'openWorkspaceNewTab', 'readTranscript']);

/** Strict validation of anything a webview posts back. Unknown shapes are dropped. */
export function validateMessage(m: unknown, knownKey: (k: string) => boolean): WebviewMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const key = typeof o.key === 'string' && o.key.length <= 200 ? o.key : undefined;
  if (key === undefined) return undefined;
  if (o.type === 'ready' && key === '') return { type: 'ready', key: '' };
  if (o.type === 'open' && knownKey(key)) return { type: 'open', key };
  if (o.type === 'select' && knownKey(key)) return { type: 'select', key };
  if (o.type === 'nav' && key === '' && typeof o.view === 'string' && ((NAV_VIEWS as readonly string[]).includes(o.view) || EXTRA_NAV.has(o.view))) return { type: 'nav', view: o.view, key: '' };
  if (o.type === 'opt' && typeof o.name === 'string' && /^[a-z0-9.-]{1,40}$/.test(o.name) && typeof o.value === 'string' && /^[a-z0-9._:-]{0,40}$/.test(o.value) && (key === '' || knownKey(key))) return { type: 'opt', name: o.name, value: o.value, key };
  if (o.type === 'act' && key === '' && typeof o.name === 'string' && /^[a-z0-9.-]{1,40}$/.test(o.name) && typeof o.arg === 'string' && o.arg.length <= 1000) return { type: 'act', name: o.name, arg: o.arg, key: '' };
  if (o.type === 'cmd' && typeof o.cmd === 'string' && CMDS.has(o.cmd) && (key === '' || knownKey(key))) return { type: 'cmd', cmd: o.cmd as any, key };
  return undefined;
}
