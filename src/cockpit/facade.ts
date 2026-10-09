import * as os from 'node:os';
import type { AgentSessionSnapshot } from '../model';
import { scanBacklog } from '../feeds/backlog';
import { bounded } from '../util/redact';
import type { AgentCockpitV1, Capability, ChangeEvent, ExportPlan, ExportReceipt, Fact, HostIdentity, ProviderConfig, Reply, Request, Scope, SessionRef, Summary } from './interfaces';
import { digest, idOk, LocalGrant, repoId, ScopePolicy, validateRequest } from './policy';
import { ConfigRead, readConfiguration, safeLocalSource } from './configuration';
import { IncrementalExporter } from '../export/incremental';
import { observeSession } from './observation';
import type { ContextRef, EventPage, NativeObservation } from './interfaces';
import { observeResources, validateResources, SelectedResource } from './resources';
import { intakeImage, ImageProducerReceipt } from './images';

export interface ContextReceipt { id: string; projectId: string; sourceIds: string[]; backend: string; generationId: string; queriedAt: string; state: string; }
export interface AcceptedWork { projectId: string; revision: string; counts: { open: number; active: number; done: number; }; }
export type AssetState = 'FILE_OBSERVED' | 'GENERATED_REPORTED' | 'GENERATED_VERIFIED' | 'SELECTED' | 'PUBLISHED';
export interface AssetRef { id: string; sha256: string; state: AssetState; producer: string | null; bytes: number; sourceId: string; }
export interface SessionEvidenceRef { id:string;sessionId:string;taskId:string|null;presetHash:string|null;configHash:string|null;promptHash:string|null;sourceSha:string|null;qaReceiptId:string|null; }
export interface ScopedInputs { contexts: ContextReceipt[]; acceptedWork: AcceptedWork[]; assets: AssetRef[]; evidenceRefs?:SessionEvidenceRef[]; panelContext?:{valid:boolean;context?:ContextRef;projectId:string}; }
interface StoreRead { all(): AgentSessionSnapshot[]; onDidChange(fn: () => void): { dispose(): void }; lastStats?: { at: number }; opts: { historyDays: number }; }
interface HostServices {
  host?: HostIdentity;
  configuration?: typeof readConfiguration;
  installed?: () => { codex?: { version?: string; source: string }; claude?: { version?: string; source: string } };
  open(view: 'compact' | 'session' | 'settings' | 'catalog' | 'project', grant: LocalGrant, id: string, context?:ContextRef): Promise<void> | void;
  openSource(file: string): Promise<void>;
}
export const localHost = (): HostIdentity => ({ hostId: 'host:' + digest(os.hostname()).slice(0, 16), os: process.platform, architecture: process.arch, runtimeVersion: process.version });
export function sessionRef(s: AgentSessionSnapshot, allowed: Set<string>): SessionRef {
  const fact = (value: string | undefined, reason?: string): Fact<string> => ({ value: value ? bounded(value, 80) : null, kind: value ? 'OBSERVED' : 'UNKNOWN', sourceIds: [s.key], ...(s.lastActivityAt ? { observedAt: new Date(s.lastActivityAt).toISOString() } : {}), ...(reason ? { reason } : {}) });
  const state = fact(s.status, s.statusReason); state.kind = s.status === 'UNKNOWN' ? 'UNKNOWN' : s.evidence.find(e=>e.field==='status')?.kind ?? 'INFERRED';
  return { id: s.key, provider: s.provider, ...(s.repository ?? s.cwd ? { repoId: repoId((s.repository ?? s.cwd)!) } : {}), ...(s.parentSessionId && allowed.has(s.parentSessionId) ? { parentId: s.parentSessionId } : {}), state, model: fact(s.model),
    ...{ effort: fact(s.effort), mode: fact(s.facts?.collaborationMode ?? s.facts?.permissionMode), providerVersion: fact(s.providerVersion), worktreeId: s.worktree ? repoId(s.worktree) : null } };
}
/** Pure aggregation over the existing store. Cumulative totals never masquerade as period samples. */
export function usageWindows(sessions: AgentSessionSnapshot[], now: number, historyDays: number): unknown[] {
  return [1, 7, 30].map(days => {
    const since = now - days * 86400000;
    const selected = [...new Map(sessions.filter(s => (s.lastActivityAt ?? 0) >= since).map(s => [s.key, s])).values()];
    const selectedKeys = new Set(selected.map(s => s.key));
    const rootSessions = selected.filter(s => !s.parentSessionId || !selectedKeys.has(s.parentSessionId));
    // A provider may include worker usage in its parent's records. Never add a linked
    // child's samples to that parent's total without an explicit attribution contract.
    const calls = rootSessions.flatMap(s => (s.facts?.calls ?? []).filter(c => c[0] >= since));
    return { window: days === 1 ? '24h' : days + 'd', since: new Date(since).toISOString(), capturedAt: new Date(now).toISOString(), basis: 'recorded root/standalone model-call samples; linked children are reported separately, never summed into parents', sessions: selected.length, sampledSessions: rootSessions.filter(s => s.facts?.calls?.some(c => c[0] >= since)).length,
      repositories: new Set(selected.map(s => s.repository ?? s.cwd).filter(Boolean).map(r => repoId(r!))).size,
      inputTokens: calls.reduce((n, c) => n + c[1], 0), outputTokens: calls.reduce((n, c) => n + c[2], 0), calls: calls.length,
      perSession: selected.map(s => ({ sourceId: s.key, parentId: s.parentSessionId && selectedKeys.has(s.parentSessionId) ? s.parentSessionId : null, model: s.model ? bounded(s.model, 80) : null, calls: (s.facts?.calls ?? []).filter(c => c[0] >= since).length, inputTokens: (s.facts?.calls ?? []).filter(c => c[0] >= since).reduce((n, c) => n + c[1], 0), outputTokens: (s.facts?.calls ?? []).filter(c => c[0] >= since).reduce((n, c) => n + c[2], 0) })),
      coverage: { loadedHistoryDays: historyDays, complete: false, reason: 'Session/reader caps and missing calls limit coverage; parent/worker aggregation semantics are provider-dependent.' }, billing: 'UNKNOWN; recorded tokens are not productivity or subscription bills' };
  });
}
export class CockpitFacade {
  readonly api: AgentCockpitV1 & { getScopes(): Promise<Reply<Scope[]>> };
  private configurations = new Map<string, ConfigRead>();
  private inputs = new Map<string, ScopedInputs>();
  private approvals = new Map<string, { planHash: string; scopeHash: string; destination: string }>();
  private destinations = new Map<string, string>();
  private activeDestination?: string;
  private sequence = 0;
  private eventStreams = new Map<string,{fingerprint:string;sequence:number;events:ChangeEvent[];epoch:number}>();
  private selectedResources=new Map<string,SelectedResource[]>();
  private subscribers = new Set<{ request: Request; listener: (e: ChangeEvent) => void; pending: number; timer?: NodeJS.Timeout; disposed: boolean }>();
  private changeSub: { dispose(): void };
  private host: HostIdentity;
  constructor(private store: StoreRead, readonly policy: ScopePolicy, private services: HostServices, private exporter: IncrementalExporter) {
    this.host = services.host ?? localHost();
    // Only bounded read/approved-effect methods cross the extension API boundary.
    const api: typeof this.api = { major: 1, capabilities: () => this.capabilities(), getScopes: async () => this.reply(undefined, policy.scopes(), 'OK'), getSummary: r => this.summary(r), getProviderConfiguration: r => this.configuration(r), reveal: r => this.reveal(r), subscribe: (r, l) => this.subscribe(r, l), planExport: r => this.plan(r), executeApprovedLocalExport: r => this.execute(r), getExportReceipt: r => this.receipt(r), getObservation:r=>this.observation(r),getEventPage:r=>this.eventPage(r),revealContext:r=>this.revealContext(r),prepareReply:r=>this.prepareReply(r),getResourceObservations:r=>this.resources(r) };
    api.getResourceObservations=r=>this.resources(r);
    this.api = Object.freeze(api);
    this.changeSub = store.onDidChange(() => this.changed());
  }
  private reply<T>(r: Request | undefined, data: T, state: Reply<T>['state'], omissions: string[] = []): Reply<T> {
    return structuredClone({ schema: 'datapass.agent-cockpit/1', requestId: r && idOk(r.requestId) ? r.requestId : 'capabilities', scopeHash: r && validateRequest(r) ? digest(r.scope) : '', capturedAt: new Date().toISOString(), host: this.host, state, data, omissions, epoch:this.policy.epoch,...(r?.generation && idOk(r.generation) ? {generation:r.generation}:{}), errors: state === 'DENIED' ? [{ code: 'SCOPE_DENIED', message: 'Host-reviewed local scope is required.' }] : [] });
  }
  private async capabilities(): Promise<Reply<Capability[]>> {
    return this.reply(undefined, ['summary', 'providerConfiguration', 'reveal', 'subscribe', 'incrementalExport', 'registeredContextReceipts', 'acceptedWork', 'assets', 'getScopes','getObservation','getEventPage','revealContext','prepareReply','getResourceObservations'].map(name => ({ name, version: 1, state: 'OK' as const })), 'OK', ['Scopes require explicit local review; no caller-created grants.','prepareReply provides manual-copy fallback; native send and provider permissions are not owned by Agent.']);
  }
  private sessions(g: LocalGrant): AgentSessionSnapshot[] { return this.policy.sessions(g, this.store.all()); }
  /** Only host file-picker selections may enroll resources; paths never come from API request JSON. */
  registerResources(g:LocalGrant,items:SelectedResource[]):void {
    if(!this.policy.authorize({requestId:'register-resource',scope:g.scope}))throw new Error('Scope unavailable.');
    validateResources(g,items);this.selectedResources.set(g.scope.policyHash,structuredClone(items));
  }
  async registerImageReceipt(g:LocalGrant,file:string,receipt:ImageProducerReceipt):Promise<AssetRef> {
    const epoch=this.policy.epoch,valid=()=>epoch===this.policy.epoch && !!this.policy.authorize({requestId:'image-intake',scope:g.scope});
    const asset=await intakeImage(file,receipt,g,valid);
    const existing=this.inputs.get(g.scope.policyHash) ?? {contexts:[],acceptedWork:[],assets:[]};
    this.inputs.set(g.scope.policyHash,{...existing,assets:[...existing.assets.filter(a=>a.id!==asset.id),asset].slice(-200)});this.changed();return asset;
  }
  private async resources(r:Request) {
    const g=this.policy.authorize(r),epoch=this.policy.epoch;
    if(!g)return this.reply(r,[],'DENIED');
    const data=await observeResources(this.selectedResources.get(g.scope.policyHash) ?? [],()=>epoch===this.policy.epoch && !!this.policy.authorize(r));
    return this.reply(r,data,epoch===this.policy.epoch && this.policy.authorize(r)?'PARTIAL':'DENIED',['Explicit selected metadata only; disabled/stale watcher does not establish the cause of another failure.']);
  }
  private async observation(r:Request):Promise<Reply<NativeObservation[]>> {
    const g=this.policy.authorize(r); if(!g) return this.reply(r,[],'DENIED');
    const all=this.sessions(g), keys=new Set(all.map(s=>s.key)), start=Number(r.cursor ?? 0),limit=r.limit ?? 100;
    const reply=this.reply(r,all.slice(start,start+limit).map(s=>observeSession(s,sessionRef(s,keys))),'PARTIAL',['Native process and turn completion are separate. Missing child model/Goal/account fields remain UNKNOWN.']);
    if(start+limit<all.length) reply.nextCursor=String(start+limit); return reply;
  }
  private stream(g:LocalGrant) {
    const key=digest(g.scope), fingerprint=digest({sessions:this.sessions(g),inputs:this.inputs.get(g.scope.policyHash)});
    let stream=this.eventStreams.get(key);
    if(!stream || stream.epoch!==this.policy.epoch) { stream={fingerprint,sequence:0,events:[],epoch:this.policy.epoch};this.eventStreams.set(key,stream); }
    return stream;
  }
  private async eventPage(r:Request & {afterSequence?:number}):Promise<Reply<EventPage>> {
    const empty:EventPage={events:[],nextSequence:0,oldestSequence:0,gap:false,epoch:this.policy.epoch},g=this.policy.authorize(r);
    if(!g || r.afterSequence!==undefined && (!Number.isSafeInteger(r.afterSequence) || r.afterSequence<0))return this.reply(r,empty,'DENIED');
    const stream=this.stream(g),after=r.afterSequence ?? 0,oldest=stream.events[0]?.sequence ?? stream.sequence;
    const gap=after>stream.sequence || oldest>1 && after<oldest-1;
    const events=stream.events.filter(e=>e.sequence>after).slice(0,r.limit ?? 100);
    return this.reply(r,{events,nextSequence:events.at(-1)?.sequence ?? stream.sequence,oldestSequence:oldest,gap,epoch:stream.epoch},gap?'STALE':'OK',gap?['Retained event gap or generation reset; resync getObservation before continuing.']:[]);
  }
  private async revealContext(r:Request & {context:ContextRef}):Promise<Reply<{opened:boolean;returnToken:string|null}>> {
    const g=this.policy.authorize(r),c=r?.context,empty={opened:false,returnToken:null};
    if(!g || !c || !g.scope.organizationIds.includes(c.organizationId) || !g.scope.privacyDomainIds.includes(c.privacyDomainId) || !g.scope.projectIds.includes(c.projectId) || !g.scope.repoIds.includes(c.repoId) || c.hostId!==this.host.hostId || !idOk(c.returnToken) || c.selectedItemId!==null && !idOk(c.selectedItemId) || c.worktreeId!==null && !idOk(c.worktreeId) || c.revision!==null && !/^[a-f0-9]{7,40}$/.test(c.revision))return this.reply(r,empty,'DENIED');
    const sessions=this.sessions(g).filter(s=>repoId(s.repository ?? s.cwd ?? '')===c.repoId),selected=c.selectedItemId ? sessions.find(s=>s.key===c.selectedItemId):undefined;
    if(!sessions.length || c.selectedItemId && !selected || c.worktreeId && !sessions.some(s=>s.worktree && repoId(s.worktree)===c.worktreeId) || c.revision && !(selected ? [selected]:sessions).some(s=>s.headAfter===c.revision || s.headBefore===c.revision))return this.reply(r,empty,'DENIED',['Canonical context cannot be mapped to the reviewed native observations.']);
    await this.services.open(selected?'session':'project',g,selected?.key ?? c.projectId,structuredClone(c));
    return this.reply(r,{opened:true,returnToken:c.returnToken},'OK');
  }
  private async prepareReply(r:Request & {sessionId:string;questionId:string;text:string}):Promise<Reply<{text:string|null;transport:'MANUAL_COPY'|'UNSUPPORTED';sent:false}>> {
    const empty={text:null,transport:'UNSUPPORTED' as const,sent:false as const},g=this.policy.authorize(r);
    if(!g || !idOk(r.sessionId) || !idOk(r.questionId) || typeof r.text!=='string' || r.text.length>4000)return this.reply(r,empty,'DENIED');
    const question=this.sessions(g).find(s=>s.key===r.sessionId)?.facts?.nativeInputs?.find(q=>q.id===r.questionId || q.questionIds.includes(r.questionId));
    if(!question || question.requestClass!=='ORDINARY_INPUT' || question.state!=='REQUESTED')return this.reply(r,empty,'DENIED',['Only an observed pending ordinary question supports a reply draft; security requests stay native/manual.']);
    return this.reply(r,{text:bounded(r.text,4000),transport:'MANUAL_COPY',sent:false},'PARTIAL',['No verified native send transport is exposed on this host. Copy the exact draft to the owned native conversation.']);
  }
  private async summary(r: Request): Promise<Reply<Summary>> {
    if (validateRequest(r)) r = {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch};
    const empty: Summary = { sessions: [], backlogGroups: [], usage: [], contextReceipts: [], assetRefs: [] }, g = this.policy.authorize(r);
    if (!g) return this.reply(r, empty, 'DENIED');
    const all = this.sessions(g), keys = new Set(all.map(s => s.key)), start = Number(r.cursor ?? 0), limit = r.limit ?? 100;
    const plan = await scanBacklog({ roots: g.roots, now: Date.now() });
    if (!this.policy.authorize(r)) return this.reply(r, empty, 'DENIED');
    const inputs = this.inputs.get(g.scope.policyHash) ?? { contexts: [], assets: [], acceptedWork: [] };
    const result: Summary = { sessions: all.slice(start, start + limit).map(s => sessionRef(s, keys)), backlogGroups: [
      { kind: 'PM_ACCEPTED', state: inputs.acceptedWork.length ? 'OK' : 'UNAVAILABLE', items: inputs.acceptedWork },
      { kind: 'OBSERVED_REPO_PLAN', at: new Date(plan.at).toISOString(), basis: 'existing read-only plan scanner', repositories: plan.files.map(f => ({ repoId: repoId(f.root), source: f.rel, freshness: new Date(f.mtime).toISOString(), counts: { open: f.items.filter(i => i.state === 'open').length, active: f.items.filter(i => i.state === 'active').length, done: f.items.filter(i => i.state === 'done').length }, state: f.skipped ? 'PARTIAL' : 'OK' })) },
    ], usage: usageWindows(all, Date.now(), this.store.opts.historyDays), contextReceipts: inputs.contexts, assetRefs: inputs.assets, evidenceRefs:inputs.evidenceRefs ?? [] };
    const stale = !this.store.lastStats || Date.now() - this.store.lastStats.at > 60000;
    const reply = this.reply(r, result, stale ? 'STALE' : 'PARTIAL', ['Bounded local observation; recent does not prove a process is alive.', 'Missing metrics, receipts and assets remain unknown.']);
    if (start + limit < all.length) reply.nextCursor = String(start + limit); return reply;
  }
  private async configuration(r: Request & { provider: 'codex' | 'claude' }): Promise<Reply<ProviderConfig>> {
    if (validateRequest(r)) r = {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch};
    const empty: ProviderConfig = { provider: 'UNKNOWN', cliVersion: { value: null, kind: 'UNKNOWN', sourceIds: [] }, layers: [], effective: {}, resolution: 'UNKNOWN', inventory: [], observedSessions: [], sourceOpenIds: [] };
    const g = this.policy.authorize(r);
    if (!g?.configuration || !['codex', 'claude'].includes(r.provider)) return this.reply(r, empty, 'DENIED');
    const all = this.sessions(g), keys = new Set(all.map(s => s.key));
    const c = await (this.services.configuration ?? readConfiguration)(g, r.provider, all.map(s => sessionRef(s, keys)));
    if (!this.policy.authorize(r)) return this.reply(r, empty, 'DENIED');
    const installed = this.services.installed?.()[r.provider];
    if (installed?.version) c.config.cliVersion = { value: bounded(installed.version, 80), kind: 'OBSERVED', sourceIds: ['installed-version:' + r.provider], observedAt: new Date().toISOString(), reason: bounded(installed.source, 120) };
    this.configurations.set(g.scope.policyHash + ':' + r.provider, c);
    return this.reply(r, c.config, 'PARTIAL', ['Configured layers do not resolve CLI overrides or prove authenticated/working/used tools.']);
  }
  private async reveal(r: Request & { target: { kind: 'session' | 'settings' | 'catalog' | 'source' | 'project'; id: string } }): Promise<Reply<{ opened: boolean }>> {
    if (validateRequest(r)) r = {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch};
    const g = this.policy.authorize(r), t = r?.target;
    if (!g || !t || !idOk(t.id)) return this.reply(r, { opened: false }, 'DENIED');
    if (t.kind === 'source') {
      const file = [...this.configurations].filter(([k]) => k.startsWith(g.scope.policyHash + ':')).map(([, c]) => c.sources.get(t.id)).find(Boolean);
      if (!file || !await safeLocalSource(file) || !this.policy.authorize(r)) return this.reply(r, { opened: false }, 'DENIED');
      await this.services.openSource(file);
    } else {
      const allowed = t.kind === 'session' ? this.sessions(g).some(s => s.key === t.id) : t.kind === 'project' ? g.scope.projectIds.includes(t.id) : (t.kind === 'settings' || t.kind === 'catalog') && g.configuration && t.id === g.scope.scopeId;
      if (!allowed) return this.reply(r, { opened: false }, 'DENIED');
      await this.services.open(t.kind, g, t.id);
    }
    return this.reply(r, { opened: true }, 'OK');
  }
  private subscribe(r: Request, listener: (e: ChangeEvent) => void): { dispose(): void } {
    if (!this.policy.authorize(r) || typeof listener !== 'function' || this.subscribers.size >= 100) return { dispose() {} };
    const sub = { request: {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch}, listener, pending: 0, disposed: false, timer: undefined as NodeJS.Timeout | undefined };
    this.stream(this.policy.authorize(r)!);
    this.subscribers.add(sub);
    return { dispose: () => { sub.disposed = true; if (sub.timer) clearTimeout(sub.timer); this.subscribers.delete(sub); } };
  }
  private changed(): void {
    this.sequence++;
    const updated=new Set<string>();
    for(const scope of this.policy.scopes()) {
      const g=this.policy.authorize({requestId:'event-refresh',scope})!;
      const stream=this.stream(g),fingerprint=digest({sessions:this.sessions(g),inputs:this.inputs.get(g.scope.policyHash)});
      if(stream.fingerprint===fingerprint)continue;
      stream.fingerprint=fingerprint;stream.sequence++;
      stream.events.push({sequence:stream.sequence,scopeHash:digest(scope),kind:'CHANGE',capturedAt:new Date().toISOString()});
      stream.events=stream.events.slice(-256);updated.add(digest(scope));
    }
    for (const sub of this.subscribers) {
      if(!this.policy.authorize(sub.request)){sub.disposed=true;if(sub.timer)clearTimeout(sub.timer);this.subscribers.delete(sub);continue;}
      if(!updated.has(digest(sub.request.scope)))continue;
      sub.pending = Math.min(sub.pending + 1, 33);
      if (sub.timer) continue;
      sub.timer = setTimeout(() => {
        sub.timer = undefined;
        if (sub.disposed || !this.policy.authorize(sub.request)) return;
        const event: ChangeEvent = { sequence: this.eventStreams.get(digest(sub.request.scope))?.sequence ?? 0, scopeHash: digest(sub.request.scope), kind: sub.pending > 32 ? 'RESYNC_REQUIRED' : 'CHANGE', capturedAt: new Date().toISOString() };
        sub.pending = 0;
        try { const result = sub.listener(event) as unknown; if (result && typeof (result as Promise<unknown>).catch === 'function') void (result as Promise<unknown>).catch(() => {}); } catch { /* Consumer failure is isolated. */ }
      }, 25);
    }
  }
  /** Called only by the host's explicit destination picker, never by request JSON. */
  setDestination(id: string, directory: string): void { this.destinations.set(id, directory); this.activeDestination = directory; }
  approve(planHash: string, g: LocalGrant, destinationId: string): void {
    const destination = this.destinations.get(destinationId); if (!destination) throw new Error('Pick a local destination.');
    this.approvals.set(planHash, { planHash, scopeHash: g.scope.policyHash, destination });
  }
  private async plan(r: Request & { sourceIds: string[]; redactionProfileHash: string }): Promise<Reply<ExportPlan>> {
    if (validateRequest(r)) r = {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch};
    const empty: ExportPlan = { id: '', hash: '', exporterVersion: 'incremental/1', newCount: 0, appendedCount: 0, rewrittenCount: 0, unchangedCount: 0, omittedCount: 0 };
    const g = this.policy.authorize(r), destination = this.activeDestination;
    if (!g?.exportConsent) return this.reply(r, empty, 'DENIED');
    if (!destination) return this.reply(r, empty, 'UNAVAILABLE', ['Pick a local export destination in Agent first.']);
    try { return this.reply(r, await this.exporter.plan(g, this.sessions(g), r.sourceIds, r.redactionProfileHash, destination), 'OK'); }
    catch { return this.reply(r, empty, 'ERROR', ['Export plan rejected; selected source or identity could not be validated.']); }
  }
  private async execute(r: Request & { approval: { approvedPlanHash: string; destinationId: string; scopePolicyHash: string } }): Promise<Reply<ExportReceipt>> {
    if (validateRequest(r)) r = {...structuredClone(r),epoch:r.epoch ?? this.policy.epoch};
    const empty: ExportReceipt = { id: '', manifestHash: '', state: 'DENIED', committedCursorIds: [], artifactRefs: [] };
    const g = this.policy.authorize(r), a = r?.approval, approved = a && this.approvals.get(a.approvedPlanHash);
    if (!g || !a || !approved || approved.scopeHash !== g.scope.policyHash || a.scopePolicyHash !== g.scope.policyHash || this.destinations.get(a.destinationId) !== approved.destination) return this.reply(r, empty, 'DENIED');
    try { return this.reply(r, await this.exporter.execute(g, a.approvedPlanHash, approved.destination,undefined,()=>!!this.policy.authorize(r)), 'OK'); }
    catch { return this.reply(r, { ...empty, state: 'ERROR' }, 'ERROR', ['Export failed before a new cursor commit; inspect selected native source or destination.']); }
  }
  private async receipt(r: Request & { id: string }): Promise<Reply<ExportReceipt>> {
    const empty: ExportReceipt = { id: '', manifestHash: '', state: 'UNAVAILABLE', committedCursorIds: [], artifactRefs: [] };
    const g = this.policy.authorize(r); if (!g || !idOk(r.id)) return this.reply(r, empty, 'DENIED');
    const epoch=this.policy.epoch;
    let receipt = this.exporter.getReceipt(g, r.id);
    if(!receipt)for(const destination of [...this.destinations.values()].slice(0,20)){
      try{receipt=await this.exporter.recoverReceipt(g,r.id,destination);}catch{return this.reply(r,empty,'ERROR',['Committed receipt or artifact integrity failed.']);}
      if(receipt)break;
    }
    if(epoch!==this.policy.epoch || !this.policy.authorize(r))return this.reply(r,empty,'DENIED');
    return this.reply(r, receipt ?? empty, receipt ? 'OK' : 'UNAVAILABLE');
  }
  /** Host-reviewed receipt input; no ambient history lookup or inferred consumption semantics. */
  registerInputs(g: LocalGrant, data: ScopedInputs): void {
    if (!this.policy.authorize({ requestId: 'register', scope: g.scope })) throw new Error('Scope unavailable.');
    if (!Array.isArray(data.contexts) || !Array.isArray(data.acceptedWork) || !Array.isArray(data.assets) || [data.contexts, data.acceptedWork, data.assets].some(a => a.length > 200)) throw new Error('Receipt bounds exceeded.');
    const contexts = data.contexts.map(c => {
      if (!idOk(c.id) || !g.scope.projectIds.includes(c.projectId) || !idOk(c.backend) || !idOk(c.generationId) || !Number.isFinite(Date.parse(c.queriedAt)) || !Array.isArray(c.sourceIds) || c.sourceIds.length > 100 || !c.sourceIds.every(idOk) || !['OK', 'PARTIAL', 'STALE', 'UNAVAILABLE', 'DENIED', 'ERROR'].includes(c.state)) throw new Error('Invalid context receipt.');
      return { id: c.id, projectId: c.projectId, sourceIds: c.sourceIds, backend: c.backend, generationId: c.generationId, queriedAt: c.queriedAt, state: bounded(c.state, 40), semantics: 'OBSERVED_QUERY_RECEIPT; consumption UNKNOWN' };
    });
    const acceptedWork = data.acceptedWork.map(w => {
      if (!g.scope.projectIds.includes(w.projectId) || !idOk(w.revision) || !['open', 'active', 'done'].every(k => Number.isSafeInteger(w.counts?.[k as keyof typeof w.counts]) && w.counts[k as keyof typeof w.counts] >= 0)) throw new Error('Invalid accepted work summary.');
      return { projectId: w.projectId, revision: w.revision, counts: { open: w.counts.open, active: w.counts.active, done: w.counts.done } };
    });
    const assets = data.assets.map(a => {
      if (!idOk(a.id) || !idOk(a.sourceId) || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || !['FILE_OBSERVED', 'GENERATED_REPORTED', 'GENERATED_VERIFIED', 'SELECTED', 'PUBLISHED'].includes(a.state)) throw new Error('Invalid asset reference.');
      return { id: a.id, sha256: a.sha256, state: a.state, bytes: a.bytes, sourceId: a.sourceId, producer: a.producer === null ? null : bounded(a.producer, 80) };
    });
    const evidenceRefs=(data.evidenceRefs ?? []).map(ref=>{
      if(!idOk(ref.id) || !g.sessionKeys.includes(ref.sessionId) || [ref.taskId,ref.qaReceiptId].some(v=>v!==null && !idOk(v)) || [ref.presetHash,ref.configHash,ref.promptHash].some(v=>v!==null && !/^[a-f0-9]{64}$/.test(v)) || ref.sourceSha!==null && !/^[a-f0-9]{40}$/.test(ref.sourceSha))throw new Error('Invalid session evidence reference.');
      return {...ref};
    });
    if(evidenceRefs.length>200)throw new Error('Evidence bounds exceeded.');
    this.inputs.set(g.scope.policyHash, { contexts, acceptedWork, assets, evidenceRefs }); this.changed();
  }
  scopedInputs(g: LocalGrant): ScopedInputs { return structuredClone(this.policy.authorize({requestId:'read-inputs',scope:g.scope}) ? this.inputs.get(g.scope.policyHash) ?? { contexts: [], acceptedWork: [], assets: [] } : { contexts: [], acceptedWork: [], assets: [] }); }
  dispose(): void { this.changeSub.dispose(); for (const sub of this.subscribers) { sub.disposed = true; if (sub.timer) clearTimeout(sub.timer); } this.subscribers.clear(); this.approvals.clear(); this.configurations.clear(); }
}
