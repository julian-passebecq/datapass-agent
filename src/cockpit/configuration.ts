import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { collectSettings, defaultHomes, isForbidden, layersFor, effective } from '../feeds/settings';
import { collectCatalog, CatalogInput } from '../feeds/catalog';
import { toConfigSnapshot } from '../galaxy/configSnapshot';
import { isCredentialPath, bounded } from '../util/redact';
import type { LocalGrant } from './policy';
import { digest } from './policy';
import type { ProviderConfig, SessionRef, Fact } from './interfaces';

export interface ConfigRead { config: ProviderConfig; sources: Map<string, string>; at: number; }
/** Reject linked ancestors before either collection or reveal; source files are inert. */
export async function safeLocalSource(file: string): Promise<boolean> {
  if (isForbidden(file) || isCredentialPath(file) || !path.isAbsolute(file)) return false;
  try {
    for (let p = file; p !== path.dirname(p); p = path.dirname(p)) if ((await fs.lstat(p)).isSymbolicLink()) return false;
    return (await fs.stat(file)).isFile();
  } catch { return false; }
}
export async function readConfiguration(grant: LocalGrant, provider: 'codex' | 'claude', sessions: SessionRef[], homes = defaultHomes()): Promise<ConfigRead> {
  const at = Date.now();
  const settings = collectSettings({ ...homes, roots: grant.roots, now: at });
  const catalog = await collectCatalog({ ...homes, roots: grant.roots, now: at } as CatalogInput);
  const snapshot = toConfigSnapshot({ settings, catalog, capturedAt: at });
  const sources = new Map<string, string>();
  for (const file of [...settings.files, ...catalog.files].slice(0, 500)) {
    if (await safeLocalSource(file)) sources.set('source:' + digest([grant.scope.policyHash, file]).slice(0, 32), file);
  }
  const fact = (value?: string, sourceIds: string[] = [], kind: Fact<string>['kind'] = 'DERIVED'): Fact<string> => ({ value: value ? bounded(value, 80) : null, kind: value ? kind : 'UNKNOWN', sourceIds, observedAt: new Date(at).toISOString() });
  const sourceFor = (file: string) => [...sources].filter(([, f]) => f === file).map(([id]) => id);
  const configured: Record<string, Fact<string>> = {};
  let layers: unknown[];
  if (provider === 'claude') {
    layers = snapshot.claude?.layers ?? [];
    // Multi-root effective configuration is not a single runtime value.
    for (const key of ['model', 'effortLevel', 'defaultMode'] as const) {
      const e = effective(layersFor(settings, grant.roots.length === 1 ? grant.roots[0] : undefined), key);
      configured[key] = { ...fact(e.value, e.file ? sourceFor(e.file) : []), reason: 'Configured precedence only; CLI overrides and active runtime may differ.' };
    }
  } else {
    layers = snapshot.codex ?? [];
    const configs = settings.codex.filter(c => c.exists && !c.error);
    for (const key of ['model', 'effort', 'approval', 'sandbox', 'serviceTier', 'profile'] as const) {
      const c = [...configs].reverse().find(c => c[key] !== undefined);
      configured[key] = { ...fact(c?.[key], c ? sourceFor(c.file) : []), reason: 'Configured value; profile selection, CLI overrides and runtime resolution are incomplete.' };
    }
  }
  const inventory: unknown[] = [
    ...(snapshot.catalog?.items ?? []).filter(i => i.provider === provider).map(i => ({ ...i, installed: i.active, probed: 'UNKNOWN', used: 'UNKNOWN' })),
    ...(snapshot.catalog?.plugins ?? []).filter(i => i.provider === provider).map(i => ({ ...i, kind: 'plugin', probed: 'UNKNOWN', used: 'UNKNOWN' })),
    ...(snapshot.catalog?.mcp ?? []).filter(i => i.provider === provider).map(i => ({ ...i, kind: 'mcp', enabled: 'UNKNOWN', probed: 'UNKNOWN', used: 'UNKNOWN' })),
    ...catalog.instructions.filter(i => i.provider === provider).map(i => ({ kind: 'instruction', source: i.source, bytes: i.bytes, sourceId: sourceFor(i.file)[0], execution: 'INERT' })),
  ].slice(0, 500);
  const observed = sessions.filter(s => s.provider === provider);
  return { at, sources, config: { provider, cliVersion: { value: null, kind: 'UNKNOWN', sourceIds: [], reason: 'No CLI execution during inventory; session-recorded versions are separate.' }, layers, effective: configured, resolution: 'PARTIAL', inventory, observedSessions: observed, sourceOpenIds: [...sources.keys()] } };
}
