import * as vscode from 'vscode';
import { SessionStore, viewNeedsRender } from '../sessions/store';
import { DIGIT_VIEWS, EXTRA_NAV, page, validateMessage, WebviewMessage } from '../render/html';
import { allViews, coreFeeds, renderWorkspace, scoped, WsState, WsView } from '../render/workspace';
import { extraViews, extraCss } from '../render/extra';
import { ActCtx } from '../render/extra/kit';
import { Feed, FeedCtx, pump, setFeedScope, scopedPanelFeed, unavailableFeed } from '../render/extra/feeds';
import { visibleViews } from '../activity/panes';
import { isForbidden } from '../feeds/settings';
import { isCredentialPath } from '../util/redact';
import { workspaceMetadata, restoreWorkspaceMetadata, type WorkspaceMetadata } from '../cockpit/workspaceState';
import type { ContextRef } from '../cockpit/interfaces';

let panelSeq = 0;

/** An Agent Workspace editor panel. Several can be open (one per tab), each with its own screen, scope and options. */
export class WorkspacePanel implements vscode.Disposable {
  private static panels = new Set<WorkspacePanel>();
  static focused(): WorkspacePanel | undefined { return [...this.panels].find(p=>p.active); }
  private readonly feedKey = `panel:${++panelSeq}`;
  private panel?: vscode.WebviewPanel;
  private state: WsState = { view: 'overview', opts: {} };
  private timer?: NodeJS.Timeout;
  private last = '';
  private lastMetadata = '';
  /** Store version and time of the last built page, and whether a feed landed since (see `storeChanged`). */
  private renderedVersion = -1;
  private renderedAt = 0;
  private feedPending = false;
  private renderedContextValid?: boolean;
  private sub: { dispose(): void };
  private terminals = new Map<string, vscode.Terminal>();

  constructor(private store: SessionStore, private onMessage: (m: WebviewMessage) => void, private ternAvailable: () => boolean, private onClosed?: (p: WorkspacePanel) => void, private readSessions?: () => import('../model').AgentSessionSnapshot[], private readInputs?: () => import('../cockpit/facade').ScopedInputs, private context?: ContextRef, private readContextValidity?: () => boolean) {
    this.sub = store.onDidChange(() => this.storeChanged());
    WorkspacePanel.panels.add(this);
    for (const v of extraViews()) EXTRA_NAV.add(v.id);
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** Whether this panel is on screen (git correlation of ended sessions pauses while no Agent view is). */
  get visible(): boolean {
    return !!this.panel?.visible;
  }

  /** Whether this panel is the focused editor (the "Go to screen" command navigates that one). */
  get active(): boolean {
    return !!this.panel?.active;
  }

  /** VS Code does not expose input focus inside a webview through !inputFocus. Recheck there. */
  numberedNavigation(view: WsView): void {
    if (this.panel?.active && (DIGIT_VIEWS as readonly string[]).includes(view))
      void this.panel.webview.postMessage({type:'numberedNav',view});
  }

  /** Called when the panel shows, hides or closes. */
  onVisibility?: () => void;

  /** Public VS Code serializer adoption: no new panel, grant, or provider state. */
  restore(panel: vscode.WebviewPanel, value: unknown): void {
    const {metadata,reason} = restoreWorkspaceMetadata(value, allViews());
    this.state = {view:metadata.view,selected:metadata.selected,opts:metadata.opts};
    this.context = metadata.context;
    if (reason) {
      this.readSessions = () => [];
      this.readInputs = () => ({contexts:[],acceptedWork:[],assets:[],panelContext:{valid:false,context:metadata.context,projectId:metadata.context?.projectId ?? 'UNKNOWN',reason}});
    }
    this.attach(panel);
  }

  private metadata(): WorkspaceMetadata { return workspaceMetadata(this.state,allViews(),!!this.readSessions,this.context); }

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
    this.attach(p);
  }

  private attach(p: vscode.WebviewPanel): void {
    p.webview.options = {enableScripts:true,enableCommandUris:false,localResourceRoots:[]};
    p.iconPath = new vscode.ThemeIcon('pulse');
    p.webview.onDidReceiveMessage(m => {
      const msg = validateMessage(m, k => (this.readSessions?.() ?? this.store.all()).some(s => s.key === k));
      if (!msg) return;
      if (this.readInputs?.().panelContext?.valid===false && (msg.type==='act' || msg.type==='open' || msg.type==='cmd' && msg.cmd!=='reviewCockpitScope')) return;
      if (msg.type === 'ready') return this.render(true);
      if (msg.type === 'nav') {
        this.state.view = msg.view;
        if (msg.key) this.state.selected = msg.key;
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
      if (msg.type === 'clear') {
        if (this.state.selected === undefined) return;
        this.state.selected = undefined;
        return this.render();
      }
      this.onMessage(msg);
    });
    p.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) this.render(true);
      this.onVisibility?.();
    });
    p.onDidDispose(() => {
      this.panel = undefined;
      this.onVisibility?.();
      this.onClosed?.(this);
    });
    this.panel = p;
    this.onVisibility?.();
    this.updateTitle();
    p.webview.html = page(p.webview.cspSource, this.body(), { filter: true, css: extraCss(), state:this.metadata() });
  }

  private updateTitle(): void {
    if (this.panel) this.panel.title = this.state.opts?.scope ? `Agent · ${this.state.opts.scope}` : this.panel.title.replace(/ · .*$/, '');
  }

  private feedCtx(): FeedCtx {
    const cfg = vscode.workspace.getConfiguration('agent');
    return { sessions: scoped({ sessions: this.readSessions?.() ?? this.store.all(), providers: [], events: [], now: Date.now(), ternAvailable: false }, this.state.opts?.scope).sessions, trusted: vscode.workspace.isTrusted && !this.readSessions, config: (k, f) => this.readSessions && k.replace(/^agent\./, '') === 'cockpit.assetRoots' ? f : cfg.get(k.replace(/^agent\./, ''), f), now: Date.now() };
  }

  private pumpFeeds(force = false): void {
    if(this.readInputs?.().panelContext?.valid===false)return;
    this.selectFeedScope();
    // The visible screen, or every pane of the Panes screen; a feed shared by two panes loads once.
    const feeds = new Map<string, Feed>();
    for (const v of this.visibleExtra()) for (const f of v.feeds ?? []) feeds.set(f.id, f);
    for (const id of visibleViews(this.state.view, this.state.opts, allViews())) for (const f of coreFeeds(id)) feeds.set(f.id, f);
    if(this.readSessions)for(const [id]of feeds)if(!scopedPanelFeed(id)){feeds.delete(id);unavailableFeed(id);}
    if (feeds.size)
      pump([...feeds.values()], this.feedCtx(), () => {
        this.feedPending = true;
        this.schedule();
      }, force);
  }

  private visibleExtra() {
    const vis = visibleViews(this.state.view, this.state.opts, allViews());
    const ext = extraViews();
    return vis.flatMap(id => ext.filter(x => x.id === id));
  }

  private async act(name: string, arg: string): Promise<void> {
    this.selectFeedScope();
    // On the Panes screen the first pane whose screen defines the action handles it.
    const fn = this.visibleExtra().find(x => x.actions?.[name])?.actions?.[name];
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
      openFile: async p => {
        // Central guard whatever screen asks: Agent never opens auth / credential files.
        if (isForbidden(p) || isCredentialPath(p)) return void vscode.window.showWarningMessage('Agent never opens credential or auth files.');
        if (/\.(png|jpe?g|gif|webp)$/i.test(p)) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p)); return; }
        await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true });
      },
      revealInOs: async p => void (await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p))),
      openUrl: async u => {
        if (/^https:\/\//.test(u)) await vscode.env.openExternal(vscode.Uri.parse(u));
      },
      copy: async t => vscode.env.clipboard.writeText(t),
      info: m => void vscode.window.showInformationMessage(m),
      confirm: async (m, yes) => (await vscode.window.showWarningMessage(m, { modal: true }, yes)) === yes,
      saveText: async (name, content) => {
        const permitted=()=>!this.readSessions || this.readInputs?.().panelContext?.valid===true && this.readInputs?.().panelContext?.exportAllowed===true;
        if(!permitted()){void vscode.window.showInformationMessage('Agent: this reviewed scope does not permit export, or its source changed. Review an export-enabled scope before saving.');return undefined;}
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name) });
        if (!uri || !permitted()) return undefined;
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
    const sessions = this.readSessions?.() ?? this.store.all();
    const allowed = new Set(sessions.map(s => s.key));
    this.selectFeedScope();
    // Full event history only for screens that roll it up; otherwise just the selected session's events.
    const full = visibleViews(this.state.view, this.state.opts, allViews()).includes('activity');
    const events = (full ? this.store.timeline(undefined, 200_000) : this.state.selected ? this.store.timeline(this.state.selected) : []).filter(e => allowed.has(e.sessionKey));
    this.pumpFeeds();
    return renderWorkspace({ sessions, cockpitInputs: this.readInputs?.(), providers: this.readSessions ? [] : this.store.providerStates, events, now: Date.now(), ternAvailable: this.ternAvailable(), git: { enabled: this.store.opts.git, lastMs: this.store.lastStats?.gitMs, at: this.store.lastStats?.at, progress: { ...this.store.gitProgress } }, idleAlertMinutes: vscode.workspace.getConfiguration('agent').get<number>('idleAlertMinutes', 30), timeline: (k, n) => this.store.timeline(k, n).filter(e => allowed.has(e.sessionKey)), stats: this.readSessions ? undefined : this.stats(), config: (k, f) => vscode.workspace.getConfiguration('agent').get(k.replace(/^agent\./, ''), f) }, this.state);
  }

  private selectFeedScope(): void {
    setFeedScope(this.readSessions ? `${this.feedKey}:${(this.readSessions()).map(s => s.key).join(',')}` : this.state.opts?.scope);
  }

  private stats() {
    const r = this.store.lastStats;
    return r ? { refreshMs: r.ms, gitMs: r.gitMs, bytesRead: r.bytesRead, artifacts: r.artifacts, heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20), at: r.at } : undefined;
  }

  /** A store notification: skip building the page when the projection did not move (idle refresh), except to keep
   *  relative times and the refresh line from going stale for more than VIEW_STALE_MS. */
  private storeChanged(): void {
    // Reviewed source/grant validity can change without changing the session projection.
    const contextValidityChanged = !!this.readContextValidity && this.readContextValidity() !== this.renderedContextValid;
    if (!contextValidityChanged && !viewNeedsRender({ version: this.store.version, renderedVersion: this.renderedVersion, renderedAt: this.renderedAt, feedPending: this.feedPending, now: Date.now() })) return;
    this.schedule();
  }

  private schedule(): void {
    // Hidden panel: no timer and no page build; becoming visible renders (onDidChangeViewState).
    if (this.timer || !this.panel?.visible) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 300);
  }

  private render(force = false, top = false): void {
    const p = this.panel;
    if (!p || !p.visible) return;
    this.renderedVersion = this.store.version;
    this.renderedAt = Date.now();
    this.feedPending = false;
    this.renderedContextValid = this.readContextValidity?.();
    const html = this.body();
    const state=this.metadata(),metadata=JSON.stringify(state);
    if (!force && html === this.last && metadata===this.lastMetadata) return;
    this.last = html;
    this.lastMetadata=metadata;
    void p.webview.postMessage({ type: 'render', html, top, state });
  }

  dispose(): void {
    WorkspacePanel.panels.delete(this);
    this.sub.dispose();
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.terminals.values()) t.dispose();
    this.panel?.dispose();
  }
}
