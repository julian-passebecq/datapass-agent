import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeAdapter } from './providers/claude/claude';
import { CodexAdapter } from './providers/codex/codex';
import { ProviderAdapter } from './providers/types';
import { claudeInstalled, codexInstalled, InstalledVersion } from './providers/versions';
import { disposeCodexState, sweepCodexCopies } from './providers/codex/state';
import { maybeWarnRaw } from './archive/rawWarning';
import { SessionStore } from './sessions/store';
import { keyOf, SessionsTree } from './ui/sessionsTree';
import { AgentView, Inspector } from './ui/webviews';
import { WorkspacePanel } from './ui/workspace';
import { screenIndex } from './render/workspace';
import { WebviewMessage } from './render/html';
import { registerKnowledgeCommands } from './ui/knowledge';
import {Analyzer} from './ui/analyzer';
import {agentLensContext} from './interop';

const TERN_COMMANDS = ['tern.revealWorktree', 'tern.revealRevision', 'tern.revealChangeSet'];

export interface AgentApi {
  store: SessionStore;
  openWorkspace(view?: string, key?: string): void;
  installed: { claude?: InstalledVersion; codex?: InstalledVersion };
  activationMs: number;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<AgentApi> {
  const t0 = performance.now();
  const out = vscode.window.createOutputChannel('Agent', { log: true });
  const cfg = () => vscode.workspace.getConfiguration('agent');
  const adapters: ProviderAdapter[] = [];
  if (cfg().get<boolean>('claude.enabled', true)) adapters.push(new ClaudeAdapter());
  if (cfg().get<boolean>('codex.enabled', true)) adapters.push(new CodexAdapter());
  const store = new SessionStore(adapters, {
    historyDays: cfg().get<number>('historyDays', 3),
    maxSessions: cfg().get<number>('maxSessions', 300),
    idleMinutes: cfg().get<number>('idleMinutes', 10),
    git: vscode.workspace.isTrusted,
    // Paused until an Agent view shows (see syncGitEnded below).
    gitEnded: false,
  });
  const api: AgentApi = { store, installed: {}, activationMs: 0, openWorkspace: (v, k) => workspace.open(v as any, k) };

  let ternAvailable = false;
  const checkTern = async () => {
    const cmds = await vscode.commands.getCommands(true);
    ternAvailable = TERN_COMMANDS.some(c => cmds.includes(c));
    void vscode.commands.executeCommand('setContext', 'agent.ternAvailable', ternAvailable);
  };

  const timeline = new AgentView('timeline', store, m => onMessage(m));
  const cockpit = new AgentView('cockpit', store, m => onMessage(m));
  const activity = new AgentView('activity', store, m => onMessage(m));
  const inspector = new Inspector(store, m => onMessage(m), () => ternAvailable, (view, key) => workspace.open(view, key));
  const tree = new SessionsTree(store);
  const workspace = new WorkspacePanel(store, m => onMessage(m), () => ternAvailable);
  registerKnowledgeCommands(ctx, store);
  const analyzer=new Analyzer(store,()=>ternAvailable);
  ctx.subscriptions.push(analyzer,vscode.window.registerTreeDataProvider('agent.analyzer',analyzer),
    vscode.commands.registerCommand('agent.openAnalyzer',()=>vscode.commands.executeCommand('agent.analyzer.focus')),
    vscode.commands.registerCommand('agent.openCurrentProject',()=>workspace.open('projects')),
    vscode.commands.registerCommand('agent.exportSelection',(arg?:unknown)=>vscode.commands.executeCommand('agent.exportConversations',arg)));
  // Extra tabs: each its own screen / scope / options.
  const tabs = new Set<WorkspacePanel>();
  const newTab = (view?: string, key?: string, opts?: Record<string, string>) => {
    const p = new WorkspacePanel(store, m => onMessage(m), () => ternAvailable, x => { tabs.delete(x); x.dispose(); });
    tabs.add(p);
    p.onVisibility = syncGitEnded;
    p.open(view ?? (workspace as any).state?.view, key, opts);
  };

  // Git correlation of ENDED sessions only feeds what a view shows: paused while no Agent view is visible, resumed
  // (with a refresh) as soon as one is. Live sessions keep being correlated.
  let resumeTimer: NodeJS.Timeout | undefined;
  function syncGitEnded(): void {
    const on = cockpit.visible || timeline.visible || activity.visible || inspector.visible || workspace.visible || [...tabs].some(t => t.visible);
    if (on === (store.opts.gitEnded !== false)) return;
    store.opts.gitEnded = on;
    out.trace(`git correlation of ended sessions ${on ? 'resumed' : 'paused (no Agent view visible)'}`);
    if (on && !resumeTimer) resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      void store.refresh();
    }, 500);
  }
  for (const v of [cockpit, timeline, activity, inspector, workspace]) v.onVisibility = syncGitEnded;
  ctx.subscriptions.push({ dispose: () => resumeTimer && clearTimeout(resumeTimer) });

  function onMessage(m: WebviewMessage): void {
    if (m.type === 'ready') return; // handled by each view
    if (m.type === 'open') return inspector.open(m.key);
    if (m.type === 'select') return workspace.open(undefined, m.key);
    if (m.type === 'nav') return workspace.open(m.view, m.key || undefined);
    if (m.type === 'opt' || m.type === 'act' || m.type === 'clear') return; // workspace-only
    switch (m.cmd) {
      case 'refresh':
        void store.refresh();
        return;
      case 'timelineAll':
        timeline.focus(undefined);
        return;
      default:
        void vscode.commands.executeCommand(`agent.${m.cmd}`, m.key);
    }
  }

  // Security (audit A2): sqlite copies left by a crashed run are removed; this run's copies go on deactivate.
  const sweep = setTimeout(() => sweepCodexCopies(), 5_000);
  const rawWarn = () => maybeWarnRaw({ enabled: () => cfg().get<boolean>('archive.rawTranscripts', false) === true, state: ctx.globalState, show: m => void vscode.window.showWarningMessage(m) });
  rawWarn();
  ctx.subscriptions.push(
    { dispose: () => { clearTimeout(sweep); disposeCodexState(); } },
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('agent.archive.rawTranscripts') && rawWarn()),
    out,
    // Views stop listening before the store goes quiet; disposal order is reverse of push.
    { dispose: () => store.dispose() },
    tree,
    cockpit,
    timeline,
    activity,
    inspector,
    workspace,
    vscode.window.registerWebviewViewProvider('agent.cockpit', cockpit),
    vscode.window.registerWebviewViewProvider('agent.timeline', timeline),
    vscode.window.registerWebviewViewProvider('agent.activity', activity),
    vscode.window.registerTreeDataProvider('agent.sessions', tree),
    vscode.commands.registerCommand('agent.refresh', () => store.refresh()),
    vscode.commands.registerCommand('agent.openWorkspace', (arg?: unknown) => workspace.open(undefined, keyOf(arg))),
    vscode.commands.registerCommand('agent.openWorkspaceNewTab', (arg?: unknown) => {
      const scope = arg && typeof arg === 'object' && typeof (arg as { scope?: unknown }).scope === 'string' ? (arg as { scope: string }).scope : undefined;
      newTab(undefined, scope ? undefined : keyOf(arg), scope && /^[a-z0-9._:-]{1,40}$/.test(scope) ? { scope } : undefined);
    }),
    { dispose: () => tabs.forEach(t => t.dispose()) },
    // Jump to any screen: label + group + hint, then navigate the focused Agent tab (else the main workspace).
    vscode.commands.registerCommand('agent.goToScreen', async () => {
      const target = [workspace, ...tabs].find(p => p.active) ?? workspace;
      const pick = await vscode.window.showQuickPick(
        screenIndex().map(s => ({ label: s.label, description: s.group, detail: s.hint || undefined, id: s.id })),
        { title: 'Agent: Go to screen', placeHolder: 'Type to filter screens', matchOnDescription: true, matchOnDetail: true },
      );
      if (pick) target.open(pick.id);
    }),
    vscode.commands.registerCommand('agent.readTranscript', (arg?: unknown) => workspace.open('transcript', keyOf(arg))),
    vscode.commands.registerCommand('agent.openAttention', () => workspace.open('attention')),
    vscode.commands.registerCommand('agent.openTeam', (arg?: unknown) => workspace.open('team', keyOf(arg))),
    vscode.commands.registerCommand('agent.openSession', async (arg?: unknown) => {
      let key = keyOf(arg);
      if (!key) {
        const pick = await vscode.window.showQuickPick(
          store.all().filter(s => !s.isWorker).map(s => ({ label: s.title ?? s.sessionId, description: `${s.provider} · ${s.status} · ${s.branch ?? ''}`, key: s.key })),
          { placeHolder: 'Select an agent session' },
        );
        key = pick?.key;
      }
      if (key) inspector.open(key);
    }),
    vscode.commands.registerCommand('agent.openTimeline', async (arg?: unknown) => {
      timeline.focus(keyOf(arg));
      await vscode.commands.executeCommand('agent.timeline.focus');
    }),
    vscode.commands.registerCommand('agent.copySessionId', async (arg?: unknown) => {
      const s = store.get(keyOf(arg) ?? '');
      if (s) {
        await vscode.env.clipboard.writeText(s.sessionId);
        void vscode.window.setStatusBarMessage(`Copied ${s.provider} session id`, 2000);
      }
    }),
    vscode.commands.registerCommand('agent.revealWorktree', async (arg?: unknown) => {
      const s = store.get(keyOf(arg) ?? '');
      const dir = s?.worktree ?? s?.cwd;
      if (!dir || !fs.existsSync(dir)) return vscode.window.showInformationMessage('Agent: this session’s worktree is not available on disk.');
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand('agent.openArtifactFolder', async (arg?: unknown) => {
      // "Open provider session": the provider's own artifact location (Agent does not copy transcripts).
      const s = store.get(keyOf(arg) ?? '');
      if (s && fs.existsSync(s.artifactPath)) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.artifactPath));
    }),
    vscode.commands.registerCommand('agent.openInTern', async (arg?: unknown) => {
      const s = store.get(keyOf(arg) ?? '');
      if (!s || !ternAvailable) return vscode.window.showInformationMessage('Agent: Lens is unavailable.');
      const pointer=agentLensContext(s,'worktree');if(!pointer)return vscode.window.showInformationMessage('Agent: no Git worktree evidence recorded.');
      await vscode.commands.executeCommand('tern.openDevContext',pointer);
      const lens=vscode.extensions.getExtension('julian-passebecq.tern-vscode');const api=lens?.isActive?lens.exports:undefined;
      api?.setAgentAnnotations?.([{provider:s.provider,sessionId:s.sessionId,repoPath:pointer.repository!.path,worktreePath:s.worktree,touchedFiles:s.changedFiles,evidenceKind:'OBSERVED',observedAt:new Date().toISOString()}]);
    }),
    vscode.commands.registerCommand('agent.showDiagnostics', () => {
      out.info(JSON.stringify({ providers: store.providerStates, installed: api.installed, refresh: store.history.slice(-10), memoryMB: Math.round(process.memoryUsage().rss / 1e6) }, null, 2));
      out.show(true);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      store.opts.git = true;
      void store.refresh();
    }),
  );
  for(const [id,action]of [['agent.inspectChangeInLens','change'],['agent.openCommitInLens','commit'],['agent.openChangedFileInLens','file']]as const)ctx.subscriptions.push(vscode.commands.registerCommand(id,async(arg?:unknown)=>{
    const s=store.get(keyOf(arg)??'');const pointer=s&&agentLensContext(s,action);if(!pointer||!ternAvailable)return vscode.window.showInformationMessage('Agent: Lens or the requested Git evidence is unavailable.');return vscode.commands.executeCommand('tern.openDevContext',pointer);
  }));

  // Refresh model: fs watchers (debounced) on provider artifact folders + a slow tick for time-based status.
  let debounce: NodeJS.Timeout | undefined;
  const kick = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void store.refresh(), 1500);
  };
  for (const a of adapters) {
    for (const dir of a.watchTargets()) {
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (_e, f) => {
          if (!f || /\.(jsonl|json)$/i.test(String(f))) kick();
        });
        w.on('error', () => w.close());
        ctx.subscriptions.push({ dispose: () => w.close() });
      } catch (e) {
        out.warn(`watch unavailable for ${path.basename(dir)}; polling only`);
      }
    }
  }
  const tick = setInterval(() => void store.refresh(), 20_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) }, { dispose: () => debounce && clearTimeout(debounce) });

  const logSub = store.onDidChange(() => {
    const st = store.lastStats;
    if (st) out.trace(`refresh ${st.ms}ms artifacts=${st.artifacts} ingested=${st.ingested} bytes=${st.bytesRead} git=${st.gitMs}ms`);
  });
  ctx.subscriptions.push(logSub);

  void checkTern();
  ctx.subscriptions.push(vscode.extensions.onDidChange(() => void checkTern()));
  void claudeInstalled().then(v => (api.installed.claude = v));
  void codexInstalled().then(v => (api.installed.codex = v));
  void store.refresh().then(st => out.info(`initial discovery ${st.ms}ms (git ${st.gitMs}ms), ${st.artifacts} artifacts, ${Math.round(st.bytesRead / 1e6)} MB`));

  api.activationMs = Math.round(performance.now() - t0);
  out.info(`activated in ${api.activationMs}ms; git correlation ${store.opts.git ? 'on' : 'off (untrusted workspace)'}`);
  return api;
}

export function deactivate(): void {
  /* subscriptions dispose watchers and timers */
}
