import * as fs from 'fs';

/** Incremental, read-only JSONL tail reader. Keeps a byte cursor so a growing multi-MB log is never re-read. */
export interface Cursor {
  offset: number;
  size: number;
  mtimeMs: number;
  /** Identity guard: first bytes of the file. A changed head means the file was replaced → restart. */
  head: string;
}

export interface ReadResult {
  lines: string[];
  cursor: Cursor;
  reset: boolean;
  bytesRead: number;
  skippedOversize: number;
}

const CHUNK = 1 << 20;
export const MAX_LINE_BYTES = 8 << 20;

function readHead(fd: number): string {
  const b = Buffer.alloc(64);
  const n = fs.readSync(fd, b, 0, 64, 0);
  return b.subarray(0, n).toString('latin1');
}

/** Reads complete new lines after cursor. A trailing partial line stays unread until it is terminated. */
export function readNewLines(file: string, prev?: Cursor, onLine?: (line: string) => void): ReadResult {
  const fd = fs.openSync(file, 'r'); // read-only: Agent never writes provider artifacts
  try {
    const st = fs.fstatSync(fd);
    const head = readHead(fd);
    let offset = prev?.offset ?? 0;
    let reset = false;
    if (prev && (st.size < prev.offset || (prev.head && head.slice(0, prev.head.length) !== prev.head))) {
      offset = 0;
      reset = true;
    }
    const lines: string[] = [];
    const emit = onLine ?? ((l: string) => lines.push(l));
    let skippedOversize = 0;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let oversize = false;
    let pos = offset;
    let consumed = offset;
    const buf = Buffer.alloc(CHUNK);
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      let start = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue;
        if (oversize) {
          skippedOversize++;
        } else {
          const part = buf.subarray(start, i);
          const line = pendingLen ? Buffer.concat([...pending, part]).toString('utf8') : part.toString('utf8');
          if (line.trim()) emit(line);
        }
        pending = [];
        pendingLen = 0;
        oversize = false;
        start = i + 1;
        consumed = pos + i + 1;
      }
      if (start < n && !oversize) {
        pendingLen += n - start;
        if (pendingLen > MAX_LINE_BYTES) {
          oversize = true;
          pending = [];
        } else pending.push(Buffer.from(buf.subarray(start, n)));
      }
      pos += n;
    }
    return {
      lines,
      cursor: { offset: consumed, size: st.size, mtimeMs: st.mtimeMs, head: head.slice(0, 32) },
      reset,
      bytesRead: pos - offset,
      skippedOversize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function safeParse(line: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? undefined : t;
  }
  return undefined;
}
