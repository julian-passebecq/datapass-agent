import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceState, ProviderState } from '../../model';
import { SessionAccumulator } from '../../sessions/accumulator';
import { commandLabel, commandText, isGitCommit, isVerificationCommand, testLabel } from '../../sessions/classify';
import { readNewLines, safeParse, toMs } from '../../util/jsonl';
import { isInside, isPlausibleLocalPath } from '../../util/paths';
import { bounded } from '../../util/redact';
import { ArtifactRef, ProviderAdapter } from '../types';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_PARSE_LINE = 512 * 1024;

interface RegistryEntry {
  pid: number;
  sessionId: string;
  status?: string;
  version?: string;
  name?: string;
  kind?: string;
  entrypoint?: string;
  startedAt?: number;
  file: string;
}

export function claudeRoot(env = process.env): string {
  return env.CLAUDE_CONFIG_DIR && isPlausibleLocalPath(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), '.claude');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Claude Code adapter. Sources (read-only):
 *  - projects/<slug>/<sessionId>.jsonl            transcript records (sessionId, cwd, gitBranch, version, model, effort, tool_use/tool_result)
 *  - projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)   subagent transcripts → parent/child
 *  - sessions/<pid>.json                          live registry of running Claude processes (status busy/idle) */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;
  private accs = new Map<string, SessionAccumulator>(); // by artifact path
  private pendingTests = new Map<string, { acc: SessionAccumulator; idx: number }>();
  private pendingAgents = new Map<string, SessionAccumulator>(); // tool_use id → parent acc
  private agentLabels = new Map<string, string>(); // tool_use id → description
  private registry = new Map<string, RegistryEntry>();
  private registryCheckedAt = 0;
  diagnostics: string[] = [];

  constructor(readonly root = claudeRoot()) {}

  detect(): ProviderState {
    const projects = path.join(this.root, 'projects');
    const detected = fs.existsSync(projects);
    this.loadRegistry(Date.now(), true);
    const versions = [...this.registry.values()].map(r => r.version).filter(Boolean) as string[];
    return {
      provider: 'claude',
      detected,
      version: versions.sort(cmpVersion).pop(),
      versionSource: versions.length ? 'live registry (~/.claude/sessions/*.json)' : undefined,
      root: this.root,
      note: detected ? 'transcripts + live registry' : 'Claude Code not detected (no ~/.claude/projects)',
      artifactsScanned: this.accs.size,
      diagnostics: [...this.diagnostics],
      sources: this.sources(detected),
    };
  }

  private sources(detected: boolean): SourceState[] {
    const at = Date.now();
    const accs = [...this.accs.values()];
    const workers = accs.filter(a => a.isWorker).length;
    const regDir = fs.existsSync(path.join(this.root, 'sessions'));
    return [
      { id: 'claude.transcripts', label: 'Claude transcripts', status: detected ? 'ready' : 'missing', detail: detected ? 'projects/<slug>/<session>.jsonl' : 'no ~/.claude/projects', count: accs.length - workers, at },
      { id: 'claude.subagents', label: 'Claude subagents', status: detected ? 'ready' : 'missing', detail: 'subagents/agent-*.jsonl + .meta.json', count: workers, at },
      { id: 'claude.registry', label: 'Claude live registry', status: regDir ? 'ready' : 'missing', detail: regDir ? 'sessions/<pid>.json busy/idle + pid check' : 'no ~/.claude/sessions: live status falls back to recency', count: this.registry.size, at },
      { id: 'claude.usage', label: 'Claude usage + cost', status: !detected ? 'missing' : 'ready', detail: 'message.usage per message id; cost-state.totalCostUSD', count: accs.filter(a => a.usage).length, at },
    ];
  }

  watchTargets(): string[] {
    return [path.join(this.root, 'projects'), path.join(this.root, 'sessions')];
  }

  listArtifacts(sinceMs: number, max: number): ArtifactRef[] {
    const projects = path.join(this.root, 'projects');
    const out: ArtifactRef[] = [];
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(projects, d.name);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(pdir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(pdir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) push(p);
        else if (e.isDirectory()) {
          const sub = path.join(p, 'subagents');
          try {
            for (const s of fs.readdirSync(sub)) if (s.startsWith('agent-') && s.endsWith('.jsonl')) push(path.join(sub, s));
          } catch {
            /* no subagents */
          }
        }
      }
    }
    function push(p: string) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs && st.size > 0) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
    // Parents before their subagents so parent links resolve; newest first otherwise.
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, max);
  }

  ingest(ref: ArtifactRef): SessionAccumulator | undefined {
    if (!isInside(path.join(this.root, 'projects'), ref.path)) {
      this.diag(`rejected artifact outside provider root: ${path.basename(ref.path)}`);
      return undefined;
    }
    let acc = this.accs.get(ref.path);
    if (acc && acc.cursor && acc.cursor.size === ref.size && acc.cursor.mtimeMs === ref.mtimeMs) return acc;
    const isSub = path.basename(path.dirname(ref.path)) === 'subagents';
    if (!acc) {
      const base = path.basename(ref.path, '.jsonl');
      if (isSub) {
        const parentSid = path.basename(path.dirname(path.dirname(ref.path)));
        acc = new SessionAccumulator('claude', `${parentSid}/${base}`, ref.path);
        acc.isWorker = true;
        acc.parentSessionId = `claude:${parentSid}`;
        acc.ev('parentSessionId', 'OBSERVED', 'transcript stored under <parent>/subagents/');
        this.readSubagentMeta(acc, ref.path.replace(/\.jsonl$/, '.meta.json'));
      } else acc = new SessionAccumulator('claude', base, ref.path);
      this.accs.set(ref.path, acc);
    }
    let res;
    try {
      res = readNewLines(ref.path, acc.cursor, line => this.line(acc!, line));
    } catch (e: any) {
      acc.diag(`read failed: ${e?.code ?? 'error'}`);
      return acc;
    }
    if (res.reset) acc.diag('artifact was truncated or replaced; re-read from start');
    acc.malformed += res.skippedOversize;
    acc.cursor = res.cursor;
    if (acc.lastActivityAt === undefined) acc.touch(ref.mtimeMs);
    return acc;
  }

  private readSubagentMeta(acc: SessionAccumulator, metaPath: string): void {
    try {
      if (!fs.existsSync(metaPath) || fs.statSync(metaPath).size > 64 * 1024) return;
      const m = safeParse(fs.readFileSync(metaPath, 'utf8'));
      if (!m) return;
      const label = [m.agentType, m.description].filter(x => typeof x === 'string').map(x => bounded(x, 60)).join(' · ');
      if (label) {
        acc.workerLabel = label;
        acc.title = bounded(m.description ?? m.agentType, 80);
        acc.ev('workerLabel', 'OBSERVED', 'subagents/<agent>.meta.json agentType/description');
      }
    } catch {
      acc.diag('subagent meta unreadable');
    }
  }

  private line(acc: SessionAccumulator, line: string): void {
    if (line.length > MAX_PARSE_LINE) {
      // Huge records are tool outputs/attachments; keep only their timestamp.
      const m = /"timestamp":"([^"]{10,40})"/.exec(line.slice(-2000)) ?? /"timestamp":"([^"]{10,40})"/.exec(line.slice(0, 4000));
      acc.touch(toMs(m?.[1]));
      return;
    }
    const o = safeParse(line);
    if (!o) {
      acc.malformed++;
      return;
    }
    const at = toMs(o.timestamp);
    const type = o.type;
    if (typeof o.uuid === 'string') {
      // Duplicated records (rewrites, replays) are counted once.
      if (acc.seenIds.has(`u:${o.uuid}`)) return;
      acc.seenIds.add(`u:${o.uuid}`);
    }
    if (typeof o.version === 'string' && /^\d+\.\d+\.\d+/.test(o.version)) {
      acc.providerVersion = o.version;
      acc.ev('providerVersion', 'OBSERVED', 'transcript record .version');
    }
    if (isPlausibleLocalPath(o.cwd) && !acc.cwd) {
      acc.cwd = o.cwd;
      acc.ev('cwd', 'OBSERVED', 'transcript record .cwd');
    }
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') {
      acc.branch = bounded(o.gitBranch, 120);
      acc.ev('branch', 'OBSERVED', 'transcript record .gitBranch');
    }
    if (typeof o.agentId === 'string' && acc.isWorker && !acc.workerLabel) acc.workerLabel = bounded(o.agentId, 40);

    switch (type) {
      case 'custom-title':
        if (typeof o.customTitle === 'string') {
          acc.title = bounded(o.customTitle, 80);
          acc.ev('title', 'OBSERVED', 'custom-title record');
        }
        return;
      case 'ai-title':
        if (typeof o.aiTitle === 'string' && !acc.evidence.has('title')) acc.title = bounded(o.aiTitle, 80);
        return;
      case 'worktree-state': {
        const w = o.worktreeSession;
        if (w && isPlausibleLocalPath(w.worktreePath)) {
          acc.cwd = w.worktreePath;
          acc.ev('cwd', 'OBSERVED', 'worktree-state record .worktreePath');
          if (typeof w.worktreeBranch === 'string') {
            acc.branch = bounded(w.worktreeBranch, 120);
            acc.ev('branch', 'OBSERVED', 'worktree-state record .worktreeBranch');
          }
        }
        return;
      }
      case 'cost-state':
        if (typeof o.totalCostUSD === 'number' && o.totalCostUSD >= 0) {
          (acc.usage ??= { totalTokens: 0, outputTokens: 0, cachedInputTokens: 0 }).costUSD = o.totalCostUSD;
          acc.ev('costUSD', 'OBSERVED', 'cost-state record .totalCostUSD (computed by Claude Code)');
        }
        if (typeof o.totalLinesAdded === 'number') {
          acc.linesAdded = o.totalLinesAdded;
          acc.linesRemoved = typeof o.totalLinesRemoved === 'number' ? o.totalLinesRemoved : undefined;
          acc.ev('linesAdded', 'OBSERVED', 'cost-state record (lines edited by the session tools)');
        }
        return;
      case 'user':
        acc.touch(at);
        this.userRecord(acc, o, at);
        return;
      case 'assistant':
        acc.touch(at);
        this.assistantRecord(acc, o, at);
        return;
      case 'system':
        acc.touch(at);
        if (o.subtype === 'compact_boundary') acc.event(at, 'SESSION_ACTIVITY', 'context compacted', 'OBSERVED', o.uuid);
        if (o.subtype === 'api_error') acc.event(at, 'SESSION_ACTIVITY', 'provider API error (retrying)', 'OBSERVED', o.uuid);
        return;
      default:
        acc.touch(at); // unknown or future record types still count as activity when timestamped
    }
  }

  private userRecord(acc: SessionAccumulator, o: Record<string, any>, at?: number): void {
    const content = o.message?.content;
    const prompt = (text: string) => {
      if (o.isMeta || text.startsWith('<')) return;
      if (!acc.firstPrompt) acc.firstPrompt = bounded(text, 80);
      acc.counts.turns++;
      if (!acc.flags.has('start') && at !== undefined) {
        acc.flags.add('start');
        acc.event(at, 'SESSION_STARTED', acc.isWorker ? 'worker started' : 'session started', 'OBSERVED');
      }
      else acc.event(at, 'SESSION_ACTIVITY', 'user turn', 'OBSERVED', o.uuid);
    };
    if (typeof content === 'string') {
      if (!o.toolUseResult) prompt(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') prompt(c.text);
      if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
      const t = this.pendingTests.get(c.tool_use_id);
      if (t) {
        this.pendingTests.delete(c.tool_use_id);
        const test = t.acc.tests[t.idx];
        test.outcome = c.is_error === true ? 'FAIL' : c.is_error === false ? 'PASS' : 'UNKNOWN';
        if (typeof o.toolUseResult?.exitCode === 'number') {
          test.exitCode = o.toolUseResult.exitCode;
          test.source = 'provider-exit-code';
          test.outcome = test.exitCode === 0 ? 'PASS' : 'FAIL';
        }
        if (at && at >= test.at) test.durationMs = at - test.at;
        t.acc.event(at, 'TEST', `${test.outcome} ${test.command}`, 'OBSERVED', `${c.tool_use_id}:r`);
      }
      const parent = this.pendingAgents.get(c.tool_use_id);
      if (parent) {
        this.pendingAgents.delete(c.tool_use_id);
        const r = o.toolUseResult;
        const label = this.agentLabels.get(c.tool_use_id) ?? 'subagent';
        const st = typeof r?.status === 'string' ? r.status : c.is_error ? 'error' : 'returned';
        parent.event(at, 'WORKER_ENDED', `${label} — ${bounded(st, 20)}`, 'OBSERVED', `${c.tool_use_id}:r`);
        if (typeof r?.agentId === 'string') this.endedAgents.add(`${parentSid(parent)}/agent-${r.agentId}`);
      }
    }
  }

  private endedAgents = new Set<string>();

  private assistantRecord(acc: SessionAccumulator, o: Record<string, any>, at?: number): void {
    const msg = o.message;
    if (typeof msg?.model === 'string' && msg.model !== '<synthetic>') {
      acc.model = bounded(msg.model, 60);
      acc.ev('model', 'OBSERVED', 'assistant message .model');
    }
    if (typeof o.effort === 'string') {
      acc.effort = bounded(o.effort, 20);
      acc.ev('effort', 'OBSERVED', 'assistant record .effort');
    }
    const u = msg?.usage;
    if (u && typeof u === 'object' && typeof msg.id === 'string') {
      const n = (x: unknown) => (typeof x === 'number' && x >= 0 ? x : 0);
      const cached = n(u.cache_read_input_tokens);
      acc.addCallUsage(msg.id, n(u.input_tokens) + cached + n(u.cache_creation_input_tokens), n(u.output_tokens), cached);
      acc.ev('usage', 'OBSERVED', 'assistant message .usage, one count per message id');
    }
    if (!Array.isArray(msg?.content)) return;
    for (const c of msg.content) {
      if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue;
      acc.counts.tools++;
      const id = typeof c.id === 'string' ? c.id : undefined;
      const input = c.input ?? {};
      if (SHELL_TOOLS.has(c.name)) {
        acc.counts.commands++;
        const cmd = commandText(input.command);
        const label = bounded(commandLabel(cmd), 100);
        if (isVerificationCommand(cmd)) {
          acc.tests.push({ command: testLabel(cmd), at: at ?? 0, outcome: 'UNKNOWN', source: 'provider-tool-error-flag' });
          if (id) this.pendingTests.set(id, { acc, idx: acc.tests.length - 1 });
        } else acc.event(at, 'PROCESS_ACTIVITY', `$ ${label}`, 'OBSERVED', id);
        if (isGitCommit(cmd)) {
          acc.ranGitCommit = true;
          acc.event(at, 'GIT_CHANGE', 'git commit command run', 'OBSERVED', id && `${id}:g`);
        }
      } else if (EDIT_TOOLS.has(c.name)) {
        const fp = input.file_path ?? input.notebook_path;
        if (isPlausibleLocalPath(fp)) {
          acc.counts.fileEdits++;
          acc.file(fp);
          acc.event(at, 'FILE_CHANGE', `${c.name === 'Write' ? 'wrote' : 'edited'} ${path.basename(fp)}`, 'OBSERVED', id);
        }
      } else if (AGENT_TOOLS.has(c.name)) {
        const label = bounded([input.subagent_type, input.description].filter(Boolean).join(' · ') || 'subagent', 70);
        if (id) {
          this.pendingAgents.set(id, acc);
          this.agentLabels.set(id, label);
        }
        acc.event(at, 'WORKER_STARTED', label, 'OBSERVED', id);
      } else {
        acc.event(at, 'TOOL_ACTIVITY', bounded(c.name, 40), 'OBSERVED', id);
      }
    }
  }

  private loadRegistry(now: number, force = false): void {
    if (!force && now - this.registryCheckedAt < 3000) return;
    this.registryCheckedAt = now;
    this.registry.clear();
    const dir = path.join(this.root, 'sessions');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (fs.statSync(file).size > 64 * 1024) continue;
        const o = safeParse(fs.readFileSync(file, 'utf8'));
        if (!o || typeof o.sessionId !== 'string' || typeof o.pid !== 'number') continue;
        // Only allow-listed fields are kept; socket paths and host ids are ignored.
        this.registry.set(o.sessionId, {
          pid: o.pid,
          sessionId: o.sessionId,
          status: typeof o.status === 'string' ? o.status : undefined,
          version: typeof o.version === 'string' ? o.version : undefined,
          name: typeof o.name === 'string' ? bounded(o.name, 80) : undefined,
          kind: typeof o.kind === 'string' ? o.kind : undefined,
          entrypoint: typeof o.entrypoint === 'string' ? o.entrypoint : undefined,
          startedAt: toMs(o.startedAt),
          file,
        });
      } catch {
        /* registry file being rewritten */
      }
    }
  }

  refreshLive(accs: Iterable<SessionAccumulator>, now: number): void {
    this.loadRegistry(now);
    for (const acc of accs) {
      if (acc.provider !== 'claude') continue;
      if (acc.isWorker) {
        const ended = this.endedAgents.has(acc.sessionId);
        acc.live = { explicitEnded: ended, openTurn: !ended, lastActivityAt: acc.lastActivityAt };
        continue;
      }
      const r = this.registry.get(acc.sessionId);
      const alive = r ? pidAlive(r.pid) : false;
      acc.live = { providerHasRegistry: true, registryAlive: alive, registryStatus: r?.status, lastActivityAt: acc.lastActivityAt };
      if (r && alive) {
        if (r.name && !acc.evidence.has('title')) {
          acc.title = r.name;
          acc.ev('title', 'OBSERVED', 'live registry .name');
        }
        if (r.version) {
          acc.providerVersion = r.version;
          acc.ev('providerVersion', 'OBSERVED', 'live registry .version (running process)');
        }
        acc.ev('status', 'OBSERVED', `live registry ~/.claude/sessions/${path.basename(r.file)} (pid alive check: INFERRED)`);
      } else acc.ev('status', 'DERIVED', 'no live registry entry for this session');
    }
  }

  private diag(m: string): void {
    if (this.diagnostics.length < 20 && !this.diagnostics.includes(m)) this.diagnostics.push(m);
  }
}

function parentSid(acc: SessionAccumulator): string {
  return acc.sessionId.split('/')[0];
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map(x => parseInt(x, 10) || 0), pb = b.split(/[.\-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
