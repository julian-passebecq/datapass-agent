import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderState, SourceState } from '../../model';
import { SessionAccumulator } from '../../sessions/accumulator';
import { commandLabel, commandText, isGitCommit, isVerificationCommand, testLabel } from '../../sessions/classify';
import { Cursor, readNewLines, safeParse, toMs } from '../../util/jsonl';
import { isInside, isPlausibleLocalPath } from '../../util/paths';
import { bounded } from '../../util/redact';
import { DirCache, statFile } from '../discover';
import { ArtifactRef, ProviderAdapter } from '../types';
import { parseRateLimits } from '../../activity/limits';
import { cmpVersion } from '../claude/claude';
import { codexStateSources } from './state';

const MAX_PARSE_LINE = 512 * 1024;
const ROLLOUT = /^rollout-.*[-_]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function codexRoot(env = process.env): string {
  return env.CODEX_HOME && isPlausibleLocalPath(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex');
}

/** Codex adapter. Sources (read-only):
 *  - sessions/YYYY/MM/DD/rollout-*.jsonl   session_meta (id, cwd, cli_version, git, parent_thread_id, agent_nickname),
 *                                         turn_context (model, effort), task_started/task_complete/turn_aborted,
 *                                         item_completed (CommandExecution with exit_code, FileChange, SubAgentActivity)
 *  - archived_sessions/rollout-*.jsonl    archived threads → ENDED
 *  - session_index.jsonl                  thread_name per id
 *  Codex exposes no live process registry; live status is derived from open turns and recency. */
export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const;
  private accs = new Map<string, SessionAccumulator>();
  private openTurns = new Map<SessionAccumulator, Set<string>>();
  private oneShot = new Set<SessionAccumulator>();
  private archived = new Set<SessionAccumulator>();
  private pendingCalls = new Map<string, { acc: SessionAccumulator; cmd: string; at?: number; test: boolean }>();
  private titles = new Map<string, string>();
  /** session_index.jsonl byte cursor: only appended titles are read. */
  private indexCursor?: Cursor;
  /** Folder listings cached by directory mtime: unchanged day folders are not re-listed. */
  readonly dirCache = new DirCache();
  private latestCli?: string;
  diagnostics: string[] = [];

  constructor(readonly root = codexRoot()) {}

  detect(): ProviderState {
    const detected = fs.existsSync(path.join(this.root, 'sessions'));
    return {
      provider: 'codex',
      detected,
      version: this.latestCli,
      versionSource: this.latestCli ? 'newest rollout session_meta.cli_version' : undefined,
      root: this.root,
      note: detected ? 'rollout logs; no live process registry exposed' : 'Codex not detected (no ~/.codex/sessions)',
      artifactsScanned: this.accs.size,
      diagnostics: [...this.diagnostics],
      sources: this.sources(detected),
    };
  }

  private sources(detected: boolean): SourceState[] {
    const at = Date.now();
    const accs = [...this.accs.values()];
    const has = (p: string) => fs.existsSync(path.join(this.root, p));
    return [
      { id: 'codex.rollouts', label: 'Codex rollouts', status: detected ? 'ready' : 'missing', detail: detected ? 'sessions/YYYY/MM/DD/rollout-*.jsonl (record shapes undocumented, may change)' : 'no ~/.codex/sessions', count: accs.length - this.archived.size, at },
      { id: 'codex.archive', label: 'Codex archive', status: has('archived_sessions') ? 'ready' : 'missing', detail: has('archived_sessions') ? 'archived_sessions/ (archived = ENDED)' : 'no archived_sessions/: archived threads not visible', count: this.archived.size, at },
      { id: 'codex.index', label: 'Codex thread titles', status: has('session_index.jsonl') ? 'ready' : 'partial', detail: has('session_index.jsonl') ? 'session_index.jsonl thread_name (undocumented, may change)' : 'no session_index.jsonl: titles fall back to the first prompt', count: this.titles.size, at },
      { id: 'codex.live', label: 'Codex live status', status: detected ? 'partial' : 'missing', detail: 'no process registry exposed: open turn + recency (INFERRED)', at },
      { id: 'codex.usage', label: 'Codex usage', status: detected ? 'ready' : 'missing', detail: 'token_count totals + model_context_window; no cost recorded', count: accs.filter(a => a.usage).length, at },
      ...codexStateSources(this.root, at),
    ];
  }

  watchTargets(): string[] {
    return [path.join(this.root, 'sessions'), path.join(this.root, 'archived_sessions')];
  }

  listArtifacts(sinceMs: number, max: number): ArtifactRef[] {
    const out: ArtifactRef[] = [];
    const add = (p: string) => {
      const st = statFile(p); // vanished → undefined
      if (st && st.mtimeMs >= sinceMs && st.size > 0) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    };
    const dc = this.dirCache;
    dc.begin();
    const safeDir = (d: string) => dc.names(d);
    const sessions = path.join(this.root, 'sessions');
    // Only walk day folders that can contain files modified since sinceMs (rollouts are filed by start day, may run for days).
    const cutoff = new Date(sinceMs - 7 * 86400_000);
    for (const y of safeDir(sessions)) {
      if (!/^\d{4}$/.test(y) || +y < cutoff.getFullYear()) continue;
      for (const m of safeDir(path.join(sessions, y))) {
        if (!/^\d{2}$/.test(m)) continue;
        for (const d of safeDir(path.join(sessions, y, m))) {
          if (!/^\d{2}$/.test(d)) continue;
          if (new Date(+y, +m - 1, +d + 1) < cutoff) continue;
          for (const f of safeDir(path.join(sessions, y, m, d))) if (ROLLOUT.test(f)) add(path.join(sessions, y, m, d, f));
        }
      }
    }
    for (const f of safeDir(path.join(this.root, 'archived_sessions'))) if (ROLLOUT.test(f)) add(path.join(this.root, 'archived_sessions', f));
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.slice(0, max);
  }

  ingest(ref: ArtifactRef): SessionAccumulator | undefined {
    if (!isInside(this.root, ref.path)) {
      this.diag(`rejected artifact outside provider root: ${path.basename(ref.path)}`);
      return undefined;
    }
    let acc = this.accs.get(ref.path);
    if (acc && acc.cursor && acc.cursor.size === ref.size && acc.cursor.mtimeMs === ref.mtimeMs) return acc;
    if (!acc) {
      const id = ROLLOUT.exec(path.basename(ref.path))?.[1] ?? path.basename(ref.path, '.jsonl');
      acc = new SessionAccumulator('codex', id, ref.path);
      if (path.basename(path.dirname(ref.path)) === 'archived_sessions') {
        this.archived.add(acc);
        acc.ev('status', 'OBSERVED', 'rollout moved to archived_sessions/');
      }
      this.accs.set(ref.path, acc);
    }
    try {
      const res = readNewLines(ref.path, acc.cursor, line => this.line(acc!, line));
      if (res.reset) acc.diag('artifact was truncated or replaced; re-read from start');
      acc.malformed += res.skippedOversize;
      acc.cursor = res.cursor;
    } catch (e: any) {
      acc.diag(`read failed: ${e?.code ?? 'error'}`);
    }
    if (acc.lastActivityAt === undefined) {
      acc.touch(ref.mtimeMs);
      acc.ev('lastActivityAt', 'DERIVED', 'artifact mtime');
    }
    return acc;
  }

  private line(acc: SessionAccumulator, line: string): void {
    if (line.length > MAX_PARSE_LINE) {
      const m = /^\{"timestamp":"([^"]{10,40})"/.exec(line);
      acc.touch(toMs(m?.[1]));
      // A huge tool output: its size still counts (line length = upper bound of the output), content is not parsed.
      const head = line.slice(0, 4000);
      const r = /"type":"(?:custom_tool_call|function_call)_output"/.test(head) ? /"call_id":"([^"]{1,100})"/.exec(head) : null;
      // Image payloads (base64) are not text put in context as chars: the call counts, its size does not.
      if (r) acc.toolResult(r[1], /"input_image"|data:image\//.test(head) ? 0 : line.length, toMs(m?.[1]));
      return;
    }
    const o = safeParse(line);
    if (!o) {
      acc.malformed++;
      return;
    }
    const at = toMs(o.timestamp);
    const p = o.payload && typeof o.payload === 'object' ? o.payload : {};
    switch (o.type) {
      case 'session_meta':
        return this.meta(acc, p, at);
      case 'turn_context':
        acc.touch(at);
        if (typeof p.model === 'string') {
          acc.model = bounded(p.model, 60);
          acc.ev('model', 'OBSERVED', 'turn_context.model');
        }
        {
          const eff = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort;
          if (typeof eff === 'string') {
            acc.effort = bounded(eff, 20);
            acc.ev('effort', 'OBSERVED', 'turn_context.effort');
          }
        }
        if (isPlausibleLocalPath(p.cwd) && !acc.cwd) {
          acc.cwd = p.cwd;
          acc.ev('cwd', 'OBSERVED', 'turn_context.cwd');
        }
        // approval_policy is an approval policy, not a permission mode: kept as approvalPolicy. permissionMode stays
        // filled as a legacy alias because existing screens read it (and label it "approval" for Codex).
        acc.setFact('approvalPolicy', p.approval_policy, 30);
        acc.setFact('permissionMode', p.approval_policy, 30);
        acc.setFact('sandbox', typeof p.sandbox_policy === 'string' ? p.sandbox_policy : p.sandbox_policy?.type ?? p.sandbox_policy?.mode, 40);
        acc.setFact('permissionProfile', profileId(p.active_permission_profile) ?? profileId(p.permission_profile), 40);
        acc.setFact('collaborationMode', p.collaboration_mode?.mode ?? p.collaboration_mode_kind, 30, at);
        if (typeof p.approval_policy === 'string') acc.ev('facts.approvalPolicy', 'OBSERVED', 'turn_context.approval_policy (approval policy, not a permission mode)');
        if (typeof (p.collaboration_mode?.mode ?? p.collaboration_mode_kind) === 'string') acc.ev('facts.collaborationMode', 'OBSERVED', 'turn_context.collaboration_mode.mode (plan = Codex plan mode)');
        return;
      case 'event_msg':
        acc.touch(at);
        return this.eventMsg(acc, p, at);
      case 'response_item':
        acc.touch(at);
        return this.responseItem(acc, p, at);
      case 'compacted':
        acc.touch(at);
        acc.event(at, 'SESSION_ACTIVITY', 'context compacted', 'OBSERVED');
        acc.bump('compactions', 'record');
        if (at !== undefined) acc.compactInfo({ at, window: typeof p.window_number === 'number' ? p.window_number : undefined });
        acc.ev('facts.compactions', 'DERIVED', 'max of `compacted` records and ContextCompaction items (two records of one compaction count once)');
        acc.ev('facts.compacts', 'OBSERVED', 'compacted record window_number');
        return;
      default:
        if (typeof o.type === 'string') acc.touch(at);
    }
  }

  private meta(acc: SessionAccumulator, p: Record<string, any>, at?: number): void {
    // Forked/subagent rollouts can embed further session_meta records; only the first describes this file.
    if (acc.flags.has('meta')) return;
    acc.flags.add('meta');
    const t = toMs(p.timestamp) ?? at;
    if (typeof p.id === 'string' && /^[0-9a-f-]{36}$/i.test(p.id) && p.id !== acc.sessionId) acc.diag('session_meta id differs from file name id');
    acc.touch(t);
    acc.event(t, 'SESSION_STARTED', acc.isWorker ? 'worker started' : 'session started', 'OBSERVED');
    if (isPlausibleLocalPath(p.cwd)) {
      acc.cwd = p.cwd;
      acc.ev('cwd', 'OBSERVED', 'session_meta.cwd');
    }
    if (typeof p.cli_version === 'string') {
      acc.providerVersion = bounded(p.cli_version, 40);
      acc.ev('providerVersion', 'OBSERVED', 'session_meta.cli_version');
      if (!this.latestCli || cmpVersion(p.cli_version, this.latestCli) > 0) this.latestCli = p.cli_version;
    }
    if (typeof p.git?.commit_hash === 'string' && /^[0-9a-f]{40}$/.test(p.git.commit_hash)) {
      acc.headBefore = p.git.commit_hash;
      acc.ev('headBefore', 'OBSERVED', 'session_meta.git.commit_hash');
    }
    if (typeof p.git?.branch === 'string') {
      acc.branch = bounded(p.git.branch, 120);
      acc.ev('branch', 'OBSERVED', 'session_meta.git.branch');
      acc.setFact('recordedBranch', p.git.branch, 120);
    }
    acc.setFact('entrypoint', typeof p.originator === 'string' ? p.originator : typeof p.source === 'string' ? p.source : undefined, 40);
    const spawn = p.source?.subagent?.thread_spawn;
    const parent = p.parent_thread_id ?? spawn?.parent_thread_id;
    if (typeof parent === 'string' && /^[0-9a-f-]{36}$/i.test(parent)) {
      acc.isWorker = true;
      acc.parentSessionId = `codex:${parent}`;
      acc.ev('parentSessionId', 'OBSERVED', 'session_meta.parent_thread_id');
      const nick = p.agent_nickname ?? spawn?.agent_nickname;
      const role = p.agent_role ?? spawn?.agent_role;
      const apath = p.agent_path ?? spawn?.agent_path;
      acc.workerLabel = bounded([nick, role, apath].filter(x => typeof x === 'string' && x).join(' · '), 70) || 'subagent';
      acc.ev('workerLabel', 'OBSERVED', 'session_meta.agent_nickname/agent_path');
    }
    if (p.source === 'exec' || p.originator === 'codex_exec') this.oneShot.add(acc);
  }

  private eventMsg(acc: SessionAccumulator, p: Record<string, any>, at?: number): void {
    const turn = typeof p.turn_id === 'string' ? p.turn_id : undefined;
    switch (p.type) {
      case 'task_started': {
        acc.counts.turns++;
        acc.humanPrompt(toMs(p.started_at) ?? at, null);
        acc.setFact('collaborationMode', p.collaboration_mode_kind, 30, toMs(p.started_at) ?? at);
        if (turn) set(this.openTurns, acc).add(turn);
        acc.event(toMs(p.started_at) ?? at, 'SESSION_ACTIVITY', 'turn started', 'OBSERVED', turn && `ts:${turn}`);
        return;
      }
      case 'task_complete':
      case 'turn_aborted': {
        if (turn) set(this.openTurns, acc).delete(turn);
        if ((this.openTurns.get(acc)?.size ?? 0) === 0) acc.clearPendingTools();
        acc.agentDone(toMs(p.completed_at) ?? at);
        const label = p.type === 'turn_aborted' ? `turn aborted (${bounded(p.reason, 20) || 'unknown'})` : p.error ? 'turn completed with error' : 'turn completed';
        acc.event(toMs(p.completed_at) ?? at, 'SESSION_ACTIVITY', label, 'OBSERVED', turn && `tc:${turn}`);
        return;
      }
      case 'token_count': {
        const rl = at !== undefined ? parseRateLimits(p.rate_limits, at) : undefined;
        if (rl) acc.rateLimits(rl);
        const t = p.info?.total_token_usage, l = p.info?.last_token_usage;
        const n = (x: unknown) => (typeof x === 'number' && x >= 0 ? x : 0);
        if (!t || typeof t !== 'object') return;
        const u = (acc.usage ??= { totalTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
        // Per-call rhythm: a cumulative total that grew means one more model call (repeated records carry the same total).
        if (n(t.total_tokens) > u.totalTokens && l && typeof l === 'object') {
          acc.modelCall(undefined, at, n(l.input_tokens), n(l.output_tokens));
          acc.ev('facts.calls', 'INFERRED', 'one model call per growth of the cumulative token_count total (Codex records no call id)');
        }
        u.totalTokens = n(t.total_tokens);
        u.outputTokens = n(t.output_tokens);
        u.cachedInputTokens = n(t.cached_input_tokens);
        // Optional fields only when recorded (cumulative, like the others).
        if (typeof t.cache_write_input_tokens === 'number' && t.cache_write_input_tokens >= 0) u.cacheCreationInputTokens = t.cache_write_input_tokens;
        if (typeof t.reasoning_output_tokens === 'number' && t.reasoning_output_tokens >= 0) u.reasoningOutputTokens = t.reasoning_output_tokens;
        if (l && typeof l === 'object') u.contextTokens = n(l.input_tokens);
        if (typeof p.info.model_context_window === 'number') u.contextWindow = p.info.model_context_window;
        acc.ev('usage', 'OBSERVED', 'event_msg token_count (cumulative)');
        return;
      }
      case 'item_completed':
        return this.item(acc, p.item, toMs(p.completed_at_ms) ?? at);
      case 'user_message':
        if (typeof p.message === 'string' && !p.message.startsWith('<')) acc.bump('prompts', 'event');
        if (!acc.firstPrompt && typeof p.message === 'string') acc.firstPrompt = bounded(p.message, 80);
        return;
      case 'plan_update':
        planTodos(acc, p, at);
        return;
      case 'agent_message':
        acc.bump('replies', 'event');
        return;
      case 'exec_command_begin':
        // Older rollout format: begin / end pair.
        if (typeof p.call_id === 'string' && !acc.seenIds.has(`call:${p.call_id}`)) {
          acc.seenIds.add(`call:${p.call_id}`);
          acc.toolStart('exec_command', bounded(commandLabel(commandText(p.command)), 80), at, p.call_id);
        }
        return;
      case 'exec_command_end':
        // Older rollout format.
        if (typeof p.call_id === 'string') acc.toolEnd(p.call_id);
        return this.command(acc, commandText(p.command), typeof p.exit_code === 'number' ? p.exit_code : undefined, at, p.call_id, p.duration);
      case 'web_search_end':
        acc.bump('web', 'event');
        return;
    }
  }

  private item(acc: SessionAccumulator, it: any, at?: number): void {
    if (!it || typeof it !== 'object') return;
    const id = typeof it.id === 'string' ? it.id : undefined;
    switch (it.type) {
      case 'CommandExecution':
        return this.command(acc, commandText(it.command), typeof it.exit_code === 'number' ? it.exit_code : undefined, at, id, it.duration, it.status);
      case 'FileChange': {
        const changes = it.changes && typeof it.changes === 'object' ? it.changes : {};
        const files = Object.keys(changes).filter(isPlausibleLocalPath);
        for (const f of files) {
          acc.file(f);
          acc.editedFile(f, at);
        }
        if (it.status === 'failed') acc.toolError();
        acc.counts.fileEdits += files.length;
        if (files.length) acc.event(at, 'FILE_CHANGE', files.length === 1 ? `${changes[files[0]]?.type ?? 'changed'} ${path.basename(files[0])}` : `${files.length} files changed`, 'OBSERVED', id);
        return;
      }
      case 'UserMessage': {
        const txt = Array.isArray(it.content) ? it.content.find((c: any) => typeof c?.text === 'string')?.text : undefined;
        if (typeof txt !== 'string' || !txt.startsWith('<')) acc.bump('prompts', 'item');
        if (!acc.firstPrompt && Array.isArray(it.content)) {
          const t = it.content.find((c: any) => typeof c?.text === 'string');
          if (t && !t.text.startsWith('<')) acc.firstPrompt = bounded(t.text, 80);
        }
        return;
      }
      case 'CollabAgentToolCall':
        if (it.tool === 'spawn_agent' || it.tool === 'spawn') {
          const recv = Array.isArray(it.receiver_thread_ids) ? it.receiver_thread_ids.filter((x: unknown) => typeof x === 'string').slice(0, 20) : [];
          this.spawned(acc, at, [id, ...recv], 'subagent spawned', typeof it.agent_type === 'string' ? it.agent_type : 'agent', '');
        } else acc.counts.tools++;
        return;
      case 'SubAgentActivity': {
        const thread = typeof it.agent_thread_id === 'string' ? it.agent_thread_id : undefined;
        if (it.kind === 'started' || it.kind === 'spawned') this.spawned(acc, at, [id, thread], 'subagent started', 'agent', typeof it.agent_path === 'string' ? it.agent_path : '');
        else if (it.kind === 'completed' || it.kind === 'finished' || it.kind === 'closed') acc.event(at, 'WORKER_ENDED', 'subagent finished', 'OBSERVED', thread ? `end:${thread}` : id);
        return;
      }
      case 'AgentMessage':
        acc.bump('replies', 'item');
        return;
      case 'ContextCompaction':
        acc.bump('compactions', 'item');
        return;
      case 'McpToolCall':
      case 'WebSearch':
      case 'ImageView':
      case 'Extension':
        if (it.type === 'McpToolCall') {
          acc.mcp(bounded(typeof it.server === 'string' ? it.server : 'mcp', 60));
          if (it.status === 'failed' || it.status === 'error') acc.toolError();
        }
        if (it.type === 'WebSearch') acc.bump('web', 'item');
        acc.counts.tools++;
        acc.event(at, 'TOOL_ACTIVITY', it.type === 'McpToolCall' ? `mcp ${bounded(it.tool ?? it.name ?? '', 40)}`.trim() : it.type, 'OBSERVED', id);
        return;
    }
  }

  private responseItem(acc: SessionAccumulator, p: Record<string, any>, at?: number): void {
    // Function calls: worker spawn and older shell formats. Newer exec items are taken from item_completed.
    if (p.type === 'web_search_call') {
      acc.bump('web', 'call');
      acc.toolStart('web_search', '', at);
      return;
    }
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.name === 'string') this.callStart(acc, p, at);
    if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string') {
      acc.toolEnd(p.call_id);
      acc.toolResult(p.call_id, outputChars(p.output), at);
    }
    if (p.type === 'function_call' && typeof p.name === 'string') {
      if (p.name === 'spawn_agent') return; // WORKER_STARTED and the spawn fact come from callStart (deduplicated)
      if (p.name === 'shell' || p.name === 'container.exec' || p.name === 'shell_command') {
        const args = typeof p.arguments === 'string' ? safeParse(p.arguments) : undefined;
        const cmd = commandText(args?.command ?? args?.cmd);
        if (cmd && typeof p.call_id === 'string') this.pendingCalls.set(p.call_id, { acc, cmd, at, test: isVerificationCommand(cmd) });
      }
      return;
    }
    if (p.type === 'function_call_output' && typeof p.call_id === 'string') {
      const call = this.pendingCalls.get(p.call_id);
      if (!call) return;
      this.pendingCalls.delete(p.call_id);
      const out = typeof p.output === 'string' ? safeParse(p.output) : p.output;
      const code = typeof out?.metadata?.exit_code === 'number' ? out.metadata.exit_code : undefined;
      this.command(call.acc, call.cmd, code, at ?? call.at, p.call_id);
    }
  }

  /** Tool counts, current tool and spawns from model tool calls (function_call / custom_tool_call). */
  private callStart(acc: SessionAccumulator, p: Record<string, any>, at?: number): void {
    const id = typeof p.call_id === 'string' ? p.call_id : undefined;
    if (id) {
      if (acc.seenIds.has(`call:${id}`)) return;
      acc.seenIds.add(`call:${id}`);
    }
    let name = bounded(p.name, 60);
    let detail = '';
    if (p.type === 'custom_tool_call' && typeof p.input === 'string') {
      // "exec" runs a small script calling tools.<name>(…): report the first inner tool, not the script.
      const inner = /\btools\.([A-Za-z_][\w]{0,59})\s*\(/.exec(p.input.slice(0, 4000));
      if (p.name === 'exec' && inner) name = inner[1];
      if (p.name === 'exec' && inner?.[1] === 'update_plan') planTodos(acc, objectArg(p.input, inner.index), at);
      if (p.name === 'apply_patch') detail = patchTarget(p.input);
      else detail = codeCmd(p.input.slice(inner?.index ?? 0));
    } else {
      const args = typeof p.arguments === 'string' ? safeParse(p.arguments.length > 64 * 1024 ? '' : p.arguments) : p.arguments;
      if (args && typeof args === 'object') {
        const cmd = args.cmd ?? args.command;
        if (cmd !== undefined) detail = bounded(commandLabel(commandText(cmd)), 80);
        else if (typeof args.task_name === 'string') detail = bounded(args.task_name, 80);
        else if (typeof args.target === 'string') detail = bounded(args.target, 60);
      }
      if (p.name === 'update_plan') planTodos(acc, args, at);
      if (p.name === 'spawn_agent') {
        const type = typeof args?.agent_type === 'string' ? args.agent_type : typeof args?.role === 'string' ? args.role : 'agent';
        this.spawned(acc, at, [id], 'spawn_agent', type, typeof args?.task_name === 'string' ? args.task_name : args?.description);
      }
    }
    acc.toolStart(name, detail, at, id);
  }

  /** One subagent spawn, recorded by up to three records (function_call spawn_agent, CollabAgentToolCall,
   *  SubAgentActivity started) that share the call id and / or the child thread id. The first record emits
   *  WORKER_STARTED and the spawn fact; later ones only link their ids to it. */
  private spawned(acc: SessionAccumulator, at: number | undefined, ids: (string | undefined)[], label: string, type: unknown, description: unknown): void {
    const keys = ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).map(x => `spawn:${x}`);
    const seen = keys.some(k => acc.seenIds.has(k));
    for (const k of keys) acc.seenIds.add(k);
    if (seen || at === undefined) return;
    acc.spawn(at, bounded(type, 40) || 'agent', bounded(description, 80));
    acc.event(at, 'WORKER_STARTED', label, 'OBSERVED');
  }

  private command(acc: SessionAccumulator, cmd: string, exit: number | undefined, at: number | undefined, id?: string, duration?: any, status?: string): void {
    if (!cmd || at === undefined) return;
    if (id && acc.seenIds.has(`cmd:${id}`)) return;
    if (id) acc.seenIds.add(`cmd:${id}`);
    acc.counts.commands++;
    acc.counts.tools++;
    if ((exit !== undefined && exit !== 0) || status === 'failed') acc.toolError();
    const label = bounded(commandLabel(cmd), 100);
    const durMs = typeof duration?.secs === 'number' ? duration.secs * 1000 + Math.round((duration.nanos ?? 0) / 1e6) : undefined;
    if (isVerificationCommand(cmd)) {
      // "Is a test" comes from the command text: OBSERVED only when Codex recorded the exit code, else INFERRED.
      const outcome = exit !== undefined ? (exit === 0 ? 'PASS' : 'FAIL') : status === 'failed' ? 'FAIL' : 'UNKNOWN';
      const source = exit !== undefined ? 'provider-exit-code' : 'provider-tool-error-flag';
      acc.tests.push({ command: testLabel(cmd), at: durMs ? at - durMs : at, outcome, exitCode: exit, durationMs: durMs, source });
      acc.event(at, 'TEST', `${outcome} ${testLabel(cmd)}`, exit !== undefined ? 'OBSERVED' : 'INFERRED');
      acc.ev('tests', exit !== undefined ? 'OBSERVED' : 'INFERRED', 'test / build command recognised by its text; outcome from the recorded exit code when present');
    } else acc.event(at, 'PROCESS_ACTIVITY', `$ ${label}${exit !== undefined && exit !== 0 ? `  → exit ${exit}` : status === 'failed' ? '  → failed' : ''}`, 'OBSERVED');
    if (isGitCommit(cmd) && (exit === undefined || exit === 0)) {
      acc.ranGitCommit = true;
      acc.event(at, 'GIT_CHANGE', 'git commit command run', 'OBSERVED');
    }
  }

  private loadIndex(): void {
    const f = path.join(this.root, 'session_index.jsonl');
    const st = statFile(f);
    const c = this.indexCursor;
    if (!st || (c && c.size === st.size && c.mtimeMs === st.mtimeMs)) return;
    try {
      // Append-only index: read from the last byte offset in bounded chunks, never the whole file again.
      const res = readNewLines(f, c, l => {
        const o = safeParse(l);
        if (o && typeof o.id === 'string' && typeof o.thread_name === 'string') this.titles.set(o.id, bounded(o.thread_name, 80));
      });
      this.indexCursor = res.cursor;
    } catch {
      /* optional */
    }
  }

  refreshLive(accs: Iterable<SessionAccumulator>, _now: number): void {
    this.loadIndex();
    for (const acc of accs) {
      if (acc.provider !== 'codex') continue;
      const t = this.titles.get(acc.sessionId);
      if (t) {
        acc.title = t;
        acc.ev('title', 'OBSERVED', 'session_index.jsonl thread_name');
      }
      const open = (this.openTurns.get(acc)?.size ?? 0) > 0;
      acc.live = {
        explicitEnded: this.archived.has(acc),
        openTurn: open,
        oneShotDone: this.oneShot.has(acc) && !open && acc.counts.turns > 0,
        lastActivityAt: acc.lastActivityAt,
      };
      if (!this.archived.has(acc)) acc.ev('status', 'INFERRED', 'open turn + recency of rollout writes (Codex exposes no live registry)');
    }
  }

  private diag(m: string): void {
    if (this.diagnostics.length < 20 && !this.diagnostics.includes(m)) this.diagnostics.push(m);
  }
}

/** Permission profile as recorded: a string, or an object with an id / name. */
function profileId(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string') return o.id;
    if (typeof o.name === 'string') return o.name;
  }
  return undefined;
}

function set<K, V>(m: Map<K, Set<V>>, k: K): Set<V> {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  return s;
}

/** First file named in an apply_patch body ("*** Update File: <path>"), basename only. */
function patchTarget(input: string): string {
  const m = /\*\*\* (?:Update|Add|Delete) File: ([^\r\n]{1,400})/.exec(input.slice(0, 4000));
  return m ? bounded(path.basename(m[1].trim()), 80) : '';
}

/** First command string in an exec script (tools.exec_command({cmd: "…"})), redacted and bounded. */
function codeCmd(input: string): string {
  const m = /\b(?:cmd|command)\s*:\s*("(?:[^"\\]|\\.){0,400}"|'(?:[^'\\]|\\.){0,400}'|`[^`]{0,400}`)/.exec(input.slice(0, 4000));
  if (!m) return '';
  return bounded(commandLabel(m[1].slice(1, -1).replace(/\\(["'\\])/g, '$1')), 80);
}

/** update_plan arguments ({explanation?, plan: [{step, status}]}) → the session's todo list. */
function planTodos(acc: SessionAccumulator, args: any, at: number | undefined): void {
  if (!args || !Array.isArray(args.plan)) return;
  acc.setTodos(at, 'update_plan', args.plan.slice(0, 200).map((x: any) => ({ text: x?.step, status: x?.status })));
}

/** First balanced {…} after `from` in a script (strings respected), parsed as JSON; undefined if not JSON. */
export function objectArg(src: string, from: number): unknown {
  const start = src.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  let q = '';
  const end = Math.min(src.length, start + 64 * 1024);
  for (let i = start; i < end; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = '';
    } else if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return safeParse(src.slice(start, i + 1));
  }
  return undefined;
}

/** Characters of a function_call_output / custom_tool_call_output as sent back to the model (string, content
 *  array text parts, or {content}). Only the length is used; the output is never kept. */
export function outputChars(output: unknown): number {
  if (typeof output === 'string') return output.length;
  const parts = Array.isArray(output) ? output : output && typeof output === 'object' ? [(output as any).content] : [];
  let n = 0;
  for (const c of parts) {
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) n += outputChars(c);
    else if (c && typeof c.text === 'string') n += c.text.length;
  }
  return n;
}
