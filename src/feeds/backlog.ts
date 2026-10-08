// Read-only scan of plan files in the repositories agents touched. Pure fs reads with a size cap and a
// parse cache keyed by (path, size, mtime); no process, no network, no writes.
import * as fs from 'fs';
import * as path from 'path';
import { BacklogReport, parsePlan, PlanFile } from '../activity/backlog';
import { hasLinkedAncestor, isPlausibleLocalPath, normalizeCase } from '../util/paths';

/** Files looked for in every repository root, in display order. */
export const PLAN_FILES = ['handoff/PLAN.md', 'handoff/ROADMAP.md', 'PLAN.md', 'ROADMAP.md', 'TODO.md', 'handoff/TODO.md', 'docs/PLAN.md', 'docs/ROADMAP.md'];
export const ARCHIVE_DIRS = ['handoff/archive', 'handoff/ARCHIVE'];
export const MAX_BYTES = 200 * 1024;
const MAX_ARCHIVE = 40;

export interface ScanInput {
  roots: string[];
  now: number;
  maxBytes?: number;
  /** Also read handoff/archive/*.md (weekly archive). */
  archive?: boolean;
}

const cache = new Map<string, { size: number; mtime: number; file: PlanFile }>();

async function statOf(p: string): Promise<fs.Stats | undefined> {
  if (hasLinkedAncestor(p)) return undefined;
  try {
    return await fs.promises.stat(p);
  } catch {
    return undefined;
  }
}

async function readPlan(root: string, rel: string, archive: boolean, maxBytes: number): Promise<PlanFile | undefined> {
  const file = path.join(root, ...rel.split('/'));
  const st = await statOf(file);
  if (!st?.isFile()) return undefined;
  const key = `${normalizeCase(file)}|${maxBytes}`;
  const hit = cache.get(key);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.file;
  const base: PlanFile = { root, repo: path.basename(root) || root, rel, file, bytes: st.size, mtime: st.mtimeMs, archive, items: [] };
  let out: PlanFile;
  if (st.size > maxBytes) out = { ...base, skipped: `larger than ${Math.round(maxBytes / 1024)} KB` };
  else {
    try {
      out = { ...base, items: parsePlan(await fs.promises.readFile(file, 'utf8')) };
    } catch (e) {
      out = { ...base, skipped: `unreadable (${String((e as NodeJS.ErrnoException)?.code ?? 'error')})` };
    }
  }
  if (cache.size > 1000) cache.clear();
  cache.set(key, { size: st.size, mtime: st.mtimeMs, file: out });
  return out;
}

/** Distinct existing repository roots, keeping the given order (most recent first). */
export async function uniqueRoots(roots: string[], max: number): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (!isPlausibleLocalPath(r)) continue;
    const k = normalizeCase(path.resolve(r));
    if (seen.has(k)) continue;
    seen.add(k);
    if (!(await statOf(r))?.isDirectory()) continue;
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

export async function scanBacklog(input: ScanInput): Promise<BacklogReport> {
  const maxBytes = input.maxBytes ?? MAX_BYTES;
  const files: PlanFile[] = [];
  const empty: string[] = [];
  for (const root of input.roots) {
    const before = files.length;
    const seen = new Set<string>();
    for (const rel of PLAN_FILES) {
      const f = await readPlan(root, rel, false, maxBytes);
      // case-insensitive file systems: handoff/TODO.md and handoff/todo.md are one file
      if (f && !seen.has(normalizeCase(f.file))) {
        seen.add(normalizeCase(f.file));
        files.push(f);
      }
    }
    if (input.archive !== false) {
      for (const dir of ARCHIVE_DIRS) {
        let names: string[] = [];
        try {
          names = (await fs.promises.readdir(path.join(root, ...dir.split('/')))).filter(n => /\.md$/i.test(n)).sort().reverse().slice(0, MAX_ARCHIVE);
        } catch {
          continue;
        }
        for (const n of names) {
          const f = await readPlan(root, `${dir}/${n}`, true, maxBytes);
          if (f && !seen.has(normalizeCase(f.file))) {
            seen.add(normalizeCase(f.file));
            files.push(f);
          }
        }
      }
    }
    if (files.length === before) empty.push(root);
  }
  return { at: input.now, roots: input.roots, files, empty };
}

export function clearBacklogCache(): void {
  cache.clear();
}
