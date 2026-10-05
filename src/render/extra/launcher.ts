// Add-on screen "Launcher": start or resume a Claude Code / Codex session in a terminal Agent owns.
// EXPERIMENTAL and the ONLY Agent screen that starts provider sessions (Agent is otherwise a read-only observer).
// It refuses to start or resume anything in an untrusted workspace (VS Code Workspace Trust).
// Logic (allow-lists, command building, owned terminals) lives in src/activity/launcher.ts.
// Nothing starts without ctx.confirm showing the exact folder and command. Never bypassPermissions.
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../../model';
import {
  addOwned, Allow, buildResume, buildStart, CLAUDE_EFFORTS, CODEX_EFFORTS, decodePick, encodePick, folderChoices, LaunchPick,
  LaunchProvider, listOwned, modelChoices, profileChoices, specOf, takeOwned, terminalName,
} from '../../activity/launcher';
import { isLive } from '../../activity/insights';
import { defaultHomes, readCodexConfig } from '../../feeds/settings';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { ago, prettyModel, repoOf, titleOf } from '../workspace';
import { Feed, feedValue } from './feeds';
import { actBtn, ActCtx, ExtraView, opt, seg, toolbar } from './kit';

const FEED_ID = 'launcher.env';

interface Env {
  /** Open VS Code workspace folders (empty outside the extension host). */
  workspace: string[];
  /** Codex profile names from ~/.codex/config.toml (names only). */
  profiles: string[];
  codexDefaultProfile?: string;
  /** Folder paths (normalised key) that do not exist on disk any more. */
  missing: string[];
}

function workspaceFolders(): string[] {
  try {
    // Guarded: the feed also runs in tests and the preview script, where there is no vscode module.

    const vs = require('vscode') as typeof import('vscode');
    return (vs.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  } catch {
    return [];
  }
}

/** True when VS Code trusts the workspace. Outside the extension host (tests, preview) there is no trust API. */
let trustProbe = (): boolean => {
  try {
    const vs = require('vscode') as typeof import('vscode');
    return vs.workspace.isTrusted !== false;
  } catch {
    return true;
  }
};

/** Test hook: replace the workspace-trust probe. */
export function setTrustProbe(probe: () => boolean): void {
  trustProbe = probe;
}

const UNTRUSTED = 'Agent: the Launcher starts provider sessions only in a trusted workspace (Workspaces: Manage Workspace Trust). Copy the command instead.';

const envFeed: Feed<Env> = {
  id: FEED_ID,
  intervalMs: 30_000,
  load: async ctx => {
    const workspace = workspaceFolders();
    const cx = readCodexConfig(path.join(defaultHomes().codexHome, 'config.toml'), 'user');
    const folders = folderChoices(ctx.sessions, workspace);
    const missing = folders.filter(f => !fs.existsSync(f.path)).map(f => f.key);
    return { workspace, profiles: profileChoices(cx.profiles.map(p => p.name)), codexDefaultProfile: cx.profile, missing };
  },
};

function allowOf(sessions: AgentSessionSnapshot[], env: Env | undefined): Allow {
  return { models: modelChoices(sessions), profiles: env?.profiles ?? [], folders: folderChoices(sessions, env?.workspace ?? []).filter(f => !env?.missing.includes(f.key)) };
}

function pickOf(st: WsState, allow: Allow): LaunchPick {
  const provider: LaunchProvider = opt(st, 'launcher.provider', 'claude') === 'codex' ? 'codex' : 'claude';
  const folder = opt(st, 'launcher.folder', '');
  return {
    provider,
    folder: allow.folders.some(f => f.key === folder) ? folder : (allow.folders[0]?.key ?? ''),
    model: opt(st, `launcher.${provider}.model`, 'default'),
    effort: opt(st, `launcher.${provider}.effort`, 'default'),
    profile: provider === 'codex' ? opt(st, 'launcher.codex.profile', 'none') : 'none',
    mode: opt(st, 'launcher.mode', 'default'),
  };
}

const MODE_TIP: Record<string, string> = {
  default: 'Claude: asks before edits and commands. Codex: its config.toml defaults.',
  plan: 'Claude: --permission-mode plan (read and plan, no edits). Codex: --sandbox read-only --ask-for-approval on-request.',
  acceptedits: 'Claude: --permission-mode acceptEdits (edits allowed, commands still ask). Codex: --sandbox workspace-write --ask-for-approval on-request.',
};

function startForm(d: WsData, st: WsState, allow: Allow, env: Env | undefined): string {
  const p = pickOf(st, allow);
  const models = allow.models[p.provider];
  const efforts = p.provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  let h = toolbar(
    seg(st, 'launcher.provider', [['claude', 'Claude Code'], ['codex', 'Codex']], 'claude', 'Which CLI to start'),
    seg(st, 'launcher.mode', [['default', 'default'], ['plan', 'plan'], ['acceptedits', 'acceptEdits']], 'default', 'Permission mode. bypassPermissions / danger-full-access are never offered.'),
  );
  // folder
  if (!allow.folders.length) h += '<div class="empty">No folder yet: open a workspace folder or run an agent once.</div>';
  else
    h += `<div class="ln-lab">Folder <span class="muted" title="OBSERVED: repository / cwd recorded by sessions, plus open workspace folders">· ${allow.folders.length}</span></div><div class="ln-folders">${allow.folders
      .map(f => `<button class="ln-f${f.key === p.folder ? ' on' : ''}" data-opt="launcher.folder" data-val="${esc(f.key)}" title="${esc(f.path)}"><b>${esc(f.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? f.path)}</b><span class="muted">${esc(f.path)}</span><span class="ln-tag">${f.from === 'sessions' ? `${f.sessions} session${f.sessions === 1 ? '' : 's'}` : f.from === 'workspace' ? 'workspace' : `workspace · ${f.sessions}`}</span></button>`)
      .join('')}</div>`;
  h += `<div class="ln-lab">Model <span class="muted" title="Allow-list: CLI aliases plus models OBSERVED in local sessions">· allow-list</span></div>${toolbar(seg(st, `launcher.${p.provider}.model`, [['default', 'CLI default'], ...models.map(m => [m, prettyModel(m) || m] as [string, string])], 'default'))}`;
  h += `<div class="ln-lab">${p.provider === 'claude' ? 'Effort' : 'Reasoning effort'}</div>${toolbar(seg(st, `launcher.${p.provider}.effort`, [['default', 'CLI default'], ...efforts.map(e => [e, e] as [string, string])], 'default'))}`;
  if (p.provider === 'codex') {
    const profs = allow.profiles;
    h += `<div class="ln-lab">Profile <span class="muted" title="OBSERVED: [profiles] names in ~/.codex/config.toml (names only)">· config.toml</span></div>${
      profs.length ? toolbar(seg(st, 'launcher.codex.profile', [['none', env?.codexDefaultProfile ? `config default (${env.codexDefaultProfile})` : 'none'], ...profs.map(n => [n, n] as [string, string])], 'none')) : '<div class="muted ln-note">No profile in ~/.codex/config.toml (or names with capitals / spaces, which are skipped).</div>'
    }`;
  }
  const spec = specOf(p, allow);
  const built = 'error' in spec ? { ok: false as const, error: spec.error } : buildStart(spec, allow);
  h += `<div class="ln-cmd">${
    built.ok
      ? `<div class="muted ln-mono">${esc(built.cwd)}&gt;</div><code class="ln-mono">${esc(built.command)}</code><div class="ln-acts">${actBtn('start', encodePick(p), 'Start in new terminal', 'Asks for confirmation, then opens an Agent-owned VS Code terminal and runs this command', 'ln-btn')} ${actBtn('copy', encodePick(p), 'Copy command')}</div>`
      : `<div class="ln-err">${esc(built.error)}</div>`
  }</div><div class="muted ln-note">Mode: ${esc(MODE_TIP[p.mode] ?? '')} First prompt: type it in the terminal once the CLI is up (Agent never types for you).</div>`;
  void d;
  return h;
}

function resumeSection(d: WsData, st: WsState): string {
  const sel = st.selected ? d.sessions.find(s => s.key === st.selected) : undefined;
  const leads = d.sessions.filter(s => !s.isWorker).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 10);
  let h = '';
  if (sel) {
    const b = buildResume(sel);
    h += `<div class="ln-sel"><b>${esc(titleOf(sel))}</b> <span class="muted">${esc(repoOf(sel))} · ${esc(sel.provider === 'codex' ? 'Codex' : 'Claude Code')}${sel.isWorker ? ' · worker' : ''}</span>${
      b.ok
        ? `<div><code class="ln-mono">${esc(b.command)}</code> ${actBtn('resume', sel.key, isLive(sel) ? 'Resume (still live!)' : 'Resume selected session', 'Asks for confirmation, then opens an Agent-owned terminal in the session folder', 'ln-btn')}</div>`
        : `<div class="ln-err">${esc(b.error)}</div>`
    }</div>`;
  } else h += '<div class="muted ln-note">Select a session (rows below, or anywhere in Agent) to resume it.</div>';
  if (leads.length)
    h += `<table class="ln-t"><tr><th>Session</th><th>Repo</th><th>Provider</th><th>Last</th><th></th></tr>${leads
      .map(s => {
        const ok = buildResume(s).ok;
        return `<tr data-select="${esc(s.key)}" class="${s.key === st.selected ? 'on' : ''}"><td>${esc(titleOf(s))}${isLive(s) ? ' <span class="chip">live</span>' : ''}</td><td class="muted">${esc(repoOf(s))}</td><td class="${s.provider === 'codex' ? 'ln-cx' : 'ln-cc'}">${s.provider === 'codex' ? 'Codex' : 'Claude'}</td><td class="muted">${esc(ago(d.now, s.lastActivityAt))}</td><td>${ok ? actBtn('resume', s.key, 'Resume', 'Asks for confirmation first') : '<span class="muted" title="id or folder not usable">—</span>'}</td></tr>`;
      })
      .join('')}</table>`;
  return h;
}

function ownedSection(d: WsData): string {
  const ts = listOwned();
  if (!ts.length) return '<div class="muted ln-note">None yet. Only terminals started from this screen are listed and can be closed here.</div>';
  return `<table class="ln-t"><tr><th>Terminal</th><th>Command</th><th>Started</th><th></th></tr>${ts
    .map(t => `<tr><td>${esc(t.name)}</td><td><code class="ln-mono">${esc(t.command)}</code><div class="muted">${esc(t.cwd)}</div></td><td class="muted">${esc(ago(d.now, t.at))}</td><td>${actBtn('close', t.id, 'Close', 'Disposes this terminal (the CLI in it stops)')}</td></tr>`)
    .join('')}</table>`;
}

function render(d: WsData, st: WsState): string {
  const fsv = feedValue<Env>(FEED_ID);
  const allow = allowOf(d.sessions, fsv.value);
  const trusted = trustProbe();
  return `<div class="ln">
<div class="ln-exp" title="Agent observes sessions read-only everywhere else. This screen runs your own CLI in a terminal, after a confirmation.">EXPERIMENTAL · the only Agent screen that starts provider sessions${trusted ? '' : ' · <b>disabled: this workspace is not trusted</b> (copy still works)'}</div>
<h2>Start a session</h2>${startForm(d, st, allow, fsv.value)}
<h2>Resume</h2>${resumeSection(d, st)}
<h2>Terminals Agent started · ${listOwned().length}</h2>${ownedSection(d)}
<div class="muted ln-note">Agent runs your own CLI under your own login and never reads auth files. Flags only: --model, --effort, --permission-mode (Claude); --profile, --model, -c model_reasoning_effort, --sandbox, --ask-for-approval on-request (Codex).</div>
</div>`;
}

function rebuild(arg: string, ctx: ActCtx) {
  const p = decodePick(arg);
  if (!p) return { ok: false as const, error: 'Bad selection.' };
  const allow = allowOf(ctx.sessions(), feedValue<Env>(FEED_ID).value);
  const spec = specOf(p, allow);
  return 'error' in spec ? { ok: false as const, error: spec.error } : buildStart(spec, allow);
}

export const launcherView: ExtraView = {
  id: 'launcher',
  label: 'Launcher',
  group: 'System',
  hint: 'EXPERIMENTAL: the only screen that starts provider sessions. Start or resume a Claude / Codex session in a terminal Agent owns (trusted workspace, confirm first).',
  ready: true,
  feeds: [envFeed as Feed],
  badge: () => (listOwned().length ? String(listOwned().length) : ''),
  render,
  actions: {
    start: async (arg, ctx) => {
      if (!trustProbe()) return ctx.info(UNTRUSTED);
      const b = rebuild(arg, ctx);
      if (!b.ok) return ctx.info(`Agent: ${b.error}`);
      if (!(await ctx.confirm(`Start a new terminal and run:\n\n${b.command}\n\nin ${b.cwd}`, 'Start'))) return;
      const provider = b.argv[0] === 'codex' ? 'codex' : 'claude';
      const name = terminalName(provider, b.cwd);
      const id = ctx.openTerminal(name, b.cwd, b.command);
      addOwned({ id, name, cwd: b.cwd, command: b.command, provider, at: Date.now() });
    },
    copy: async (arg, ctx) => {
      const b = rebuild(arg, ctx);
      if (!b.ok) return ctx.info(`Agent: ${b.error}`);
      await ctx.copy(b.command);
      ctx.info('Agent: command copied.');
    },
    resume: async (arg, ctx) => {
      if (!trustProbe()) return ctx.info(UNTRUSTED);
      const s = ctx.sessions().find(x => x.key === arg);
      const b = buildResume(s);
      if (!b.ok || !s) return ctx.info(`Agent: ${b.ok ? 'session not found' : b.error}`);
      const warn = isLive(s) ? '\n\nThis session still looks live: resuming it in a second terminal can make both write to the same transcript.' : '';
      if (!(await ctx.confirm(`Resume "${titleOf(s)}" in a new terminal:\n\n${b.command}\n\nin ${b.cwd}${warn}`, 'Resume'))) return;
      const provider = s.provider === 'codex' ? 'codex' : 'claude';
      const name = terminalName(provider, b.cwd, true);
      const id = ctx.openTerminal(name, b.cwd, b.command);
      addOwned({ id, name, cwd: b.cwd, command: b.command, provider, at: Date.now() });
    },
    close: (arg, ctx) => {
      const t = takeOwned(arg);
      if (t) ctx.closeTerminal(t.id);
    },
  },
  css: `
.ln .ln-exp { font-size: 11px; color: var(--vscode-descriptionForeground); border: 1px dashed var(--line); border-radius: 4px; padding: 3px 8px; margin: 0 0 6px; }
.ln .ln-lab { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 8px 0 2px; }
.ln .ln-folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px; }
.ln .ln-f { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left; background: var(--raise); color: var(--vscode-foreground); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; cursor: pointer; font: inherit; min-width: 0; }
.ln .ln-f span { font-size: 10px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ln .ln-f.on { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.ln .ln-tag { color: var(--vscode-descriptionForeground); }
.ln .ln-cmd { margin: 10px 0 4px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--raise); }
.ln .ln-mono { font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-wrap: anywhere; }
.ln .ln-acts { margin-top: 6px; display: flex; gap: 10px; align-items: center; }
.ln .ln-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 3px 10px; cursor: pointer; font: inherit; }
.ln .ln-err { color: var(--bad); }
.ln .ln-note { font-size: 11px; margin: 4px 0; }
.ln .ln-sel { margin: 4px 0 8px; padding: 6px 8px; border-left: 3px solid var(--accent); background: var(--raise); }
.ln .ln-t { border-collapse: collapse; width: 100%; font-size: 12px; }
.ln .ln-t th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 2px 6px; }
.ln .ln-t td { border-bottom: 1px solid var(--line); padding: 3px 6px; vertical-align: top; }
.ln .ln-t tr[data-select] { cursor: pointer; }
.ln .ln-t tr.on td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.ln .ln-cc { color: var(--claude); } .ln .ln-cx { color: var(--codex); }
`,
};
