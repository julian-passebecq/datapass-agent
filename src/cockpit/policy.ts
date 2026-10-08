import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Request, Scope } from './interfaces';
import type { AgentSessionSnapshot } from '../model';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const repoId = (root: string): string => { const p = path.resolve(root).replace(/\\/g, '/'); return 'repo:' + digest(process.platform === 'win32' ? p.toLowerCase() : p).slice(0, 24); };
export const idOk = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(v);
export interface LocalGrant {
  scope: Scope;
  sessionKeys: string[];
  roots: string[];
  configuration: boolean;
  exportConsent: boolean;
}
export function makeGrant(input: { id: string; organization: string; project: string; privacy: string; sessions: AgentSessionSnapshot[]; configuration: boolean; exportConsent: boolean }): LocalGrant {
  if (![input.id, input.organization, input.project, input.privacy].every(idOk) || !input.sessions.length) throw new Error('Select a bounded local scope.');
  const roots = [...new Set(input.sessions.map(s => s.repository ?? s.cwd).filter((x): x is string => !!x))].sort();
  const sessionKeys = [...new Set(input.sessions.map(s => s.key))].sort();
  const scope: Scope = { scopeId: input.id, organizationIds: [input.organization], privacyDomainIds: [input.privacy], projectIds: [input.project], repoIds: roots.map(repoId), sourceVectorHash: digest(sessionKeys), policyHash: '' };
  scope.policyHash = digest({ scope, sessionKeys, roots, configuration: input.configuration, exportConsent: input.exportConsent });
  return { scope, sessionKeys, roots, configuration: input.configuration, exportConsent: input.exportConsent };
}
export function validateRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const r = value as Request, s = r.scope;
  return idOk(r.requestId) && !!s && idOk(s.scopeId) &&
    ['organizationIds', 'privacyDomainIds', 'projectIds', 'repoIds'].every(k => {
      const a = s[k as keyof Scope]; return Array.isArray(a) && a.length <= 100 && a.every(idOk);
    }) && typeof s.policyHash === 'string' && typeof s.sourceVectorHash === 'string' && /^[a-f0-9]{64}$/.test(s.policyHash) && /^[a-f0-9]{64}$/.test(s.sourceVectorHash) &&
    (r.limit === undefined || Number.isInteger(r.limit) && r.limit > 0 && r.limit <= 500) &&
    (r.cursor === undefined || /^[0-9]{1,6}$/.test(r.cursor));
}
/** Only host-owned grants authorize; request fields never create grants. */
export class ScopePolicy {
  private grants = new Map<string, LocalGrant>();
  set(grant: LocalGrant): void { this.grants.set(grant.scope.scopeId, structuredClone(grant)); }
  clear(): void { this.grants.clear(); }
  scopes(): Scope[] { return [...this.grants.values()].map(g => structuredClone(g.scope)); }
  authorize(request: Request): LocalGrant | undefined {
    if (!validateRequest(request)) return undefined;
    const g = this.grants.get(request.scope.scopeId);
    // Compare semantic fields, independently of caller object property order.
    const same = g && (Object.keys(g.scope) as (keyof Scope)[]).every(k => JSON.stringify(g.scope[k]) === JSON.stringify(request.scope[k]));
    return same ? structuredClone(g) : undefined;
  }
  sessions(g: LocalGrant, sessions: AgentSessionSnapshot[]): AgentSessionSnapshot[] {
    const keys = new Set(g.sessionKeys); return sessions.filter(s => keys.has(s.key));
  }
}
