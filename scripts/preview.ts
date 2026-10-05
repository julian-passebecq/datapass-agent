// Dev-only: renders every Agent Workspace view from this machine's real provider data into static HTML
// (with a VS Code-like theme stub) for fast visual review. Output stays local; nothing is uploaded.
// Usage: node out-test/scripts/preview.js <out-dir> [dark|light]
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { STYLE } from '../src/render/html';
import { extraCss } from '../src/render/extra';
import { allViews, renderWorkspace, teamRoot, WsData } from '../src/render/workspace';
import { isLive } from '../src/activity/insights';

const DARK = `--vscode-font-family: 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: Consolas, monospace; --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-editor-background: #1f1f1f; --vscode-editorWidget-background: #202020; --vscode-widget-border: #313131; --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #fff; --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8; --vscode-focusBorder: #0078d4; --vscode-textLink-foreground: #4daafc; --vscode-button-background: #0078d4; --vscode-button-foreground: #fff; --vscode-charts-green: #89d185; --vscode-charts-red: #f14c4c; --vscode-charts-orange: #d18616; --vscode-charts-yellow: #cca700; --vscode-charts-blue: #3794ff; --vscode-charts-purple: #b180d7; --vscode-disabledForeground: #6e6e6e; background: #1f1f1f;`;
const LIGHT = `--vscode-font-family: 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: Consolas, monospace; --vscode-foreground: #3b3b3b; --vscode-descriptionForeground: #717171; --vscode-editor-background: #ffffff; --vscode-editorWidget-background: #f8f8f8; --vscode-widget-border: #e5e5e5; --vscode-list-hoverBackground: #f2f2f2; --vscode-list-activeSelectionBackground: #e8e8e8; --vscode-list-activeSelectionForeground: #000; --vscode-badge-background: #cccccc; --vscode-badge-foreground: #3b3b3b; --vscode-focusBorder: #005fb8; --vscode-textLink-foreground: #005fb8; --vscode-button-background: #005fb8; --vscode-button-foreground: #fff; --vscode-charts-green: #388a34; --vscode-charts-red: #e51400; --vscode-charts-orange: #d18616; --vscode-charts-yellow: #bf8803; --vscode-charts-blue: #1a85ff; --vscode-charts-purple: #652d90; --vscode-disabledForeground: #a0a0a0; background: #fff;`;

async function main() {
  const out = process.argv[2];
  const theme = process.argv[3] === 'light' ? LIGHT : DARK;
  fs.mkdirSync(out, { recursive: true });
  const store = new SessionStore([new ClaudeAdapter(), new CodexAdapter()], { historyDays: 3, maxSessions: 300, idleMinutes: 10, git: true });
  await store.refresh();
  const sessions = store.all();
  const d: WsData = { sessions, providers: store.providerStates, events: store.timeline(undefined, 200_000), now: Date.now(), ternAvailable: true, git: { enabled: true, lastMs: store.lastStats?.gitMs, at: store.lastStats?.at } };
  const live = sessions.filter(s => !s.isWorker && isLive(s));
  const selected = (live.find(s => s.status === 'RUNNING') ?? live[0] ?? sessions[0])?.key;
  for (const view of allViews()) {
    const sel = view === 'team' ? teamRoot(d)?.key : selected;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html{${theme}}${STYLE}${extraCss()}</style></head><body><div id="root">${renderWorkspace(d, { view, selected: sel })}</div></body></html>`;
    fs.writeFileSync(path.join(out, `${view}.html`), html);
  }
  console.log(`${sessions.length} sessions, ${live.length} live → ${out}`);
  store.dispose();
}
void main();
