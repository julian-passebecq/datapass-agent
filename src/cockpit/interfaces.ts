/** NIGHT4 DTO/API specification. TO IMPLEMENT, not a claim about current exported APIs.
 * Keep actual legacy AgentApi intact. New facade is additive. All inputs validated in host.
 */
export type FactKind = 'OBSERVED' | 'ASSERTED' | 'DERIVED' | 'INFERRED' | 'UNKNOWN';
export type ResultState = 'OK' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'DENIED' | 'ERROR';
export interface Scope {
  scopeId: string; organizationIds: string[]; privacyDomainIds: string[];
  projectIds: string[]; repoIds: string[]; sourceVectorHash: string; policyHash: string;
}
export interface Request { requestId: string; scope: Scope; limit?: number; cursor?: string; epoch?: number; generation?: string; }
export interface HostIdentity { hostId: string; os: string; architecture: string; remoteAuthority?: string; runtimeVersion: string; }
export interface Capability { name: string; version: number; state: ResultState; reason?: string; }
export interface Reply<T> {
  schema: string; requestId: string; scopeHash: string; capturedAt: string;
  host: HostIdentity; state: ResultState; data: T; omissions: string[];
  nextCursor?: string; errors: {code:string; message:string; sourceId?:string}[];
  epoch?: number; generation?: string;
}
export interface Fact<T> { value: T | null; kind: FactKind; sourceIds: string[]; observedAt?: string; reason?: string; }
export interface SessionRef { id:string; provider:string; repoId?:string; parentId?:string; state:Fact<string>; model:Fact<string>; effort?:Fact<string>; mode?:Fact<string>; providerVersion?:Fact<string>; worktreeId?:string|null; }
export interface ContextRef {
  organizationId:string; privacyDomainId:string; projectId:string; repoId:string;
  hostId:string; worktreeId:string|null; revision:string|null; selectedItemId:string|null; returnToken:string;
  origin?:{schema:'datapass.pm-origin/1';projectId:string;taskId:string|null;taskRevision:number|null;taskAuthorityHash:string|null};
}
export interface ContextMapping { repoId:string;path:string;worktreeId:string|null;worktreePath:string|null;revision:string|null;sessionId:string; }
export interface NativeObservation {
  session:SessionRef; nativeId:string; surface:Fact<string>;
  process:AgentNativeProcess; timestamps:{startedAt:string|null;lastProviderEventAt:string|null;capturedAt:string};
  requestedTrace:NonNullable<import('../model').SessionFacts['requestedTrace']>;
  goal:NonNullable<import('../model').SessionFacts['nativeGoal']>;
  nativeInputs:import('../model').NativeInput[];
  metrics:{usage:import('../model').SessionUsage|null;activeMs:number|null;waitMs:number|null;wallMs:number|null;quota:import('../model').RateLimits|null;accountingBasis:string;costBasis:string;coverage:string};
  tools:{name:string;calls:number}[]; provenance:{field:string;kind:FactKind;source:string}[];
}
export interface AgentNativeProcess { alive:boolean|null;openTurn:boolean|null;explicitEnded:boolean|null;oneShotDone:boolean|null; }
export interface EventPage { events:ChangeEvent[]; nextSequence:number; oldestSequence:number; gap:boolean; epoch:number; }
export interface Summary { sessions:SessionRef[]; backlogGroups:unknown[]; usage:unknown[]; contextReceipts:unknown[]; assetRefs:unknown[]; evidenceRefs?:unknown[]; }
export interface ProviderConfig {
  provider:string; cliVersion:Fact<string>; layers:unknown[]; effective:Record<string,Fact<string>>;
  resolution:'COMPLETE'|'PARTIAL'|'UNKNOWN'; inventory:unknown[]; observedSessions:SessionRef[];
  sourceOpenIds:string[]; // opaque trusted-host IDs, not arbitrary paths/commands
}
export interface ExportPlan { id:string; hash:string; exporterVersion:string; newCount:number; appendedCount:number; rewrittenCount:number; unchangedCount:number; omittedCount:number; }
export interface LocalExportApproval { approvedPlanHash:string; destinationId:string; scopePolicyHash:string; }
export interface ExportReceipt { id:string; manifestHash:string; state:ResultState; committedCursorIds:string[]; artifactRefs:string[]; }
export interface ChangeEvent { sequence:number; scopeHash:string; kind:'REFRESH'|'CHANGE'|'RESYNC_REQUIRED'; capturedAt:string; }
export interface Disposable { dispose():void; }
export interface AgentCockpitV1 {
  readonly major:1;
  capabilities():Promise<Reply<Capability[]>>;
  getSummary(request:Request):Promise<Reply<Summary>>;
  getProviderConfiguration(request:Request & {provider:'codex'|'claude';}):Promise<Reply<ProviderConfig>>;
  reveal(request:Request & {target:{kind:'session'|'settings'|'catalog'|'source'|'project';id:string;}}):Promise<Reply<{opened:boolean}>>;
  subscribe(request:Request,listener:(event:ChangeEvent)=>void):Disposable;
  planExport(request:Request & {sourceIds:string[];redactionProfileHash:string;}):Promise<Reply<ExportPlan>>;
  executeApprovedLocalExport(request:Request & {approval:LocalExportApproval;}):Promise<Reply<ExportReceipt>>;
  getExportReceipt(request:Request & {id:string;}):Promise<Reply<ExportReceipt>>;
  getObservation(request:Request):Promise<Reply<NativeObservation[]>>;
  getEventPage(request:Request & {afterSequence?:number}):Promise<Reply<EventPage>>;
  revealContext(request:Request & {context:ContextRef}):Promise<Reply<{opened:boolean;returnToken:string|null}>>;
  prepareReply(request:Request & {sessionId:string;questionId:string;text:string}):Promise<Reply<{text:string|null;transport:'MANUAL_COPY'|'UNSUPPORTED';sent:false}>>;
  getResourceObservations(request:Request):Promise<Reply<import('./resources').ResourceObservation[]>>;
  getContextMappings(request:Request):Promise<Reply<ContextMapping[]>>;
}
export interface BrainCapabilities { protocolMajor:1; capabilities:Capability[]; actualBackends:string[]; runtime:HostIdentity; generationIds:string[]; }
export interface ReadyManifest {
  schema:'galaxy.component-ready/1'; workstreamId:string; lane:'PM'|'AGENT'|'BRAIN'|'DIAGRAM';
  componentId:string; componentVersion:string; sourceSha:string; capturedAt:string; host:HostIdentity;
  contractMajor:1; contractMinor:number; capabilities:Capability[];
  artifacts:{relativePath:string; sha256:string; bytes:number; kind:'vsix'|'node-package'|'web-build'|'source'|'fixture'|'report';}[];
  checks:{id:string; status:'PASS'|'FAIL'|'NOT_RUN'; evidenceRefs:string[];}[];
  unavailable:{capability:string;reason:string}[];
  // No arbitrary shell commands, credentials or automatic approval in a READY file.
}
