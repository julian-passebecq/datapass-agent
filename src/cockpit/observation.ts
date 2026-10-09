import type { AgentSessionSnapshot } from '../model';
import type { NativeObservation, SessionRef } from './interfaces';
import { bounded } from '../util/redact';

const iso = (at?:number) => at !== undefined && Number.isFinite(at) ? new Date(at).toISOString() : null;
export function observeSession(snapshot:AgentSessionSnapshot, ref:SessionRef):NativeObservation {
  const facts = snapshot.facts;
  return { session:ref, nativeId:snapshot.sessionId,
    surface:{value:facts?.entrypoint ? bounded(facts.entrypoint,80) : null,kind:facts?.entrypoint ? 'OBSERVED':'UNKNOWN',sourceIds:[snapshot.key],reason:'Recorded native entrypoint; CLI/Desktop/IDE mapping is not guessed.'},
    process:snapshot.nativeProcess ?? {alive:null,openTurn:null,explicitEnded:null,oneShotDone:null},
    timestamps:{startedAt:iso(snapshot.startedAt),lastProviderEventAt:iso(snapshot.lastActivityAt),capturedAt:new Date().toISOString()},
    requestedTrace:structuredClone(facts?.requestedTrace ?? []),nativeInputs:structuredClone(facts?.nativeInputs ?? []),
    goal:facts?.nativeGoal ? {...facts.nativeGoal}:{requested:null,observed:null,nativeThreadId:null,source:'UNKNOWN: no recorded supported native Goal tool result',at:null},
    metrics:{usage:snapshot.usage ? {...snapshot.usage}:null,activeMs:facts?.activeMs ?? null,waitMs:facts?.waitTotalMs ?? null,
      wallMs:snapshot.startedAt !== undefined && snapshot.lastActivityAt !== undefined ? Math.max(0,snapshot.lastActivityAt-snapshot.startedAt):null,
      quota:facts?.rateLimits ? structuredClone(facts.rateLimits):null,
      accountingBasis:'PER_SESSION_PROVIDER_COUNTER; linked parent/child disjointness UNKNOWN; never sum family counters',
      costBasis:snapshot.usage?.costUSD !== undefined ? 'PROVIDER_RECORDED_USD; no subscription/quota conversion':'UNKNOWN',
      coverage:'PARTIAL: bounded loaded history, recorded counters and <=2000 model-call samples; work/wait heuristics are DERIVED'},
    tools:Object.entries(facts?.toolCounts ?? {}).map(([name,calls])=>({name:bounded(name,80),calls})),
    provenance:snapshot.evidence.map(e=>({...e,source:bounded(e.source,180)})) };
}
