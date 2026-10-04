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
  const inside = (r: string, f: string) => {
    const rel = path.relative(r, f);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : undefined;
  };
  // Providers may record 8.3 short paths (C:\Users\RUNNER~1\…) while git reports long ones: compare canonical forms.
  return inside(root, file) ?? inside(canonical(root), canonical(file)) ?? file;
}

/** Long, case-correct path when it (or its parent, for deleted files) exists; otherwise unchanged. */
export function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}
