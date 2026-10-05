import * as vscode from 'vscode';
import { SessionStore } from '../sessions/store';
import { weekly } from '../activity/activity';
import { page, validateMessage, WebviewMessage } from '../render/html';
import { renderActivity, renderCockpit, renderInspector, renderTimeline } from '../render/views';

type Kind = 'cockpit' | 'timeline' | 'activity';

/** Sends rendered (host-escaped) HTML to a webview whose shell was loaded once, so scroll position survives refreshes. */
function post(w: vscode.Webview, html: string): void {
  void w.postMessage({ type: 'render', html });
}

/** Sidebar webview views. Rendering is throttled; hidden views are not rendered. */
export class AgentView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private sub: { dispose(): void };
  focusKey?: string;

  constructor(private kind: Kind, private store: SessionStore, private onMessage: (m: WebviewMessage) => void) {
    this.sub = store.onDidChange(() => this.schedule());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    view.webview.onDidReceiveMessage(m => {
      const msg = validateMessage(m, k => !!this.store.get(k));
      if (!msg) return;
      if (msg.type === 'ready') this.render(true);
      else this.onMessage(msg);
    });
    view.onDidChangeVisibility(() => view.visible && this.render(true));
    view.webview.html = page(view.webview.cspSource, this.body());
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 250);
  }

  focus(key: string | undefined): void {
    this.focusKey = key;
    this.render();
  }

  private body(): string {
    const now = Date.now();
    const all = this.store.all();
    if (this.kind === 'cockpit') return renderCockpit(all, this.store.providerStates, now);
    if (this.kind === 'timeline') {
      const focus = this.focusKey ? this.store.get(this.focusKey) : undefined;
      return renderTimeline(this.store.timeline(focus?.key), new Map(all.map(s => [s.key, s])), { focus });
    }
    return renderActivity(weekly(all, now), all);
  }

  private last = '';

  render(force = false): void {
    const v = this.view;
    if (!v || !v.visible) return;
    const html = this.body();
    if (!force && html === this.last) return;
    this.last = html;
    post(v.webview, html);
  }

  dispose(): void {
    this.sub.dispose();
    if (this.timer) clearTimeout(this.timer);
  }
}

/** One inspector panel per session, reused. */
export class Inspector implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private sub: { dispose(): void };

  constructor(private store: SessionStore, private onMessage: (m: WebviewMessage) => void, private ternAvailable: () => boolean) {
    this.sub = store.onDidChange(() => {
      for (const k of this.panels.keys()) this.render(k);
    });
  }

  open(key: string): void {
    const s = this.store.get(key);
    if (!s) return;
    let p = this.panels.get(key);
    if (p) {
      p.reveal();
      return;
    }
    p = vscode.window.createWebviewPanel('agent.inspector', `Agent · ${(s.title ?? s.sessionId).slice(0, 30)}`, vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, localResourceRoots: [], retainContextWhenHidden: false });
    p.iconPath = new vscode.ThemeIcon('pulse');
    p.webview.onDidReceiveMessage(m => {
      const msg = validateMessage(m, k => !!this.store.get(k));
      if (!msg) return;
      if (msg.type === 'ready') this.render(key);
      else this.onMessage(msg);
    });
    p.onDidChangeViewState(e => e.webviewPanel.visible && this.render(key));
    p.onDidDispose(() => this.panels.delete(key));
    this.panels.set(key, p);
    p.webview.html = page(p.webview.cspSource, this.body(key) ?? '');
  }

  private body(key: string): string | undefined {
    const s = this.store.get(key);
    if (!s) return undefined;
    const parent = s.parentSessionId ? this.store.get(s.parentSessionId) : undefined;
    return renderInspector(s, this.store.children(key), parent, this.store.timeline(key), this.ternAvailable());
  }

  private render(key: string): void {
    const p = this.panels.get(key);
    const html = this.body(key);
    if (p && p.visible && html !== undefined) post(p.webview, html);
  }

  dispose(): void {
    this.sub.dispose();
    for (const p of this.panels.values()) p.dispose();
  }
}
