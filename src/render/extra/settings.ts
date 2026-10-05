// Add-on screen "Settings": effective Claude Code and Codex configuration, read-only and redacted.
// Data: src/feeds/settings.ts (fs reads only). Actions open / reveal / copy a file the feed listed; the user edits there.
import type { ExtraView, ActCtx } from './kit';
import { actBtn, loadError, loading, seg, toolbar, opt } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';
import { esc } from '../html';
import { ago, bytes, kpi, prettyModel, repoOf, WsData, WsState } from '../workspace';
import { isLive } from '../../activity/insights';
import { modeChip, modeFacts } from './live';
import { normalizeCase } from '../../util/paths';
import {
  ClaudeLayer,
  CodexConfig,
  collectSettings,
  defaultHomes,
  effective,
  Effective,
  isForbidden,
  LayerKind,
  layersFor,
  MdItem,
  mergedRules,
  rootsOf,
  SettingsReport,
} from '../../feeds/settings';
import type { AgentSessionSnapshot } from '../../model';

const FEED_ID = 'settings.config';

/** Reads `agent.settings.<name>`; accepts both full and section-relative keys from the host. */
function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.settings.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`settings.${name}`, fallback);
}

const settingsFeed: Feed<SettingsReport> = {
  id: FEED_ID,
  intervalMs: 30_000,
  async load(ctx) {
    const h = defaultHomes();
    const extra = cfg<unknown>(ctx, 'extraRoots', []);
    const max = Math.max(1, Math.min(200, Number(cfg<number>(ctx, 'maxRepos', 40)) || 40));
    const roots = [...rootsOf(ctx.sessions).slice(0, max), ...(Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string') : [])];
    return collectSettings({ claudeHome: h.claudeHome, codexHome: h.codexHome, managedFile: cfg<boolean>(ctx, 'managed', true) ? h.managedFile : undefined, roots, now: ctx.now });
  },
};

// ---------------------------------------------------------------- helpers

const LAYER_LETTER: Record<LayerKind, string> = { managed: 'M', local: 'L', project: 'P', user: 'U' };
const LAYER_NAME: Record<LayerKind, string> = { managed: 'Managed (admin policy)', local: 'Project local (.claude/settings.local.json)', project: 'Project shared (.claude/settings.json)', user: 'User (~/.claude/settings.json)' };

function home(report: SettingsReport): string {
  return report.claudeHome.replace(/[\\/]\.claude[\\/]?$/, '');
}

function short(report: SettingsReport, file: string): string {
  const h = home(report);
  return h && normalizeCase(file).startsWith(normalizeCase(h)) ? '~' + file.slice(h.length).replace(/\\/g, '/') : file.replace(/\\/g, '/');
}

function ly(kind: LayerKind | undefined, title = ''): string {
  if (!kind) return '';
  return `<span class="cfg-ly cfg-${kind}" title="${esc(`${LAYER_NAME[kind]}${title ? ' · ' + title : ''}`)}">${LAYER_LETTER[kind]}</span>`;
}

function modeCls(m?: string): string {
  if (!m) return '';
  if (/bypass/i.test(m)) return 'cfg-bad';
  if (/acceptEdits|auto/i.test(m)) return 'cfg-warn';
  if (/plan/i.test(m)) return 'cfg-acc';
  return 'cfg-ok';
}

function codexRisk(approval?: string, sandbox?: string): string {
  if (sandbox === 'danger-full-access' && approval === 'never') return 'cfg-bad';
  if (sandbox === 'danger-full-access' || approval === 'never') return 'cfg-warn';
  return '';
}

/** One effective value cell: value, winning layer letter, shadowed layers in the tooltip. */
function effCell(e: Effective<string>, fmt: (v: string) => string = v => v, cls = ''): string {
  if (e.value === undefined) return `<td class="cfg-unset" title="UNKNOWN: not set in any settings layer; the CLI uses its own default or a command-line flag">—</td>`;
  const sh = e.shadowed.length ? ` · overrides ${e.shadowed.map(s => `${LAYER_LETTER[s.layer]}=${s.value}`).join(', ')}` : '';
  return `<td class="${cls}" title="${esc(`DERIVED: winning layer by precedence managed > local > project > user · OBSERVED in ${e.file ?? ''}${sh}`)}">${esc(fmt(e.value))}${ly(e.layer)}${e.shadowed.length ? '<sup class="cfg-sh">*</sup>' : ''}</td>`;
}

function fileBtns(report: SettingsReport, file: string): string {
  if (isForbidden(file)) return '';
  return `<span class="cfg-acts">${actBtn('open', file, 'Open', `Open ${short(report, file)} in the editor`)}${actBtn('reveal', file, 'Reveal', 'Reveal in the file explorer')}${actBtn('copy', file, 'Copy path', '')}</span>`;
}

const when = (d: WsData, t?: number) => (t ? `<span class="muted" title="${esc(new Date(t).toLocaleString())}">${esc(ago(d.now, t))}</span>` : '');

interface Scope {
  root?: string;
  name: string;
  layers: ClaudeLayer[];
  sessions: AgentSessionSnapshot[];
  own: ClaudeLayer[];
}

function scopes(report: SettingsReport, d: WsData): Scope[] {
  const byRoot = new Map<string, AgentSessionSnapshot[]>();
  for (const s of d.sessions) {
    const p = s.repository ?? s.cwd;
    if (!p) continue;
    const k = normalizeCase(p);
    byRoot.set(k, [...(byRoot.get(k) ?? []), s]);
  }
  const out: Scope[] = [{ name: 'User (all projects)', layers: layersFor(report), sessions: [], own: report.layers.filter(l => l.kind === 'user' || l.kind === 'managed') }];
  for (const r of report.roots) {
    const k = normalizeCase(r.path);
    out.push({ root: r.path, name: r.name, layers: layersFor(report, r.path), sessions: byRoot.get(k) ?? [], own: report.layers.filter(l => l.root && normalizeCase(l.root) === k) });
  }
  return out;
}

function observed(sc: Scope): string {
  if (!sc.root) return '';
  const parts: string[] = [];
  for (const p of ['claude', 'codex'] as const) {
    const top = sc.sessions.filter(s => !s.isWorker && s.provider === p);
    if (!top.length) continue;
    const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].slice(0, 3);
    const facts = top.flatMap(s => modeFacts(s)).filter(x => x.field !== 'sandbox');
    const modes = (['permissionMode', 'approvalPolicy', 'collaborationMode'] as const)
      .map(f => {
        const xs = facts.filter(x => x.field === f);
        const vals = uniq(xs.map(x => x.value));
        return vals.length ? `${xs[0].label} ${vals.join('/')}` : '';
      })
      .filter(Boolean);
    const txt = [uniq(top.map(s => prettyModel(s.model))).join(', '), uniq(top.map(s => s.effort)).join('/'), ...modes].filter(Boolean).join(' · ');
    const kinds = new Set(facts.map(x => x.kind));
    const kind = kinds.has('UNKNOWN') ? 'UNKNOWN' : kinds.has('INFERRED') ? 'INFERRED' : kinds.has('DERIVED') ? 'DERIVED' : 'OBSERVED';
    const chip = modes.length
      ? modeChip(kind, p === 'claude' ? 'transcript permissionMode (latest per session)' : 'rollout turn_context approval_policy / collaboration_mode (latest per session)')
      : modeChip('UNKNOWN', p === 'claude' ? 'no permissionMode recorded in these transcripts' : 'no approval policy / collaboration mode recorded in these rollouts');
    if (txt) parts.push(`<span class="cfg-seen ${p}" title="${esc(`OBSERVED in ${top.length} ${p === 'claude' ? 'Claude Code transcript(s)' : 'Codex rollout(s)'} of this repo (loaded window)`)}">${esc(txt)}${chip}</span>`);
  }
  return parts.length ? parts.join(' ') : '<span class="muted">—</span>';
}

// ---------------------------------------------------------------- tabs

function effectiveTab(report: SettingsReport, d: WsData, st: WsState): string {
  const show = opt(st, 'settings.repos', 'overrides');
  const layout = opt(st, 'settings.layout', 'matrix');
  let rows = scopes(report, d);
  if (show === 'overrides') rows = rows.filter(r => !r.root || r.own.some(l => l.exists));
  else if (show === 'live') rows = rows.filter(r => !r.root || r.sessions.some(isLive));
  const hidden = report.roots.length + 1 - rows.length;
  const tb = toolbar(
    seg(st, 'settings.repos', [['overrides', 'Repos with own settings'], ['live', 'Repos with live sessions'], ['all', 'All repos agents used']], 'overrides', 'Which repos to list'),
    seg(st, 'settings.layout', [['matrix', 'Matrix'], ['cards', 'Cards']], 'matrix', 'Layout'),
  );
  if (layout === 'cards') {
    return (
      tb +
      `<div class="cfg-cards">${rows
        .map(sc => {
          const L = sc.layers;
          const r = mergedRules(L);
          const field = (label: string, e: Effective<string>, f: (v: string) => string = v => v, cls = '') => `<div class="cfg-kv"><span>${esc(label)}</span>${e.value !== undefined ? `<b class="${cls}">${esc(f(e.value))}${ly(e.layer)}</b>` : '<b class="cfg-unset">—</b>'}</div>`;
          const dm = effective(L, 'defaultMode');
          return `<div class="cfg-card"><div class="cfg-ch"><b title="${esc(sc.root ?? report.claudeHome)}">${esc(sc.name)}</b>${sc.root ? `<span class="muted">${sc.sessions.length} session(s)${sc.sessions.some(isLive) ? ' · <span class="cfg-ok">live</span>' : ''}</span>` : ''}</div>
${field('Model', effective(L, 'model'), prettyModel)}${field('Effort', effective(L, 'effortLevel'))}${field('Permission mode', dm, v => v, modeCls(dm.value))}${field('Output style', effective(L, 'outputStyle'))}${field('Status line', effective(L, 'statusLine'), v => (v.length > 40 ? v.slice(0, 39) + '…' : v))}
<div class="cfg-kv"><span>Rules</span><b><span class="cfg-ok">${r.allow}</span> allow · <span class="cfg-bad">${r.deny}</span> deny · <span class="cfg-warn">${r.ask}</span> ask</b></div><div class="cfg-kv"><span>Hooks</span><b>${r.hooks}</b></div>${sc.root ? `<div class="cfg-kv"><span>Seen</span><b>${observed(sc)}</b></div>` : ''}
<div class="cfg-files">${sc.own.filter(l => l.exists).map(l => `${ly(l.kind)} ${fileBtns(report, l.file)}`).join('<br>') || '<span class="muted">no own settings file</span>'}</div></div>`;
        })
        .join('')}</div>` +
      (hidden > 0 ? `<div class="foot">${hidden} repo(s) without their own settings hidden.</div>` : '')
    );
  }
  let h = `${tb}<table class="cfg-t cfg-eff"><tr><th>Scope</th><th title="sessions in the loaded window (OBSERVED)">Sessions</th><th>Model</th><th>Effort</th><th>Permission mode</th><th>Output style</th><th>Status line</th><th title="unique rules across applying layers">Allow</th><th>Deny</th><th>Ask</th><th>Hooks</th><th title="what sessions in this repo actually ran with">Seen in sessions</th><th>Files</th></tr>`;
  for (const sc of rows) {
    const L = sc.layers;
    const r = mergedRules(L);
    const dm = effective(L, 'defaultMode');
    const live = sc.sessions.filter(isLive).length;
    h += `<tr class="${sc.root ? '' : 'cfg-userrow'}"><td title="${esc(sc.root ?? report.claudeHome)}"><b>${esc(sc.name)}</b></td><td class="num">${sc.root ? `${sc.sessions.length}${live ? ` <span class="cfg-ok" title="live now">●${live}</span>` : ''}` : ''}</td>${effCell(effective(L, 'model'), prettyModel)}${effCell(effective(L, 'effortLevel'))}${effCell(dm, v => v, modeCls(dm.value))}${effCell(effective(L, 'outputStyle'))}${effCell(effective(L, 'statusLine'), v => (v.length > 28 ? v.slice(0, 27) + '…' : v))}<td class="num cfg-ok">${r.allow || ''}</td><td class="num cfg-bad">${r.deny || ''}</td><td class="num cfg-warn">${r.ask || ''}</td><td class="num">${r.hooks || ''}</td><td>${observed(sc)}</td><td class="cfg-nowrap">${sc.own
      .filter(l => l.exists)
      .map(l => (l.error ? `<span class="cfg-bad" title="${esc(l.error)}">${LAYER_LETTER[l.kind]}!</span>` : actBtn('open', l.file, LAYER_LETTER[l.kind], `Open ${short(report, l.file)}`, 'link cfg-fl')))
      .join(' ')}</td></tr>`;
  }
  h += '</table>';
  if (hidden > 0) h += `<div class="foot">${hidden} repo(s) hidden by the filter above.</div>`;
  return h;
}

function layersTab(report: SettingsReport, d: WsData, st: WsState): string {
  const showMissing = opt(st, 'settings.missing', 'hide') === 'show';
  const layout = opt(st, 'settings.layout2', 'table');
  const ls = report.layers.filter(l => showMissing || l.exists);
  const tb = toolbar(seg(st, 'settings.missing', [['hide', 'Existing files'], ['show', 'Include missing']], 'hide'), seg(st, 'settings.layout2', [['table', 'Table'], ['cards', 'Cards']], 'table', 'Layout'));
  const where = (l: ClaudeLayer) => (l.root ? report.roots.find(r => r.path === l.root)?.name ?? l.root : l.kind === 'managed' ? 'machine' : 'user');
  const fields = (l: ClaudeLayer) =>
    [
      l.model && `model <b>${esc(prettyModel(l.model))}</b>`,
      l.effortLevel && `effort <b>${esc(l.effortLevel)}</b>`,
      l.defaultMode && `mode <b class="${modeCls(l.defaultMode)}">${esc(l.defaultMode)}</b>`,
      l.outputStyle && `style <b>${esc(l.outputStyle)}</b>`,
      l.statusLine && `statusLine <b>set</b>`,
      l.apiKeyHelper && `apiKeyHelper <b>set</b>`,
      l.additionalDirectories && `+dirs <b>${l.additionalDirectories}</b>`,
      l.envNames.length + l.envHidden ? `<span title="${esc(`env names: ${l.envNames.join(', ')}${l.envHidden ? ` (+${l.envHidden} secret-like name(s) hidden)` : ''}. Values are never shown.`)}">env <b>${l.envNames.length + l.envHidden}</b></span>` : '',
      l.enabledPlugins.length && `<span title="${esc(l.enabledPlugins.join(', '))}">plugins <b>${l.enabledPlugins.length}</b></span>`,
      l.otherKeys.length && `<span class="muted" title="${esc(l.otherKeys.join(', '))}">+${l.otherKeys.length} other key(s)</span>`,
    ]
      .filter(Boolean)
      .join(' · ');
  if (!ls.length) return tb + '<div class="empty">No Claude Code settings file found.</div>';
  if (layout === 'cards')
    return (
      tb +
      `<div class="cfg-cards">${ls
        .map(
          l => `<div class="cfg-card ${l.exists ? '' : 'cfg-missing'}"><div class="cfg-ch">${ly(l.kind)} <b>${esc(where(l))}</b><span class="muted">${l.exists ? `${bytes(l.bytes ?? 0)} · ${esc(ago(d.now, l.mtime))}` : 'missing'}</span></div><div class="cfg-path" title="${esc(l.file)}">${esc(short(report, l.file))}</div>${l.error ? `<div class="cfg-bad">${esc(l.error)}</div>` : ''}<div class="cfg-fields">${fields(l) || '<span class="muted">no tracked key</span>'}</div><div class="cfg-rules"><span class="cfg-ok">${l.allow.length} allow</span> · <span class="cfg-bad">${l.deny.length} deny</span> · <span class="cfg-warn">${l.ask.length} ask</span> · ${l.hooks.length} hook(s)</div>${rulesDetail(l)}${l.exists ? fileBtns(report, l.file) : ''}</div>`,
        )
        .join('')}</div>`
    );
  return (
    tb +
    `<table class="cfg-t"><tr><th>Layer</th><th>Scope</th><th>File</th><th>Keys set</th><th>Allow</th><th>Deny</th><th>Ask</th><th>Hooks</th><th>Modified</th><th></th></tr>${ls
      .map(
        l => `<tr class="${l.exists ? '' : 'cfg-missing'}"><td>${ly(l.kind)}</td><td>${esc(where(l))}</td><td class="cfg-path" title="${esc(l.file)}">${esc(short(report, l.file))}${l.error ? ` <span class="cfg-bad">${esc(l.error)}</span>` : ''}</td><td class="cfg-fields">${l.exists ? fields(l) : '<span class="muted">missing</span>'}</td><td class="num cfg-ok" title="${esc(l.allow.slice(0, 40).join('\n'))}">${l.allow.length || ''}</td><td class="num cfg-bad" title="${esc(l.deny.slice(0, 40).join('\n'))}">${l.deny.length || ''}</td><td class="num cfg-warn" title="${esc(l.ask.slice(0, 40).join('\n'))}">${l.ask.length || ''}</td><td class="num">${l.hooks.length || ''}</td><td>${when(d, l.mtime)}</td><td>${l.exists ? fileBtns(report, l.file) : ''}</td></tr>`,
      )
      .join('')}</table><div class="foot">Precedence: ${ly('managed')} managed &gt; ${ly('local')} local &gt; ${ly('project')} project &gt; ${ly('user')} user. Permission rules from every layer merge (deny wins). Hover the counts to see the rules. Env values, API key helpers and secret-like key names are never shown.</div>`
  );
}

function rulesDetail(l: ClaudeLayer): string {
  if (!l.allow.length && !l.deny.length && !l.ask.length) return '';
  const list = (xs: string[], cls: string) => xs.slice(0, 60).map(x => `<code class="${cls}">${esc(x)}</code>`).join(' ');
  return `<details class="cfg-det"><summary>rules</summary>${list(l.deny, 'cfg-bad')} ${list(l.ask, 'cfg-warn')} ${list(l.allow, '')}</details>`;
}

function hooksTab(report: SettingsReport, d: WsData, st: WsState): string {
  const by = opt(st, 'settings.hookby', 'event');
  const all = report.layers.filter(l => l.exists).flatMap(l => l.hooks.map(h => ({ h, l })));
  const lines = report.layers.filter(l => l.statusLine);
  const tb = toolbar(seg(st, 'settings.hookby', [['event', 'By event'], ['layer', 'By file']], 'event', 'Group hooks by'));
  if (!all.length && !lines.length) return tb + '<div class="empty">No hook and no status line configured in any settings layer.</div>';
  const where = (l: ClaudeLayer) => (l.root ? report.roots.find(r => r.path === l.root)?.name ?? l.root : l.kind);
  const groups = new Map<string, typeof all>();
  for (const x of all) {
    const k = by === 'event' ? x.h.event : `${x.l.kind}|${x.l.file}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  let h = tb;
  for (const [k, xs] of groups) {
    const head = by === 'event' ? esc(k) : `${ly(xs[0].l.kind)} ${esc(where(xs[0].l))} <span class="muted cfg-path">${esc(short(report, xs[0].l.file))}</span>`;
    h += `<h3 class="cfg-h3">${head} <span class="muted">· ${xs.length}</span></h3><table class="cfg-t"><tr>${by === 'event' ? '<th>Layer</th>' : '<th>Event</th>'}<th>Matcher</th><th>Type</th><th>Command (redacted)</th><th>Timeout</th><th></th></tr>${xs
      .map(
        ({ h: e, l }) => `<tr><td>${by === 'event' ? `${ly(l.kind)} ${esc(where(l))}` : esc(e.event)}</td><td><code>${esc(e.matcher || '*')}</code></td><td>${esc(e.type)}</td><td class="cfg-cmd"><code title="${esc(e.command)}">${esc(e.command || '—')}</code></td><td class="num">${e.timeout !== undefined ? esc(e.timeout + ' s') : ''}</td><td>${actBtn('open', l.file, 'Open', 'Open the settings file that defines this hook')}</td></tr>`,
      )
      .join('')}</table>`;
  }
  if (lines.length)
    h += `<h3 class="cfg-h3">Status line <span class="muted">· only one is active (highest layer wins)</span></h3><table class="cfg-t">${lines.map(l => `<tr><td>${ly(l.kind)} ${esc(where(l))}</td><td class="cfg-cmd"><code>${esc(l.statusLine)}</code></td><td>${actBtn('open', l.file, 'Open')}</td></tr>`).join('')}</table>`;
  return h + `<div class="foot">OBSERVED from settings files. Commands are shown redacted and single-line; Agent never runs, edits or installs hooks.</div>`;
}

function catalogTab(report: SettingsReport, d: WsData, st: WsState): string {
  const kind = opt(st, 'settings.kind', 'agent');
  const scope = opt(st, 'settings.scope', 'all');
  const n = (k: string) => report.items.filter(i => i.kind === k).length;
  const tb = toolbar(
    seg(st, 'settings.kind', [['agent', `Subagents ${n('agent')}`], ['skill', `Skills ${n('skill')}`], ['command', `Commands ${n('command')}`], ['output-style', `Output styles ${n('output-style')}`], ['all', 'All']], 'agent', 'Kind'),
    seg(st, 'settings.scope', [['all', 'All scopes'], ['user', 'User'], ['project', 'Project']], 'all', 'Scope'),
  );
  const xs = report.items.filter(i => (kind === 'all' || i.kind === kind) && (scope === 'all' || i.scope === scope));
  if (!xs.length) return tb + '<div class="empty">Nothing found for this filter. Files are read from ~/.claude/{agents,skills,commands,output-styles} and the same folders under each repo\'s .claude.</div>';
  const where = (i: MdItem) => (i.root ? report.roots.find(r => r.path === i.root)?.name ?? i.root : 'user');
  const withModel = kind === 'agent' || kind === 'all';
  return (
    tb +
    `<table class="cfg-t cfg-cat"><tr>${kind === 'all' ? '<th>Kind</th>' : ''}<th>Name</th><th>Scope</th>${withModel ? '<th>Model</th><th>Effort</th><th>Tools</th>' : ''}<th>Description</th><th>Modified</th><th></th></tr>${xs
      .map(
        i => `<tr>${kind === 'all' ? `<td class="muted">${esc(i.kind)}</td>` : ''}<td><b>${esc(i.kind === 'command' ? '/' + i.name : i.name)}</b></td><td><span class="cfg-sc ${i.scope}">${esc(where(i))}</span></td>${withModel ? `<td>${esc(i.model ? prettyModel(i.model) : i.kind === 'agent' ? 'inherit' : '')}</td><td>${esc(i.effort ?? '')}</td><td class="cfg-tools" title="${esc(i.tools ?? 'all tools (inherited)')}">${esc(i.tools ?? (i.kind === 'agent' ? 'all' : ''))}</td>` : ''}<td class="cfg-desc" title="${esc(i.description ?? '')}">${esc(i.description ?? '')}</td><td>${when(d, i.mtime)}</td><td>${fileBtns(report, i.file)}</td></tr>`,
      )
      .join('')}</table><div class="foot">OBSERVED from front matter (name, description, model, effort, tools). "inherit" means no model is pinned in the file.</div>`
  );
}

function codexTab(report: SettingsReport, d: WsData): string {
  if (!report.codex.some(c => c.exists)) return `<div class="empty">No Codex config.toml found at ${esc(short(report, report.codex[0]?.file ?? '~/.codex/config.toml'))}.</div>`;
  return report.codex
    .filter(c => c.exists)
    .map(c => codexCard(report, d, c))
    .join('');
}

function codexCard(report: SettingsReport, d: WsData, c: CodexConfig): string {
  const kv = (k: string, v: string | undefined, cls = '', title = '') => `<div class="cfg-kv"${title ? ` title="${esc(title)}"` : ''}><span>${esc(k)}</span><b class="${v ? cls : 'cfg-unset'}">${esc(v ?? '—')}</b></div>`;
  const risk = codexRisk(c.approval, c.sandbox);
  const chips = (xs: { name: string; on: boolean }[]) => xs.map(x => `<span class="cfg-chip ${x.on ? 'on' : 'off'}" title="${x.on ? 'enabled' : 'disabled'}">${esc(x.name)}</span>`).join('');
  let h = `<div class="cfg-codex"><div class="cfg-ch"><span class="cfg-prov">Codex</span> <b>${c.scope === 'user' ? 'User config' : esc(report.roots.find(r => r.path === c.root)?.name ?? c.root ?? '')}</b><span class="muted cfg-path" title="${esc(c.file)}">${esc(short(report, c.file))} · ${bytes(c.bytes ?? 0)} · ${esc(ago(d.now, c.mtime))}</span>${fileBtns(report, c.file)}</div>`;
  if (c.error) h += `<div class="cfg-bad">${esc(c.error)}</div>`;
  h += `<div class="cfg-grid">${kv('Model', c.model && prettyModel(c.model))}${kv('Reasoning effort', c.effort)}${kv('Approval policy', c.approval, risk)}${kv('Sandbox', c.sandbox, risk)}${kv('Service tier', c.serviceTier)}${kv('Default profile', c.profile)}${kv('Notify', c.notify ? 'set' : 'not set', c.notify ? 'cfg-ok' : '', 'notify program (only whether it is set; the command is not shown)')}${kv('Trusted projects', String(c.trustedProjects))}</div>`;
  if (c.profiles.length)
    h += `<h3 class="cfg-h3">Profiles · ${c.profiles.length}</h3><table class="cfg-t"><tr><th>Profile</th><th>Model</th><th>Effort</th><th>Approval</th><th>Sandbox</th></tr>${c.profiles.map(p => `<tr><td><b>${esc(p.name)}</b>${p.name === c.profile ? ' <span class="chip">default</span>' : ''}</td><td>${esc(p.model ? prettyModel(p.model) : '')}</td><td>${esc(p.effort ?? '')}</td><td class="${codexRisk(p.approval, p.sandbox)}">${esc(p.approval ?? '')}</td><td class="${codexRisk(p.approval, p.sandbox)}">${esc(p.sandbox ?? '')}</td></tr>`).join('')}</table>`;
  if (c.mcpServers.length) h += `<h3 class="cfg-h3">MCP servers · ${c.mcpServers.length} <span class="muted">(names only; commands, args and env are not shown)</span></h3><div class="cfg-chips">${c.mcpServers.map(n => `<span class="cfg-chip on">${esc(n)}</span>`).join('')}</div>`;
  if (c.features.length) h += `<h3 class="cfg-h3">Features</h3><div class="cfg-chips">${chips(c.features)}</div>`;
  if (c.plugins.length) h += `<h3 class="cfg-h3">Plugins · ${c.plugins.filter(p => p.on).length}/${c.plugins.length} enabled</h3><div class="cfg-chips">${chips(c.plugins)}</div>`;
  if (c.otherKeys.length) h += `<div class="foot">Other tables: ${esc(c.otherKeys.join(', '))} (values not shown).</div>`;
  return h + '</div>';
}

function memoryTab(report: SettingsReport, d: WsData, st: WsState): string {
  const sort = opt(st, 'settings.memsort', 'recent');
  const tb = toolbar(seg(st, 'settings.memsort', [['recent', 'Recent'], ['size', 'Largest'], ['repo', 'By repo']], 'recent', 'Sort'));
  const xs = [...report.memory].sort((a, b) => (sort === 'size' ? b.bytes - a.bytes : sort === 'repo' ? (a.root ?? '').localeCompare(b.root ?? '') : b.mtime - a.mtime));
  if (!xs.length) return tb + '<div class="empty">No CLAUDE.md or AGENTS.md found in the user folders or the repos agents used.</div>';
  const max = Math.max(...xs.map(m => m.bytes), 1);
  return (
    tb +
    `<table class="cfg-t"><tr><th>Provider</th><th>Scope</th><th>File</th><th>Lines</th><th>Size</th><th></th><th>Modified</th><th></th></tr>${xs
      .map(
        m => `<tr><td><span class="cfg-prov ${m.provider}">${m.provider === 'claude' ? 'Claude' : 'Codex'}</span></td><td>${esc(m.root ? report.roots.find(r => r.path === m.root)?.name ?? m.root : 'user')}</td><td class="cfg-path" title="${esc(m.file)}">${esc(short(report, m.file))}</td><td class="num">${m.lines || ''}</td><td class="num">${bytes(m.bytes)}</td><td class="cfg-barc"><i class="cfg-bar ${m.provider}" style="width:${Math.max(2, Math.round((100 * m.bytes) / max))}%"></i></td><td>${when(d, m.mtime)}</td><td>${fileBtns(report, m.file)}</td></tr>`,
      )
      .join('')}</table><div class="foot">Instruction files loaded into every session's context: larger files cost context on every turn. OBSERVED file sizes; line counts for files up to 1 MB.</div>`
  );
}

// ---------------------------------------------------------------- view

function render(d: WsData, st: WsState): string {
  const fs = feedValue<SettingsReport>(FEED_ID);
  const report = fs.value;
  if (!report) return fs.error ? loadError(`Could not read configuration: ${fs.error}`, 'refresh') : loading('settings', 'Reading configuration files…', { retry: 'refresh' });
  const tab = opt(st, 'settings.tab', 'effective');
  const user = layersFor(report);
  const r = mergedRules(report.layers.filter(l => l.exists));
  const ownRepos = new Set(report.layers.filter(l => l.exists && l.root).map(l => normalizeCase(l.root!))).size;
  const cx = report.codex[0];
  const n = (k: string) => report.items.filter(i => i.kind === k).length;
  const dm = effective(user, 'defaultMode');
  let h = `<div class="cfg">`;
  h += `<div class="kpis">${kpi(prettyModel(effective(user, 'model').value) || '—', 'Claude model', '', 'DERIVED: user-scope effective model (managed > user)')}${kpi(effective(user, 'effortLevel').value ?? '—', 'Claude effort')}${kpi(dm.value ?? 'default', 'Permission mode', /bypass/i.test(dm.value ?? '') ? 'k-fail' : /acceptEdits/i.test(dm.value ?? '') ? 'k-need' : '', 'DERIVED: user-scope defaultMode')}${kpi(report.layers.filter(l => l.exists).length, 'Settings files')}${kpi(ownRepos, 'Repos w/ own settings', '', `of ${report.roots.length} repo(s) agents used in the loaded window`)}${kpi(`${r.allow}/${r.deny}`, 'Allow / deny', r.deny ? '' : '', 'unique rules across all files')}${kpi(r.hooks, 'Hooks')}${kpi(n('agent'), 'Subagents')}${kpi(n('skill'), 'Skills')}${kpi(n('command'), 'Commands')}${cx?.exists ? kpi([prettyModel(cx.model), cx.effort].filter(Boolean).join(' · ') || '—', 'Codex model') + kpi(cx.profiles.length, 'Codex profiles') + kpi(cx.mcpServers.length, 'Codex MCP') : kpi('—', 'Codex config')}</div>`;
  h += toolbar(
    seg(
      st,
      'settings.tab',
      [
        ['effective', 'Effective'],
        ['layers', 'Files & layers'],
        ['hooks', `Hooks ${r.hooks}`],
        ['catalog', 'Agents & skills'],
        ['codex', 'Codex'],
        ['memory', `Instructions ${report.memory.length}`],
      ],
      'effective',
      'Section',
    ),
    `<span class="muted" title="${esc(new Date(report.at).toLocaleString())}">read ${esc(ago(d.now, report.at))}${fs.ms !== undefined ? ` in ${fs.ms} ms` : ''}</span>`,
    actBtn('refresh', '', 'Re-read', 'Read the configuration files again'),
  );
  h +=
    tab === 'layers'
      ? layersTab(report, d, st)
      : tab === 'hooks'
        ? hooksTab(report, d, st)
        : tab === 'catalog'
          ? catalogTab(report, d, st)
          : tab === 'codex'
            ? codexTab(report, d)
            : tab === 'memory'
              ? memoryTab(report, d, st)
              : effectiveTab(report, d, st);
  h += `<div class="foot cfg-legend">${ly('managed')} managed ${ly('local')} local ${ly('project')} project ${ly('user')} user · <sup class="cfg-sh">*</sup> overrides a lower layer · values OBSERVED in files, winners DERIVED by precedence, "—" UNKNOWN (CLI default or flag). Read-only: edit in the opened file; changes apply to new sessions only.</div>`;
  return h + '</div>';
}

function checkPath(arg: string): string {
  const files = feedValue<SettingsReport>(FEED_ID).value?.files ?? [];
  const f = files.find(x => x === arg);
  if (!f || isForbidden(f)) throw new Error('Unknown configuration file.');
  return f;
}

export const settingsView: ExtraView = {
  id: 'settings',
  label: 'Settings',
  group: 'System',
  hint: 'Effective Claude Code and Codex configuration layers, agents and hooks (read-only, redacted).',
  ready: true,
  feeds: [settingsFeed as Feed],
  render,
  actions: {
    open: (arg: string, ctx: ActCtx) => ctx.openFile(checkPath(arg)),
    reveal: (arg: string, ctx: ActCtx) => ctx.revealInOs(checkPath(arg)),
    copy: (arg: string, ctx: ActCtx) => ctx.copy(checkPath(arg)),
    refresh: (_arg: string, ctx: ActCtx) => ctx.refreshFeeds(),
  },
  css: `
.cfg .cfg-t { font-size: 12px; margin-bottom: 6px; }
.cfg .cfg-t th { white-space: nowrap; }
.cfg .cfg-t tr:hover td { background: var(--vscode-list-hoverBackground); }
.cfg .cfg-t td.num { text-align: right; white-space: nowrap; }
.cfg .cfg-userrow td { border-bottom: 2px solid var(--line); background: var(--raise); }
.cfg .cfg-ly { display: inline-block; min-width: 13px; text-align: center; font-size: 9px; font-weight: 700; line-height: 13px; border-radius: 3px; margin-left: 4px; color: var(--vscode-editor-background); vertical-align: 1px; }
.cfg .cfg-managed { background: var(--bad); } .cfg .cfg-local { background: var(--warn); } .cfg .cfg-project { background: var(--accent); } .cfg .cfg-user { background: var(--vscode-descriptionForeground); }
.cfg .cfg-sh { color: var(--warn); margin-left: 1px; }
.cfg .cfg-unset { color: var(--quiet); }
.cfg .cfg-ok { color: var(--ok); } .cfg .cfg-bad { color: var(--bad); } .cfg .cfg-warn { color: var(--warn); } .cfg .cfg-acc { color: var(--accent); }
.cfg .cfg-nowrap { white-space: nowrap; }
.cfg .cfg-fl { font-weight: 600; padding: 0 3px; }
.cfg .cfg-path { font-family: var(--vscode-editor-font-family); font-size: 11px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cfg .cfg-fields { font-size: 11px; color: var(--vscode-descriptionForeground); } .cfg .cfg-fields b { color: var(--vscode-foreground); font-weight: 600; }
.cfg .cfg-acts { white-space: nowrap; } .cfg .cfg-acts .link { margin-right: 6px; }
.cfg .cfg-missing { opacity: .55; }
.cfg .cfg-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px; }
.cfg .cfg-card, .cfg .cfg-codex { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 7px 9px; display: grid; gap: 3px; min-width: 0; font-size: 12px; }
.cfg .cfg-codex { border-left: 3px solid var(--codex); margin-bottom: 10px; }
.cfg .cfg-ch { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 2px; }
.cfg .cfg-kv { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dashed var(--line); padding: 1px 0; }
.cfg .cfg-kv span { color: var(--vscode-descriptionForeground); font-size: 11px; } .cfg .cfg-kv b { font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cfg .cfg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); column-gap: 18px; }
.cfg .cfg-files { margin-top: 3px; font-size: 11px; }
.cfg .cfg-rules { font-size: 11px; }
.cfg .cfg-det summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); } .cfg .cfg-det code { display: inline-block; margin: 1px 2px; padding: 0 3px; border: 1px solid var(--line); border-radius: 3px; }
.cfg .cfg-h3 { font-size: 12px; margin: 10px 0 3px; font-weight: 600; }
.cfg .cfg-cmd code { display: block; max-width: 620px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cfg .cfg-desc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.cfg .cfg-tools { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.cfg .cfg-sc { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--line); } .cfg .cfg-sc.project { border-color: var(--accent); }
.cfg .cfg-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.cfg .cfg-chip { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--line); } .cfg .cfg-chip.on { border-color: var(--ok); } .cfg .cfg-chip.off { color: var(--quiet); text-decoration: line-through; }
.cfg .cfg-prov { font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 3px; color: #fff; background: var(--codex); } .cfg .cfg-prov.claude { background: var(--claude); }
.cfg .cfg-barc { width: 18%; } .cfg .cfg-bar { display: block; height: 6px; border-radius: 3px; background: var(--codex); } .cfg .cfg-bar.claude { background: var(--claude); }
.cfg .cfg-legend { margin-top: 12px; }
.cfg .cfg-seen { font-size: 11px; padding-left: 5px; border-left: 2px solid var(--claude); margin-right: 6px; white-space: nowrap; } .cfg .cfg-seen.codex { border-left-color: var(--codex); }
`,
};
