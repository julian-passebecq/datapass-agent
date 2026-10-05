// Galaxy seams: pure projections of Agent's read model into the proposed Galaxy contracts
// (galaxy.agent-observation/1, galaxy.agent-config-snapshot/1). No I/O, no network, no Mongo, no clock:
// the caller passes `capturedAt`. Nothing here is wired to a command yet; see docs/GALAXY.md.
import { createHash } from 'crypto';
import { EvidenceKind } from '../model';

export const OBSERVATION_SCHEMA = 'galaxy.agent-observation/1' as const;
export const CONFIG_SNAPSHOT_SCHEMA = 'galaxy.agent-config-snapshot/1' as const;
export const GALAXY_SCHEMAS = [OBSERVATION_SCHEMA, CONFIG_SNAPSHOT_SCHEMA] as const;

/** A local path as Galaxy may see it: the folder name and a stable hash, never the absolute path. */
export interface PathRef {
  name: string;
  /** sha256 of the normalised path (lower case, forward slashes, no trailing slash), first 16 hex chars. */
  hash: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function pathRef(p: string | undefined): PathRef | undefined {
  if (!p) return undefined;
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const name = norm.split('/').filter(Boolean).pop() ?? '';
  return { name, hash: sha256(norm).slice(0, 16) };
}

export function iso(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Drops undefined fields (Galaxy documents never carry "undefined"; an absent field means not exposed). */
export function compactObj<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Minimal structural check of a projected document: right schema id, ISO capturedAt, kinds from the grammar. */
export function validateGalaxyDoc(doc: unknown): string[] {
  const errs: string[] = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  const d = doc as Record<string, unknown>;
  if (!GALAXY_SCHEMAS.includes(d.schema as never)) errs.push(`unknown schema ${String(d.schema)}`);
  if (typeof d.capturedAt !== 'string' || Number.isNaN(Date.parse(d.capturedAt))) errs.push('capturedAt is not an ISO date');
  const kinds: EvidenceKind[] = ['OBSERVED', 'DERIVED', 'INFERRED', 'UNKNOWN'];
  for (const [f, k] of Object.entries((d.kinds ?? {}) as Record<string, unknown>)) if (!kinds.includes(k as EvidenceKind)) errs.push(`kinds.${f} = ${String(k)}`);
  if (/[A-Za-z]:[\\/]|\\\\|\/(home|Users)\//.test(JSON.stringify(doc))) errs.push('contains an absolute path');
  return errs;
}
