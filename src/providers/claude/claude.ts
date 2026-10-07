import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceState, ProviderState } from '../../model';
import { SessionAccumulator } from '../../sessions/accumulator';
import { checkKind, commandLabel, commandText, isGitCommit, isVerificationCommand, testLabel, testVerdict } from '../../sessions/classify';
import { readNewLines, safeParse, toMs } from '../../util/jsonl';
import { isInside, isPlausibleLocalPath } from '../../util/paths';
import { bounded } from '../../util/redact';
import { DirCache, statFile } from '../discover';
import { ArtifactRef, ProviderAdapter } from '../types';
import { AGENT_FILE } from './workflows';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
const MAX_PARSE_LINE = 512 * 1024;
const MAX_PENDING = 500;
const MAX_ASYNC_AGENTS = 500;
/** task-notification statuses that end a background task. */
const END_STATUS = new Set(['completed', 'failed', 'killed']);

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

/** Parent transcript of a subagent transcript (<session>/subagents/agent-*.jsonl → <session>.jsonl), else undefined. */
export function parentTranscriptOf(p: string): string | undefined {
  return claudeArtifactIdentity(p)?.parentTranscript;
}

/** Same recorded filesystem layout used by the existing workflow reader. */
export function claudeArtifactIdentity(file: string): { parentTranscript: string; parentId: string; worker: boolean; workflowId?: string } | undefined {
  const dir = path.dirname(file), name = path.basename(file);
  if (path.basename(dir) === 'subagents' && AGENT_FILE.test(name)) {
    const parent = path.dirname(dir);
    return { parentTranscript: `${parent}.jsonl`, parentId: path.basename(parent), worker: true };
  }
  if (path.basename(path.dirname(dir)) === 'workflows' && path.basename(path.dirname(path.dirname(dir))) === 'subagents'
    && (AGENT_FILE.test(name) || name === 'journal.jsonl')) {
    const parent = path.dirname(path.dirname(path.dirname(dir)));
    return { parentTranscript: `${parent}.jsonl`, parentId: path.basename(parent), worker: name !== 'journal.jsonl', workflowId: path.basename(dir) };
  }
  return undefined;
}

/**
 * Scan cap: keeps at most `max` refs from a newest-first list, never dropping the parent transcript of a kept
 * subagent transcript (a child is kept only when its listed parent fits too). Output is newest first, except that a
 * parent always comes before its subagents so parent links resolve.
 */
export function capArtifacts(sorted: ArtifactRef[], max: number): ArtifactRef[] {
  if (sorted.length <= max) return orderParentsFirst(sorted);
  const byPath = new Map(sorted.map(r => [r.path, r]));
  const kept = new Set<string>();
  for (const r of sorted) {
    if (kept.size >= max) break;
    if (kept.has(r.path)) continue;
    const parent = parentTranscriptOf(r.path);
    if (parent && byPath.has(parent) && !kept.has(parent)) {
      if (kept.size + 2 > max) continue; // no room for the pair: skip the child, a later parent-less ref may still fit
      kept.add(parent);
    }
    kept.add(r.path);
  }
  return orderParentsFirst(sorted.filter(r => kept.has(r.path)));
}

function orderParentsFirst(list: ArtifactRef[]): ArtifactRef[] {
  const listed = new Set(list.map(r => r.path));
  const out: ArtifactRef[] = [];
  const done = new Set<string>();
  const byPath = new Map(list.map(r => [r.path, r]));
  for (const r of list) {
    if (done.has(r.path)) continue;
    const parent = parentTranscriptOf(r.path);
    if (parent && listed.has(parent) && !done.has(parent)) {
      out.push(byPath.get(parent)!);
      done.add(parent);
    }
    out.push(r);
    done.add(r.path);
  }
  return out;
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
  /** Folder listings cached by directory mtime: unchanged project folders are not re-listed. */
  readonly dirCache = new DirCache();
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

  listArtifacts(sinceMs: number, max: number, includeWorkflowHistory = false): ArtifactRef[] {
    const projects = path.join(this.root, 'projects');
    const out: ArtifactRef[] = [];
    const dc = this.dirCache;
    dc.begin();
    const dirs = dc.list(projects);
    if (!dirs) return out;
    for (const d of dirs) {
      if (!d.dir) continue;
      const pdir = path.join(projects, d.name);
      for (const e of dc.list(pdir) ?? []) {
        const p = path.join(pdir, e.name);
        if (e.file && e.name.endsWith('.jsonl')) push(p);
        else if (e.dir) {
          // <session>/ gains subagents/ when the first worker starts (its mtime changes): both listings are cached.
          if (!dc.list(p)?.some(x => x.dir && x.name === 'subagents')) continue;
          const sub = path.join(p, 'subagents');
          for (const s of dc.list(sub) ?? []) if (s.name.startsWith('agent-') && s.name.endsWith('.jsonl')) push(path.join(sub, s.name));
          if (includeWorkflowHistory) {
            const workflows = path.join(sub, 'workflows');
            if (dc.list(sub)?.some(s => s.dir && s.name === 'workflows')) {
              for (const run of dc.list(workflows) ?? []) if (run.dir) {
                const runDir = path.join(workflows, run.name);
                for (const artifact of dc.list(runDir) ?? []) if (artifact.file &&
                  (AGENT_FILE.test(artifact.name) || artifact.name === 'journal.jsonl')) push(path.join(runDir, artifact.name));
              }
            }
          }
        }
      }
    }
    function push(p: string) {
      const st = statFile(p); // vanished → undefined
      if (st && st.mtimeMs >= sinceMs && st.size > 0) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return capArtifacts(out, max);
  }

  ingest(ref: ArtifactRef): SessionAccumulator | undefined {
    if (!isInside(path.join(this.root, 'projects'), ref.path)) {
      this.diag(`rejected artifact outside provider root: ${path.basename(ref.path)}`);
      return undefined;
    }
    let acc = this.accs.get(ref.path);
    if (acc && acc.cursor && acc.cursor.size === ref.size && acc.cursor.mtimeMs === ref.mtimeMs) return acc;
    const identity = claudeArtifactIdentity(ref.path);
    if (!acc) {
      const base = path.basename(ref.path, '.jsonl');
      if (identity) {
        const parentSid = identity.parentId;
        acc = new SessionAccumulator('claude', identity.worker ? `${parentSid}/${base}` : `${parentSid}/${identity.workflowId}/journal`, ref.path);
        acc.isWorker = identity.worker;
        acc.parentSessionId = `claude:${parentSid}`;
        acc.ev('parentSessionId', 'OBSERVED', 'transcript stored under <parent>/subagents/');
        if (identity.worker) this.readSubagentMeta(acc, ref.path.replace(/\.jsonl$/, '.meta.json'));
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
      // A huge tool result: its size still counts (line length = upper bound of the content), content is not parsed.
      const head = line.slice(0, 4000);
      const r = /"type":"user"/.test(head) ? /"tool_use_id":"([^"]{1,100})"/.exec(head) : null;
      // Image payloads (base64) are not text put in context as chars: the call counts, its size does not.
      if (r) acc.toolResult(r[1], /"type":"image"|data:image\//.test(head) ? 0 : line.length, toMs(m?.[1]));
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
      acc.setFact('recordedBranch', o.gitBranch, 120);
    }
    if (typeof o.entrypoint === 'string') acc.setFact('entrypoint', o.entrypoint, 30);
    if (typeof o.permissionMode === 'string') acc.setFact('permissionMode', o.permissionMode, 30, at);
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
        if (acc.isWorker) this.finalTurn.delete(acc);
        this.userRecord(acc, o, at);
        return;
      case 'assistant':
        acc.touch(at);
        this.assistantRecord(acc, o, at);
        if (acc.isWorker) {
          const m = o.message;
          const final = m?.stop_reason === 'end_turn' && !(Array.isArray(m?.content) && m.content.some((c: any) => c?.type === 'tool_use'));
          if (final) this.finalTurn.add(acc);
          else this.finalTurn.delete(acc);
        }
        return;
      case 'system':
        acc.touch(at);
        if (o.subtype === 'compact_boundary') {
          const m = o.compactMetadata && typeof o.compactMetadata === 'object' ? o.compactMetadata : {};
          const pre = typeof m.preTokens === 'number' ? m.preTokens : undefined, post = typeof m.postTokens === 'number' ? m.postTokens : undefined;
          acc.event(at, 'SESSION_ACTIVITY', pre !== undefined && post !== undefined ? `context compacted (${pre} → ${post} tokens)` : 'context compacted', 'OBSERVED', o.uuid);
          acc.bump('compactions');
          if (at !== undefined) acc.compactInfo({ at, trigger: m.trigger, preTokens: pre, postTokens: post, durationMs: m.durationMs });
          acc.ev('facts.compacts', 'OBSERVED', 'compact_boundary compactMetadata trigger / preTokens / postTokens');
        }
        if (o.subtype === 'api_error') acc.event(at, 'SESSION_ACTIVITY', 'provider API error (retrying)', 'OBSERVED', o.uuid);
        return;
      case 'mode':
        // {type:"mode", mode, sessionId}: no timestamp; dated by the latest record seen before it.
        acc.setFact('sessionMode', o.mode, 30);
        acc.ev('facts.sessionMode', 'OBSERVED', 'transcript {type:"mode"} record (dated by the previous record)');
        return;
      case 'pr-link':
        acc.touch(at);
        acc.prLink(at, o.prUrl, o.prNumber, o.prRepository);
        acc.ev('facts.prLinks', 'OBSERVED', 'transcript pr-link record (prUrl, prNumber, prRepository)');
        return;
      case 'queue-operation':
        acc.touch(at);
        acc.queueOp(o.operation);
        // A background task's completion notification is queued before it is delivered as a user record.
        if (typeof o.content === 'string') this.taskNotification(o.content, at);
        return;
      default:
        acc.touch(at); // unknown or future record types still count as activity when timestamped
    }
  }

  private userRecord(acc: SessionAccumulator, o: Record<string, any>, at?: number): void {
    const content = o.message?.content;
    let prompted = false;
    const prompt = (text: string) => {
      if (o.isMeta || text.startsWith('<')) return;
      if (text.startsWith('[Request interrupted')) {
        acc.clearPendingTools();
        return;
      }
      if (!prompted) {
        prompted = true;
        acc.humanPrompt(at);
      }
      if (!acc.firstPrompt) acc.firstPrompt = bounded(text, 80);
      acc.counts.turns++;
      if (!acc.flags.has('start') && at !== undefined) {
        acc.flags.add('start');
        acc.event(at, 'SESSION_STARTED', acc.isWorker ? 'worker started' : 'session started', 'OBSERVED');
      }
      else acc.event(at, 'SESSION_ACTIVITY', 'user turn', 'OBSERVED', o.uuid);
    };
    if (typeof content === 'string') {
      if (content.startsWith('<task-notification>')) this.taskNotification(content, at);
      if (!o.toolUseResult) prompt(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        if (c.text.startsWith('<task-notification>')) this.taskNotification(c.text, at);
        prompt(c.text);
      }
      if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
      acc.toolEnd(c.tool_use_id, c.is_error === true);
      acc.toolResult(c.tool_use_id, resultChars(c.content), at);
      const r = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : undefined;
      const t = this.pendingTests.get(c.tool_use_id);
      if (t) {
        this.pendingTests.delete(c.tool_use_id);
        const test = t.acc.tests[t.idx];
        // Claude Code records no exit code for Bash (toolUseResult: stdout, stderr, interrupted, backgroundTaskId …):
        // the outcome is DERIVED from tool_result.is_error. An interrupted or backgrounded run has no outcome yet.
        const noOutcome = r?.interrupted === true || typeof r?.backgroundTaskId === 'string';
        test.outcome = noOutcome ? 'UNKNOWN' : c.is_error === true ? 'FAIL' : c.is_error === false ? 'PASS' : 'UNKNOWN';
        if (typeof r?.exitCode === 'number') {
          // Not recorded by current Claude Code versions; kept in case a future version does.
          test.exitCode = r.exitCode;
          test.source = 'provider-exit-code';
          test.outcome = test.exitCode === 0 ? 'PASS' : 'FAIL';
        }
        // A piped or chained test with only the tool error flag: the flag is the last command's status, not the test's.
        test.outcome = testVerdict(test).outcome;
        if (at && at >= test.at) test.durationMs = at - test.at;
        // "Is a test" comes from the command regex: INFERRED unless the provider recorded an exit code.
        t.acc.event(at, 'TEST', `${test.outcome} ${test.command}`, test.source === 'provider-exit-code' ? 'OBSERVED' : 'INFERRED', `${c.tool_use_id}:r`);
      }
      const parent = this.pendingAgents.get(c.tool_use_id);
      if (parent) {
        this.pendingAgents.delete(c.tool_use_id);
        const label = this.agentLabels.get(c.tool_use_id) ?? 'subagent';
        const st = typeof r?.status === 'string' ? r.status : c.is_error ? 'error' : 'returned';
        const agentKey = typeof r?.agentId === 'string' ? `${parentSid(parent)}/agent-${r.agentId}` : undefined;
        if (st === 'async_launched') {
          // Background subagent: the tool returned at launch, the worker keeps running. It ends on its
          // <task-notification> (completed / failed / killed) or, failing that, on its own transcript (INFERRED).
          parent.event(at, 'SESSION_ACTIVITY', `${label} — running in background`, 'OBSERVED', `${c.tool_use_id}:launch`);
          this.asyncAgents.set(c.tool_use_id, { parent, label, agentKey });
          if (this.asyncAgents.size > MAX_ASYNC_AGENTS) this.asyncAgents.delete(this.asyncAgents.keys().next().value!);
          continue;
        }
        this.agentLabels.delete(c.tool_use_id);
        parent.event(at, 'WORKER_ENDED', `${label} — ${bounded(st, 20)}`, 'OBSERVED', `${c.tool_use_id}:r`);
        if (agentKey) this.endedAgents.add(agentKey);
      }
    }
  }

  /** `<task-notification>` (user record or queued prompt): a background task finished. Only the tool-use id and the
   *  status tag are read; summary and output are never kept. Ends the background subagent launched by that call. */
  private taskNotification(text: string, at: number | undefined): void {
    const head = text.slice(0, 4000);
    const tu = /<tool-use-id>([^<]{1,100})<\/tool-use-id>/.exec(head)?.[1];
    const st = /<status>([a-z_]{1,20})<\/status>/.exec(head)?.[1];
    if (!tu || !st || !END_STATUS.has(st)) return;
    const a = this.asyncAgents.get(tu);
    if (!a) return;
    this.asyncAgents.delete(tu);
    this.agentLabels.delete(tu);
    a.parent.event(at, 'WORKER_ENDED', `${a.label} — ${st}`, 'OBSERVED', `${tu}:r`);
    if (a.agentKey) this.endedAgents.add(a.agentKey);
  }

  private endedAgents = new Set<string>();
  /** Background (async_launched) Agent calls still running: tool_use id → parent, label, worker session id. */
  private asyncAgents = new Map<string, { parent: SessionAccumulator; label: string; agentKey?: string }>();
  /** Workers whose own transcript last recorded a final assistant reply (stop_reason end_turn, no tool call). */
  private finalTurn = new Set<SessionAccumulator>();

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
      const opt = (x: unknown) => (typeof x === 'number' && x >= 0 ? x : undefined);
      const cached = n(u.cache_read_input_tokens);
      const prompt = n(u.input_tokens) + cached + n(u.cache_creation_input_tokens);
      const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : undefined;
      acc.addCallUsage(msg.id, prompt, n(u.output_tokens), cached, {
        inputTokens: opt(u.input_tokens),
        cacheCreationInputTokens: opt(u.cache_creation_input_tokens),
        cacheCreation5mTokens: opt(cc?.ephemeral_5m_input_tokens),
        cacheCreation1hTokens: opt(cc?.ephemeral_1h_input_tokens),
      });
      acc.modelCall(msg.id, at, prompt, n(u.output_tokens), typeof msg.model === 'string' && msg.model !== '<synthetic>' ? bounded(msg.model, 60) : undefined);
      acc.ev('usage', 'DERIVED', 'sum per message id of assistant .usage input + cache read + cache creation + output (cache reads re-counted on every call)');
      acc.ev('usage.fields', 'OBSERVED', 'assistant .usage input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens (+ cache_creation 5m/1h) as recorded, summed per message id');
    }
    if (msg?.model !== '<synthetic>') acc.agentDone(at);
    if (!Array.isArray(msg?.content)) return;
    for (const c of msg.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim() && typeof msg.id === 'string' && !acc.seenIds.has(`r:${msg.id}`)) {
        acc.seenIds.add(`r:${msg.id}`);
        acc.bump('replies');
      }
      if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue;
      acc.counts.tools++;
      const id = typeof c.id === 'string' ? c.id : undefined;
      const input = c.input ?? {};
      acc.toolStart(bounded(c.name, 60), toolDetail(c.name, input), at, id);
      if (c.name.startsWith('mcp__')) acc.mcp(bounded(c.name.split('__')[1] || 'mcp', 60));
      else if (c.name === 'WebFetch' || c.name === 'WebSearch') acc.bump('web');
      if (TODO_TOOLS.has(c.name) && !(id && acc.seenIds.has(`todo:${id}`))) {
        if (id) acc.seenIds.add(`todo:${id}`);
        if (c.name === 'TodoWrite' && Array.isArray(input.todos)) acc.setTodos(at, 'TodoWrite', input.todos.slice(0, 200).map((t: any) => ({ text: t?.content, status: t?.status })));
        else if (c.name === 'TaskCreate') acc.taskCreate(at, input.subject ?? input.description);
        else if (c.name === 'TaskUpdate') acc.taskUpdate(at, input.taskId, input.status, input.subject);
      }
      if (SHELL_TOOLS.has(c.name)) {
        acc.counts.commands++;
        const cmd = commandText(input.command);
        const label = bounded(commandLabel(cmd), 100);
        if (isVerificationCommand(cmd)) {
          acc.tests.push({ command: testLabel(cmd), at: at ?? 0, outcome: 'UNKNOWN', kind: checkKind(cmd), source: 'provider-tool-error-flag' });
          acc.ev('tests', 'INFERRED', 'test / build command recognised by its text; outcome DERIVED from tool_result.is_error (Claude records no exit code)');
          if (id) this.pendingTests.set(id, { acc, idx: acc.tests.length - 1 });
          if (this.pendingTests.size > MAX_PENDING) this.pendingTests.delete(this.pendingTests.keys().next().value!);
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
          acc.editedFile(fp, at);
          acc.event(at, 'FILE_CHANGE', `${c.name === 'Write' ? 'wrote' : 'edited'} ${path.basename(fp)}`, 'OBSERVED', id);
        }
      } else if (AGENT_TOOLS.has(c.name)) {
        const label = bounded([input.subagent_type, input.description].filter(Boolean).join(' · ') || 'subagent', 70);
        acc.spawn(at, bounded(input.subagent_type, 40) || 'general-purpose', bounded(input.description, 80));
        if (id) {
          this.pendingAgents.set(id, acc);
          this.agentLabels.set(id, label);
          if (this.pendingAgents.size > MAX_PENDING) this.pendingAgents.delete(this.pendingAgents.keys().next().value!);
          if (this.agentLabels.size > MAX_PENDING) this.agentLabels.delete(this.agentLabels.keys().next().value!);
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
        // Ended only on the parent's recorded result (sync call) or task-notification (background call).
        // A final reply in the worker's own transcript closes its turn (INFERRED) but never marks it ENDED.
        const ended = this.endedAgents.has(acc.sessionId);
        const final = !ended && this.finalTurn.has(acc);
        acc.live = { explicitEnded: ended, openTurn: !ended && !final, lastActivityAt: acc.lastActivityAt };
        // Set (not ranked): the basis changes as the worker resumes or ends.
        if (ended) acc.evidence.set('status', { field: 'status', kind: 'OBSERVED', source: 'parent transcript recorded the subagent result or its task-notification' });
        else if (final) acc.evidence.set('status', { field: 'status', kind: 'INFERRED', source: 'subagent transcript ends on a final reply (stop_reason end_turn); no end recorded by the parent yet' });
        else acc.evidence.delete('status');
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
        acc.ev('status', 'OBSERVED', `live registry ~/.claude/sessions/${path.basename(r.file)} status ${bounded(r.status ?? 'none', 20)}`);
        acc.ev('status.alive', 'INFERRED', 'registry pid answers a signal-0 check (pid reuse is possible)');
      } else acc.ev('status', 'DERIVED', 'no live registry entry for this session');
    }
  }

  private diag(m: string): void {
    if (this.diagnostics.length < 20 && !this.diagnostics.includes(m)) this.diagnostics.push(m);
  }
}

/** Short, redacted "what is this call doing" line for the current-tool display. Never the tool input body. */
export function toolDetail(name: string, input: Record<string, any>): string {
  if (SHELL_TOOLS.has(name) || name === 'Monitor') return bounded(commandLabel(commandText(input.command)), 80);
  const fp = input.file_path ?? input.notebook_path;
  if (typeof fp === 'string') return bounded(path.basename(fp), 80);
  if (AGENT_TOOLS.has(name)) return bounded([input.subagent_type, input.description].filter(x => typeof x === 'string' && x).join(' · '), 80);
  if (name === 'WebFetch' && typeof input.url === 'string') {
    try {
      return bounded(new URL(input.url).hostname, 80);
    } catch {
      return '';
    }
  }
  if (name === 'WebSearch' || name === 'ToolSearch') return bounded(input.query, 80);
  if (name === 'Grep' || name === 'Glob') return bounded(input.pattern, 80);
  if (name === 'Skill') return bounded(input.skill, 80);
  if (name === 'SendMessage') return bounded(input.to ?? input.recipient, 60);
  return '';
}

/** Characters of a tool result as sent back to the model: string content, or the text parts of a content array.
 *  Images and other non-text parts are not counted. Only the length is used; the content is never kept. */
export function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (typeof c === 'string') n += c.length;
    else if (c && typeof c.text === 'string') n += c.text.length;
  }
  return n;
}

function parentSid(acc: SessionAccumulator): string {
  return acc.sessionId.split('/')[0];
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-]/).map(x => parseInt(x, 10) || 0), pb = b.split(/[.\-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
