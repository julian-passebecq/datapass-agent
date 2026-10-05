import * as vscode from 'vscode';
import { AgentSessionSnapshot } from '../model';
import { SessionStore } from '../sessions/store';
import { duration } from '../activity/activity';
import { base, hhmm, statusText } from '../render/views';

type Node = { kind: 'provider'; provider: 'claude' | 'codex' } | { kind: 'session'; s: AgentSessionSnapshot } | { kind: 'info'; label: string };

const ICON: Record<string, [string, string | undefined]> = {
  RUNNING: ['pulse', 'charts.green'],
  IDLE: ['circle-filled', 'charts.yellow'],
  NEEDS_INPUT: ['bell-dot', 'charts.orange'],
  ENDED: ['circle-outline', undefined],
  UNKNOWN: ['question', undefined],
};

export class SessionsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;
  private sub: { dispose(): void };

  constructor(private store: SessionStore) {
    // Coalesce bursts of store updates into one tree refresh.
    this.sub = store.onDidChange(() => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const sig = this.signature();
        if (sig === this.lastSig) return; // nothing visible changed
        this.lastSig = sig;
        this.emitter.fire(undefined);
      }, 300);
    });
  }

  private lastSig = '';

  /** Everything the tree displays, at minute resolution for durations. */
  private signature(): string {
    const m = Math.floor(Date.now() / 60_000);
    return m + '|' + this.store.providerStates.map(p => `${p.provider}${p.detected}${p.version}`).join() + '|' +
      this.store.all().map(s => `${s.key}:${s.status}:${s.title}:${s.branch}:${s.repository}:${s.parentSessionId}:${s.changedFiles.length}:${s.commits.length}:${s.tests.length}`).join(';');
  }

  dispose(): void {
    this.sub.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }

  getChildren(n?: Node): Node[] {
    const all = this.store.all();
    if (!n) {
      return (['claude', 'codex'] as const).map(provider => ({ kind: 'provider', provider }));
    }
    if (n.kind === 'provider') {
      const st = this.store.providerStates.find(p => p.provider === n.provider);
      if (!st?.detected) return [{ kind: 'info', label: st?.note ?? 'not detected' }];
      const keys = new Set(all.map(s => s.key));
      const top = all.filter(s => s.provider === n.provider && (!s.parentSessionId || !keys.has(s.parentSessionId)));
      if (!top.length) return [{ kind: 'info', label: 'No session in the loaded history' }];
      const rank = (s: AgentSessionSnapshot) => ({ NEEDS_INPUT: 0, RUNNING: 1, IDLE: 2, UNKNOWN: 3, ENDED: 4 })[s.status];
      return top.sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map(s => ({ kind: 'session', s }));
    }
    if (n.kind === 'session') return this.store.children(n.s.key).map(s => ({ kind: 'session', s }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'info') {
      const it = new vscode.TreeItem(n.label);
      it.iconPath = new vscode.ThemeIcon('info');
      return it;
    }
    if (n.kind === 'provider') {
      const st = this.store.providerStates.find(p => p.provider === n.provider);
      const list = this.store.all().filter(s => s.provider === n.provider && !s.isWorker);
      const live = list.filter(s => s.status === 'RUNNING' || s.status === 'IDLE' || s.status === 'NEEDS_INPUT').length;
      const it = new vscode.TreeItem(n.provider === 'claude' ? 'Claude Code' : 'Codex', vscode.TreeItemCollapsibleState.Expanded);
      it.description = st?.detected ? `${live} live · ${list.length} in history${st.version ? ` · ${st.version}` : ''}` : 'not detected';
      it.tooltip = `${st?.note ?? ''}\n${st?.root ?? ''}`;
      it.iconPath = new vscode.ThemeIcon(n.provider === 'claude' ? 'sparkle' : 'hubot');
      it.contextValue = 'provider';
      return it;
    }
    const s = n.s;
    const kids = this.store.children(s.key).length;
    const label = s.isWorker ? s.workerLabel ?? s.title ?? s.sessionId : s.title ?? s.sessionId.slice(0, 8);
    const it = new vscode.TreeItem(label, kids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const live = s.status !== 'ENDED' && s.status !== 'UNKNOWN';
    const loc = [base(s.repository) || base(s.cwd), s.branch ?? (s.detachedHead ? 'detached' : '')].filter(Boolean).join(' · ');
    it.description = `${loc}${loc ? ' · ' : ''}${live ? duration(Date.now() - (s.startedAt ?? Date.now())) : hhmm(s.lastActivityAt)}${kids ? ` · ${kids}w` : ''}`;
    const [icon, color] = ICON[s.status];
    it.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const md = new vscode.MarkdownString(undefined, false);
    md.appendText(`${statusText(s)} — ${s.statusReason}\n\n`);
    md.appendText(`${s.provider} ${s.providerVersion ?? ''} · ${s.model ?? 'model not exposed'}${s.effort ? ' · ' + s.effort : ''}\n`);
    if (s.repository) md.appendText(`repo ${s.repository}\n`);
    if (s.worktree && s.isLinkedWorktree) md.appendText(`worktree ${s.worktree}\n`);
    md.appendText(`${s.changedFiles.length} files · ${s.commits.length} commits · ${s.tests.length} tests observed`);
    it.tooltip = md;
    it.contextValue = s.isWorker ? 'session.worker' : 'session';
    it.id = s.key;
    it.command = { command: 'agent.openSession', title: 'Open session', arguments: [s.key] };
    return it;
  }
}

export function keyOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const n = arg as Node | undefined;
  return n && n.kind === 'session' ? n.s.key : undefined;
}
