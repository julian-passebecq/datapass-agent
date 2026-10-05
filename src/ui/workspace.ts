import * as vscode from 'vscode';
import { SessionStore } from '../sessions/store';
import { EXTRA_NAV, page, validateMessage, WebviewMessage } from '../render/html';
import { renderWorkspace, scoped, WsState, WsView } from '../render/workspace';
import { extraViews, extraCss } from '../render/extra';
import { ActCtx } from '../render/extra/kit';
import { FeedCtx, pump } from '../render/extra/feeds';

let panelSeq = 0;

/** An Agent Workspace editor panel. Several can be open (one per tab), each with its own screen, scope and options. */
export class WorkspacePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state: WsState = { view: 'overview', opts: {} };
  private timer?: NodeJS.Timeout;
  private last = '';
  private sub: { dispose(): void };
  private terminals = new Map<string, vscode.Terminal>();

  constructor(private store: SessionStore, private onMessage: (m: WebviewMessage) => void, private ternAvailable: () => boolean, private onClosed?: (p: WorkspacePanel) => void) {
    this.sub = store.onDidChange(() => this.schedule());
    for (const v of extraViews()) EXTRA_NAV.add(v.id);
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  open(view?: WsView, selected?: string, opts?: Record<string, string>): void {
    if (view) this.state.view = view;
    if (selected) this.state.selected = selected;
    if (opts) this.state.opts = { ...this.state.opts, ...opts };
    if (this.panel) {
      this.panel.reveal();
      this.render(true);
      return;
    }
    const n = ++panelSeq;
    const p = vscode.window.createWebviewPanel('agent.workspace', n === 1 ? 'Agent' : `Agent ${n}`, vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: false });
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
        if (msg.name === 'scope') this.updateTitle();
        return this.render();
      }
      if (msg.type === 'act') return void this.act(msg.name, msg.arg);
      if (msg.type === 'select') {
        this.state.selected = msg.key;
        return this.render();
      }
      this.onMessage(msg);
    });
    p.onDidChangeViewState(e => e.webviewPanel.visible && this.render(true));
    p.onDidDispose(() => {
      this.panel = undefined;
      this.onClosed?.(this);
    });
    this.panel = p;
    this.updateTitle();
    p.webview.html = page(p.webview.cspSource, this.body(), { filter: true, css: extraCss() });
  }

  private updateTitle(): void {
    if (this.panel) this.panel.title = this.state.opts?.scope ? `Agent · ${this.state.opts.scope}` : this.panel.title.replace(/ · .*$/, '');
  }

  private feedCtx(): FeedCtx {
    const cfg = vscode.workspace.getConfiguration('agent');
    return { sessions: scoped({ sessions: this.store.all(), providers: [], events: [], now: Date.now(), ternAvailable: false }, this.state.opts?.scope).sessions, trusted: vscode.workspace.isTrusted, config: (k, f) => cfg.get(k, f), now: Date.now() };
  }

  private pumpFeeds(force = false): void {
    const v = extraViews().find(x => x.id === this.state.view);
    if (v?.feeds?.length) pump(v.feeds, this.feedCtx(), () => this.schedule(), force);
  }

  private async act(name: string, arg: string): Promise<void> {
    const v = extraViews().find(x => x.id === this.state.view);
    const fn = v?.actions?.[name];
    if (!fn) return;
    try {
      await fn(arg, this.ctx());
    } catch (e) {
      void vscode.window.showWarningMessage(`Agent: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    this.render(true);
  }

  private ctx(): ActCtx {
    return {
      openFile: async p => void (await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true })),
      revealInOs: async p => void (await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p))),
      openUrl: async u => {
        if (/^https:\/\//.test(u)) await vscode.env.openExternal(vscode.Uri.parse(u));
      },
      copy: async t => vscode.env.clipboard.writeText(t),
      info: m => void vscode.window.showInformationMessage(m),
      confirm: async (m, yes) => (await vscode.window.showWarningMessage(m, { modal: true }, yes)) === yes,
      saveText: async (name, content) => {
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name) });
        if (!uri) return undefined;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return uri.fsPath;
      },
      openTerminal: (name, cwd, command) => {
        const t = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon('pulse') });
        const id = `t${Date.now()}`;
        this.terminals.set(id, t);
        t.show();
        if (command) t.sendText(command, true);
        return id;
      },
      closeTerminal: id => {
        this.terminals.get(id)?.dispose();
        this.terminals.delete(id);
      },
      runCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
      refreshFeeds: () => this.pumpFeeds(true),
      sessions: () => this.feedCtx().sessions,
    };
  }

  private body(): string {
    // Full event history only for screens that roll it up; otherwise just the selected session's events.
    const full = this.state.view === 'activity';
    const events = full ? this.store.timeline(undefined, 200_000) : this.state.selected ? this.store.timeline(this.state.selected) : [];
    this.pumpFeeds();
    return renderWorkspace({ sessions: this.store.all(), providers: this.store.providerStates, events, now: Date.now(), ternAvailable: this.ternAvailable(), git: { enabled: this.store.opts.git, lastMs: this.store.lastStats?.gitMs, at: this.store.lastStats?.at }, idleAlertMinutes: vscode.workspace.getConfiguration('agent').get<number>('idleAlertMinutes', 30), timeline: (k, n) => this.store.timeline(k, n), stats: this.stats() }, this.state);
  }

  private stats() {
    const r = this.store.lastStats;
    return r ? { refreshMs: r.ms, gitMs: r.gitMs, bytesRead: r.bytesRead, artifacts: r.artifacts, heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20), at: r.at } : undefined;
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
    for (const t of this.terminals.values()) t.dispose();
    this.panel?.dispose();
  }
}
