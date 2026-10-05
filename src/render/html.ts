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
.kpi span { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
.row { display: grid; grid-template-columns: 12px 1fr auto; gap: 2px 6px; padding: 3px 4px; border-radius: 3px; cursor: pointer; align-items: baseline; }
.row:hover { background: var(--vscode-list-hoverBackground); }
/* Keyboard focus is always visible (rows, rail, pills, segmented buttons, links). */
:focus { outline: none; } :focus-visible { outline: 2px solid var(--vscode-focusBorder, #0078d4); outline-offset: 1px; }
tr[data-select]:focus-visible { outline-offset: -2px; } tr[data-select]:focus-visible td, [data-select]:focus-visible { background: var(--vscode-list-hoverBackground, #8882); }
.row .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub { grid-column: 2 / 4; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .right { color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.RUNNING { background: var(--vscode-charts-green); } .IDLE { background: var(--vscode-charts-yellow); } .NEEDS_INPUT { background: var(--vscode-charts-orange); }
.ENDED { background: var(--vscode-disabledForeground, #888); } .UNKNOWN { background: transparent; border: 1px solid var(--vscode-descriptionForeground); box-sizing: border-box; }
.prov { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 8px 0 2px; }
.muted { color: var(--vscode-descriptionForeground); }
.pass { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); } .fail { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td, th { padding: 2px 4px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 11px; }
.tl { display: grid; grid-template-columns: 42px 92px 1fr; gap: 0 6px; font-size: 12px; padding: 1px 0; }
.tl .t { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.tl .k { font-size: 11px; letter-spacing: .03em; color: var(--vscode-descriptionForeground); }
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
.nb { font-size: 11px; min-width: 16px; text-align: center; border-radius: 8px; padding: 0 5px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); } .nb.hot { background: color-mix(in srgb, var(--bad) 30%, transparent); color: var(--vscode-foreground); box-shadow: inset 0 0 0 1px var(--bad); }
.rail { overflow-y: auto; } .rg { display: flex; flex-direction: column; gap: 1px; margin-bottom: 4px; }
.rail .railg { display: flex; align-items: center; gap: 4px; width: 100%; background: none; border: none; cursor: pointer; font: inherit; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 6px 0 2px; padding: 2px 4px; border-radius: 3px; }
.rail .railg:hover { background: var(--vscode-list-hoverBackground); } .rail .chev { width: 10px; } .rail .rgc { margin-left: auto; font-size: 11px; }
.nav .dk { font: inherit; font-size: 11px; min-width: 10px; text-align: center; color: var(--vscode-descriptionForeground); border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; } .nav > .nb, .nav > .dk { margin-left: auto; } .nav > .nb + .dk { margin-left: 4px; }
.rail .nav { padding: 4px 8px 4px 18px; }
.railfoot { margin-top: auto; font-size: 11px; padding: 8px; display: grid; gap: 3px; }
.mainw { padding: 10px 16px 24px; min-width: 0; }
.mh { display: flex; align-items: baseline; gap: 6px 10px; flex-wrap: wrap; margin-bottom: 8px; } .mh h1 { font-size: 18px; margin: 0; } .mh .right { margin-left: auto; font-size: 11px; white-space: nowrap; }
.mh .hint { flex: 1 1 260px; min-width: 0; } .mh .q + .right, .mh .q ~ .right { margin-left: 0; }
.side { border-left: 1px solid var(--line); padding: 10px 12px; position: sticky; top: 0; height: calc(100vh - 20px); overflow-y: auto; }
.kpis.big .kpi { min-width: 78px; padding: 6px 10px; border-radius: 6px; background: var(--raise); } .kpis.big .kpi b { font-size: 20px; }
/* Value colours are mixed with the foreground so they keep contrast on light themes. */
.k-run b { color: color-mix(in srgb, var(--ok) 70%, var(--vscode-foreground)); } .k-need b { color: color-mix(in srgb, var(--warn) 65%, var(--vscode-foreground)); } .k-fail b { color: color-mix(in srgb, var(--bad) 75%, var(--vscode-foreground)); } .k-idle b { color: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 60%, var(--vscode-foreground)); }
.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 2fr); gap: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.card { border: 1px solid var(--line); border-left: 3px solid var(--id, var(--accent)); border-radius: 6px; padding: 7px 9px; background: var(--raise); cursor: pointer; display: grid; gap: 2px; min-width: 0; }
.card:hover { border-color: var(--vscode-focusBorder); border-left-color: var(--id); }
.card.sel, .att.sel, .gr.sel, tr.sel, .agent.sel { outline: 1px solid var(--vscode-focusBorder); }
.ct { display: flex; align-items: center; gap: 6px; } .ct b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; } .ct .right { color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.cl { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .cl.num { font-variant-numeric: tabular-nums; } .cl .who { color: var(--id); font-weight: 600; } .cl.act { color: var(--vscode-foreground); }
.meter { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin: 2px 0; } .meter i { display: block; height: 100%; background: var(--ok); } .meter.warm i { background: var(--vscode-charts-yellow); } .meter.hot i { background: var(--bad); }
.stages { display: inline-flex; flex-wrap: wrap; gap: 2px; margin-top: 3px; } .stg { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.stg.done { background: color-mix(in srgb, var(--ok) 22%, transparent); border-color: color-mix(in srgb, var(--ok) 55%, transparent); color: var(--vscode-foreground); }
.stg.fail { background: color-mix(in srgb, var(--bad) 25%, transparent); border-color: var(--bad); color: var(--vscode-foreground); }
.stg.live { background: color-mix(in srgb, var(--accent) 25%, transparent); border-color: var(--accent); color: var(--vscode-foreground); }
.att { display: grid; grid-template-columns: 54px 1fr auto; gap: 8px; align-items: start; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 6px; cursor: pointer; background: var(--raise); }
.att .sev { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; text-align: center; border-radius: 3px; padding: 1px 0; } .att.high .sev { background: color-mix(in srgb, var(--bad) 30%, transparent); box-shadow: inset 0 0 0 1px var(--bad); color: var(--vscode-foreground); } .att.medium .sev { background: color-mix(in srgb, var(--warn) 28%, transparent); box-shadow: inset 0 0 0 1px var(--warn); color: var(--vscode-foreground); } .att.low .sev { border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.att > div { min-width: 0; overflow-wrap: anywhere; } .basis { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }
.board { display: grid; grid-template-columns: repeat(5, minmax(220px, 1fr)); gap: 10px; overflow-x: auto; align-items: start; padding-bottom: 6px; scrollbar-gutter: stable; } .col { display: grid; gap: 6px; min-width: 0; } .col > *, .grid > * { min-width: 0; } .card { overflow: hidden; }
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
.gh .track { height: 14px; border: none; } .tick { position: absolute; font-size: 11px; color: var(--vscode-descriptionForeground); transform: translateX(-50%); } .now { position: absolute; top: 0; height: 14px; width: 2px; background: var(--bad); }
.bar2 { position: absolute; top: 3px; height: 10px; border-radius: 3px; background: var(--claude); opacity: .8; box-shadow: inset 3px 0 0 var(--id, transparent); } .bar2.codex { background: var(--codex); } .bar2.live { opacity: 1; }
.mk { position: absolute; top: 4px; width: 7px; height: 7px; transform: translateX(-50%) rotate(45deg); background: var(--vscode-foreground); } .mk.test { transform: translateX(-50%); width: 3px; height: 12px; top: 2px; } .mk.test.PASS { background: var(--ok); } .mk.test.FAIL { background: var(--bad); } .mk.test.UNKNOWN { background: var(--quiet); }
.legend { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; } .legend .sample { position: relative; display: inline-block; top: 0; left: 0; transform: none; } .legend .bar2.sample { width: 18px; height: 8px; } .legend .mk.commit.sample { transform: rotate(45deg); }
table.vt tr { cursor: pointer; } table.vt td:nth-child(1), table.vt td:nth-child(5), table.vt td:nth-child(6) { white-space: nowrap; } table.vt td:nth-child(2) { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } table.vt td:nth-child(3) { white-space: nowrap; } table.vt td:nth-child(4) code { display: block; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } table.vt tr:hover { background: var(--vscode-list-hoverBackground); } code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
.week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 8px; } .wd { display: grid; justify-items: center; gap: 2px; font-size: 11px; } .wd b { font-size: 14px; }
.stack { height: 90px; width: 26px; display: flex; flex-direction: column-reverse; border-radius: 4px; overflow: hidden; background: var(--raise); border: 1px solid var(--line); } .stack i { display: block; width: 100%; } .stack i.claude { background: var(--claude); } .stack i.codex { background: var(--codex); }
.heat { display: grid; grid-template-columns: 34px repeat(24, 1fr); gap: 2px; font-size: 11px; } .heat i { display: block; height: 15px; border-radius: 2px; background: var(--accent); } .hx, .hy { color: var(--vscode-descriptionForeground); }
.sd { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; } .sd.ready { background: var(--ok); } .sd.partial { background: var(--warn); } .sd.missing { background: var(--bad); } .sd.off { border: 1px solid var(--quiet); } .sd.RUNNING { background: var(--ok); } .sd.NEEDS_INPUT { background: var(--warn); } .sd.IDLE { background: var(--accent); } .sd.UNKNOWN, .sd.ENDED { background: var(--quiet); }
.st-ready { color: var(--ok); } .st-partial { color: var(--warn); } .st-missing { color: var(--bad); } .st-off { color: var(--quiet); } td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.split { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 2px 0 8px; } .split i.claude { background: var(--claude); } .split i.codex { background: var(--codex); }
.szbar { display: block; height: 8px; border-radius: 2px; background: var(--claude); } .szbar.codex { background: var(--codex); }
.cs { font-size: 11px; text-align: left; color: var(--vscode-descriptionForeground); }
.keys { position: sticky; bottom: 0; margin: 14px -16px -24px; padding: 4px 16px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background, #1f1f1f); border-top: 1px solid var(--line); } .keys b { color: var(--vscode-foreground); font-weight: 600; margin-left: 8px; } .keys b:first-child { margin-left: 0; }
.q { flex: 0 1 200px; width: 200px; min-width: 120px; box-sizing: border-box; align-self: center; padding: 3px 8px; font: inherit; font-size: 12px; color: var(--vscode-input-foreground, var(--vscode-foreground)); background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px; } .q:focus { outline: 1px solid var(--vscode-focusBorder); } .q.q-off { display: none; } body > .q { display: none; }
.hide { display: none !important; }
.foot { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
.sideh { border-left: 3px solid var(--id); padding-left: 8px; margin-bottom: 8px; } .sideh h3 { margin: 2px 0; font-size: 14px; overflow-wrap: anywhere; }
.rcard { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 4px; margin: 6px 0; } .rc { border: 1px solid var(--line); border-radius: 5px; padding: 3px 7px; background: var(--raise); min-width: 0; }
.rc span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); } .rc b { font-weight: 600; font-variant-numeric: tabular-nums; font-size: 12px; overflow-wrap: anywhere; } .rc.ok { border-color: var(--ok); } .rc.bad { border-color: var(--bad); }
.sidestages { margin: 4px 0 8px; } .sloc { font-size: 12px; display: grid; gap: 2px; overflow-wrap: anywhere; } .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 3px 10px; cursor: pointer; font: inherit; } .btn:hover { background: var(--vscode-button-hoverBackground); }
.mini { font-size: 12px; padding: 2px 4px; border-radius: 3px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; } .mini:hover { background: var(--vscode-list-hoverBackground); } .tl2 { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) { .ws { grid-template-columns: 130px minmax(0, 1fr); } .side { grid-column: 1 / -1; position: static; height: auto; border-left: none; border-top: 1px solid var(--line); } .cols { grid-template-columns: 1fr; } }
/* Narrow: wide tables scroll inside their own box, never the page. */
@media (max-width: 900px) { .mainw table { display: block; max-width: 100%; overflow-x: auto; } .mainw pre { max-width: 100%; overflow-x: auto; } .mainw svg { max-width: 100%; } table.vt td:nth-child(4) code { max-width: 260px; } .mh .q { flex-basis: 100%; width: auto; order: 5; } }
/* Phone-width: the rail is one horizontally scrolling strip instead of a screen-tall block of buttons. */
@media (max-width: 700px) { .ws { grid-template-columns: minmax(0, 1fr); } .rail { position: static; height: auto; flex-direction: row; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; border-right: none; border-bottom: 1px solid var(--line); padding: 4px 6px; } .rail .rg { flex-direction: row; flex: none; align-items: center; margin: 0 6px 0 0; } .rail .railg { width: auto; margin: 0; } .rail .nav { padding: 3px 8px; white-space: nowrap; } .brand { flex: none; padding: 2px 8px; } .railfoot { display: none; } .mainw { padding: 8px 10px 16px; } .keys { margin: 14px -10px -16px; } .board { grid-template-columns: repeat(5, 220px); } .gh, .gr { grid-template-columns: 120px minmax(0, 1fr); } .wt { grid-template-columns: minmax(0, 1fr); } dl { grid-template-columns: 90px minmax(0, 1fr); } .cols { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
.tree { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; overflow-x: auto; }
.tree a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.chip { display: inline-block; font-size: 11px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground)); color: var(--vscode-descriptionForeground); margin-left: 4px; }
/* Evidence chips: one style per kind, defined once. */
.ev { font-size: 11px; } .chip.OBSERVED { border-color: var(--ok); } .chip.DERIVED { border-color: var(--accent); } .chip.INFERRED { border-style: dashed; border-color: var(--warn); } .chip.UNKNOWN { border-style: dotted; }
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
svg .fh { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; fill: var(--vscode-descriptionForeground); }
table.ft { width: 100%; border-collapse: collapse; font-size: 12px; } table.ft th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; }
/* Jump-to-screen picker ("g" / Ctrl+K): a small filterable list over the workspace. */
.gp { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; background: color-mix(in srgb, var(--vscode-editor-background, #1f1f1f) 45%, transparent); }
.gp-box { width: min(440px, calc(100vw - 32px)); max-height: 60vh; display: flex; flex-direction: column; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, #252526)); color: var(--vscode-quickInput-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-widget-border, var(--line)); border-radius: 6px; box-shadow: 0 4px 18px var(--vscode-widget-shadow, #0008); overflow: hidden; }
.gp-in { margin: 6px; padding: 4px 8px; font: inherit; color: var(--vscode-input-foreground, var(--vscode-foreground)); background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px; } .gp-in:focus { outline: 2px solid var(--vscode-focusBorder, #0078d4); }
.gp-list { list-style: none; margin: 0; padding: 0 0 6px; overflow-y: auto; } .gp-opt { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 3px 10px; cursor: pointer; }
.gp-opt .gp-h { grid-column: 1 / -1; font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .gp-opt .gp-g { font-size: 11px; color: var(--vscode-descriptionForeground); }
.gp-opt:hover { background: var(--vscode-list-hoverBackground); } .gp-opt.on { background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-quickInputList-focusForeground, var(--vscode-list-activeSelectionForeground)); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; } .gp-opt.on .gp-h, .gp-opt.on .gp-g { color: inherit; }
.gp-none { padding: 4px 10px; color: var(--vscode-descriptionForeground); }
table.ft td { padding: 3px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; } table.ft tr[data-select] { cursor: pointer; } table.ft tr[data-select]:hover, table.ft tr.sel { background: var(--vscode-list-hoverBackground); }
`;

/**
 * Fixed digit shortcuts (1..9, 0) by screen id, so a key never changes meaning when rail groups collapse.
 * The rail shows the digit next to each of these screens; ids not registered are dropped by nav validation.
 */
export const DIGIT_VIEWS = ['overview', 'attention', 'live', 'board', 'hud', 'gantt', 'review', 'team', 'worktrees', 'workflows'] as const;

/** Digit key ('1'..'9', '0') of a screen, or '' if it has none. */
export function digitOf(view: string): string {
  const i = (DIGIT_VIEWS as readonly string[]).indexOf(view);
  return i < 0 ? '' : String((i + 1) % 10);
}

/**
 * Text after a loading marker (kit.loading) once it has been visible for elapsedMs: elapsed seconds, then a timeout
 * note. Runs in the webview too (inlined into SCRIPT), so it must stay self-contained.
 */
export function loadNote(elapsedMs: number, timeoutS: number): { text: string; late: boolean } {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s >= timeoutS) return { text: ' · no answer after ' + timeoutS + ' s: the source may be slow, locked or unavailable.', late: true };
  return { text: s >= 1 ? ' · ' + s + ' s' : '', late: false };
}

/** Client script: renders host-escaped HTML into #root (keeps scroll), forwards clicks on [data-open]/[data-cmd]. */
const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const q = document.getElementById('q');
const DIGITS = ${JSON.stringify(DIGIT_VIEWS)};
// Minified builds rename functions: bind the helper by value, not by its declared name.
const loadNote = ${loadNote.toString()};
// Loading markers: first time each id was seen, so the elapsed time survives re-renders.
const seen = new Map();
function tickLoading() {
  const now = Date.now();
  const live = new Set();
  for (const el of root.querySelectorAll('[data-loading]')) {
    const id = el.dataset.loading;
    live.add(id);
    if (!seen.has(id)) seen.set(id, now);
    const n = loadNote(now - seen.get(id), +el.dataset.timeout || 60);
    const t = el.querySelector('.ld-t');
    if (t && t.textContent !== n.text) t.textContent = n.text;
    el.classList.toggle('ld-late', n.late);
  }
  for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
  document.body.dataset.ready = live.size ? '0' : '1';
}
setInterval(tickLoading, 1000);
// Rows and clickable non-buttons become reachable with Tab; the filter box sits in the screen header.
function decorate() {
  for (const el of root.querySelectorAll('[data-select]:not([tabindex]), [data-opt]:not(button):not(select):not([tabindex]), [data-act]:not(button):not([tabindex])')) el.setAttribute('tabindex', '0');
  if (!q) return;
  const mh = root.querySelector('.mh');
  if (mh) { if (q.parentNode !== mh) mh.insertBefore(q, mh.querySelector(':scope > .right')); }
  else if (q.parentNode !== document.body) document.body.insertBefore(q, root);
  q.classList.toggle('q-off', !q.value && !root.querySelector('main [data-select], main table tr td'));
}
window.addEventListener('message', e => {
  const m = e.data;
  if (m && m.type === 'render' && typeof m.html === 'string') {
    const a = document.activeElement;
    const fk = a && a !== q && root.contains(a) && a.dataset ? a.dataset.select : undefined;
    const qf = !!q && a === q, qs = q ? [q.selectionStart, q.selectionEnd] : [];
    root.innerHTML = m.html;
    if (m.top) window.scrollTo(0, 0);
    decorate();
    applyFilter();
    tickLoading();
    if (qf) { q.focus({ preventScroll: true }); try { q.setSelectionRange(qs[0], qs[1]); } catch {} }
    else if (fk) { const el = [...root.querySelectorAll('main [data-select]')].find(x => x.dataset.select === fk); if (el) el.focus({ preventScroll: true }); }
  }
});
function applyFilter() {
  if (!q) return;
  const t = q.value.trim().toLowerCase();
  for (const el of root.querySelectorAll('main [data-select]')) el.classList.toggle('hide', !!t && !el.textContent.toLowerCase().includes(t));
  // Plain table rows (catalog, backlog, changes …) filter too; header rows stay.
  for (const el of root.querySelectorAll('main table tr:not([data-select])')) if (!el.querySelector('th')) el.classList.toggle('hide', !!t && !el.textContent.toLowerCase().includes(t));
}
if (q) q.addEventListener('input', applyFilter);
decorate();
tickLoading();
// Jump-to-screen picker: "g" or Ctrl+K opens it over the workspace; type to filter, Up/Down, Enter to go, Esc to close.
// It lives outside #root so a re-render never closes it; entries come from the hidden .gp-src list in the markup.
let gp = null;
function gpEntries() { return [...root.querySelectorAll('.gp-src [data-gp]')].map(li => ({ id: li.dataset.gp, label: li.textContent, group: li.dataset.group || '', hint: li.dataset.hint || '' })); }
function gpRender() {
  const t = gp.input.value.trim().toLowerCase();
  gp.shown = gp.all.filter(x => !t || (x.label + ' ' + x.group + ' ' + x.id + ' ' + x.hint).toLowerCase().includes(t));
  gp.at = Math.max(0, Math.min(gp.at, gp.shown.length - 1));
  gp.list.textContent = '';
  gp.shown.forEach((x, i) => {
    const li = document.createElement('li');
    li.className = 'gp-opt' + (i === gp.at ? ' on' : '');
    li.id = 'gp-o' + i;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === gp.at ? 'true' : 'false');
    li.dataset.i = String(i);
    const b = document.createElement('span'); b.textContent = x.label;
    const g = document.createElement('span'); g.className = 'gp-g'; g.textContent = x.group;
    const h = document.createElement('span'); h.className = 'gp-h'; h.textContent = x.hint;
    li.append(b, g, h);
    gp.list.append(li);
  });
  if (!gp.shown.length) { const li = document.createElement('li'); li.className = 'gp-none'; li.textContent = 'No screen matches.'; gp.list.append(li); }
  if (gp.shown.length) gp.input.setAttribute('aria-activedescendant', 'gp-o' + gp.at); else gp.input.removeAttribute('aria-activedescendant');
  const on = gp.list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function gpClose() {
  if (!gp) return;
  const back = gp.back;
  gp.el.remove(); gp = null;
  if (back && back !== document.body && document.contains(back)) back.focus({ preventScroll: true });
}
function gpGo(i) {
  const x = gp && gp.shown[i];
  if (!x) return;
  gpClose();
  vscode.postMessage({ type: 'nav', view: x.id, key: '' });
}
function gpOpen() {
  if (gp) { gp.input.focus(); return; }
  const all = gpEntries();
  if (!all.length) return;
  const el = document.createElement('div');
  el.className = 'gp';
  el.innerHTML = '<div class="gp-box" role="dialog" aria-modal="true" aria-label="Go to screen"><input class="gp-in" type="text" role="combobox" aria-expanded="true" aria-controls="gp-list" aria-autocomplete="list" aria-label="Go to screen: type to filter, Enter to go, Esc to close" placeholder="Go to screen…  (Enter to go, Esc to close)" autocomplete="off" spellcheck="false"><ul class="gp-list" id="gp-list" role="listbox" aria-label="Screens"></ul></div>';
  document.body.append(el);
  gp = { el, input: el.querySelector('.gp-in'), list: el.querySelector('.gp-list'), all, shown: all, at: 0, back: document.activeElement };
  const cur = root.querySelector('.nav.on');
  if (cur) gp.at = Math.max(0, all.findIndex(x => x.id === cur.dataset.nav));
  gp.input.addEventListener('input', () => { gp.at = 0; gpRender(); });
  gp.input.addEventListener('keydown', e => {
    const n = gp.shown.length;
    if (e.key === 'Escape') gpClose();
    else if (e.key === 'Enter') gpGo(gp.at);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (n) { gp.at = (gp.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; gpRender(); } }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { if (n) { gp.at = Math.max(0, Math.min(n - 1, gp.at + (e.key === 'PageDown' ? 8 : -8))); gpRender(); } }
    else if (e.key !== 'Tab') return; // Tab is swallowed: focus stays in the dialog.
    e.preventDefault();
  });
  gp.list.addEventListener('mousedown', e => e.preventDefault());
  gp.list.addEventListener('click', e => { const o = e.target.closest('.gp-opt'); if (o) gpGo(+o.dataset.i); });
  el.addEventListener('mousedown', e => { if (e.target === el) { e.preventDefault(); gpClose(); } });
  gpRender();
  gp.input.focus();
}
// One entry per session: a session shown in two panes (Panes screen) must not trap j/k between its copies.
function items() { const seen = new Set(); return [...root.querySelectorAll('main [data-select]')].filter(e => !e.classList.contains('hide') && !seen.has(e.dataset.select) && seen.add(e.dataset.select)); }
document.addEventListener('keydown', e => {
  if (!root.querySelector('.ws')) return;
  if (gp && gp.el.contains(e.target)) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { gpOpen(); e.preventDefault(); return; }
  if (e.target === q) { if (e.key === 'Escape') { q.value = ''; applyFilter(); q.blur(); } return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (/^[0-9]$/.test(e.key)) {
    const v = DIGITS[e.key === '0' ? 9 : +e.key - 1];
    const b = v && root.querySelector('[data-nav="' + v + '"].nav');
    if (b) b.click(); else if (v) vscode.postMessage({ type: 'nav', view: v, key: '' });
    e.preventDefault();
    return;
  }
  if (e.key === 'g') { gpOpen(); e.preventDefault(); return; }
  if (e.key === '/' && q && !q.classList.contains('q-off')) { q.focus(); e.preventDefault(); return; }
  if (e.key === 'r') { vscode.postMessage({ type: 'cmd', cmd: 'refresh', key: '' }); return; }
  if (e.key === '?') { root.querySelector('.keys')?.scrollIntoView({ block: 'end' }); return; }
  if (e.key === 'Escape') {
    if (q && q.value) { q.value = ''; applyFilter(); decorate(); }
    else {
      if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
      // Esc with no filter to clear: drop the selection (the host re-renders without it).
      vscode.postMessage({ type: 'clear', key: '' });
    }
    return;
  }
  if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    const list = items();
    if (!list.length) return;
    const a = document.activeElement;
    let i = a && a.dataset && a.dataset.select ? list.findIndex(x => x.dataset.select === a.dataset.select) : -1;
    if (i < 0) i = list.findIndex(x => x.classList.contains('sel'));
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'select', key: next.dataset.select });
    e.preventDefault();
  }
});
vscode.postMessage({ type: 'ready', key: '' });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-open],[data-cmd],[data-nav],[data-select],[data-opt],[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  // Retry on a timed-out loading marker restarts its clock.
  const ld = el.classList.contains('ld-retry') ? el.closest('[data-loading]') : null;
  if (ld) seen.delete(ld.dataset.loading);
  if (el.dataset.act) vscode.postMessage({ type: 'act', name: el.dataset.act, arg: el.dataset.arg || '', key: '' });
  else if (el.dataset.opt) vscode.postMessage({ type: 'opt', name: el.dataset.opt, value: el.dataset.val || '', key: el.dataset.key || '' });
  else if (el.dataset.nav) vscode.postMessage({ type: 'nav', view: el.dataset.nav, key: '' });
  else if (el.dataset.select) vscode.postMessage({ type: 'select', key: el.dataset.select });
  else if (el.dataset.open) vscode.postMessage({ type: 'open', key: el.dataset.open });
  else vscode.postMessage({ type: 'cmd', cmd: el.dataset.cmd, key: el.dataset.key || '' });
});
// Enter opens a focused row and Space selects it; on other focused non-button controls both act as a click.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!t || !t.dataset || /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(t.tagName)) return;
  const d = t.dataset;
  if (d.select || d.open) {
    if (e.key === 'Enter') vscode.postMessage({ type: 'open', key: d.select || d.open });
    else if (d.select) vscode.postMessage({ type: 'select', key: d.select });
    e.preventDefault();
  } else if (d.opt || d.act || d.nav || d.cmd) { t.dispatchEvent(new MouseEvent('click', { bubbles: true })); e.preventDefault(); }
});
// <select data-opt="name"> posts its value as an option on change (same validation as seg buttons).
document.addEventListener('change', e => { const el = e.target; if (el && el.tagName === 'SELECT' && el.dataset.opt) vscode.postMessage({ type: 'opt', name: el.dataset.opt, value: el.value, key: '' }); });
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
  | { type: 'clear'; key: '' }
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
  if (o.type === 'clear' && key === '') return { type: 'clear', key: '' };
  if (o.type === 'nav' && key === '' && typeof o.view === 'string' && ((NAV_VIEWS as readonly string[]).includes(o.view) || EXTRA_NAV.has(o.view))) return { type: 'nav', view: o.view, key: '' };
  if (o.type === 'opt' && typeof o.name === 'string' && /^[a-z0-9.-]{1,40}$/.test(o.name) && typeof o.value === 'string' && /^[a-z0-9._:-]{0,40}$/.test(o.value) && (key === '' || knownKey(key))) return { type: 'opt', name: o.name, value: o.value, key };
  if (o.type === 'act' && key === '' && typeof o.name === 'string' && /^[a-z0-9.-]{1,40}$/.test(o.name) && typeof o.arg === 'string' && o.arg.length <= 1000) return { type: 'act', name: o.name, arg: o.arg, key: '' };
  if (o.type === 'cmd' && typeof o.cmd === 'string' && CMDS.has(o.cmd) && (key === '' || knownKey(key))) return { type: 'cmd', cmd: o.cmd as any, key };
  return undefined;
}
