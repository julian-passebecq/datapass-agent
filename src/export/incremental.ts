// Selected incremental shared packs extend the existing native reader/exporter.
// This curated projection intentionally excludes hidden reasoning and tool payloads.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { guardSource, hashPrefix, resolveDestination } from './providerHistory';
import { jsonLines, sanitize } from './conversations';
import { digest, LocalGrant } from '../cockpit/policy';
import type { ExportPlan, ExportReceipt } from '../cockpit/interfaces';
import type { AgentSessionSnapshot } from '../model';
import type { ProviderAdapter } from '../providers/types';

interface Cursor { id: string; sourceId: string; identity: string; bytes: number; prefixHash: string; }
interface Capture extends Cursor { file: string; root: string; kind: 'new' | 'appended' | 'rewritten' | 'unchanged'; }
interface Plan extends ExportPlan { scopeHash: string; destination: string; sources: Capture[]; }
interface Manifest { schema: 'datapass.incremental-history/1'; planHash: string; committedAt: string; scopeHash: string; cursors: Cursor[]; artifacts: { file: string; hash: string; records: number; }[]; projection: 'selected-full-session-resnapshot'; }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
async function plainDirectory(directory: string): Promise<void> {
  for (let p = directory; p !== path.dirname(p); p = path.dirname(p)) {
    try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Linked export directory refused.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
/** Whitelist shared dialogue; unknown native formats remain omitted rather than exporting raw payloads. */
export function sharedDialogue(value: unknown): unknown | undefined {
  const e = obj(value), p = obj(e.payload), m = obj(e.message ?? (e.type === 'response_item' ? e.payload : undefined));
  const role = m.role ?? (e.type === 'user' || e.type === 'assistant' ? e.type : p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'assistant' : undefined);
  if (role !== 'user' && role !== 'assistant') return undefined;
  const content = m.content ?? p.message;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => ['text', 'input_text', 'output_text'].includes(obj(x).type as string)).map(x => obj(x).text).filter(x => typeof x === 'string').join('\n') : '';
  if (!text || m.type === 'reasoning' || e.type === 'thinking' || p.type === 'reasoning') return undefined;
  return sanitize({ type: 'dialogue', role, text, ...(typeof e.timestamp === 'string' ? { timestamp: e.timestamp } : {}) });
}
async function stableBytes(file: string, size: number): Promise<number> {
  // Seek backwards, bounded to the existing JSONL maximum record size.
  const h = await fs.open(file, 'r');
  try {
    for (let end = size; end > Math.max(0, size - 32 * 1024 * 1024);) {
      const start = Math.max(0, end - 64 * 1024), b = Buffer.alloc(end - start);
      const read = await h.read(b, 0, b.length, start);
      if (read.bytesRead !== b.length) throw new Error('Source truncated during capture.');
      const i = b.lastIndexOf(10); if (i >= 0) return start + i + 1; end = start;
    }
    if (size > 32 * 1024 * 1024) throw new Error('Partial record exceeds reader bound.');
    return 0;
  } finally { await h.close(); }
}
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Export cancelled before commit.'); };

export class IncrementalExporter {
  private plans = new Map<string, Plan>();
  private receipts = new Map<string, { scopeHash: string; receipt: ExportReceipt }>();
  constructor(private adapters: ProviderAdapter[]) {}
  private async manifests(destination: string): Promise<Manifest[]> {
    const dir = path.join(destination, 'commits');
    await plainDirectory(dir);
    const names = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    if (names.length > 10000) throw new Error('Commit recovery bound exceeded.');
    const out: Manifest[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      if ((await fs.lstat(path.join(dir, name))).isSymbolicLink() || (await fs.stat(path.join(dir, name))).size > 1024 * 1024) throw new Error('Unsafe manifest.');
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      if (digest(JSON.parse(text)) + '.json' !== name) throw new Error('Manifest hash validation failed.');
      const m = JSON.parse(text) as Manifest;
      if (m.schema !== 'datapass.incremental-history/1') throw new Error('Manifest schema mismatch.');
      if (!Array.isArray(m.cursors) || m.cursors.length > 500 || !m.cursors.every(c => /^[a-f0-9]{64}$/.test(c.id) && Number.isSafeInteger(c.bytes) && c.bytes >= 0 && /^[a-f0-9]{64}$/.test(c.prefixHash)) || !Array.isArray(m.artifacts) || m.artifacts.length > 500 || !m.artifacts.every(a => /^objects\/[a-f0-9]{64}\.jsonl$/.test(a.file) && a.file === 'objects/' + a.hash + '.jsonl')) throw new Error('Invalid manifest contents.');
      out.push(m);
    }
    return out.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  }
  async plan(grant: LocalGrant, sessions: AgentSessionSnapshot[], sourceIds: string[], redactionHash: string, destination: string): Promise<ExportPlan> {
    if (!grant.exportConsent || !/^[a-f0-9]{64}$/.test(redactionHash) || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 500 || new Set(sourceIds).size !== sourceIds.length) throw new Error('Selected source consent is required.');
    const selected = sourceIds.map(id => sessions.find(s => s.key === id && grant.sessionKeys.includes(s.key)));
    if (selected.some(s => !s)) throw new Error('Source is outside approved scope.');
    await plainDirectory(path.resolve(destination));
    const out = await resolveDestination(path.resolve(destination));
    const roots = await Promise.all(this.adapters.map(a => fs.realpath(a.root)));
    if (roots.some(root => { const r = path.relative(root, out); return r === '' || !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); })) throw new Error('Destination is inside provider storage.');
    const previous = new Map<string, Cursor>();
    for (const m of await this.manifests(out)) for (const c of m.cursors) previous.set(c.id, c);
    const captures: Capture[] = [];
    for (const s of selected as AgentSessionSnapshot[]) {
      const a = this.adapters.find(a => a.provider === s.provider); if (!a) throw new Error('Provider reader unavailable.');
      const root = await fs.realpath(a.root), file = path.resolve(s.artifactPath);
      await guardSource(root, file);
      const st = await fs.stat(file); if (st.size > 256 * 1024 * 1024) throw new Error('Selected source exceeds capture bound.');
      const observed = a.ingest({ path: file, size: st.size, mtimeMs: st.mtimeMs });
      if (!observed || observed.key !== s.key) throw new Error('Native identity mismatch; mapping requires review.');
      const bytes = await stableBytes(file, st.size), prefixHash = await hashPrefix(file, bytes);
      // The adapter may retain its original accumulator identity across a same-size rewrite.
      // Validate the native declaration independently, using the existing bounded JSONL reader.
      for await (const row of jsonLines(file, bytes)) {
        const event = obj(row.value), payload = obj(event.payload);
        const native = s.provider === 'codex' && event.type === 'session_meta' ? payload.id : s.provider === 'claude' ? event.sessionId : undefined;
        if (typeof native === 'string') {
          if (s.sessionId !== native && !(s.provider === 'claude' && s.sessionId.startsWith(native + '/agent-'))) throw new Error('Native identity mismatch; mapping requires review.');
          break;
        }
        if (row.line >= 128) throw new Error('Native identity declaration unavailable within reader bound.');
      }
      const id = digest({ organizations: grant.scope.organizationIds, privacy: grant.scope.privacyDomainIds, sourceId: s.key, locator: digest(file), schema: 'datapass.incremental-history/1', redactionHash, policy: grant.scope.policyHash });
      const old = previous.get(id);
      let kind: Capture['kind'] = 'new';
      if (old) kind = bytes === old.bytes && prefixHash === old.prefixHash ? 'unchanged' : bytes >= old.bytes && await hashPrefix(file, old.bytes) === old.prefixHash ? 'appended' : 'rewritten';
      captures.push({ id, sourceId: s.key, identity: s.key, bytes, prefixHash, file, root, kind });
    }
    const base = { exporterVersion: 'incremental/1', scopeHash: grant.scope.policyHash, destination: out, sources: captures };
    const hash = digest(base), plan: Plan = { ...base, id: 'plan:' + hash, hash, newCount: captures.filter(c => c.kind === 'new').length, appendedCount: captures.filter(c => c.kind === 'appended').length, rewrittenCount: captures.filter(c => c.kind === 'rewritten').length, unchangedCount: captures.filter(c => c.kind === 'unchanged').length, omittedCount: 0 };
    if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(hash, plan); return this.publicPlan(plan);
  }
  private publicPlan(p: Plan): ExportPlan { const { sources: _sources, scopeHash: _scopeHash, destination: _destination, ...publicPlan } = p; return publicPlan; }
  async execute(grant: LocalGrant, planHash: string, destination: string, signal?: AbortSignal): Promise<ExportReceipt> {
    const p = this.plans.get(planHash);
    if (!p || !grant.exportConsent || p.scopeHash !== grant.scope.policyHash) throw new Error('Approved plan is absent or scope changed.');
    await plainDirectory(path.resolve(destination));
    const out = await resolveDestination(path.resolve(destination));
    if (out !== p.destination) throw new Error('Destination differs from reviewed plan.');
    await fs.mkdir(out, { recursive: true });
    const lock = path.join(out, '.export-lock'); await fs.mkdir(lock).catch(() => { throw new Error('Another export owns the destination; do not steal its lock.'); });
    const stage = path.join(out, '.stage-' + randomUUID());
    try {
      checkAbort(signal);
      const manifests = await this.manifests(out), committed = manifests.find(m => m.planHash === p.hash);
      if (committed) {
        for (const a of committed.artifacts) {
          await plainDirectory(path.join(out, a.file)); const st = await fs.stat(path.join(out, a.file));
          if (await hashPrefix(path.join(out, a.file), st.size) !== a.hash) throw new Error('Committed object hash mismatch.');
        }
        return this.receipt(committed);
      }
      const latest = new Map<string, Cursor>(); for (const m of manifests) for (const c of m.cursors) latest.set(c.id, c);
      for (const c of p.sources) if ((latest.get(c.id)?.bytes ?? 0) > c.bytes) throw new Error('A newer export committed; preview again.');
      await plainDirectory(path.join(out, 'objects'));
      await fs.mkdir(stage); await fs.mkdir(path.join(out, 'objects'), { recursive: true }); await fs.mkdir(path.join(out, 'commits'), { recursive: true });
      const artifacts: Manifest['artifacts'] = [];
      for (const c of p.sources.filter(c => c.kind !== 'unchanged')) {
        checkAbort(signal); await guardSource(c.root, c.file);
        if (await hashPrefix(c.file, c.bytes) !== c.prefixHash) throw new Error('Source changed after preview.');
        const records: string[] = []; let bytes = 0;
        for await (const row of jsonLines(c.file, c.bytes)) {
          checkAbort(signal); if (row.invalid) throw new Error('Malformed stable record; cursor unchanged.');
          const event = sharedDialogue(row.value); if (!event) continue;
          const line = JSON.stringify({ sourceId: c.sourceId, nativeLine: row.line, event }) + '\n';
          bytes += Buffer.byteLength(line); if (bytes > 64 * 1024 * 1024) throw new Error('Shared pack bound exceeded.'); records.push(line);
        }
        await guardSource(c.root, c.file);
        if (await hashPrefix(c.file, c.bytes) !== c.prefixHash) throw new Error('Source rewritten during capture.');
        const text = records.join(''), hash = textHash(text), file = 'objects/' + hash + '.jsonl';
        const staged = path.join(stage, hash + '.jsonl'); await fs.writeFile(staged, text, { flag: 'wx', mode: 0o600 });
        if (textHash(await fs.readFile(staged, 'utf8')) !== hash) throw new Error('Stage validation failed.');
        const target = path.join(out, file);
        try { await fs.link(staged, target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || (await fs.lstat(target)).isSymbolicLink() || textHash(await fs.readFile(target, 'utf8')) !== hash) throw e; }
        artifacts.push({ file, hash, records: records.length });
      }
      checkAbort(signal);
      const manifest: Manifest = { schema: 'datapass.incremental-history/1', planHash: p.hash, committedAt: new Date().toISOString(), scopeHash: p.scopeHash, cursors: p.sources.map(({ id, sourceId, identity, bytes, prefixHash }) => ({ id, sourceId, identity, bytes, prefixHash })), artifacts, projection: 'selected-full-session-resnapshot' };
      const hash = digest(manifest), temp = path.join(stage, hash + '.json');
      await fs.writeFile(temp, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      // The immutable manifest is the cursor commit. Recovery derives cursors only from committed manifests.
      checkAbort(signal); await fs.rename(temp, path.join(out, 'commits', hash + '.json'));
      return this.receipt(manifest);
    } finally { await fs.rm(stage, { recursive: true, force: true }); await fs.rmdir(lock); }
  }
  private receipt(m: Manifest): ExportReceipt {
    const hash = digest(m), receipt: ExportReceipt = { id: 'receipt:' + hash, manifestHash: hash, state: 'OK', committedCursorIds: m.cursors.map(c => c.id), artifactRefs: ['commits/' + hash + '.json', ...m.artifacts.map(a => a.file)] };
    this.receipts.set(receipt.id, { scopeHash: m.scopeHash, receipt }); return structuredClone(receipt);
  }
  getReceipt(grant: LocalGrant, id: string): ExportReceipt | undefined { const r = this.receipts.get(id); return r?.scopeHash === grant.scope.policyHash ? structuredClone(r.receipt) : undefined; }
}
