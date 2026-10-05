import * as vscode from 'vscode';
import { SessionStore } from '../sessions/store';
import { EXTRA_NAV, page, validateMessage, WebviewMessage } from '../render/html';
import { renderWorkspace, WsState, WsView } from '../render/workspace';
import { EXTRA_VIEWS, extraCss } from '../render/extra';

/** The Agent Workspace editor panel (single instance). Navigation and selection live on the host. */
export class WorkspacePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state: WsState = { view: 'overview', opts: {} };
  private timer?: NodeJS.Timeout;
  private last = '';
  private sub: { dispose(): void };

  constructor(private store: SessionStore, private onMessage: (m: WebviewMessage) => void, private ternAvailable: () => boolean) {
    this.sub = store.onDidChange(() => this.schedule());
    for (const v of EXTRA_VIEWS) EXTRA_NAV.add(v.id);
  }

  open(view?: WsView, selected?: string): void {
    if (view) this.state.view = view;
    if (selected) this.state.selected = selected;
    if (this.panel) {
      this.panel.reveal();
      this.render(true);
      return;
    }
    const p = vscode.window.createWebviewPanel('agent.workspace', 'Agent', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: false });
    p.iconPath = new vscode.ThemeIcon('pulse');
    p.webview.onDidReceiveMessage(m => {
      const msg = validateMessage(m, k => !!this.store.get(k));
      if (!msg) return;
      if (msg.type === 'ready') return this.render(true);
      if (msg.type === 'nav') {
        this.state.view = msg.view;
        return this.render(false, true);
      }
      if (msg.type === 'opt') {
        this.state.opts = { ...this.state.opts, [msg.name]: msg.value };
        if (msg.key) this.state.selected = msg.key;
        return this.render();
      }
      if (msg.type === 'select') {
        this.state.selected = msg.key;
        return this.render();
      }
      this.onMessage(msg);
    });
    p.onDidChangeViewState(e => e.webviewPanel.visible && this.render(true));
    p.onDidDispose(() => (this.panel = undefined));
    this.panel = p;
    p.webview.html = page(p.webview.cspSource, this.body(), { filter: true, css: extraCss() });
  }

  private body(): string {
    // Full event history only for the hourly heatmap; otherwise just the selected session's events.
    const events = this.state.view === 'activity' ? this.store.timeline(undefined, 200_000) : this.state.selected ? this.store.timeline(this.state.selected) : [];
    return renderWorkspace({ sessions: this.store.all(), providers: this.store.providerStates, events, now: Date.now(), ternAvailable: this.ternAvailable(), git: { enabled: this.store.opts.git, lastMs: this.store.lastStats?.gitMs, at: this.store.lastStats?.at }, idleAlertMinutes: vscode.workspace.getConfiguration('agent').get<number>('idleAlertMinutes', 30), timeline: (k, n) => this.store.timeline(k, n) }, this.state);
  }

  private schedule(): void {
    if (this.timer || !this.panel) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 300);
  }

  private render(force = false, top = false): void {
    const p = this.panel;
    if (!p || !p.visible) return;
    const html = this.body();
    if (!force && html === this.last) return;
    this.last = html;
    void p.webview.postMessage({ type: 'render', html, top });
  }

  dispose(): void {
    this.sub.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
  }
}
