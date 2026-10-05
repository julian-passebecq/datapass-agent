// Normalized read model. Providers fill only what they actually expose; every claim carries provenance.

export type Provider = 'claude' | 'codex';

/** OBSERVED: read from a provider artifact. DERIVED: computed deterministically (git, arithmetic).
 *  INFERRED: heuristic (recency, process presence). UNKNOWN: not exposed. */
export type EvidenceKind = 'OBSERVED' | 'DERIVED' | 'INFERRED' | 'UNKNOWN';

export interface Evidence {
  field: string;
  kind: EvidenceKind;
  /** Short human source, e.g. "rollout session_meta.cwd" or "git rev-parse in cwd". */
  source: string;
}

export type SessionStatus = 'RUNNING' | 'IDLE' | 'NEEDS_INPUT' | 'ENDED' | 'UNKNOWN';

export type EventType =
  | 'SESSION_STARTED' | 'SESSION_ACTIVITY' | 'TOOL_ACTIVITY' | 'PROCESS_ACTIVITY'
  | 'FILE_CHANGE' | 'GIT_CHANGE' | 'COMMIT' | 'TEST' | 'WORKER_STARTED' | 'WORKER_ENDED' | 'SESSION_ENDED';

export interface TimelineEvent {
  at: number; // epoch ms
  type: EventType;
  label: string; // bounded, redacted
  provider: Provider;
  sessionKey: string;
  kind: EvidenceKind;
}

export type TestOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface TestObservation {
  command: string; // bounded, redacted
  at: number;
  outcome: TestOutcome;
  exitCode?: number;
  durationMs?: number;
  /** Where the outcome comes from. "provider-exit-code": provider recorded the process exit code.
   *  "provider-tool-error-flag": provider only recorded tool success/error. */
  source: 'provider-exit-code' | 'provider-tool-error-flag';
}

export interface CommitObservation {
  sha: string;
  at: number;
  subject: string; // bounded
  /** "observed during session window" unless the provider records the commit command itself. */
  attribution: 'during-session' | 'session-ran-git-commit';
}

/** Token accounting exactly as the provider recorded it. Nothing is priced or estimated by Agent. */
export interface SessionUsage {
  /** Sum over model calls of prompt tokens (incl. cache) + output tokens. */
  totalTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Prompt size of the latest model call, i.e. what the context window held. */
  contextTokens?: number;
  /** Only when the provider records the window size (Codex). */
  contextWindow?: number;
  /** Only when the provider itself records a cost (Claude Code cost-state). */
  costUSD?: number;
}

export interface AgentSessionSnapshot {
  key: string; // provider:providerSessionId
  provider: Provider;
  sessionId: string;
  providerVersion?: string;
  model?: string;
  effort?: string;
  title?: string; // bounded, redacted
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number;
  status: SessionStatus;
  statusReason: string;
  cwd?: string;
  repository?: string;
  worktree?: string;
  isLinkedWorktree?: boolean;
  branch?: string;
  detachedHead?: boolean;
  headBefore?: string;
  headAfter?: string;
  dirty?: boolean;
  commits: CommitObservation[];
  changedFiles: string[]; // files the provider reported editing (repo-relative when possible)
  linesAdded?: number;
  linesRemoved?: number;
  tests: TestObservation[];
  parentSessionId?: string; // key of parent
  workerLabel?: string; // e.g. Codex agent nickname or Claude subagent type
  isWorker: boolean;
  counts: { tools: number; commands: number; fileEdits: number; turns: number };
  usage?: SessionUsage;
  /** Latest command / file / test / worker event label, for "now doing" lines. */
  lastAction?: string;
  lastActionAt?: number;
  /** Richer facts (filled by the "data" package; every field optional, absent = not exposed). */
  facts?: SessionFacts;
  evidence: Evidence[];
  artifactPath: string;
  /** Size of the provider artifact when last read (bytes). */
  artifactBytes?: number;
  diagnostics: string[];
}

/** Per-session detail extracted from transcripts / rollouts. All OBSERVED unless noted. */
export interface SessionFacts {
  /** Tool name → calls (e.g. Bash, Edit, Read, Task, exec_command, apply_patch, web_search). */
  toolCounts?: Record<string, number>;
  /** Tool calls whose result the provider flagged as error. */
  toolErrors?: number;
  /** A tool call with no recorded result yet (what the session is doing right now). */
  currentTool?: { name: string; detail: string; startedAt: number };
  /** User prompts (human turns) and assistant replies. */
  prompts?: number;
  replies?: number;
  /** Files the session edited with per-file edit counts (repo-relative when possible, capped at 300). */
  files?: { path: string; edits: number; lastAt: number }[];
  /** Tokens per model, as recorded. */
  modelTokens?: Record<string, number>;
  /** Per model call: [at, promptTokens, outputTokens], capped at the latest 2000 calls (token rhythm). */
  calls?: [number, number, number][];
  /** Permission / approval / sandbox mode as recorded by the provider. */
  permissionMode?: string;
  sandbox?: string;
  /** Git branch the provider recorded in the transcript (no git call). */
  recordedBranch?: string;
  /** Context compactions recorded. */
  compactions?: number;
  /** Claude Task / Codex spawn calls: requested worker type and short description. */
  spawns?: { at: number; type: string; description: string }[];
  /** Web fetches / searches and MCP tool calls. */
  web?: number;
  mcp?: Record<string, number>;
  /** Longest gap waiting on the user (ms), and total time waiting. DERIVED. */
  waitMaxMs?: number;
  waitTotalMs?: number;
  /** Active time = sum of gaps < 5 min between events. DERIVED. */
  activeMs?: number;
  /** CLI entry point / originator (cli, vscode, exec, sdk …). */
  entrypoint?: string;
  /** Codex only: latest `token_count.rate_limits` (used %, window, reset) plus a short used-% history. */
  rateLimits?: RateLimits;
  /** Latest todo / plan list the agent wrote (Claude TodoWrite or TaskCreate / TaskUpdate, Codex update_plan),
   *  capped at 30 items × 120 chars, redacted. */
  todos?: TodoList;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoList {
  /** When the list was last written (epoch ms). */
  at: number;
  /** Tool that wrote it (TodoWrite, TaskCreate, update_plan …). */
  source: string;
  items: { text: string; status: TodoStatus }[];
  /** Items dropped by the cap. */
  dropped?: number;
}

/** One provider rate-limit window as recorded. resetsAt in epoch ms. */
export interface RateWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number }
export interface RateLimits {
  at: number;
  primary?: RateWindow;
  secondary?: RateWindow;
  planType?: string;
  /** [at, 5-hour window used %, weekly window used %] (by recorded window length) when a value changed, capped at the latest 300. */
  history?: [number, number | null, number | null][];
}

/** One data source Agent reads. Missing access is shown, never hidden. */
export type SourceStatus = 'ready' | 'partial' | 'missing' | 'off';
export interface SourceState {
  id: string;
  label: string;
  status: SourceStatus;
  detail: string;
  count?: number;
  at: number;
}

export interface ProviderState {
  provider: Provider;
  detected: boolean;
  version?: string;
  versionSource?: string;
  root?: string;
  note: string;
  artifactsScanned: number;
  diagnostics: string[];
  sources?: SourceState[];
}

export function sessionKey(provider: Provider, id: string): string {
  return `${provider}:${id}`;
}
