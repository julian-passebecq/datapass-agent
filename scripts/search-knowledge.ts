import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { sanitize } from '../src/export/conversations';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Read-only lexical fallback: --bundle <directory> --query <text> [--limit 8] [--max-chars 800]\nSearches full exported events, returns bounded cited snippets. No network, embeddings or canonical writes.'); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--bundle', '--query', '--limit', '--max-chars'].includes(key) || !value) throw new Error('Invalid query options.');
    options.set(key, value);
  }
  const bundleDir = options.get('--bundle'), query = options.get('--query');
  const limit = Number(options.get('--limit') ?? 8), maxChars = Number(options.get('--max-chars') ?? 800);
  if (!bundleDir || !query?.trim() || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxChars) || maxChars < 200 || maxChars > 4000) throw new Error('Invalid query bounds.');
  const directory = path.resolve(bundleDir);
  try { await fs.access(path.join(directory, 'INCOMPLETE.txt')); throw new Error('Incomplete bundle.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'cockpit.json'), 'utf8')) as { schema?: unknown; policy?: { redacted?: unknown } };
  if (manifest.schema !== 'datapass.cockpit/1' || manifest.policy?.redacted !== true) throw new Error('Expected exported knowledge bundle.');
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const results: Array<{ id: string; title: string; group: string; snippet: string; score: number; source: unknown; authority: string }> = [];
  let scanned = 0;
  const input = createReadStream(path.join(directory, 'leviathan.jsonl'));
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const record = sanitize(JSON.parse(line)) as { id?: unknown; title?: unknown; text?: unknown; group?: unknown; source?: unknown };
      scanned++;
      const content = typeof record.text === 'string' ? record.text : '', lower = content.toLowerCase();
      if (!words.every(word => lower.includes(word))) continue;
      const score = words.reduce((sum, word) => sum + Math.min(20, lower.split(word).length - 1), 0);
      const first = Math.max(0, lower.indexOf(words[0]) - 100);
      results.push({ id: String(record.id ?? ''), title: String(record.title ?? ''), group: String(record.group ?? ''),
        snippet: content.slice(first, first + maxChars), score, source: record.source, authority: 'historical-observations' });
      results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (results.length > limit) results.pop();
    }
  } finally { reader.close(); input.destroy(); }
  console.log(JSON.stringify({ backend: 'local-lexical-fallback', scanned, query: sanitize(query), results }, null, 2));
}
void main().catch(() => { console.error('Knowledge search failed. Check bundle completeness and query bounds.'); process.exitCode = 1; });
