import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { redact, isSecretKeyName, isCredentialPath } from '../util/redact';

export type ExportProvider = 'codex' | 'claude' | 'chatgpt' | 'mongo' | 'csv';
export interface ConversationSource {
  provider: ExportProvider; file: string; id: string; project?: string;
  observation?:unknown;
}
export interface ExportSession {
  provider: ExportProvider; id: string; project?: string; title: string;
  file: string; records: number; malformed: number; omitted: number; changedDuringExport: boolean;
  sourceBytes: number; sourceModifiedAt: string; contentHash: string;
  excerpts: Array<{ id: string; role: string; timestamp?: string; text: string }>;
}
export interface CockpitBundle {
  schema: 'datapass.cockpit/1'; exportedAt: string; sessions: ExportSession[];
  policy: { authority: 'historical-observations'; redacted: true; attachments: 'excluded'; autoPublish: false };
  warnings: string[];
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const nativeId = (value: unknown): string | undefined => {
  const text = string(value);
  return text && /^[a-zA-Z0-9._:-]{1,160}(?:\/[a-zA-Z0-9._:-]{1,160}){0,3}$/.test(text) ? text : undefined;
};

/** Complete connection strings and embedded binary data must never enter a shareable bundle. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[REDACTED: depth limit]';
  if (typeof value === 'string') return redact(value)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[REDACTED:MONGO_URI]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]')
    .replace(/data:[^;,\s]+;base64,[a-zA-Z0-9+/=\r\n]+/g, '[EXCLUDED: binary attachment]');
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const node = object(value);
    if (node.type === 'base64') return { type: 'base64', data: '[EXCLUDED: attachment]' };
    return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => {
      const recordedId = /^(sessionId|session_id|parentSessionId|parent_session_id)$/.test(key) && nativeId(item);
      const count = typeof item === 'number' && /tokens|_count$/i.test(key);
      const binary = /^(image|image_url|audio|audio_url|base64|image_data)$/.test(key);
      const environment = /^(env|environment|environmentVariables|environment_variables|processEnv)$/i.test(key);
      const encrypted = key === 'encrypted_content';
      return [redact(key), encrypted ? '[EXCLUDED: encrypted provider payload]' : environment ? '[EXCLUDED: environment snapshot]' : binary ? '[EXCLUDED: attachment]' : isSecretKeyName(key) && !recordedId && !count
        ? '[REDACTED]' : sanitize(item, depth + 1)];
    }));
  }
  return value;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function projectMatches(cwd: string | undefined, project: string): boolean {
  if (!cwd) return false;
  const actual = normalizedPath(cwd), wanted = normalizedPath(project);
  return actual === wanted || actual.startsWith(wanted + path.sep);
}

export async function* jsonLines(file: string, size: number): AsyncGenerator<{ line: number; value?: unknown; invalid?: boolean; reason?: 'malformed' | 'oversize' }> {
  if (!size) return;
  const input = createReadStream(file, { start: 0, end: size - 1 });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of reader) {
      line++;
      if (!text.trim()) continue;
      if (text.length > 32 * 1024 * 1024) { yield { line, invalid: true, reason: 'oversize' }; continue; }
      try { yield { line, value: JSON.parse(text) as unknown }; }
      catch { yield { line, invalid: true, reason: 'malformed' }; }
    }
  } finally { reader.close(); input.destroy(); }
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Provider folder could not be read.'); }
    for (const entry of entries) {
      // Never follow links out of a provider's conversation directory.
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  await walk(root);
  return files.sort();
}

export async function discoverConversations(options: { codexHome?: string; claudeHome?: string; provider?: 'codex' | 'claude' } = {}): Promise<ConversationSource[]> {
  const roots: Array<[ExportProvider, string]> = [];
  if (options.provider !== 'claude') {
    const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    roots.push(['codex', path.join(home, 'sessions')], ['codex', path.join(home, 'archived_sessions')]);
  }
  if (options.provider !== 'codex') roots.push(['claude', path.join(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')]);
  const sources: ConversationSource[] = [];
  for (const [provider, root] of roots) {
    for (const file of await filesUnder(root)) {
      const stat = await fs.stat(file);
      let id = path.basename(file, '.jsonl'), project: string | undefined;
      // Read only the header during discovery. Export subsequently reads the entire selected file.
      for await (const item of jsonLines(file, stat.size)) {
        const event = object(item.value), payload = object(event.payload);
        if (provider === 'codex' && event.type === 'session_meta') {
          id = nativeId(payload.id) ?? id; project = string(payload.cwd); break;
        }
        if (provider === 'claude') {
          id = nativeId(event.sessionId) ?? id; project = string(event.cwd) ?? project;
          if (project) break;
        }
        if (item.line >= 256) break;
      }
      sources.push({ provider, file, id, ...(project ? { project } : {}) });
    }
  }
  return sources;
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join('\n');
  const item = object(value);
  if (item.type === 'tool_use' || item.type === 'function_call') return `[tool ${String(item.name ?? 'call')}] ${JSON.stringify(item.input ?? item.arguments ?? {})}`;
  return string(item.text) ?? string(item.output) ?? displayText(item.content);
}
function excerpt(value: unknown): { role: string; text: string; timestamp?: string } | undefined {
  const event = object(value), payload = object(event.payload), message = object(event.message);
  const body = event.type === 'response_item' ? payload : Object.keys(message).length ? message : event;
  const role = string(body.role) ?? (event.type === 'user' || event.type === 'assistant' ? event.type : undefined);
  if (!role) return undefined;
  const text = displayText(body.content);
  if (!text) return undefined;
  return { role, text: text.slice(0, 1600), ...(string(event.timestamp) ? { timestamp: string(event.timestamp) } : {}) };
}

/** RFC4180-style quoted fields, including embedded newlines; strict unmatched quote rejection. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [], row: string[] = [];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else throw new Error('Invalid CSV quoting.');
    } else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row.splice(0));
    } else cell += ch;
  }
  if (quoted) throw new Error('Unterminated CSV field.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift()?.map(item => item.replace(/^\uFEFF/, '')) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers.');
  return rows.filter(item => item.some(Boolean)).map(item => {
    if (item.length !== headers.length) throw new Error('CSV row does not match header.');
    return Object.fromEntries(headers.map((key, i) => [key, item[i]]));
  });
}

async function* inputEvents(source: ConversationSource, size: number): AsyncGenerator<{ line: number; value?: unknown; invalid?: boolean }> {
  if (source.provider === 'codex' || source.provider === 'claude' || source.file.endsWith('.jsonl')) {
    yield* jsonLines(source.file, size); return;
  }
  if (size > 128 * 1024 * 1024) throw new Error('JSON/CSV import exceeds 128 MiB; split it or use JSONL.');
  const text = await fs.readFile(source.file, 'utf8');
  const data: unknown = source.provider === 'csv' ? parseCsv(text) : JSON.parse(text);
  const items = Array.isArray(data) ? data : [data];
  let line = 0;
  for (const item of items) {
    if (source.provider === 'chatgpt') {
      const conv = object(item), mapping = object(conv.mapping);
      // Keep every branch and parent ID. Never silently flatten to only the active ChatGPT branch.
      for (const [nodeId, raw] of Object.entries(mapping)) {
        const node = object(raw), message = object(node.message);
        yield { line: ++line, value: { conversationId: conv.id, title: conv.title, nodeId, parent: node.parent,
          children: node.children, message: { ...message, role: object(message.author).role, content: object(message.content).parts } } };
      }
      if (!Object.keys(mapping).length) yield { line: ++line, value: item };
    } else yield { line: ++line, value: item };
  }
}

/** Writes only derived output. Existing bundles are never overwritten. No network or provider processes. */
export async function exportConversations(sources: ConversationSource[], destination: string): Promise<CockpitBundle & { directory: string }> {
  if (!sources.length) throw new Error('Select at least one conversation or knowledge input.');
  if (sources.some(source => isCredentialPath(source.file))) throw new Error('Credential files cannot be exported.');
  const parent = path.resolve(destination), target = path.join(parent, `datapass-${Date.now()}-${randomUUID().slice(0, 8)}`);
  for (const source of sources) if ((source.provider === 'codex' || source.provider === 'claude') && projectMatches(parent, path.dirname(source.file))) throw new Error('Export destination must be outside the native conversation directories.');
  await fs.mkdir(target, { recursive: true });
  const bundle: CockpitBundle = { schema: 'datapass.cockpit/1', exportedAt: new Date().toISOString(), sessions: [],
    policy: { authority: 'historical-observations', redacted: true, attachments: 'excluded', autoPublish: false },
    warnings: ['Recorded conversations are historical observations, not proof of current code or accepted decisions.',
      'Pattern redaction cannot guarantee removal of every secret or personal detail. Review before sharing.',
      'Cockpit excerpts are bounded; full redacted events are in each JSONL file. No attachments are copied.'] };
  const lexical = await fs.open(path.join(target, 'leviathan.jsonl'), 'wx');
  try {
    for (const source of sources) {
      const stat = await fs.lstat(source.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular source files are supported.');
      const slug = hash(`${source.provider}:${source.id}:${path.resolve(source.file)}`).slice(0, 20);
      const relative = `${source.provider}-${slug}.jsonl`;
      const output = await fs.open(path.join(target, relative), 'wx');
      const markdown = await fs.open(path.join(target, `${source.provider}-${slug}.md`), 'wx');
      const contentHash = createHash('sha256');
      const session: ExportSession = { provider: source.provider, id: String(sanitize(source.id)),
        ...(source.project ? { project: String(sanitize(source.project)) } : {}), title: source.id,
        file: relative, records: 0, malformed: 0, omitted: 0, changedDuringExport: false,
        sourceBytes: stat.size, sourceModifiedAt: stat.mtime.toISOString(), contentHash: '', excerpts: [] };
      await markdown.write(`# ${source.provider} conversation\n\nHistorical observations. Redacted export; binary attachments excluded.\n\n`);
      try {
        for await (const item of inputEvents(source, stat.size)) {
          if (item.invalid) { session.malformed++; continue; }
          const safe = sanitize(item.value), data = object(safe), id = `${slug}:${item.line}`;
          const event = { schema: 'datapass.conversation-event/1', id,
            source: { provider: source.provider, sessionId: session.id, line: item.line, project: session.project,
              path: String(sanitize(path.resolve(source.file))), sourceModifiedAt: session.sourceModifiedAt }, event: safe };
          const serialized = JSON.stringify(event) + '\n';
          contentHash.update(serialized); await output.write(serialized); session.records++;
          const message = excerpt(safe);
          if (message) {
            session.excerpts.push({ id, ...message });
            if (session.excerpts.length > 12) { session.excerpts.shift(); session.omitted++; }
            if (session.title === source.id && message.role === 'user') session.title = message.text.replace(/\s+/g, ' ').slice(0, 140);
          }
          // Full event JSON remains searchable: tool inputs, results and metadata are retained too.
          await lexical.write(JSON.stringify({ id, title: `${source.provider} ${session.id} line ${item.line}`,
            text: JSON.stringify(safe), group: session.project ?? source.provider,
            source: event.source, authority: 'historical-observations' }) + '\n');
          await markdown.write(`### Record ${item.line}\n\n\`\`\`json\n${JSON.stringify(safe, null, 2).replace(/`/g, '\\u0060')}\n\`\`\`\n\n`);
          if ((source.provider === 'mongo' || source.provider === 'csv') && session.excerpts.length < 12) {
            session.excerpts.push({ id, role: 'source-record', text: JSON.stringify(data).slice(0, 1600) });
          }
        }
      } finally { await output.close(); await markdown.close(); }
      session.contentHash = contentHash.digest('hex');
      const after = await fs.stat(source.file);
      session.changedDuringExport = after.size !== stat.size || after.mtimeMs !== stat.mtimeMs;
      if (session.changedDuringExport || session.malformed) bundle.warnings.push(`${source.provider} ${session.id}: ${session.malformed} malformed/oversized rows; changed during export: ${session.changedDuringExport}. Re-export after the session settles.`);
      session.title = String(sanitize(session.title));
      bundle.sessions.push(session);
      if(source.observation)await fs.writeFile(path.join(target,`${source.provider}-${slug}.observation.json`),JSON.stringify(sanitize(source.observation),null,2)+'\n',{flag:'wx'});
    }
  } catch {
    // Leave evidence of an incomplete run, but never emit source content in an exception.
    await fs.writeFile(path.join(target, 'INCOMPLETE.txt'), 'Export did not finish. Do not ingest this directory.\n');
    throw new Error('Export failed. An incomplete derived bundle was retained; no source was modified.');
  } finally { await lexical.close(); }
  await fs.writeFile(path.join(target, 'cockpit.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(target, 'README.md'), `# DataPass knowledge bundle\n\n${bundle.warnings.join('\n\n')}\n\nImport cockpit.json in the DataPass T3 cockpit. JSONL and Markdown contain full redacted records. leviathan.jsonl is a rebuildable lexical projection. No canonical knowledge is written.\n`, { flag: 'wx' });
  return Object.assign(bundle, { directory: target });
}
