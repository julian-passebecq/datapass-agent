import type {AgentSessionSnapshot} from '../model';
import {bounded} from '../util/redact';
/** Bounded observations only. No conversation text, raw archive or collector IO. */
export function developmentObservations(sessions:AgentSessionSnapshot[],now=Date.now()){
 return {version:'agent.development-observations/1' as const,observedAt:new Date(now).toISOString(),sessions:sessions.slice(0,100).map(s=>({
  sessionId:bounded(s.sessionId,160),provider:s.provider,repository:s.repository?bounded(s.repository,2048):null,worktree:s.worktree?bounded(s.worktree,2048):null,cwd:s.cwd?bounded(s.cwd,2048):null,branch:s.branch?bounded(s.branch,160):null,head:s.headAfter??null,status:s.status,model:s.model?bounded(s.model,160):null,effort:s.effort?bounded(s.effort,80):null,
  timing:{startedAt:s.startedAt??null,lastActivityAt:s.lastActivityAt??null,endedAt:s.endedAt??null},
  currentAction:s.facts?.currentTool?{tool:bounded(s.facts.currentTool.name,80),startedAt:s.facts.currentTool.startedAt}:null,
  changedFiles:s.changedFiles.slice(0,100).map(f=>bounded(f,2048)),commits:s.commits.slice(-30).map(c=>({sha:c.sha,at:c.at,attribution:c.attribution})),
  verification:s.tests.slice(-30).map(t=>({at:t.at,outcome:t.outcome,kind:t.kind??null,exitCode:t.exitCode??null,source:t.source})),pendingInput:s.status==='NEEDS_INPUT',
  evidence:s.evidence.slice(0,100).map(e=>({field:bounded(e.field,80),kind:e.kind,source:bounded(e.source,160)})),observedAt:new Date(now).toISOString()
 })),omitted:Math.max(0,sessions.length-100)};
}
