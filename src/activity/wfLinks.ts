// Claude Workflow-tool runs joined to their lead session, for the screens that show workers (Topology, Team,
// Live, Overview, HUD). The link is OBSERVED: a run lives under ~/.claude/projects/<slug>/<sessionId>/, so its
// parent is claude:<sessionId>. Pure functions over the snapshot src/providers/claude/workflows.ts already
// builds (the shared "workflows.scan" feed): nothing here reads files.
import type { AgentSessionSnapshot, EvidenceKind } from '../model';
import type { WfAgent, WfRun, WorkflowsSnapshot } from '../providers/claude/workflows';

/** Runs shown per lead (newest kept); older ones stay on the Workflows screen. */
export const MAX_RUNS_PER_LEAD = 6;

export const WF_LINK_BASIS = 'OBSERVED: run stored under <session>/subagents/workflows/<runId>/, so its lead is that session';
export const WF_COUNT_BASIS = 'DERIVED: workflow agents counted from the run journal and agent transcripts (status per agent: result recorded, or transcript written in the last 10 min)';

export interface RunCounts {
  total: number;
  done: number;
  failed: number;
  running: number;
}

/**
 * Runs per lead session key, oldest first, at most MAX_RUNS_PER_LEAD per lead. Agents whose transcript is already
 * loaded as a session (`known`) are dropped so nothing is counted twice.
 */
export function runsByLead(snap: WorkflowsSnapshot | undefined, known?: Set<string>): Map<string, WfRun[]> {
  const out = new Map<string, WfRun[]>();
  for (const r of snap?.runs ?? []) {
    const run = known ? { ...r, agents: r.agents.filter(a => !known.has(a.sessionKey)) } : r;
    out.set(r.parentKey, [...(out.get(r.parentKey) ?? []), run]);
  }
  for (const [k, rs] of out) out.set(k, rs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).slice(-MAX_RUNS_PER_LEAD));
  return out;
}

export function runCounts(r: WfRun): RunCounts {
  const c: RunCounts = { total: r.agents.length, done: 0, failed: 0, running: 0 };
  for (const a of r.agents) {
    if (a.status === 'done') c.done++;
    else if (a.status === 'failed') c.failed++;
    else if (a.status === 'running') c.running++;
  }
  return c;
}

/** Current phase: the phase of the newest running agent, else of the last agent, else the script's last phase. */
export function runPhase(r: WfRun): string | undefined {
  const running = r.agents.filter(a => a.status === 'running').sort((a, b) => (b.firstAt ?? 0) - (a.firstAt ?? 0));
  return running[0]?.phase ?? r.agents[r.agents.length - 1]?.phase ?? r.phases[r.phases.length - 1]?.title;
}

export interface EffortFact {
  /** Text to show next to the model ("medium", "medium (inherited)"), '' when UNKNOWN. */
  text: string;
  kind: EvidenceKind;
  basis: string;
}

/**
 * Effort of a workflow agent: recorded for the agent (OBSERVED), else the lead session's recorded effort
 * (INFERRED: agents run with the parent's setting unless the script overrides it), else UNKNOWN.
 */
export function agentEffort(a: WfAgent, parent: AgentSessionSnapshot | undefined): EffortFact {
  if (a.effort) return { text: a.effort, kind: 'OBSERVED', basis: a.effortSource === 'meta' ? 'agent meta.json effort' : 'assistant record .effort in the agent transcript' };
  if (parent?.effort) return { text: `${parent.effort} (inherited)`, kind: 'INFERRED', basis: 'not recorded for the agent; the lead session recorded this effort and agents inherit it unless the workflow overrides it' };
  return { text: '', kind: 'UNKNOWN', basis: 'no effort recorded for the agent or its lead session' };
}

/** "Opus 5.5 · medium" with the effort evidence in the title. */
export function modelEffortText(a: WfAgent, parent: AgentSessionSnapshot | undefined, pretty: (m: string | undefined) => string): { text: string; title: string } {
  const e = agentEffort(a, parent);
  const text = [pretty(a.model), e.text].filter(Boolean).join(' · ') || '—';
  return { text, title: `model: assistant message .model (OBSERVED); effort ${e.kind}: ${e.basis}` };
}

export const runName = (r: WfRun) => r.name ?? r.runId;
export const agentLabel = (a: WfAgent) => a.label || a.description || a.agentId;

/** Wall time of an agent: first → last record, or → now while running (DERIVED). */
export function agentWallMs(a: WfAgent, now: number): number | undefined {
  if (a.firstAt === undefined) return undefined;
  const end = a.status === 'running' ? now : a.lastAt;
  return end === undefined ? undefined : Math.max(0, end - a.firstAt);
}

export function liveRunsOf(runs: WfRun[] | undefined): WfRun[] {
  return (runs ?? []).filter(r => r.status === 'running');
}

/** Running workflow agents over every running run. */
export function runningWfAgents(runs: Map<string, WfRun[]>): number {
  let n = 0;
  for (const rs of runs.values()) for (const r of liveRunsOf(rs)) n += runCounts(r).running;
  return n;
}

/** "workflow <name> · <phase> · n/m done" (n = agents with a result, done or failed). */
export function runStrip(r: WfRun): string {
  const c = runCounts(r);
  const ph = runPhase(r);
  return [`workflow ${runName(r)}`, ph, `${c.done + c.failed}/${c.total} done`].filter(Boolean).join(' · ');
}
