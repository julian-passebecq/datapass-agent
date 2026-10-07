import * as vscode from 'vscode';
import * as path from 'node:path';
import { SessionStore } from '../sessions/store';
import { keyOf } from './sessionsTree';
import { ConversationSource, discoverConversations, exportConversations, projectMatches } from '../export/conversations';
import { bounded } from '../util/redact';

export function registerKnowledgeCommands(context: vscode.ExtensionContext, store: SessionStore): void {
  context.subscriptions.push(vscode.commands.registerCommand('agent.exportConversations', async (argument?: unknown) => {
    let sources: ConversationSource[];
    const key = keyOf(argument), session = key ? store.get(key) : undefined;
    try {
      if (session) sources = [{ provider: session.provider, file: session.artifactPath, id: session.sessionId, project: session.cwd }];
      else {
        const discovered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding recorded Claude and Codex sessions' }, () => discoverConversations());
        const projects = [...new Set(discovered.map(item => item.project).filter((item): item is string => !!item))].sort();
        const project = await vscode.window.showQuickPick(projects.map(value => ({ label: bounded(value, 180), value })),
          { title: 'Export conversations: choose a project', placeHolder: 'Only recorded sessions for the selected folder' });
        if (!project) return;
        const choices = discovered.filter(item => projectMatches(item.project, project.value));
        const titles = new Map(store.all().map(item => [item.artifactPath, item.title]));
        const picked = await vscode.window.showQuickPick(choices.map(source => ({ label: bounded(titles.get(source.file), 140) || `${source.provider}: ${bounded(source.id, 100)}`, description: `${source.provider} · ${bounded(source.id, 100)}`, detail: bounded(path.basename(source.file), 180), source })),
          { title: 'Choose conversations to export', canPickMany: true, placeHolder: 'Select sessions; exports include full recorded events' });
        if (!picked?.length) return;
        sources = picked.map(item => item.source);
      }
      const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export here' });
      if (!folder?.[0]) return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting redacted conversation events' },
        () => exportConversations(sources, folder[0].fsPath));
      const action = await vscode.window.showInformationMessage(`Exported ${result.sessions.length} sources. Review redacted files before sharing. Import cockpit.json in the T3 DataPass cockpit.`, 'Open bundle');
      if (action) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.directory));
    } catch { void vscode.window.showErrorMessage('Conversation export failed. Check source and destination permissions. No source was changed.'); }
  }), vscode.commands.registerCommand('agent.knowledge', async () => {
    const pick = await vscode.window.showQuickPick([
      { label: 'Export selected conversations', description: 'Full redacted JSONL, Markdown and Leviathan input', command: 'agent.exportConversations' },
      { label: 'Live agent overview', description: 'What Claude and Codex are doing now', command: 'agent.openWorkspace' },
      { label: 'Attention', description: 'Sessions that need a look', command: 'agent.openAttention' },
      { label: 'Choose a cockpit screen', description: 'Projects, repositories, review, sources and more', command: 'agent.goToScreen' },
    ], { title: 'DataPass: Start here', matchOnDescription: true });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }));
}
