// On-demand reader that turns one Claude transcript / Codex rollout / worker transcript into a conversation.
// Tail-read (last maxBytes), incremental (only the bytes appended since the last read), entries capped.
// Every kept string goes through redact(); images and base64 runs are never kept; thinking keeps its length only.
import * as fs from 'fs';
import type { Provider } from '../model';
import { redact } from '../util/redact';

export type EntryKind = 'prompt' | 'reply' | 'thinking' | 'tool' | 'spawn' | 'error' | 'compact' | 'command' | 'meta' | 'turn';

export interface EntryResult {
  at: number;
  /** Redacted preview, at most RESULT_MAX characters. */
  text: string;
  error: boolean;
  /** Length of the full result text before the preview cut. */
  chars: number;
  exitCode?: number;
  durationMs?: number;
}

export interface Entry {
  /** Stable within one reader cache (sequence number). */
  id: number;
  at: number;
  kind: EntryKind;
  /** Prompt / reply / meta text, or the short tool input. Redacted, bounded. */
  text: string;
  /** Tool name (tool, spawn) or command name. */
  name?: string;
  callId?: string;
  result?: EntryResult;
  /** Thinking: length of the thinking text (content itself is never kept). */
  chars?: number;
  spawn?: { type: string; description: string };
  model?: string;
  /** Nested item (Codex command / MCP / file change run inside a tool call). */
  sub?: boolean;
  /** Assistant message phase (Codex: commentary / final_answer). */
  phase?: string;
}

export interface Transcript {
  path: string;
  provider: Provider;
  entries: Entry[];
  /** File size at the last read, bytes. */
  size: number;
  /** Byte offset the loaded window starts at (0 = whole file). */
  from: number;
  /** Records (JSON lines) parsed in the loaded window. */
  records: number;
  /** Lines that were not valid JSON (partial writes, corruption). */
  bad: number;
  /** Entries dropped from the front because of maxEntries. */
  dropped: number;
  at: number;
  error?: string;
}

export interface ReadOpts {
  maxBytes?: number;
  maxEntries?: number;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 2000;
export const RESULT_MAX = 2048;
const TEXT_MAX = 6000;
const INPUT_MAX = 240;

// ---------------------------------------------------------------- text hygiene

const B64 = /[A-Za-z0-9+/_-]{180,}={0,2}/g;
const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/** Redacted, base64-free, length-bounded multi-line text. */
export function clean(text: unknown, max = TEXT_MAX): string {
  if (typeof text !== 'string' || !text) return '';
  let t = text.replace(DATA_URL, m => `[data url ${m.length} chars omitted]`).replace(B64, m => `[${m.length} chars of encoded data omitted]`);
  t = redact(t).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}… (+${t.length - max + 1} chars)` : t;
}

/** Single line version of clean(). */
export function line(text: unknown, max = INPUT_MAX): string {
  return clean(typeof text === 'string' ? text.replace(/\s+/g, ' ') : text, max);
}

function contentText(c: unknown): { text: string; images: number } {
  if (typeof c === 'string') return { text: c, images: 0 };
  if (!Array.isArray(c)) return { text: '', images: 0 };
  let text = '', images = 0;
  for (const b of c) {
    if (typeof b === 'string') text += (text ? '\n' : '') + b;
    else if (b && typeof b === 'object') {
      const t = (b as { type?: string }).type ?? '';
      if (/image/.test(t)) images++;
      else if (typeof (b as { text?: unknown }).text === 'string') text += (text ? '\n' : '') + (b as { text: string }).text;
    }
  }
  return { text, images };
}

function ts(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string') return undefined;
  const n = Date.parse(v);
  return isNaN(n) ? undefined : n;
}

function parseJson(s: unknown): Record<string, unknown> | undefined {
  if (typeof s !== 'string') return s && typeof s === 'object' ? (s as Record<string, unknown>) : undefined;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Short, human input of a tool call (never the full payload). */
export function toolInput(name: string, input: unknown): string {
  if (typeof input === 'string') {
    const patch = [...input.matchAll(/\*\*\* (Update|Add|Delete) File: ([^\n]+)/g)].map(m => `${m[1].toLowerCase()} ${m[2].trim()}`);
    if (patch.length) return line(patch.join(', '));
    const cmd = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(input);
    if (cmd) return line(cmd[2].replace(/\\(["'`\\])/g, '$1'));
    const o = parseJson(input);
    if (o) return toolInput(name, o);
    return line(input);
  }
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.command === 'string') return line(o.command);
  if (Array.isArray(o.command)) return line(o.command.map(String).slice(-1)[0] ?? '');
  if (typeof o.cmd === 'string') return line(o.cmd);
  if (typeof o.file_path === 'string' || typeof o.notebook_path === 'string' || typeof o.path === 'string') {
    const p = str(o.file_path) || str(o.notebook_path) || str(o.path);
    const extra = typeof o.pattern === 'string' ? `${o.pattern} in ` : '';
    return line(extra + p);
  }
  if (typeof o.pattern === 'string') return line(o.pattern);
  if (typeof o.url === 'string') return line(o.url.replace(/\?.*$/, '?…'));
  if (typeof o.query === 'string') return line(o.query);
  if (typeof o.description === 'string') return line(`${str(o.subagent_type) || str(o.agent_type)}${o.subagent_type || o.agent_type ? ': ' : ''}${o.description}`);
  if (Array.isArray(o.todos)) return `${o.todos.length} todo item(s)`;
  if (typeof o.task_name === 'string') return line(o.task_name);
  const keys = Object.keys(o);
  if (!keys.length) return '';
  return line(keys.slice(0, 4).map(k => `${k}: ${typeof o[k] === 'string' ? o[k] : Array.isArray(o[k]) ? `[${(o[k] as unknown[]).length}]` : typeof o[k] === 'object' ? '{…}' : String(o[k])}`).join(' · '));
}

function result(at: number, raw: unknown, error: boolean, extra: Partial<EntryResult> = {}): EntryResult {
  const { text, images } = contentText(raw);
  const body = text + (images ? `${text ? '\n' : ''}[${images} image(s) omitted]` : '');
  return { at, text: clean(body, RESULT_MAX), error, chars: body.length, ...extra };
}

// ---------------------------------------------------------------- parser state

export interface ParseState {
  provider: Provider;
  entries: Entry[];
  byCall: Map<string, Entry>;
  seq: number;
  dropped: number;
  /** Codex: last turn context shown, to emit a meta entry only on change. */
  ctx?: string;
  lastAt: number;
  /** Codex message ids already shown. */
  seen: Set<string>;
  /** Bounded provider/type identities of tool calls already shown. */
  nativeSeen?: Set<string>;
  /** Retained completed Codex tools: later observations update the same entry. */
  nativeEntries?: Map<string,Entry>;
}

export function newState(provider: Provider): ParseState {
  return { provider, entries: [], byCall: new Map(), seq: 0, dropped: 0, lastAt: 0, seen: new Set() };
}

function repeatedNativeTool(st:ParseState,type:string,id:string):boolean {
  if(!id || id.length>512)return false;
  const seen=st.nativeSeen ??= new Set<string>(),key=st.provider+':'+type+':'+id;
  if(seen.has(key))return true;
  seen.add(key);
  if(seen.size>5000)seen.delete(seen.values().next().value!);
  return false;
}

function completedTool(st:ParseState,type:string,id:string,value:Omit<Entry,'id'>):void {
  const key='item_completed:'+type+':'+id,retained=st.nativeEntries?.get(key);
  if(id && id.length<=512 && retained){Object.assign(retained,value,{id:retained.id,at:retained.at});return;}
  if(repeatedNativeTool(st,'item_completed:'+type,id))return;
  const entry=push(st,value);
  if(id && id.length<=512){
    const items=st.nativeEntries ??= new Map<string,Entry>();items.set(key,entry);
    if(items.size>5000)items.delete(items.keys().next().value!);
  }
}

function push(st: ParseState, e: Omit<Entry, 'id'>): Entry {
  const x = { ...e, id: ++st.seq } as Entry;
  st.entries.push(x);
  if (x.callId) st.byCall.set(x.callId, x);
  return x;
}

const META_TAG = /^\s*<([a-z][a-z0-9_-]*)[\s>]/i;
const SPAWN_TOOLS = new Set(['Task', 'Agent', 'spawn_agent']);

function claudeUserText(st: ParseState, at: number, text: string, images: number, o: Record<string, unknown>): void {
  const t = text.trim();
  if (!t && !images) return;
  if (o.isCompactSummary) return void push(st, { at, kind: 'compact', text: 'Compaction summary (text not shown)' });
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? '';
    return void push(st, { at, kind: 'command', name: line(cmd[1], 60), text: line(args) });
  }
  if (/^\[Request interrupted by user/.test(t)) return void push(st, { at, kind: 'meta', text: 'Interrupted by the user' });
  const tag = META_TAG.exec(t);
  if (tag) return void push(st, { at, kind: 'meta', name: tag[1].toLowerCase(), text: `<${tag[1].toLowerCase()}> (${t.length} chars)` });
  push(st, { at, kind: 'prompt', text: clean(t) + (images ? `${t ? '\n' : ''}[${images} image(s) omitted]` : '') });
}

/** Feeds one parsed Claude transcript record. */
export function claudeRecord(st: ParseState, o: Record<string, unknown>): void {
  const at = ts(o.timestamp) ?? st.lastAt;
  if (at) st.lastAt = at;
  const type = str(o.type);
  if (type === 'system') {
    const sub = str(o.subtype);
    if (sub === 'compact_boundary') {
      const meta = (o.compactMetadata ?? {}) as Record<string, unknown>;
      const pre = typeof meta.preTokens === 'number' ? ` · ${Math.round(meta.preTokens / 1000)}k tokens before` : '';
      push(st, { at, kind: 'compact', text: `Context compacted${meta.trigger ? ` (${line(meta.trigger, 20)})` : ''}${pre}` });
    } else if (o.level === 'error' || /error/i.test(sub)) {
      push(st, { at, kind: 'error', name: sub || 'system', text: line(str(o.content) || str((o.error as Record<string, unknown>)?.message) || sub, 400) });
    }
    return;
  }
  const m = o.message as Record<string, unknown> | undefined;
  if (!m || (type !== 'user' && type !== 'assistant')) return;
  if (type === 'user') {
    if (o.isMeta) return;
    if (typeof m.content === 'string') return claudeUserText(st, at, m.content, 0, o);
    if (!Array.isArray(m.content)) return;
    let text = '', images = 0;
    for (const b of m.content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const call = st.byCall.get(str(b.tool_use_id));
        const r = result(at, b.content, b.is_error === true);
        if (call) {
          call.result = r;
          if (call.kind === 'spawn' || call.kind === 'tool') continue;
        }
      } else if (b.type === 'text') text += (text ? '\n' : '') + str(b.text);
      else if (/image/.test(str(b.type))) images++;
    }
    if (text || images) claudeUserText(st, at, text, images, o);
    return;
  }
  // assistant
  const model = str(m.model) || undefined;
  if (o.isApiErrorMessage || o.error) {
    const { text } = contentText(m.content);
    return void push(st, { at, kind: 'error', name: 'api', text: line(text || str(o.error), 400), model });
  }
  if (!Array.isArray(m.content)) return;
  for (const b of m.content as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && str(b.text).trim()) push(st, { at, kind: 'reply', text: clean(b.text), model });
    else if (b.type === 'thinking' || b.type === 'redacted_thinking') push(st, { at, kind: 'thinking', text: '', chars: str(b.thinking).length || str(b.data).length, model });
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      if(repeatedNativeTool(st,str(b.type),str(b.id)))continue;
      const name = line(b.name, 80) || 'tool';
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (SPAWN_TOOLS.has(name)) {
        push(st, { at, kind: 'spawn', name, callId: str(b.id), text: toolInput(name, input), spawn: { type: line(input.subagent_type, 60) || 'general', description: line(input.description, 160) }, model });
      } else push(st, { at, kind: 'tool', name, callId: str(b.id) || undefined, text: toolInput(name, input), model });
    }
  }
}

function codexItem(st: ParseState, at: number, item: Record<string, unknown>, p: Record<string, unknown>): void {
  const t = str(item.type);
  const done = ts(p.completed_at_ms) ?? at;
  const started = ts(p.started_at_ms) ?? at;
  if (t === 'UserMessage') {
    const { text, images } = contentText(item.content);
    const tt = text.trim();
    if (!tt && !images) return;
    const tag = META_TAG.exec(tt);
    if (tag) return void push(st, { at, kind: 'meta', name: tag[1].toLowerCase(), text: `<${tag[1].toLowerCase()}> (${tt.length} chars)` });
    push(st, { at, kind: 'prompt', text: clean(tt) + (images ? `\n[${images} image(s) omitted]` : '') });
  } else if (t === 'CommandExecution') {
    const cmd = Array.isArray(item.command) ? String(item.command.slice(-1)[0] ?? '') : str(item.command);
    const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const d = item.duration as { secs?: number; nanos?: number } | undefined;
    const durationMs = d && typeof d.secs === 'number' ? Math.round(d.secs * 1000 + (d.nanos ?? 0) / 1e6) : done - started || undefined;
    completedTool(st,t,str(item.id), { at: started, kind: 'tool', name: 'command', sub: true, text: line(cmd), result: result(done, str(item.aggregated_output) || str(item.stdout) || str(item.formatted_output), (exit !== undefined && exit !== 0) || item.status === 'failed', { exitCode: exit, durationMs }) });
  } else if (t === 'McpToolCall') {
    const r = (item.result ?? {}) as Record<string, unknown>;
    completedTool(st,t,str(item.id), { at: started, kind: 'tool', name: `mcp ${line(item.server, 40)}.${line(item.tool, 60)}`, sub: true, text: toolInput('mcp', item.arguments), result: result(done, r.content, r.isError === true || item.status === 'failed', { durationMs: done - started || undefined }) });
  } else if (t === 'FileChange') {
    const ch = (item.changes ?? {}) as Record<string, { type?: string; unified_diff?: string }>;
    const files = Object.keys(ch);
    const diff = files.map(f => str(ch[f]?.unified_diff)).filter(Boolean).join('\n');
    completedTool(st,t,str(item.id), { at, kind: 'tool', name: 'file change', sub: true, text: line(files.map(f => `${ch[f]?.type ?? 'edit'} ${f}`).join(', ')), result: result(done, diff, item.status === 'failed') });
  } else if (t === 'ImageView') {
    completedTool(st,t,str(item.id), { at, kind: 'tool', name: 'view image', sub: true, text: line(item.path), result: { at, text: '[image not shown]', error: false, chars: 0 } });
  } else if (t === 'AgentMessage') {
    codexReply(st, at, contentText(item.content).text, str(item.id), str(item.phase));
  }
  // WebSearch, Reasoning, ContextCompaction, Extension: the response_item / compacted records already show them.
}

/** Codex writes assistant text twice (response_item message and item_completed AgentMessage): keep one. */
function codexReply(st: ParseState, at: number, text: string, id: string, phase: string): void {
  const t = text.trim();
  if (!t) return;
  if (id) {
    if (st.seen.has(id)) return;
    st.seen.add(id);
    if (st.seen.size > 5000) st.seen.clear();
  }
  const body = clean(t);
  for (let i = st.entries.length - 1, k = 0; i >= 0 && k < 6; i--, k++) {
    const e = st.entries[i];
    if (e.kind === 'reply' && e.text === body && Math.abs(e.at - at) < 30_000) return;
  }
  push(st, { at, kind: 'reply', text: body, phase: phase || undefined });
}

/** Feeds one parsed Codex rollout record. */
export function codexRecord(st: ParseState, o: Record<string, unknown>): void {
  const at = ts(o.timestamp) ?? st.lastAt;
  if (at) st.lastAt = at;
  const type = str(o.type);
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const pt = str(p.type);
  if (type === 'session_meta') {
    push(st, { at, kind: 'meta', name: 'session', text: line(`Session started${p.cli_version ? ` · cli ${p.cli_version}` : ''}${p.originator ? ` · ${p.originator}` : ''}${p.source ? ` · ${typeof p.source === 'string' ? p.source : 'sub-agent'}` : ''}`) });
    return;
  }
  if (type === 'turn_context') {
    const sandbox = p.sandbox_policy && typeof p.sandbox_policy === 'object' ? str((p.sandbox_policy as Record<string, unknown>).type) : str(p.sandbox_policy);
    const c = [str(p.model), str(p.effort) && `effort ${p.effort}`, str(p.approval_policy) && `approval ${p.approval_policy}`, sandbox && `sandbox ${sandbox}`].filter(Boolean).join(' · ');
    if (c && c !== st.ctx) {
      st.ctx = c;
      push(st, { at, kind: 'meta', name: 'turn context', text: line(c) });
    }
    return;
  }
  if (type === 'compacted') return void push(st, { at, kind: 'compact', text: 'Context compacted' });
  if (type === 'event_msg') {
    if (pt === 'item_completed' && p.item && typeof p.item === 'object') return codexItem(st, at, p.item as Record<string, unknown>, p);
    if (pt === 'user_message') {
      const t = str(p.message).trim();
      if (!t) return;
      const tag = META_TAG.exec(t);
      if (tag) return void push(st, { at, kind: 'meta', name: tag[1].toLowerCase(), text: `<${tag[1].toLowerCase()}> (${t.length} chars)` });
      return void push(st, { at, kind: 'prompt', text: clean(t) });
    }
    if (pt === 'agent_message') return codexReply(st, at, str(p.message), '', '');
    if (pt === 'task_started') return void push(st, { at, kind: 'turn', text: 'Turn started' });
    if (pt === 'task_complete') {
      const ms = typeof p.duration_ms === 'number' ? p.duration_ms : undefined;
      return void push(st, { at, kind: 'turn', name: 'end', text: `Turn complete${ms ? ` · ${Math.round(ms / 1000)} s` : ''}` });
    }
    if (pt === 'turn_aborted') return void push(st, { at, kind: 'meta', name: 'aborted', text: line(`Turn aborted${p.reason ? ` (${p.reason})` : ''}`) });
    if (pt === 'error' || pt === 'stream_error') return void push(st, { at, kind: 'error', name: pt, text: line(str(p.message) || pt, 400) });
    if (pt === 'exec_command_end') {
      // Older rollouts: one record per finished command.
      const cmd = Array.isArray(p.command) ? String(p.command.slice(-1)[0] ?? '') : str(p.command);
      const exit = typeof p.exit_code === 'number' ? p.exit_code : undefined;
      const call = st.byCall.get(str(p.call_id));
      const r = result(at, str(p.aggregated_output) || str(p.stdout) || str(p.formatted_output), exit !== undefined && exit !== 0, { exitCode: exit });
      if (call) call.result = r;
      else push(st, { at, kind: 'tool', name: 'command', sub: true, text: line(cmd), result: r });
    }
    return;
  }
  if (type !== 'response_item') return;
  if (pt === 'message') {
    if (p.role === 'assistant') codexReply(st, at, contentText(p.content).text, str(p.id), str(p.phase));
  } else if (pt === 'reasoning') {
    const sum = Array.isArray(p.summary) ? contentText(p.summary).text.length : 0;
    const raw = Array.isArray(p.content) ? contentText(p.content).text.length : 0;
    push(st, { at, kind: 'thinking', text: sum || raw ? '' : 'encrypted', chars: sum || raw || str(p.encrypted_content).length });
  } else if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'local_shell_call') {
    const name = line(p.namespace ? `${p.namespace}.${p.name}` : p.name, 80) || (pt === 'local_shell_call' ? 'shell' : 'tool');
    const raw = pt === 'function_call' ? p.arguments : pt === 'custom_tool_call' ? p.input : p.action;
    const callId = str(p.call_id) || str(p.id) || undefined;
    if (str(p.name) === 'spawn_agent') {
      const a = parseJson(raw) ?? {};
      push(st, { at, kind: 'spawn', name: 'spawn_agent', callId, text: toolInput('spawn_agent', a), spawn: { type: line(a.agent_type, 60) || 'agent', description: line(a.task_name ?? a.description, 160) } });
    } else push(st, { at, kind: 'tool', name, callId, text: toolInput(name, raw) });
  } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output' || pt === 'local_shell_call_output') {
    const call = st.byCall.get(str(p.call_id));
    let out: unknown = p.output;
    const asObj = parseJson(out);
    if (asObj && typeof asObj.output === 'string') out = asObj.output;
    const failed = /\b(exit code|exit_code)\W+[1-9]/i.test(typeof out === 'string' ? out.slice(0, 400) : '') || (asObj?.metadata as Record<string, unknown> | undefined)?.exit_code !== undefined && (asObj?.metadata as Record<string, unknown>).exit_code !== 0;
    if (call) call.result = result(at, out, !!failed);
  } else if (pt === 'web_search_call') {
    const a = (p.action ?? {}) as Record<string, unknown>;
    push(st, { at, kind: 'tool', name: 'web_search', text: line(str(a.query) || str(a.url) || str(a.type)), result: p.status ? { at, text: line(p.status, 40), error: p.status === 'failed', chars: 0 } : undefined });
  }
}

export function feed(st: ParseState, o: Record<string, unknown>): void {
  if (st.provider === 'claude') claudeRecord(st, o);
  else codexRecord(st, o);
}

/** Drops the oldest entries above max (and their call ids). */
export function trim(st: ParseState, max: number): void {
  const over = st.entries.length - max;
  if (over <= 0) return;
  const removed=new Set(st.entries.slice(0,over));
  for (const e of removed) if (e.callId && st.byCall.get(e.callId) === e) st.byCall.delete(e.callId);
  for(const [key,entry] of st.nativeEntries ?? [])if(removed.has(entry))st.nativeEntries!.delete(key);
  st.entries.splice(0, over);
  st.dropped += over;
}

/** Parses a whole JSONL text (tests, small files). */
export function parseText(provider: Provider, text: string, maxEntries = DEFAULT_MAX_ENTRIES): { entries: Entry[]; records: number; bad: number } {
  const st = newState(provider);
  let records = 0, bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      feed(st, JSON.parse(l));
      records++;
    } catch {
      bad++;
    }
  }
  trim(st, maxEntries);
  return { entries: st.entries, records, bad };
}

// ---------------------------------------------------------------- incremental tail reader

interface Cached {
  st: ParseState;
  offset: number;
  from: number;
  tail: Buffer;
  records: number;
  bad: number;
  mtime: number;
  at: number;
}

const CACHE = new Map<string, Cached>();
const CACHE_MAX = 6;
/** Appended bytes are read and parsed this many at a time (memory stays bounded whatever the window). */
const READ_CHUNK = 1 << 20;

export function clearTranscriptCache(): void {
  CACHE.clear();
}

/**
 * Reads (or refreshes) one transcript. Synchronous and incremental: the first call reads at most the last
 * maxBytes; later calls read only appended bytes. A shrunk or replaced file is re-read from scratch.
 */
export function readTranscript(path: string, provider: Provider, opts: ReadOpts = {}): Transcript {
  const maxBytes = Math.max(64 * 1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxEntries = Math.max(50, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = Date.now();
  const empty = (error: string): Transcript => ({ path, provider, entries: [], size: 0, from: 0, records: 0, bad: 0, dropped: 0, at: now, error });
  if (!/\.jsonl$/i.test(path)) return empty('Not a JSONL transcript.');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    CACHE.delete(path);
    return empty('Transcript file not found (moved, archived or deleted).');
  }
  let c = CACHE.get(path);
  const size = stat.size;
  if (c && (size < c.offset || stat.mtimeMs < c.mtime || c.st.provider !== provider || size - c.offset > maxBytes)) c = undefined;
  if (!c) {
    const from = Math.max(0, size - maxBytes);
    c = { st: newState(provider), offset: from, from, tail: Buffer.alloc(0), records: 0, bad: 0, mtime: stat.mtimeMs, at: now };
  }
  CACHE.delete(path);
  CACHE.set(path, c);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
  if (size > c.offset) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path, 'r');
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - c.offset));
      // A window that starts mid-file begins with a partial line: skip it.
      let skipPartial = c.offset === c.from && c.from > 0 && c.records === 0 && c.bad === 0 && !c.tail.length;
      while (c.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - c.offset), c.offset);
        if (!n) break;
        c.offset += n;
        let data = c.tail.length ? Buffer.concat([c.tail, buf.subarray(0, n)]) : buf.subarray(0, n);
        if (skipPartial) {
          const nl = data.indexOf(0x0a);
          if (nl < 0) {
            c.tail = Buffer.alloc(0);
            continue;
          }
          data = data.subarray(nl + 1);
          skipPartial = false;
        }
        const last = data.lastIndexOf(0x0a);
        const whole = last < 0 ? '' : data.subarray(0, last).toString('utf8');
        c.tail = Buffer.from(last < 0 ? data : data.subarray(last + 1));
        if (c.tail.length > maxBytes) c.tail = Buffer.alloc(0); // runaway line without newline
        for (const l of whole.split('\n')) {
          if (!l.trim()) continue;
          let o: unknown;
          try {
            o = JSON.parse(l);
          } catch {
            c.bad++;
            continue;
          }
          c.records++;
          if (o && typeof o === 'object') feed(c.st, o as Record<string, unknown>);
        }
        trim(c.st, maxEntries);
      }
    } catch (e) {
      return { ...empty(`Read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`), size };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  c.mtime = stat.mtimeMs;
  c.at = now;
  return { path, provider, entries: c.st.entries, size, from: c.from, records: c.records, bad: c.bad, dropped: c.st.dropped, at: now };
}
