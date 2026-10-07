import type {AgentSessionSnapshot, TimelineEvent} from '../model';
import {sanitize} from './conversations';
export const OBSERVATION_CONTRACT = 'agent.observation-export/1' as const;
/** Missing verification stays absent/UNKNOWN; Git correlation is not task success. */
export function observationExport(s:AgentSessionSnapshot,events:TimelineEvent[],observedAt=new Date().toISOString()) {
  return sanitize({schema:OBSERVATION_CONTRACT,provider:s.provider,sessionId:s.sessionId,
    parentSessionId:s.parentSessionId,workerId:s.isWorker?s.sessionId:undefined,
    project:s.cwd??null,repoPath:s.repository??null,worktreePath:s.worktree,branch:s.branch,
    headBefore:s.headBefore,headAfter:s.headAfter,startedAt:s.startedAt?new Date(s.startedAt).toISOString():null,
    endedAt:s.endedAt?new Date(s.endedAt).toISOString():undefined,status:s.status,model:s.model,effort:s.effort,
    events,verification:s.tests,files:s.changedFiles,commits:s.commits,usage:s.usage,
    evidenceKind:s.evidence.find(e=>e.field==='status')?.kind??'UNKNOWN',evidence:s.evidence,
    source:'provider-artifact + bounded observer model',observedAt,
    policy:{redacted:true,eventWindow:'latest 300 normalized events; complete recorded events in sibling JSONL',authority:'observation'}});
}
