// Reads the lessons file of each repository root (handoff/MEMORY.md, tasks/lessons.md or the "Lessons" section of
// CLAUDE.md) for the Session HUD. Async, read-only, at most `maxBytes` per file (the rest is ignored and flagged).
import * as fs from 'fs';
import * as path from 'path';
import { countLessons, LESSON_FILES, LessonsInfo } from '../activity/hud';

export const LESSONS_MAX_BYTES = 256 * 1024;

async function readHead(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean } | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const n = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), bytes: st.size, truncated: st.size > maxBytes };
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Lessons count for one repository root: the first candidate file that exists (CLAUDE.md only with a Lessons section). */
export async function readLessons(root: string, maxBytes = LESSONS_MAX_BYTES): Promise<LessonsInfo> {
  for (const c of LESSON_FILES) {
    const r = await readHead(path.join(root, ...c.rel.split('/')), maxBytes);
    if (!r) continue;
    const rules = countLessons(r.text, c.mode);
    if (c.mode === 'section' && !rules) continue;
    return { root, file: c.rel, rules, bytes: r.bytes, truncated: r.truncated };
  }
  return { root, rules: 0, bytes: 0, truncated: false };
}

/** Lessons for several roots (deduplicated case-insensitively, capped). */
export async function loadLessons(roots: string[], max = 24, maxBytes = LESSONS_MAX_BYTES): Promise<Record<string, LessonsInfo>> {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const r of roots) {
    const k = r.replace(/\\/g, '/').toLowerCase();
    if (!r || seen.has(k)) continue;
    seen.add(k);
    list.push(r);
    if (list.length >= max) break;
  }
  const out: Record<string, LessonsInfo> = {};
  for (const info of await Promise.all(list.map(r => readLessons(r, maxBytes)))) out[info.root] = info;
  return out;
}
