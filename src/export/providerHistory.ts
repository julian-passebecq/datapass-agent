import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ClaudeAdapter, claudeRoot, claudeArtifactIdentity } from '../providers/claude/claude';
import { CodexAdapter, codexRoot } from '../providers/codex/codex';
import { isCredentialPath } from '../util/redact';
import { jsonLines, sanitize } from './conversations';

export const HISTORY_SCHEMA = 'datapass.provider-history/1' as const;
export type HistoryProvider = 'codex' | 'claude';
export interface HistoryOptions {
  provider: HistoryProvider; out: string; codexHome?: string; claudeHome?: string;
}
export interface HistorySource {
  path: string; bytes: number; modifiedAt: string; sha256: string;
  prefixSha256After: string; prefixUnchanged: boolean; changedDuringExport: boolean;
  bytesAfter: number;
  metadata?: unknown;
}
export interface HistoryRecord {
  provider: HistoryProvider; sessionId: string; key: string; parentKey: string | null;
  kind: 'session-transcript' | 'worker-transcript' | 'workflow-journal'; workflowId?: string;
  worker: boolean; cwd: string | null; project: string | null; repository: null;
  startedAt: number | null; lastActivityAt: number | null; file: string;
  eventCount: number; eventSha256: string; recordTypes: Record<string, number>;
  source: HistorySource; companions: HistorySource[]; projection: unknown;
}
export interface HistoryBundle {
  schema: typeof HISTORY_SCHEMA; exportedAt: string; provider: HistoryProvider;
  records: HistoryRecord[]; artifactCount: number; sessionCount: number; eventCount: number;
  policy: { readOnly: true; redacted: true; autoPublish: false; attachments: 'excluded'; encryptedPayloads: 'excluded'; environmentSnapshots: 'excluded';
    completeness: 'all-discovered-artifacts-at-captured-byte-boundaries';
    projection: 'bounded-Agent-observer; native JSONL is authoritative' };
  warnings: string[];
}
const safeString = (value: string) => String(sanitize(value));
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

/** Resolve a not-yet-created destination through its nearest existing ancestor. */
async function resolveDestination(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const parent = path.dirname(file);
    if (parent === file) throw e;
    return path.join(await resolveDestination(parent), path.basename(file));
  }
}

/** No links, credentials or paths outside the provider root, including linked ancestors. */
async function guardSource(root: string, file: string): Promise<void> {
  if (!within(root, file) || isCredentialPath(file)) throw new Error('Unsafe provider artifact.');
  for (let current = file; current !== root; current = path.dirname(current)) {
    if (isCredentialPath(current)) throw new Error('Credential artifacts are not exported.');
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked provider artifacts are not exported.');
  }
  if (!within(root, await fs.realpath(file)) || !(await fs.lstat(file)).isFile()) throw new Error('Unsafe provider artifact.');
}

export async function hashPrefix(file: string, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  let read = 0;
  if (bytes) for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1 })) {
    read += chunk.length; hash.update(chunk);
  }
  if (read !== bytes) throw new Error('Source truncated during export.');
  return hash.digest('hex');
}

async function capture(root: string, file: string): Promise<HistorySource> {
  await guardSource(root, file);
  const st = await fs.stat(file);
  const sha256 = await hashPrefix(file, st.size);
  return { path: safeString(file), bytes: st.size, modifiedAt: st.mtime.toISOString(), sha256,
    prefixSha256After: '', prefixUnchanged: false, changedDuringExport: false, bytesAfter: st.size };
}
async function verify(root: string, file: string, source: HistorySource): Promise<void> {
  await guardSource(root, file);
  const st = await fs.stat(file);
  source.prefixSha256After = await hashPrefix(file, source.bytes);
  source.prefixUnchanged = source.sha256 === source.prefixSha256After;
  source.bytesAfter = st.size;
  source.changedDuringExport = st.size !== source.bytes || st.mtime.toISOString() !== source.modifiedAt;
  if (!source.prefixUnchanged) throw new Error('Captured source bytes changed. Export must be retried.');
}

/** Native artifact discovery + observer interpretation belong to the existing Agent adapters.
 * Full records use the same JSONL reader/sanitizer as selected export. No SQLite, network, Git or provider CLI. */
export async function exportProviderHistory(options: HistoryOptions): Promise<HistoryBundle> {
  if (options.provider !== 'codex' && options.provider !== 'claude') throw new Error('Unsupported provider.');
  const roots = await Promise.all([options.codexHome ?? codexRoot(), options.claudeHome ?? claudeRoot()]
    .map(async root => resolveDestination(path.resolve(root))));
  const out = await resolveDestination(path.resolve(options.out));
  if (roots.some(root => within(root, out))) throw new Error('Output must be outside both provider roots.');
  const root = roots[options.provider === 'codex' ? 0 : 1];
  const adapter = options.provider === 'codex' ? new CodexAdapter(root) : new ClaudeAdapter(root);
  const artifacts = adapter instanceof ClaudeAdapter ? adapter.listArtifacts(0, Number.MAX_SAFE_INTEGER, true)
    : adapter.listArtifacts(0, Number.MAX_SAFE_INTEGER);
  if (!artifacts.length) throw new Error('No native provider history discovered.');
  const optionalArchiveAbsent = options.provider === 'codex' &&
    !(await fs.stat(path.join(root, 'archived_sessions')).catch(e => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }));
  if (adapter.dirCache.stats.missing > (optionalArchiveAbsent ? 1 : 0)) throw new Error('Provider discovery was incomplete or unreadable.');
  for (const ref of artifacts) {
    await guardSource(root, ref.path);
    if (options.provider === 'claude' && claudeArtifactIdentity(ref.path)?.worker) {
      const companion = ref.path.replace(/\.jsonl$/, '.meta.json');
      try { await guardSource(root, companion); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  await fs.mkdir(out, { recursive: true });
  if ((await fs.readdir(out)).length) throw new Error('Output must be an empty directory; bundles are never overwritten.');
  const bundle: HistoryBundle = { schema: HISTORY_SCHEMA, exportedAt: new Date().toISOString(), provider: options.provider,
    records: [], artifactCount: 0, sessionCount: 0, eventCount: 0,
    policy: { readOnly: true, redacted: true, autoPublish: false, attachments: 'excluded', encryptedPayloads: 'excluded', environmentSnapshots: 'excluded',
      completeness: 'all-discovered-artifacts-at-captured-byte-boundaries',
      projection: 'bounded-Agent-observer; native JSONL is authoritative' },
    warnings: ['Pattern redaction is not a guarantee against arbitrary unlabeled secrets or personal data. Review before any archive push.',
      'Each JSONL retains native provider semantics, including record types the bounded observer does not interpret.',
      'New files and bytes appended after discovery/capture require another export. No provider process is paused.'] };
  try {
    for (const ref of artifacts) {
      const companions: HistorySource[] = [];
      const companionFiles: string[] = [];
      const identity = options.provider === 'claude' ? claudeArtifactIdentity(ref.path) : undefined;
      if (identity?.worker) {
        const file = ref.path.replace(/\.jsonl$/, '.meta.json');
        try {
          const companion = await capture(root, file);
          if (companion.bytes > 64 * 1024) throw new Error('Worker metadata exceeds the Agent reader limit.');
          companion.metadata = sanitize(JSON.parse(await fs.readFile(file, 'utf8')));
          companions.push(companion); companionFiles.push(file);
        }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      const acc = adapter.ingest(ref);
      if (!acc || acc.diagnostics.some(d => /read failed|unreadable/.test(d))) throw new Error('Agent could not read provider metadata.');
      const projection = acc.toSnapshot();
      const source = await capture(root, ref.path);
      const slug = createHash('sha256').update(options.provider + ':' + path.relative(root, ref.path)).digest('hex');
      const file = `events/${slug}.jsonl`;
      await fs.mkdir(path.join(out, 'events'), { recursive: true });
      const handle = await fs.open(path.join(out, file), 'wx', 0o600);
      const eventHash = createHash('sha256');
      let pending = '', pendingBytes = 0;
      const record: HistoryRecord = { provider: options.provider, sessionId: safeString(acc.sessionId), key: safeString(acc.key),
        kind: identity && !identity.worker ? 'workflow-journal' : acc.isWorker ? 'worker-transcript' : 'session-transcript',
        ...(identity?.workflowId ? { workflowId: safeString(identity.workflowId) } : {}),
        parentKey: acc.parentSessionId ? safeString(acc.parentSessionId) : null, worker: acc.isWorker,
        cwd: acc.cwd ? safeString(acc.cwd) : null, project: acc.cwd ? safeString(acc.cwd) : null, repository: null,
        startedAt: acc.startedAt ?? null, lastActivityAt: acc.lastActivityAt ?? null,
        file, eventCount: 0, eventSha256: '', recordTypes: Object.create(null) as Record<string, number>,
        source, companions, projection: sanitize(projection) };
      try {
        for await (const row of jsonLines(ref.path, source.bytes)) {
          // A malformed/oversize source is not silently qualified as a complete archive.
          if (row.invalid) throw new Error(`Source ${row.reason} record; export must be retried or repaired by its owner.`);
          const event = sanitize(row.value);
          const type = event && typeof event === 'object' && 'type' in event && typeof event.type === 'string'
            ? event.type : '(untyped JSON)';
          record.recordTypes[type] = (record.recordTypes[type] ?? 0) + 1;
          const serialized = JSON.stringify({ schema: 'datapass.conversation-event/1',
            id: `${slug}:${row.line}`, source: { provider: record.provider, sessionId: record.sessionId,
              key: record.key, artifact: source.path, sha256: source.sha256, line: row.line }, event }) + '\n';
          eventHash.update(serialized); pending += serialized; pendingBytes += Buffer.byteLength(serialized);
          if (pendingBytes >= 1024 * 1024) { await handle.writeFile(pending); pending = ''; pendingBytes = 0; }
          record.eventCount++;
        }
        if (pending) await handle.writeFile(pending);
      } finally { await handle.close(); }
      record.eventSha256 = eventHash.digest('hex');
      await verify(root, ref.path, source);
      for (const [i, file] of companionFiles.entries()) await verify(root, file, companions[i]);
      if (source.changedDuringExport) bundle.warnings.push(`Source ${slug} changed externally; captured ${source.bytes}-byte prefix verified unchanged.`);
      bundle.records.push(record); bundle.artifactCount++;
      if (record.kind !== 'workflow-journal') bundle.sessionCount++;
      bundle.eventCount += record.eventCount;
    }
    // Written last: a failed or partial run cannot be mistaken for a consumable bundle.
    await fs.writeFile(path.join(out, 'cockpit.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return bundle;
  } catch (error) {
    await fs.writeFile(path.join(out, 'INCOMPLETE.txt'), 'Export failed. No cockpit.json was published. Do not archive this directory.\n', { flag: 'wx', mode: 0o600 });
    throw error;
  }
}
