import * as fs from 'fs';
import * as path from 'path';

/** True when `candidate` resolves (following symlinks) to a location inside `root`. Rejects traversal and injected paths. */
export function isInside(root: string, candidate: string): boolean {
  try {
    const r = fs.realpathSync.native(root);
    const c = fs.realpathSync.native(candidate);
    const rel = path.relative(r, c);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** Absolute local path with no NUL, no UNC/device prefix, no URL scheme. Used for cwd values read from artifacts. */
export function isPlausibleLocalPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (p.includes('\0')) return false;
  if (/^\\\\[?.]\\/.test(p)) return false; // \\?\ and \\.\ device paths
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(p)) return false;
  return path.isAbsolute(p);
}

export function normalizeCase(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

/** Repo-relative display path when `file` is inside `root`. */
export function relTo(root: string | undefined, file: string): string {
  if (!root) return file;
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
}
