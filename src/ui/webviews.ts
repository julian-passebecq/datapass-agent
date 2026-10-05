import * as vscode from 'vscode';
import { SessionStore, viewNeedsRender } from '../sessions/store';
import { weekly } from '../activity/activity';
import { page, validateMessage, WebviewMessage } from '../render/html';
import { renderActivity, renderCockpit, renderInspector, renderTimeline } from '../render/views';
import { inspectorJumps } from '../render/workspace';

type Kind = 'cockpit' | 'timeline' | 'activity';

/** Sends rendered (host-escaped) HTML to a webview whose shell was loaded once, so scroll position survives refreshes. */
function post(w: vscode.Webview, html: string): void {
  void w.postMessage({ type: 'render', html });
}

/** Last build of a view: store version and wall time (see `viewNeedsRender`). */
interface Built {
  version: number;
  at: number;
}

/** Sidebar webview views. Rendering is throttled; hidden views and idle store notifications build no page. */
export class AgentView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private sub: { dispose(): void };
  private built: Built = { version: -1, at: 0 };
  focusKey?: string;
  /** Called when the view shows or hides. */
  onVisibility?: () => void;

  constructor(private kind: Kind, private store: SessionStore, private onMessage: (m: WebviewMessage) => void) {
    this.sub = store.onDidChange(() => this.storeChanged());
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  /** A store notification: nothing to do while hidden or when the projection did not move (idle refresh). */
  private storeChanged(): void {
    if (!this.view?.visible) return;
    if (!viewNeedsRender({ version: this.store.version, renderedVersion: this.built.version, renderedAt: this.built.at, feedPending: false, now: Date.now() })) return;
    this.schedule();
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
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render(true);
      this.onVisibility?.();
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.onVisibility?.();
    });
    view.webview.html = page(view.webview.cspSource, this.body());
    this.onVisibility?.();
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
    this.built = { version: this.store.version, at: Date.now() };
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

/** One inspector panel per session, reused. Hidden panels and idle store notifications build no page. */
export class Inspector implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private built = new Map<string, Built>();
  private sub: { dispose(): void };
  /** Called when a panel shows, hides or closes. */
  onVisibility?: () => void;

  /** `onNav` opens the workspace on a screen with the inspected session selected (Replay, HUD buttons). */
  constructor(private store: SessionStore, private onMessage: (m: WebviewMessage) => void, private ternAvailable: () => boolean, private onNav?: (view: string, key: string) => void) {
    this.sub = store.onDidChange(() => {
      for (const [k, p] of this.panels) {
        const b = this.built.get(k) ?? { version: -1, at: 0 };
        if (p.visible && viewNeedsRender({ version: store.version, renderedVersion: b.version, renderedAt: b.at, feedPending: false, now: Date.now() })) this.render(k);
      }
    });
  }

  get visible(): boolean {
    return [...this.panels.values()].some(p => p.visible);
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
      else if (msg.type === 'nav' && this.onNav) this.onNav(msg.view, key);
      else this.onMessage(msg);
    });
    p.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) this.render(key);
      this.onVisibility?.();
    });
    p.onDidDispose(() => {
      this.panels.delete(key);
      this.built.delete(key);
      this.onVisibility?.();
    });
    this.panels.set(key, p);
    this.onVisibility?.();
    p.webview.html = page(p.webview.cspSource, this.body(key) ?? '');
  }

  private body(key: string): string | undefined {
    const s = this.store.get(key);
    if (!s) return undefined;
    const parent = s.parentSessionId ? this.store.get(s.parentSessionId) : undefined;
    return inspectorJumps(key) + renderInspector(s, this.store.children(key), parent, this.store.timeline(key), this.ternAvailable());
  }

  private render(key: string): void {
    const p = this.panels.get(key);
    if (!p || !p.visible) return;
    this.built.set(key, { version: this.store.version, at: Date.now() });
    const html = this.body(key);
    if (html !== undefined) post(p.webview, html);
  }

  dispose(): void {
    this.sub.dispose();
    for (const p of this.panels.values()) p.dispose();
  }
}
