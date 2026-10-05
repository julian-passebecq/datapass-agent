import { Provider, ProviderState } from '../model';
import { SessionAccumulator } from '../sessions/accumulator';

export interface ArtifactRef {
  path: string;
  mtimeMs: number;
  size: number;
}

/** A provider adapter reads provider-owned artifacts. It never writes them and never controls the provider. */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly root: string;
  detect(): ProviderState;
  /** Session artifacts modified since `sinceMs`, newest first, bounded. */
  listArtifacts(sinceMs: number, max: number): ArtifactRef[];
  /** Incremental ingest of one artifact; returns the accumulator (created on first call). */
  ingest(ref: ArtifactRef): SessionAccumulator | undefined;
  /** Refresh live signals (registry, archive state) for all known accumulators. */
  refreshLive(accs: Iterable<SessionAccumulator>, now: number): void;
  /** Directories to watch for changes. */
  watchTargets(): string[];
}
