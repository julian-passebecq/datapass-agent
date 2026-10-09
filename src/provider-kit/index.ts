import { collectConfiguration, safeLocalSource } from '../cockpit/configuration';
import type { ProviderConfig } from '../cockpit/interfaces';
import { defaultHomes } from '../feeds/settings';
import { canonicalJson, sha256 } from '../galaxy';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';

export const providerKitVersion = '1.0.2' as const;
export const providerKitSchema = 'datapass.provider-kit-capture/1' as const;
export { safeLocalSource, defaultHomes };
export type { ProviderConfig, Fact, SessionRef } from '../cockpit/interfaces';
export interface CaptureSelection {
  provider: 'codex' | 'claude';
  surface: 'CLI' | 'Desktop' | 'IDE' | 'API';
  nativeVersion: string | null;
  hostId: string;
  accountId: string | null;
  /** Exact reviewed local roots; selection does not grant native action permissions. */
  roots: string[];
  policyHash: string;
  homes: ReturnType<typeof defaultHomes>;
}
export interface ConfigurationCapture {
  schema: typeof providerKitSchema;
  kitVersion: typeof providerKitVersion;
  capturedAt: string;
  sourceHash: string;
  identity: Pick<CaptureSelection, 'provider' | 'surface' | 'nativeVersion' | 'hostId' | 'accountId'>;
  configuration: ProviderConfig;
  sourceRefs: { id: string; kind: 'LOCAL_FILE'; observedAt: string }[];
  omissions: string[];
}
/** Same collector used by Agent cockpitV1. No session/history discovery, process spawn, writes or network. */
export async function captureConfiguration(input: CaptureSelection): Promise<ConfigurationCapture> {
  if (!input || !['codex', 'claude'].includes(input.provider) || !['CLI', 'Desktop', 'IDE', 'API'].includes(input.surface) ||
    !/^[a-f0-9]{64}$/.test(input.policyHash) || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(input.hostId) ||
    !Array.isArray(input.roots) || input.roots.length > 60 || input.roots.some(r => !isPlausibleLocalPath(r) || hasLinkedAncestor(r)) ||
    !input.homes || ![input.homes.codexHome, input.homes.claudeHome, input.homes.managedFile].every(isPlausibleLocalPath) ||
    [input.nativeVersion, input.accountId].some(v => v !== null && (typeof v !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(v)))) throw new Error('Invalid reviewed capture selection.');
  const selection = structuredClone(input);
  const read = await collectConfiguration(selection, selection.provider, [], selection.homes);
  const capturedAt = new Date(read.at).toISOString();
  const identity = { provider: selection.provider, surface: selection.surface, nativeVersion: selection.nativeVersion, hostId: selection.hostId, accountId: selection.accountId };
  const sourceRefs = [...read.sources.keys()].map(id => ({ id, kind: 'LOCAL_FILE' as const, observedAt: capturedAt }));
  const configuration = read.config;
  // Capture time is deliberately excluded: equivalent safe observations have a stable content hash.
  const hashConfig = structuredClone(configuration);
  for (const fact of Object.values(hashConfig.effective)) delete fact.observedAt;
  return { schema: providerKitSchema, kitVersion: providerKitVersion, capturedAt,
    sourceHash: sha256(canonicalJson({ identity, configuration: hashConfig, sources: sourceRefs.map(s => s.id), policyHash: selection.policyHash })),
    identity, configuration, sourceRefs,
    omissions: ['Safe observed projection hash; not an exact-byte backup of native files.', 'CLI overrides, managed native resolution and session-effective state remain PARTIAL.',
      'No auth files, environment values, hook payloads, MCP args/URLs/headers or instruction content.', 'Installed/configured does not prove authentication or tool usability.',
      'No history reader, provider task launch, config apply or CLI execution.'] };
}
