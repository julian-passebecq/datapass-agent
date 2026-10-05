// Projection of one Agent session snapshot (+ its timeline events) into the proposed galaxy.agent-observation/1.
// Pure: same input, same output. Never exported: prompt or reply text, titles, command lines, commit subjects,
// event labels, todo text, tool details, absolute paths (folder name + hash only). See docs/GALAXY.md.
import { AgentSessionSnapshot, EventType, EvidenceKind, Provider, SessionStatus, TestOutcome, TimelineEvent } from '../model';
import { bounded } from '../util/redact';
import { compactObj, iso, OBSERVATION_SCHEMA, PathRef, pathRef } from './index';

export interface GalaxyObservation {
  schema: typeof OBSERVATION_SCHEMA;
  /** provider:sessionId, as Agent keys sessions. */
  observationId: string;
  provider: Provider;
  sessionId: string;
  providerVersion?: string;
  model?: string;
  effort?: string;
  status: SessionStatus;
  /** Agent's own short reason for the status (bounded, redacted). */
  statusReason?: string;
  startedAt?: string;
  lastActivityAt?: string;
  endedAt?: string;
  repo?: PathRef;
  worktree?: PathRef & { linked?: boolean };
  branch?: string;
  headBefore?: string;
  headAfter?: string;
  dirty?: boolean;
  commits: { sha: string; at: string; attribution: 'during-session' | 'session-ran-git-commit' }[];
  tests: { at: string; outcome: TestOutcome; source: 'provider-exit-code' | 'provider-tool-error-flag'; exitCode?: number; durationMs?: number }[];
  /** Number of files the provider reported editing (names are not exported). */
  changedFiles: number;
  linesAdded?: number;
  linesRemoved?: number;
  isWorker: boolean;
  parentKey?: string;
  /** Recorded worker role (Claude subagent type, Codex agent nickname); never the task description. */
  workerLabel?: string;
  counts: { tools: number; commands: number; fileEdits: number; turns: number };
  usage?: { totalTokens: number; outputTokens: number; cachedInputTokens: number; contextTokens?: number; contextWindow?: number; costUSD?: number };
  /** Flat, text-free subset of SessionFacts. */
  facts?: { toolCounts?: Record<string, number>; toolErrors?: number; prompts?: number; replies?: number; compactions?: number; permissionMode?: string; sandbox?: string; entrypoint?: string; activeMs?: number; spawns?: number; web?: number };
  /** Timeline events without their labels. */
  events: { at: string; type: EventType; kind: EvidenceKind }[];
  /** Evidence behind the fields, as Agent recorded it. */
  evidence: { field: string; kind: EvidenceKind; source: string }[];
  /** Evidence kind per exported field. A field that is absent is UNKNOWN, never OBSERVED. */
  kinds: Record<string, EvidenceKind>;
  /** When Agent produced this projection. It is "as of capturedAt", not current truth. */
  capturedAt: string;
  /** live = from the running in-memory store; archived = from ~/.agent/archive (as last seen on that day). */
  freshness: 'live' | 'archived';
}

export interface ObservationOptions {
  capturedAt: number;
  freshness?: 'live' | 'archived';
  /** Most events kept (the oldest are dropped first). Default 500. */
  maxEvents?: number;
}

const has = (v: unknown) => v !== undefined && v !== null && v !== '';

/** Evidence kind of one field: what Agent recorded, else `fallback` when the value is present, else UNKNOWN. */
function kindOf(s: AgentSessionSnapshot, field: string, value: unknown, fallback: EvidenceKind): EvidenceKind {
  if (!has(value)) return 'UNKNOWN';
  return s.evidence.find(e => e.field === field)?.kind ?? fallback;
}

function statusKind(s: AgentSessionSnapshot): EvidenceKind {
  if (s.status === 'UNKNOWN') return 'UNKNOWN';
  // Live states rest on process presence or recency unless the provider registry recorded them.
  return s.evidence.find(e => e.field === 'status')?.kind ?? 'INFERRED';
}

/** Projects one session. `events` may hold other sessions' events; only this session's are kept. */
export function toObservation(s: AgentSessionSnapshot, events: TimelineEvent[], opts: ObservationOptions): GalaxyObservation {
  const max = opts.maxEvents ?? 500;
  const own = events.filter(e => e.sessionKey === s.key).sort((a, b) => a.at - b.at).slice(-max);
  const f = s.facts;
  const u = s.usage;
  const repo = pathRef(s.repository);
  const wt = pathRef(s.worktree);
  // Claude totals are a sum over per-message usage (DERIVED); Codex records running totals (OBSERVED).
  const sumKind: EvidenceKind = s.provider === 'claude' ? 'DERIVED' : 'OBSERVED';
  const kinds: Record<string, EvidenceKind> = {
    observationId: 'OBSERVED',
    providerVersion: kindOf(s, 'providerVersion', s.providerVersion, 'OBSERVED'),
    model: kindOf(s, 'model', s.model, 'OBSERVED'),
    effort: kindOf(s, 'effort', s.effort, 'OBSERVED'),
    status: statusKind(s),
    startedAt: kindOf(s, 'startedAt', s.startedAt, 'OBSERVED'),
    lastActivityAt: kindOf(s, 'lastActivityAt', s.lastActivityAt, 'OBSERVED'),
    endedAt: kindOf(s, 'endedAt', s.endedAt, 'OBSERVED'),
    repo: kindOf(s, 'repository', repo, 'DERIVED'),
    worktree: kindOf(s, 'worktree', wt, 'DERIVED'),
    branch: kindOf(s, 'branch', s.branch, 'DERIVED'),
    headBefore: kindOf(s, 'headBefore', s.headBefore, 'DERIVED'),
    headAfter: kindOf(s, 'headAfter', s.headAfter, 'DERIVED'),
    commits: s.commits.length ? kindOf(s, 'commits', true, 'DERIVED') : 'UNKNOWN',
    tests: s.tests.length ? 'OBSERVED' : 'UNKNOWN',
    changedFiles: s.changedFiles.length ? 'OBSERVED' : 'UNKNOWN',
    linesAdded: kindOf(s, 'linesAdded', s.linesAdded, 'DERIVED'),
    parentKey: kindOf(s, 'parentSessionId', s.parentSessionId, 'OBSERVED'),
    workerLabel: kindOf(s, 'workerLabel', s.workerLabel, 'OBSERVED'),
    'usage.totalTokens': u ? sumKind : 'UNKNOWN',
    'usage.contextTokens': has(u?.contextTokens) ? 'OBSERVED' : 'UNKNOWN',
    'usage.contextWindow': has(u?.contextWindow) ? 'OBSERVED' : 'UNKNOWN',
    'usage.costUSD': has(u?.costUSD) ? kindOf(s, 'costUSD', u?.costUSD, 'OBSERVED') : 'UNKNOWN',
    facts: f ? 'OBSERVED' : 'UNKNOWN',
    'facts.activeMs': has(f?.activeMs) ? 'DERIVED' : 'UNKNOWN',
    capturedAt: 'OBSERVED',
  };
  return compactObj<GalaxyObservation>({
    schema: OBSERVATION_SCHEMA,
    observationId: s.key,
    provider: s.provider,
    sessionId: s.sessionId,
    providerVersion: s.providerVersion,
    model: s.model,
    effort: s.effort,
    status: s.status,
    statusReason: s.statusReason ? bounded(s.statusReason, 160) : undefined,
    startedAt: iso(s.startedAt),
    lastActivityAt: iso(s.lastActivityAt),
    endedAt: iso(s.endedAt),
    repo,
    worktree: wt ? compactObj({ ...wt, linked: s.isLinkedWorktree }) : undefined,
    branch: s.branch,
    headBefore: s.headBefore,
    headAfter: s.headAfter,
    dirty: s.dirty,
    commits: s.commits.map(c => ({ sha: c.sha, at: iso(c.at) ?? '', attribution: c.attribution })),
    tests: s.tests.map(t => compactObj({ at: iso(t.at) ?? '', outcome: t.outcome, source: t.source, exitCode: t.exitCode, durationMs: t.durationMs })),
    changedFiles: s.changedFiles.length,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    isWorker: s.isWorker,
    parentKey: s.parentSessionId,
    // Claude labels are "<agentType> · <task description>": the description is free text, so only the type is kept.
    workerLabel: s.workerLabel ? bounded(s.workerLabel.split(' · ')[0], 60) : undefined,
    counts: { ...s.counts },
    usage: u ? compactObj({ totalTokens: u.totalTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens, contextTokens: u.contextTokens, contextWindow: u.contextWindow, costUSD: u.costUSD }) : undefined,
    facts: f ? compactObj({ toolCounts: f.toolCounts ? { ...f.toolCounts } : undefined, toolErrors: f.toolErrors, prompts: f.prompts, replies: f.replies, compactions: f.compactions, permissionMode: f.permissionMode, sandbox: f.sandbox, entrypoint: f.entrypoint, activeMs: f.activeMs, spawns: f.spawns?.length, web: f.web }) : undefined,
    events: own.map(e => ({ at: iso(e.at) ?? '', type: e.type, kind: e.kind })),
    evidence: s.evidence.map(e => ({ field: e.field, kind: e.kind, source: bounded(e.source, 160) })),
    kinds,
    capturedAt: iso(opts.capturedAt) ?? new Date(0).toISOString(),
    freshness: opts.freshness ?? 'live',
  });
}

/** Projects many sessions at once; events are grouped per session in one pass. */
export function toObservations(sessions: AgentSessionSnapshot[], events: TimelineEvent[], opts: ObservationOptions): GalaxyObservation[] {
  const by = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const list = by.get(e.sessionKey);
    if (list) list.push(e);
    else by.set(e.sessionKey, [e]);
  }
  return sessions.map(s => toObservation(s, by.get(s.key) ?? [], opts));
}
