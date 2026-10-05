// Add-on screen "Projects": company → project → repository → sessions, with counts, and a scope picker
// for every other screen. Mapping comes from `agent.projects` rules or, failing that, from the path.
import type { AgentSessionSnapshot } from '../../model';
import { buildProjects, parseRules, ProjectInfer, ProjectRule, ProjNode, ProjSort, ProjStats, repoName, repoPath, squarify } from '../../activity/projects';
import { compact, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import { hhmm } from '../views';
import { ago, prettyModel, scopeKey, titleOf, WsData, WsState } from '../workspace';
import { actBtn, ActCtx, ExtraView, opt, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';

const RULES_FEED = 'projects.rules';

/** Reads the `agent.projects` setting (no process, no file). */
const rulesFeed: Feed<ProjectRule[]> = {
  id: RULES_FEED,
  intervalMs: 3000,
  load: async ctx => parseRules(ctx.config<unknown>('agent.projects', undefined) ?? ctx.config<unknown>('projects', [])),
};

const SCOPE_OK = /^[a-z0-9._:-]{1,40}$/;
const H = 3600_000;
const PERIOD: Record<string, number | undefined> = { '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H, all: undefined };

function rules(): ProjectRule[] {
  return feedValue<ProjectRule[]>(RULES_FEED).value ?? [];
}

const SRC_TITLE = { rule: 'Mapped by an agent.projects rule (OBSERVED setting)', inferred: 'Inferred from the folder path (INFERRED)' } as const;

function srcTag(n: ProjNode): string {
  return `<span class="pj-src ${n.source}" title="${esc(SRC_TITLE[n.source])}">${n.source === 'rule' ? 'rule' : 'path'}</span>`;
}

function split(st: ProjStats): string {
  const n = st.claude + st.codex;
  if (!n) return '';
  return `<span class="pj-split" title="${esc(`Claude ${st.claude} · Codex ${st.codex} sessions (DERIVED)`)}"><i class="claude" style="width:${(100 * st.claude) / n}%"></i><i class="codex" style="width:${(100 * st.codex) / n}%"></i></span>`;
}

function liveCell(st: ProjStats): string {
  const n = st.live + st.liveWorkers;
  if (!n) return '<span class="muted">·</span>';
  return `<span class="pj-live" title="${esc(`${st.live} live sessions, ${st.liveWorkers} live workers (INFERRED from recency / process)`)}"><span class="dot RUNNING"></span>${st.live}${st.liveWorkers ? `<span class="muted">+${st.liveWorkers}</span>` : ''}</span>`;
}

function tokBar(v: number, max: number): string {
  return `<span class="pj-tok" title="${esc(`${v.toLocaleString()} tokens as recorded by the provider (OBSERVED), summed over sessions in the period`)}"><span class="pj-bar"><i style="width:${max ? Math.max(v ? 2 : 0, (100 * v) / max) : 0}%"></i></span>${v ? esc(compact(v)) : '<span class="muted">—</span>'}</span>`;
}

/** Scope key of a repo node (same as workspace scopeKey of its sessions). */
function repoScope(n: ProjNode): string | undefined {
  // Scope keys follow the workspace naming (repo or cwd folder); prefer the one equal to the repo name.
  const keys = n.sessions.map(scopeKey);
  const k = keys.find(x => x === n.name.toLowerCase()) ?? keys[0];
  return k && SCOPE_OK.test(k) ? k : undefined;
}

function scopeBtn(n: ProjNode, st: WsState, label = 'scope'): string {
  const k = repoScope(n);
  if (!k) return `<span class="muted" title="This folder name cannot be used as a scope">—</span>`;
  const on = st.opts?.scope === k;
  return `<button class="link pj-scope${on ? ' on' : ''}" data-opt="scope" data-val="${on ? '' : esc(k)}" title="${esc(on ? 'Clear scope' : `Scope every screen to ${n.name}`)}">${on ? '✕ scope' : esc(label)}</button>`;
}

function repoActions(n: ProjNode, st: WsState): string {
  const k = repoScope(n);
  return `${scopeBtn(n, st)}${k ? ` ${actBtn('newtab', k, '↗ tab', `Open another Agent tab for ${n.name}`)}` : ''}${n.path ? ` ${actBtn('reveal', n.path, 'folder', n.path)} ${actBtn('copy', n.path, 'copy', 'Copy path')}` : ''}`;
}

/** Repos of a node (itself if it is a repo). */
function repos(n: ProjNode): ProjNode[] {
  return n.level === 'repo' ? [n] : n.children.flatMap(repos);
}

function groupActions(n: ProjNode, st: WsState): string {
  const rs = repos(n);
  return rs.length === 1 ? repoActions(rs[0], st) : `<span class="muted" title="Scope works per repository: pick one below">${rs.length} repos</span>`;
}

function lastCell(now: number, t: number): string {
  return t ? `<span class="muted" title="${esc(new Date(t).toLocaleString())}">${esc(ago(now, t))}</span>` : '';
}

function sessionRow(s: AgentSessionSnapshot, d: WsData, st: WsState): string {
  const who = [s.provider === 'claude' ? 'Claude' : 'Codex', prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
  return `<tr class="pj-r l4${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" tabindex="0">
<td class="pj-n"><span class="dot ${esc(s.status)}"></span> ${esc(titleOf(s).slice(0, 60))}${s.isWorker ? ' <span class="muted">worker</span>' : ''} <span class="muted">${esc(who)}${s.branch ? ` · ${esc(s.branch)}` : ''}</span></td>
<td>${isLive(s) ? '<span class="pj-live"><span class="dot RUNNING"></span></span>' : ''}</td><td></td><td></td>
<td class="num">${s.usage?.totalTokens ? esc(compact(s.usage.totalTokens)) : '<span class="muted">—</span>'}</td>
<td class="num">${s.commits.length || ''}</td><td></td><td>${lastCell(d.now, s.lastActivityAt ?? s.startedAt ?? 0)}</td><td></td></tr>`;
}

function nodeRow(n: ProjNode, lvl: number, max: number, d: WsData, st: WsState, color: string): string {
  const icon = n.level === 'company' ? '▣' : n.level === 'project' ? '◆' : '⎇';
  const st2 = n.stats;
  return `<tr class="pj-r l${lvl}" style="--id:${color}">
<td class="pj-n"><span class="pj-ic">${icon}</span><b>${esc(n.name)}</b> ${srcTag(n)}</td>
<td>${liveCell(st2)}</td>
<td class="num" title="Sessions and workers active since midnight (DERIVED)">${st2.today || '<span class="muted">·</span>'}</td>
<td class="num" title="${esc(`${st2.sessions} sessions, ${st2.workers} workers in the period (DERIVED)`)}">${st2.sessions}${st2.workers ? `<span class="muted"> +${st2.workers}w</span>` : ''}</td>
<td>${tokBar(st2.tokens, max)}</td>
<td class="num" title="Commits observed during session windows (DERIVED)">${st2.commits || ''}</td>
<td>${split(st2)}</td>
<td>${lastCell(d.now, st2.lastAt)}</td>
<td class="pj-a">${n.level === 'repo' ? repoActions(n, st) : groupActions(n, st)}</td></tr>`;
}

function treeView(companies: ProjNode[], d: WsData, st: WsState): string {
  const depth = Number(opt(st, 'projects.depth', '3'));
  const maxAt = (lvl: number) => Math.max(1, ...companies.flatMap(c => (lvl === 1 ? [c] : lvl === 2 ? c.children : c.children.flatMap(p => p.children))).map(n => n.stats.tokens));
  const mx = [0, maxAt(1), maxAt(2), maxAt(3)];
  let h = `<table class="pj-t"><thead><tr><th>Company / project / repository</th><th>Live</th><th class="num">Today</th><th class="num">Sessions</th><th>Tokens</th><th class="num">Commits</th><th>Providers</th><th>Last</th><th></th></tr></thead><tbody>`;
  for (const c of companies) {
    const cc = identityColor(c.name);
    h += nodeRow(c, 1, mx[1], d, st, cc);
    if (depth < 2) continue;
    for (const p of c.children) {
      // A project holding a single repo of the same name is shown once.
      const same = p.children.length === 1 && p.children[0].name.toLowerCase() === p.name.toLowerCase();
      const pc = identityColor(p.name);
      if (same) h += nodeRow({ ...p.children[0], source: p.source }, 2, mx[2], d, st, pc);
      else h += nodeRow(p, 2, mx[2], d, st, pc);
      if (depth < 3) continue;
      for (const r of p.children) {
        if (!same && depth >= 3) h += nodeRow(r, 3, mx[3], d, st, pc);
        if (depth >= 4) h += r.sessions.slice(0, 25).map(s => sessionRow(s, d, st)).join('') + (r.sessions.length > 25 ? `<tr class="pj-r l4"><td class="pj-n muted" colspan="9">+${r.sessions.length - 25} more · scope to ${esc(r.name)} to see all</td></tr>` : '');
      }
    }
  }
  return h + '</tbody></table>';
}

function miniKpi(v: string | number, label: string, title: string): string {
  return `<span class="pj-k" title="${esc(title)}"><b>${esc(v)}</b>${esc(label)}</span>`;
}

function cardsView(companies: ProjNode[], d: WsData, st: WsState): string {
  return companies
    .map(c => {
      const cards = c.children
        .map(p => {
          const live = p.sessions.filter(isLive).slice(0, 4);
          const chips = p.children.map(r => {
            const k = repoScope(r);
            const on = k && st.opts?.scope === k;
            return k ? `<button class="pj-chip${on ? ' on' : ''}" data-opt="scope" data-val="${on ? '' : esc(k)}" title="${esc(`${r.path ?? r.name} — ${on ? 'clear scope' : 'scope every screen'}`)}">${esc(r.name)} <span class="muted">${r.stats.sessions}</span></button>` : `<span class="pj-chip">${esc(r.name)}</span>`;
          });
          return `<div class="pj-card" style="--id:${identityColor(p.name)}">
<div class="pj-ch"><b>${esc(p.name)}</b>${srcTag(p)}<span class="right">${lastCell(d.now, p.stats.lastAt)}</span></div>
<div class="pj-ks">${miniKpi(p.stats.live + p.stats.liveWorkers, 'live', 'Live sessions + workers (INFERRED)')}${miniKpi(p.stats.today, 'today', 'Active since midnight (DERIVED)')}${miniKpi(p.stats.sessions, 'sessions', `${p.stats.workers} workers too (DERIVED)`)}${miniKpi(compact(p.stats.tokens), 'tokens', 'Recorded by the provider (OBSERVED)')}${miniKpi(p.stats.commits, 'commits', 'Observed during session windows (DERIVED)')}</div>
${split(p.stats)}
<div class="pj-chips">${chips.join('')}</div>
${live.length ? `<div class="pj-lv">${live.map(s => `<div class="pj-mini${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}"><span class="dot ${esc(s.status)}"></span>${esc(titleOf(s).slice(0, 44))} <span class="muted">${esc(s.lastAction ? s.lastAction.slice(0, 40) : '')}</span></div>`).join('')}</div>` : ''}
<div class="pj-ca">${groupActions(p, st)}</div></div>`;
        })
        .join('');
      return `<section class="pj-co" style="--id:${identityColor(c.name)}"><div class="pj-coh"><b>${esc(c.name)}</b>${srcTag(c)}<span class="muted">${c.children.length} project${c.children.length === 1 ? '' : 's'} · ${repos(c).length} repos</span>${liveCell(c.stats)}<span class="muted">${c.stats.sessions} sessions · ${esc(compact(c.stats.tokens))} tok</span></div><div class="pj-grid">${cards}</div></section>`;
    })
    .join('');
}

function sizeOf(n: ProjNode, by: string): number {
  if (by === 'sessions') return n.stats.sessions + n.stats.workers;
  if (by === 'live') return n.stats.live + n.stats.liveWorkers;
  if (by === 'today') return n.stats.today;
  return n.stats.tokens;
}

const SIZE_LABEL: Record<string, string> = { tokens: 'tokens (OBSERVED)', sessions: 'sessions + workers (DERIVED)', live: 'live sessions + workers (INFERRED)', today: 'sessions active today (DERIVED)' };

function treemapView(companies: ProjNode[], d: WsData, st: WsState): string {
  const by = opt(st, 'projects.size', 'tokens');
  const cs = companies.filter(c => sizeOf(c, by) > 0);
  if (!cs.length) return `<div class="empty">Nothing to size by ${esc(SIZE_LABEL[by] ?? by)} in this period. Try another size or a longer period.</div>`;
  const outer = squarify(cs.map(c => sizeOf(c, by)), { x: 0, y: 0, w: 100, h: 100 });
  const pct = (r: { x: number; y: number; w: number; h: number }) => `left:${r.x.toFixed(3)}%;top:${r.y.toFixed(3)}%;width:${r.w.toFixed(3)}%;height:${r.h.toFixed(3)}%`;
  let h = `<div class="pj-tm">`;
  cs.forEach((c, i) => {
    const leaves = c.children.flatMap(p => p.children.map(r => ({ p, r }))).filter(x => sizeOf(x.r, by) > 0);
    const inner = squarify(leaves.map(x => sizeOf(x.r, by)), { x: 0, y: 0, w: 100, h: 100 });
    h += `<div class="pj-tc" style="${pct(outer[i])}" title="${esc(`${c.name}: ${sizeOf(c, by).toLocaleString()} ${SIZE_LABEL[by] ?? by}`)}"><div class="pj-tch">${esc(c.name)} <span>${esc(compact(sizeOf(c, by)))}</span></div><div class="pj-tci">`;
    leaves.forEach(({ p, r }, j) => {
      const k = repoScope(r);
      const on = k && st.opts?.scope === k;
      const live = r.stats.live + r.stats.liveWorkers;
      const label = p.name.toLowerCase() === r.name.toLowerCase() ? r.name : `${p.name} / ${r.name}`;
      const tip = `${label} — ${sizeOf(r, by).toLocaleString()} ${SIZE_LABEL[by] ?? by} · ${r.stats.sessions} sessions · ${live} live${k ? (on ? ' · click to clear scope' : ' · click to scope') : ''}`;
      h += `<div class="pj-tl${live ? ' live' : ''}${on ? ' on' : ''}" style="${pct(inner[j])};--id:${identityColor(p.name)}"${k ? ` data-opt="scope" data-val="${on ? '' : esc(k)}"` : ''} title="${esc(tip)}"><span>${esc(label)}</span><small>${esc(compact(sizeOf(r, by)))}${live ? ` · ${live} live` : ''}</small></div>`;
    });
    h += `</div></div>`;
  });
  return h + `</div><div class="muted pj-legend">Area = ${esc(SIZE_LABEL[by] ?? by)}. Colour = project. Outline = live. Click a block to scope every screen to that repository.</div>`;
}

function render(d: WsData, st: WsState): string {
  const view = opt(st, 'projects.view', 'tree');
  const period = opt(st, 'projects.period', '7d');
  const infer = opt(st, 'projects.infer', 'folder') as ProjectInfer;
  const sort = opt(st, 'projects.sort', 'recent') as ProjSort;
  const rs = rules();
  const span = PERIOD[period];
  const res = buildProjects(d.sessions, rs, { now: d.now, since: span === undefined ? undefined : d.now - span, infer, sort });
  const tb = toolbar(
    seg(st, 'projects.view', [['tree', 'Tree'], ['cards', 'Cards'], ['treemap', 'Treemap']], 'tree', 'Layout'),
    seg(st, 'projects.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Sessions active in this period (live ones always count)'),
    view === 'tree' ? seg(st, 'projects.depth', [['1', 'Company'], ['2', 'Project'], ['3', 'Repo'], ['4', 'Sessions']], '3', 'Tree depth') : '',
    view === 'treemap' ? seg(st, 'projects.size', [['tokens', 'Tokens'], ['sessions', 'Sessions'], ['today', 'Today'], ['live', 'Live']], 'tokens', 'Block size') : '',
    view !== 'treemap' ? seg(st, 'projects.sort', [['recent', 'Recent'], ['live', 'Live'], ['tokens', 'Tokens'], ['name', 'Name']], 'recent', 'Sort') : '',
    seg(st, 'projects.infer', [['folder', 'Project = folder'], ['prefix', 'Project = name prefix']], 'folder', 'How a project is inferred when no agent.projects rule matches'),
  );
  const t = res.total;
  const nProj = res.companies.reduce((a, c) => a + c.children.length, 0);
  const nRepo = res.companies.reduce((a, c) => a + repos(c).length, 0);
  const sum = `<div class="pj-sum">${miniKpi(res.companies.length, 'companies', 'DERIVED')}${miniKpi(nProj, 'projects', 'DERIVED')}${miniKpi(nRepo, 'repos', 'DERIVED')}${miniKpi(t.live + t.liveWorkers, 'live', `${t.live} sessions + ${t.liveWorkers} workers (INFERRED)`)}${miniKpi(t.today, 'today', 'Active since midnight (DERIVED)')}${miniKpi(t.sessions, 'sessions', `${t.workers} workers too (DERIVED)`)}${miniKpi(compact(t.tokens), 'tokens', 'Recorded by providers (OBSERVED)')}${miniKpi(t.commits, 'commits', 'Observed during session windows (DERIVED)')}</div>`;
  const scope = st.opts?.scope ? `<div class="pj-note">Scoped to <b>${esc(st.opts.scope)}</b>: only its sessions are counted. <button class="link" data-opt="scope" data-val="">Clear scope</button> to see every company.</div>` : '';
  const ruleNote = rs.length
    ? `${rs.length} rule${rs.length === 1 ? '' : 's'} from <code>agent.projects</code>${res.unusedRules.length ? ` · <span class="pj-warn" title="${esc(res.unusedRules.map(i => rs[i].match).join('\n'))}">${res.unusedRules.length} matched nothing in this period</span>` : ''}`
    : `No <code>agent.projects</code> rules: companies and projects are inferred from paths. Add rules like <code>{"match": "D:/PROJ/datapass-*", "company": "DataPass", "project": "VS Code"}</code>.`;
  if (!res.companies.length) return `${tb}${scope}<div class="empty">No sessions in this period.</div><div class="muted pj-legend">${ruleNote}</div>`;
  const body = view === 'cards' ? cardsView(res.companies, d, st) : view === 'treemap' ? treemapView(res.companies, d, st) : treeView(res.companies, d, st);
  return `<div class="pj">${tb}${scope}${sum}${body}<div class="muted pj-legend">${ruleNote} · <span class="pj-src rule">rule</span> = setting (OBSERVED) · <span class="pj-src inferred">path</span> = folder heuristic (INFERRED) · counts DERIVED · tokens OBSERVED · live INFERRED · updated ${esc(hhmm(d.now))}</div></div>`;
}

/** Paths a session of the current tab actually uses (so an action cannot be pointed elsewhere). */
function knownPath(arg: string, ctx: ActCtx): string | undefined {
  if (!arg || arg.length > 1000) return undefined;
  const lc = arg.toLowerCase();
  for (const s of ctx.sessions()) {
    const p = repoPath(s);
    if (p && p.toLowerCase() === lc) return p;
  }
  return undefined;
}

const CSS = `
.pj .pj-sum { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 10px; }
.pj .pj-k { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--raise); font-size: 11px; color: var(--vscode-descriptionForeground); }
.pj .pj-k b { color: var(--vscode-foreground); font-size: 13px; font-variant-numeric: tabular-nums; }
.pj .pj-note { margin: 0 0 8px; padding: 4px 8px; border-left: 3px solid var(--accent); background: var(--raise); font-size: 12px; }
.pj .pj-legend { font-size: 11px; margin-top: 10px; line-height: 1.7; }
.pj .pj-warn { color: var(--warn); cursor: help; }
.pj .pj-src { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 0 4px; border-radius: 3px; margin-left: 4px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); vertical-align: 1px; font-weight: 400; }
.pj .pj-src.rule { border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--accent); }
.pj table.pj-t { width: 100%; border-collapse: collapse; font-size: 12px; }
.pj .pj-t th { text-align: left; font-weight: 400; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; white-space: nowrap; }
.pj .pj-t th.num, .pj .pj-t td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pj .pj-t td { padding: 3px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: middle; white-space: nowrap; }
.pj .pj-t tr:hover td { background: var(--vscode-list-hoverBackground); }
.pj .pj-t tr.sel td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.pj .pj-n { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
.pj .pj-ic { color: var(--id); margin-right: 5px; display: inline-block; width: 12px; text-align: center; }
.pj tr.l1 td { border-top: 1px solid var(--line); background: color-mix(in srgb, var(--id) 7%, transparent); }
.pj tr.l1 .pj-n b { font-size: 13px; }
.pj tr.l2 .pj-n { padding-left: 22px; }
.pj tr.l3 .pj-n { padding-left: 40px; } .pj tr.l3 .pj-n b { font-weight: 400; font-family: var(--vscode-editor-font-family); }
.pj tr.l4 .pj-n { padding-left: 58px; font-size: 11px; } .pj tr.l4 { cursor: pointer; }
.pj .pj-a { text-align: right; } .pj .pj-a .link { margin-left: 6px; font-size: 11px; }
.pj .pj-scope.on { color: var(--warn); }
.pj .pj-live { display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; }
.pj .pj-tok { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; min-width: 110px; }
.pj .pj-bar { width: 60px; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--line) 60%, transparent); overflow: hidden; display: inline-block; }
.pj .pj-bar i { display: block; height: 100%; background: var(--id, var(--accent)); }
.pj .pj-split { display: inline-flex; width: 54px; height: 6px; border-radius: 3px; overflow: hidden; vertical-align: middle; background: var(--line); }
.pj .pj-split i.claude { background: var(--claude); } .pj .pj-split i.codex { background: var(--codex); }
.pj .pj-co { margin-bottom: 14px; }
.pj .pj-coh { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 3px 0 5px; border-bottom: 2px solid var(--id); margin-bottom: 8px; font-size: 12px; }
.pj .pj-coh b { font-size: 14px; color: var(--id); }
.pj .pj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px; }
.pj .pj-card { border: 1px solid var(--line); border-top: 3px solid var(--id); border-radius: 6px; padding: 6px 9px; background: var(--raise); display: grid; gap: 5px; min-width: 0; }
.pj .pj-ch { display: flex; align-items: center; gap: 4px; } .pj .pj-ch b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pj .pj-ch .right { margin-left: auto; font-size: 11px; }
.pj .pj-ks { display: flex; flex-wrap: wrap; gap: 4px; } .pj .pj-ks .pj-k { padding: 0 6px; }
.pj .pj-card .pj-split { width: 100%; }
.pj .pj-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pj .pj-chip { font: inherit; font-size: 11px; border: 1px solid var(--line); border-radius: 10px; padding: 0 8px; background: none; color: var(--vscode-foreground); cursor: pointer; font-family: var(--vscode-editor-font-family); }
.pj .pj-chip:hover { border-color: var(--id); } .pj .pj-chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.pj .pj-lv { display: grid; gap: 2px; border-top: 1px dashed var(--line); padding-top: 4px; }
.pj .pj-mini { font-size: 11px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pj .pj-mini .dot { margin-right: 4px; } .pj .pj-mini.sel { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.pj .pj-ca { font-size: 11px; } .pj .pj-ca .link { margin-right: 6px; }
.pj .pj-tm { position: relative; height: max(320px, 58vh); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.pj .pj-tc { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background, #1f1f1f); }
.pj .pj-tch { position: absolute; left: 0; right: 0; top: 0; height: 18px; padding: 1px 6px; font-size: 11px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; background: var(--raise); }
.pj .pj-tch span { font-weight: 400; color: var(--vscode-descriptionForeground); }
.pj .pj-tci { position: absolute; left: 0; right: 0; top: 18px; bottom: 0; }
.pj .pj-tl { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background, #1f1f1f); background: color-mix(in srgb, var(--id) 38%, var(--vscode-editor-background, #1f1f1f)); padding: 2px 5px; overflow: hidden; cursor: pointer; font-size: 11px; color: var(--vscode-foreground); }
.pj .pj-tl:hover { background: color-mix(in srgb, var(--id) 55%, var(--vscode-editor-background, #1f1f1f)); }
.pj .pj-tl span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.pj .pj-tl small { display: block; white-space: nowrap; overflow: hidden; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.pj .pj-tl.live { box-shadow: inset 0 0 0 2px var(--ok); }
.pj .pj-tl.on { box-shadow: inset 0 0 0 2px var(--vscode-focusBorder, var(--accent)); }
`;

export const projectsView: ExtraView = {
  id: 'projects',
  label: 'Projects',
  group: 'Now',
  hint: 'Company → project → repository → sessions. Pick a scope for every screen.',
  ready: true,
  feeds: [rulesFeed as Feed],
  render,
  css: CSS,
  badge: d => {
    const live = new Set(d.sessions.filter(isLive).map(repoName));
    return live.size ? String(live.size) : '';
  },
  actions: {
    newtab: async (arg, ctx) => {
      if (!SCOPE_OK.test(arg)) return;
      await ctx.runCommand('agent.openWorkspaceNewTab', { scope: arg });
    },
    reveal: async (arg, ctx) => {
      const p = knownPath(arg, ctx);
      if (p) await ctx.revealInOs(p);
    },
    copy: async (arg, ctx) => {
      const p = knownPath(arg, ctx);
      if (p) {
        await ctx.copy(p);
        ctx.info(`Copied ${p}`);
      }
    },
  },
};
