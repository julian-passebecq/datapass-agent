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
  evidence: Evidence[];
  artifactPath: string;
  /** Size of the provider artifact when last read (bytes). */
  artifactBytes?: number;
  diagnostics: string[];
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
