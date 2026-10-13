import type { Request } from '../cockpit/interfaces';
export type AHPState = 'AHP_AVAILABLE' | 'AUTH_REQUIRED' | 'PROVIDER_UNSUPPORTED' | 'HOST_NOT_RUNNING' | 'PERMISSION_REQUIRED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED' | 'UNCERTAIN' | 'UNAVAILABLE' | 'DENIED' | 'PROTOCOL_UNSUPPORTED';
export interface AHPReply<T> { schema:'datapass.agent-host-reply/1'; requestId:string; scopeHash:string; state:AHPState; message:string; data:T; }
export interface AHPBinding {
  taskId:string; roleId:string; root:string; revision:string; authorityHash:string; preparedTaskHash:string;
  compiledPromptHash:string; configScopeHash:string; presetHash:string; provider:'codex'|'claude';
  requestedModel:string|null; requestedEffort?:string|null; prompt:string; promptHash:string;
  requestedMode?:'PLAN'|'GOAL'|'DEFAULT'; testPolicyHash?:string; outputPolicyHash?:string;
  taskRevision?:number;
  executionPolicy?: AHPExecutionPolicy;
}
/** Config owns selection; Agent owns protocol validation and enforcement. */
export interface AHPExecutionPolicy { mode:'READ_ONLY_NO_DELEGATION'; sourcePolicyHash:string; }
export interface AHPPermissionReview {
  policyHash:string; resolvedConfigHash:string; hostConfigHash:string;
  configuration:'SUPPORTED'; nativeEffective:'UNKNOWN'; hostTools:'UNVERIFIED';
  stage:'RESOLVED'|'SESSION_CONFIG_OBSERVED'; message:string;
}
export interface AHPHost { hostId:string; kind:'VSCODE_AGENT_HOST'|'STANDALONE_AGENT_HOST'|'SYNTHETIC'; label:string; protocolVersion:string|null; connectionState:AHPState; identityHash:string; }
export interface AHPProvider { provider:string; state:AHPState; models:{id:string;provider:string;name:string;efforts:string[]}[]; }
export interface AHPInspection { state:AHPState; hosts:AHPHost[]; providers:AHPProvider[]; capabilities:string[]; selectedHostId:string|null; protocolVersion:string|null; sessions:{hostId:string;sessionId:string;taskId:string}[]; message:string; }
export interface AHPPrepared { schema:'datapass.agent-host-prepared/1'; handleId:string; preparedHash:string; hostId:string; hostIdentityHash:string; protocolVersion:string; scopeHash:string; binding:AHPBinding; inventoryHash:string; capturedAt:string; permissionReview?:AHPPermissionReview; }
export interface AHPApproval { preparedHash:string; taskId:string; promptHash:string; hostId:string; provider:'codex'|'claude'; protocolVersion:string; }
export interface AHPObservation {
  schema:'datapass.agent-host-observation/1'; handleId:string; taskId:string; roleId:string; preparedHash:string; scopeHash:string;
  hostId:string; hostIdentityHash:string; protocolVersion:string; provider:'codex'|'claude'; root:string; revision:string; promptHash:string;
  sessionId:string|null; chatId:string|null; turnId:string|null; state:AHPState; resultText:string; resultHash:string;
  observedModel:string|null; observedEffort:string|null; requestedModel:string|null; requestedEffort:string|null;
  lastServerSeq:number; capturedAt:string; evidence:'SYNTHETIC'|'NATIVE_AHP_OBSERVED'; message:string; acceptedTaskCompletion:false;
  executionPolicyHash?:string; permissionReview?:AHPPermissionReview;
}
export interface AgentHostApi {
  readonly major:1;
  reviewProject(input:{request:Request;binding:AHPBinding}):Promise<AHPReply<{authorized:boolean}>>;
  reviewHostConnection(input:{request:Request;binding:AHPBinding}):Promise<AHPReply<AHPInspection>>;
  inspect(input:{request:Request;target:{provider:'codex'|'claude';surface:'VSCODE_AGENT_HOST';hostId?:string}}):Promise<AHPReply<AHPInspection>>;
  prepare(input:{request:Request;binding:AHPBinding;hostId:string}):Promise<AHPReply<AHPPrepared|null>>;
  execute(input:{request:Request;preparedHash:string;approval:AHPApproval}):Promise<AHPReply<AHPObservation|null>>;
  observe(input:{request:Request;handleId:string}):Promise<AHPReply<AHPObservation|null>>;
  recover(input:{request:Request;handleId:string}):Promise<AHPReply<AHPObservation|null>>;
  cancel(input:{request:Request;handleId:string}):Promise<AHPReply<AHPObservation|null>>;
  reveal(input:{request:Request;handleId:string}):Promise<AHPReply<{opened:boolean}>>;
  subscribe(input:{request:Request;handleId:string},listener:(event:AHPObservation)=>void):{dispose():void};
}
