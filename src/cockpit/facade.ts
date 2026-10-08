import * as os from 'node:os';
import type { AgentSessionSnapshot } from '../model';
import { scanBacklog } from '../feeds/backlog';
import { bounded } from '../util/redact';
import type { AgentCockpitV1, Capability, ChangeEvent, ExportReceipt, Fact, HostIdentity, Reply, Request, Scope, SessionRef, Summary } from './interfaces';
import { digest, idOk, LocalGrant, repoId, ScopePolicy, validateRequest } from './policy';
import { ConfigRead, readConfiguration, safeLocalSource } from './configuration';
import { IncrementalExporter } from '../export/incremental';

export interface ContextReceipt { id: string; projectId: string; sourceIds: string[]; backend: string; generationId: string; queriedAt: string; state: string; }
export interface AcceptedWork { projectId: string; revision: string; counts: { open: number; active: number; done: number; }; }
export type AssetState = 'FILE_OBSERVED' | 'GENERATED_REPORTED' | 'GENERATED_VERIFIED' | 'SELECTED' | 'PUBLISHED';
export interface AssetRef { id: string; sha256: string; state: AssetState; producer: string | null; bytes: number; sourceId: string; }
export interface ScopedInputs { contexts: ContextReceipt[]; acceptedWork: AcceptedWork[]; assets: AssetRef[]; }
interface StoreRead { all(): AgentSessionSnapshot[]; onDidChange(fn: () => void): { dispose(): void }; lastStats?: { at: number }; opts: { historyDays: number }; }
interface HostServices {
  host?: HostIdentity;
  configuration?: typeof readConfiguration;
  installed?: () => { codex?: { version?: string; source: string }; claude?: { version?: string; source: string } };
  open(view: 'compact' | 'session' | 'settings' | 'catalog' | 'project', grant: LocalGrant, id: string): Promise<void> | void;
  openSource(file: string): Promise<void>;
}
export const localHost = (): HostIdentity => ({ hostId: 'host:' + digest(os.hostname()).slice(0, 16), os: process.platform, architecture: process.arch, runtimeVersion: process.version });
export function sessionRef(s: AgentSessionSnapshot, allowed: Set<string>): SessionRef {
  const fact = (value: string | undefined, reason?: string): Fact<string> => ({ value: value ? bounded(value, 80) : null, kind: value ? 'OBSERVED' : 'UNKNOWN', sourceIds: [s.key], ...(s.lastActivityAt ? { observedAt: new Date(s.lastActivityAt).toISOString() } : {}), ...(reason ? { reason } : {}) });
  return { id: s.key, provider: s.provider, ...(s.repository ?? s.cwd ? { repoId: repoId((s.repository ?? s.cwd)!) } : {}), ...(s.parentSessionId && allowed.has(s.parentSessionId) ? { parentId: s.parentSessionId } : {}), state: fact(s.status, s.statusReason), model: fact(s.model),
    ...{ effort: fact(s.effort), mode: fact(s.facts?.collaborationMode ?? s.facts?.permissionMode), providerVersion: fact(s.providerVersion), worktreeId: s.worktree ? repoId(s.worktree) : null } };
}
/** Pure aggregation over the existing store. Cumulative totals never masquerade as period samples. */
export function usageWindows(sessions: AgentSessionSnapshot[], now: number, historyDays: number): unknown[] {
  return [1, 7, 30].map(days => {
    const since = now - days * 86400000;
    const selected = [...new Map(sessions.filter(s => (s.lastActivityAt ?? 0) >= since).map(s => [s.key, s])).values()];
    const calls = selected.flatMap(s => (s.facts?.calls ?? []).filter(c => c[0] >= since));
    return { window: days === 1 ? '24h' : days + 'd', since: new Date(since).toISOString(), capturedAt: new Date(now).toISOString(), basis: 'recorded per-session model-call samples; bounded provider history', sessions: selected.length, sampledSessions: selected.filter(s => s.facts?.calls?.some(c => c[0] >= since)).length,
      repositories: new Set(selected.map(s => s.repository ?? s.cwd).filter(Boolean).map(r => repoId(r!))).size,
      inputTokens: calls.reduce((n, c) => n + c[1], 0), outputTokens: calls.reduce((n, c) => n + c[2], 0), calls: calls.length,
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
  private subscribers = new Set<{ request: Request; listener: (e: ChangeEvent) => void; pending: number; timer?: NodeJS.Timeout; disposed: boolean }>();
  private changeSub: { dispose(): void };
  private host: HostIdentity;
  constructor(private store: StoreRead, readonly policy: ScopePolicy, private services: HostServices, private exporter: IncrementalExporter) {
    this.host = services.host ?? localHost();
    // Only bounded read/approved-effect methods cross the extension API boundary.
    const api: typeof this.api = { major: 1, capabilities: () => this.capabilities(), getScopes: async () => this.reply(undefined, policy.scopes(), 'OK'), getSummary: r => this.summary(r), getProviderConfiguration: r => this.configuration(r), reveal: r => this.reveal(r), subscribe: (r, l) => this.subscribe(r, l), planExport: r => this.plan(r), executeApprovedLocalExport: r => this.execute(r), getExportReceipt: r => this.receipt(r) };
    this.api = Object.freeze(api);
    this.changeSub = store.onDidChange(() => this.changed());
  }
  private reply<T>(r: Request | undefined, data: T, state: Reply<T>['state'], omissions: string[] = []): Reply<T> {
    return structuredClone({ schema: 'datapass.agent-cockpit/1', requestId: r && idOk(r.requestId) ? r.requestId : 'capabilities', scopeHash: r && validateRequest(r) ? digest(r.scope) : '', capturedAt: new Date().toISOString(), host: this.host, state, data, omissions, errors: state === 'DENIED' ? [{ code: 'SCOPE_DENIED', message: 'Host-reviewed local scope is required.' }] : [] });
  }
  private async capabilities(): Promise<Reply<Capability[]>> {
    return this.reply(undefined, ['summary', 'providerConfiguration', 'reveal', 'subscribe', 'incrementalExport', 'registeredContextReceipts', 'acceptedWork', 'assets', 'getScopes'].map(name => ({ name, version: 1, state: 'OK' as const })), 'OK', ['Scopes require explicit local review; no caller-created grants.']);
  }
  private sessions(g: LocalGrant): AgentSessionSnapshot[] { return this.policy.sessions(g, this.store.all()); }
  private async summary(r: Request): Promise<Reply<Summary>> {
    if (validateRequest(r)) r = structuredClone(r);
    const empty: Summary = { sessions: [], backlogGroups: [], usage: [], contextReceipts: [], assetRefs: [] }, g = this.policy.authorize(r);
    if (!g) return this.reply(r, empty, 'DENIED');
    const all = this.sessions(g), keys = new Set(all.map(s => s.key)), start = Number(r.cursor ?? 0), limit = r.limit ?? 100;
    const plan = await scanBacklog({ roots: g.roots, now: Date.now() });
    if (!this.policy.authorize(r)) return this.reply(r, empty, 'DENIED');
    const inputs = this.inputs.get(g.scope.policyHash) ?? { contexts: [], assets: [], acceptedWork: [] };
    const result: Summary = { sessions: all.slice(start, start + limit).map(s => sessionRef(s, keys)), backlogGroups: [
      { kind: 'PM_ACCEPTED', state: inputs.acceptedWork.length ? 'OK' : 'UNAVAILABLE', items: inputs.acceptedWork },
      { kind: 'OBSERVED_REPO_PLAN', at: new Date(plan.at).toISOString(), basis: 'existing read-only plan scanner', repositories: plan.files.map(f => ({ repoId: repoId(f.root), source: f.rel, freshness: new Date(f.mtime).toISOString(), counts: { open: f.items.filter(i => i.state === 'open').length, active: f.items.filter(i => i.state === 'active').length, done: f.items.filter(i => i.state === 'done').length }, state: f.skipped ? 'PARTIAL' : 'OK' })) },
    ], usage: usageWindows(all, Date.now(), this.store.opts.historyDays), contextReceipts: inputs.contexts, assetRefs: inputs.assets };
    const stale = !this.store.lastStats || Date.now() - this.store.lastStats.at > 60000;
    const reply = this.reply(r, result, stale ? 'STALE' : 'PARTIAL', ['Bounded local observation; recent does not prove a process is alive.', 'Missing metrics, receipts and assets remain unknown.']);
    if (start + limit < all.length) reply.nextCursor = String(start + limit); return reply;
  }
  private async configuration(r: Request & { provider: 'codex' | 'claude' }): Promise<Reply<any>> {
    if (validateRequest(r)) r = structuredClone(r);
    const g = this.policy.authorize(r);
    if (!g?.configuration || !['codex', 'claude'].includes(r.provider)) return this.reply(r, null, 'DENIED');
    const all = this.sessions(g), keys = new Set(all.map(s => s.key));
    const c = await (this.services.configuration ?? readConfiguration)(g, r.provider, all.map(s => sessionRef(s, keys)));
    if (!this.policy.authorize(r)) return this.reply(r, null, 'DENIED');
    const installed = this.services.installed?.()[r.provider];
    if (installed?.version) c.config.cliVersion = { value: bounded(installed.version, 80), kind: 'OBSERVED', sourceIds: ['installed-version:' + r.provider], observedAt: new Date().toISOString(), reason: bounded(installed.source, 120) };
    this.configurations.set(g.scope.policyHash + ':' + r.provider, c);
    return this.reply(r, c.config, 'PARTIAL', ['Configured layers do not resolve CLI overrides or prove authenticated/working/used tools.']);
  }
  private async reveal(r: Request & { target: { kind: 'session' | 'settings' | 'catalog' | 'source' | 'project'; id: string } }): Promise<Reply<{ opened: boolean }>> {
    if (validateRequest(r)) r = structuredClone(r);
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
    const sub = { request: structuredClone(r), listener, pending: 0, disposed: false, timer: undefined as NodeJS.Timeout | undefined };
    this.subscribers.add(sub);
    return { dispose: () => { sub.disposed = true; if (sub.timer) clearTimeout(sub.timer); this.subscribers.delete(sub); } };
  }
  private changed(): void {
    this.sequence++;
    for (const sub of this.subscribers) {
      sub.pending = Math.min(sub.pending + 1, 33);
      if (sub.timer) continue;
      sub.timer = setTimeout(() => {
        sub.timer = undefined;
        if (sub.disposed || !this.policy.authorize(sub.request)) return;
        const event: ChangeEvent = { sequence: this.sequence, scopeHash: digest(sub.request.scope), kind: sub.pending > 32 ? 'RESYNC_REQUIRED' : 'CHANGE', capturedAt: new Date().toISOString() };
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
  private async plan(r: Request & { sourceIds: string[]; redactionProfileHash: string }): Promise<Reply<any>> {
    if (validateRequest(r)) r = structuredClone(r);
    const g = this.policy.authorize(r), destination = this.activeDestination;
    if (!g?.exportConsent) return this.reply(r, null, 'DENIED');
    if (!destination) return this.reply(r, null, 'UNAVAILABLE', ['Pick a local export destination in Agent first.']);
    try { return this.reply(r, await this.exporter.plan(g, this.sessions(g), r.sourceIds, r.redactionProfileHash, destination), 'OK'); }
    catch { return this.reply(r, null, 'ERROR', ['Export plan rejected; selected source or identity could not be validated.']); }
  }
  private async execute(r: Request & { approval: { approvedPlanHash: string; destinationId: string; scopePolicyHash: string } }): Promise<Reply<any>> {
    if (validateRequest(r)) r = structuredClone(r);
    const g = this.policy.authorize(r), a = r?.approval, approved = a && this.approvals.get(a.approvedPlanHash);
    if (!g || !a || !approved || approved.scopeHash !== g.scope.policyHash || a.scopePolicyHash !== g.scope.policyHash || this.destinations.get(a.destinationId) !== approved.destination) return this.reply(r, null, 'DENIED');
    try { return this.reply(r, await this.exporter.execute(g, a.approvedPlanHash, approved.destination), 'OK'); }
    catch { return this.reply(r, null, 'ERROR', ['Export failed before a new cursor commit; inspect selected native source or destination.']); }
  }
  private async receipt(r: Request & { id: string }): Promise<Reply<ExportReceipt>> {
    const empty: ExportReceipt = { id: '', manifestHash: '', state: 'UNAVAILABLE', committedCursorIds: [], artifactRefs: [] };
    const g = this.policy.authorize(r); if (!g || !idOk(r.id)) return this.reply(r, empty, 'DENIED');
    const receipt = this.exporter.getReceipt(g, r.id); return this.reply(r, receipt ?? empty, receipt ? 'OK' : 'UNAVAILABLE');
  }
  /** Host-reviewed receipt input; no ambient history lookup or inferred consumption semantics. */
  registerInputs(g: LocalGrant, data: ScopedInputs): void {
    if (!this.policy.authorize({ requestId: 'register', scope: g.scope })) throw new Error('Scope unavailable.');
    if (!Array.isArray(data.contexts) || !Array.isArray(data.acceptedWork) || !Array.isArray(data.assets) || [data.contexts, data.acceptedWork, data.assets].some(a => a.length > 200)) throw new Error('Receipt bounds exceeded.');
    const contexts = data.contexts.map(c => {
      if (!idOk(c.id) || !g.scope.projectIds.includes(c.projectId) || !idOk(c.backend) || !idOk(c.generationId) || !Number.isFinite(Date.parse(c.queriedAt)) || !Array.isArray(c.sourceIds) || c.sourceIds.length > 100 || !c.sourceIds.every(idOk)) throw new Error('Invalid context receipt.');
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
    this.inputs.set(g.scope.policyHash, { contexts, acceptedWork, assets }); this.changed();
  }
  scopedInputs(g: LocalGrant): ScopedInputs { return structuredClone(this.inputs.get(g.scope.policyHash) ?? { contexts: [], acceptedWork: [], assets: [] }); }
  dispose(): void { this.changeSub.dispose(); for (const sub of this.subscribers) { sub.disposed = true; if (sub.timer) clearTimeout(sub.timer); } this.subscribers.clear(); this.approvals.clear(); this.configurations.clear(); }
}
