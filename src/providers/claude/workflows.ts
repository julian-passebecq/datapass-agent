// Claude Code workflow runs and background subagents, read-only.
// Layout (all under ~/.claude/projects/<slug>/<sessionId>/):
//   subagents/workflows/<runId>/journal.jsonl          {"type":"launched"} / {"type":"started",agentId,label,phase} / {"type":"result",agentId,result}
//   subagents/workflows/<runId>/agent-<id>.jsonl       that agent's transcript (assistant records: model, usage, tool_use; user: tool_result)
//   subagents/workflows/<runId>/agent-<id>.meta.json   {agentType, description, workflowPhase, worktreePath, spawnDepth}
//   workflows/scripts/<name>-<runId>.js                the script; only its `export const meta = {...}` literal is parsed (never evaluated)
//   subagents/agent-<id>.jsonl + .meta.json            background subagents (Agent tool)
// Transcripts are tail-read incrementally (byte cursor). Results are never kept raw: only a short redacted summary.
import * as fs from 'fs';
import * as path from 'path';
import { readNewLines, safeParse, toMs, Cursor } from '../../util/jsonl';
import { isInside } from '../../util/paths';
import { bounded } from '../../util/redact';

export type WfAgentStatus = 'running' | 'done' | 'failed' | 'stale';
export type WfRunStatus = 'running' | 'done' | 'failed' | 'killed' | 'stale';

export interface WfAgent {
  agentId: string;
  /** Journal label (or meta description). */
  label: string;
  phase?: string;
  agentType?: string;
  description?: string;
  worktree?: string;
  spawnDepth?: number;
  model?: string;
  firstAt?: number;
  lastAt?: number;
  /** Sum over unique message ids of prompt (incl. cache) + output tokens, as recorded. */
  tokens: number;
  outputTokens: number;
  calls: number;
  tools: number;
  toolErrors: number;
  lastTool?: string;
  lastToolAt?: number;
  /** tool_use without a recorded tool_result. */
  currentTool?: string;
  status: WfAgentStatus;
  /** Why status was chosen (evidence for tooltips). */
  statusBasis: string;
  /** Short redacted summary of the journal result (≤ 160 chars). */
  result?: string;
  transcript?: string;
  transcriptBytes?: number;
  /** Session key the main store would use for this transcript, if it were listed. */
  sessionKey: string;
}

export interface WfPhase {
  title: string;
  detail?: string;
}

export interface WfRun {
  runId: string;
  sessionId: string;
  /** Session key of the parent session (claude:<sessionId>). */
  parentKey: string;
  projectSlug: string;
  name?: string;
  description?: string;
  phases: WfPhase[];
  scriptPath?: string;
  startedAt?: number;
  lastAt?: number;
  status: WfRunStatus;
  /** Final status recorded in workflows/<runId>.json once the run ended (OBSERVED). */
  finalStatus?: string;
  /** Short redacted error recorded for the run. */
  error?: string;
  agents: WfAgent[];
}

export interface BgAgent {
  agentId: string;
  sessionId: string;
  parentKey: string;
  sessionKey: string;
  agentType?: string;
  description?: string;
  transcript: string;
  bytes: number;
  mtimeMs: number;
  birthMs?: number;
}

export interface WorkflowsSnapshot {
  runs: WfRun[];
  background: BgAgent[];
  scannedAt: number;
  scanMs: number;
  diagnostics: string[];
}

export const LIVE_WINDOW_MS = 10 * 60_000;
export const HISTORY_MS = 7 * 86400_000;
const DISCOVER_EVERY_MS = 30_000;
const MAX_PARSE_LINE = 256 * 1024;
const MAX_JOURNAL_BYTES = 8 << 20;
const MAX_META_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_BG = 120;
const MAX_STATE_BYTES = 4 << 20;

export interface TranscriptState {
  cursor?: Cursor;
  model?: string;
  firstAt?: number;
  lastAt?: number;
  usage: Map<string, number>;
  output: Map<string, number>;
  open: Map<string, { name: string; at?: number }>;
  tools: number;
  toolErrors: number;
  lastTool?: string;
  lastToolAt?: number;
  mtimeMs: number;
}

interface RunDir {
  dir: string;
  runId: string;
  sessionId: string;
  slug: string;
  sessionDir: string;
}

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;

export class WorkflowScanner {
  private runDirs: RunDir[] = [];
  private bgFiles: { file: string; sessionId: string; sessionDir: string }[] = [];
  private discoveredAt = -Infinity;
  private transcripts = new Map<string, TranscriptState>();
  private journals = new Map<string, { size: number; mtimeMs: number; recs: JournalRecs }>();
  private metas = new Map<string, { mtimeMs: number; meta: AgentMeta }>();
  private scripts = new Map<string, { file?: string; mtimeMs: number; meta?: ScriptMeta }>();
  private states = new Map<string, { mtimeMs: number; state?: RunState }>();
  private diags: string[] = [];

  constructor(private readonly projectsDir: string) {}

  scan(now = Date.now()): WorkflowsSnapshot {
    const t0 = Date.now();
    this.diags = [];
    if (now - this.discoveredAt >= DISCOVER_EVERY_MS) this.discover(now);
    const runs: WfRun[] = [];
    for (const rd of this.runDirs) {
      const run = this.readRun(rd, now);
      if (run) runs.push(run);
    }
    runs.sort((a, b) => (b.startedAt ?? b.lastAt ?? 0) - (a.startedAt ?? a.lastAt ?? 0));
    const background: BgAgent[] = [];
    for (const f of this.bgFiles) {
      let st: fs.Stats;
      try {
        st = fs.statSync(f.file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > HISTORY_MS || st.size === 0) continue;
      const id = AGENT_FILE.exec(path.basename(f.file))?.[1] ?? '';
      const meta = this.meta(f.file.replace(/\.jsonl$/, '.meta.json'));
      background.push({
        agentId: id,
        sessionId: f.sessionId,
        parentKey: `claude:${f.sessionId}`,
        sessionKey: `claude:${f.sessionId}/agent-${id}`,
        agentType: meta.agentType,
        description: meta.description,
        transcript: f.file,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        birthMs: st.birthtimeMs > 0 ? st.birthtimeMs : undefined,
      });
    }
    background.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { runs, background: background.slice(0, MAX_BG), scannedAt: now, scanMs: Date.now() - t0, diagnostics: this.diags.slice(0, 20) };
  }

  /** Walks projects/<slug>/<session>/subagents once every 30 s; per-tick work only stats known dirs. */
  private discover(now: number): void {
    this.discoveredAt = now;
    const runDirs: RunDir[] = [];
    const bg: { file: string; sessionId: string; sessionDir: string }[] = [];
    for (const slug of listDirs(this.projectsDir)) {
      const pdir = path.join(this.projectsDir, slug);
      for (const sid of listDirs(pdir)) {
        const sdir = path.join(pdir, sid);
        const sub = path.join(sdir, 'subagents');
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(sub, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isFile() && AGENT_FILE.test(e.name)) bg.push({ file: path.join(sub, e.name), sessionId: sid, sessionDir: sdir });
          else if (e.isDirectory() && e.name === 'workflows') {
            for (const runId of listDirs(path.join(sub, 'workflows'))) {
              const dir = path.join(sub, 'workflows', runId);
              const mt = mtime(dir);
              const jt = mtime(path.join(dir, 'journal.jsonl'));
              if (Math.max(mt ?? 0, jt ?? 0) < now - HISTORY_MS) continue;
              runDirs.push({ dir, runId, sessionId: sid, slug, sessionDir: sdir });
            }
          }
        }
      }
    }
    this.runDirs = runDirs;
    this.bgFiles = bg;
  }

  private readRun(rd: RunDir, now: number): WfRun | undefined {
    if (!isInside(this.projectsDir, rd.dir)) return undefined;
    const recs = this.journal(path.join(rd.dir, 'journal.jsonl'));
    let files: string[] = [];
    try {
      files = fs.readdirSync(rd.dir).filter(f => AGENT_FILE.test(f));
    } catch {
      return undefined;
    }
    const ids = new Set<string>([...recs.started.keys(), ...files.map(f => AGENT_FILE.exec(f)![1])]);
    const agents: WfAgent[] = [];
    for (const id of ids) {
      const file = path.join(rd.dir, `agent-${id}.jsonl`);
      const started = recs.started.get(id);
      const meta = this.meta(path.join(rd.dir, `agent-${id}.meta.json`));
      const tr = files.includes(`agent-${id}.jsonl`) ? this.transcript(file) : undefined;
      const res = recs.results.get(id);
      let status: WfAgentStatus;
      let basis: string;
      if (res) {
        status = res.failed ? 'failed' : 'done';
        basis = res.failed ? 'OBSERVED: journal result reports a failure' : 'OBSERVED: journal has a result';
      } else if (tr && now - tr.mtimeMs < LIVE_WINDOW_MS) {
        status = 'running';
        basis = 'INFERRED: started, no result, transcript written < 10 min ago';
      } else {
        status = 'stale';
        basis = 'INFERRED: started, no result, transcript quiet ≥ 10 min';
      }
      let tokens = 0;
      let out = 0;
      if (tr) {
        for (const v of tr.usage.values()) tokens += v;
        for (const v of tr.output.values()) out += v;
      }
      const open = tr ? [...tr.open.values()].pop() : undefined;
      agents.push({
        agentId: id,
        label: started?.label ?? meta.description ?? id,
        phase: started?.phase ?? meta.workflowPhase,
        agentType: meta.agentType,
        description: meta.description,
        worktree: meta.worktreePath,
        spawnDepth: meta.spawnDepth,
        model: tr?.model,
        firstAt: tr?.firstAt,
        lastAt: tr?.lastAt,
        tokens,
        outputTokens: out,
        calls: tr?.usage.size ?? 0,
        tools: tr?.tools ?? 0,
        toolErrors: tr?.toolErrors ?? 0,
        lastTool: tr?.lastTool,
        lastToolAt: tr?.lastToolAt,
        currentTool: status === 'running' ? open?.name : undefined,
        status,
        statusBasis: basis,
        result: res?.summary,
        transcript: tr ? file : undefined,
        transcriptBytes: tr?.cursor?.size,
        sessionKey: `claude:${rd.sessionId}/agent-${id}`,
      });
    }
    // Journal order first (started order), unknown agents after.
    const order = [...recs.started.keys()];
    agents.sort((a, b) => idx(order, a.agentId) - idx(order, b.agentId) || (a.firstAt ?? 0) - (b.firstAt ?? 0));
    const st0 = this.runState(path.join(rd.sessionDir, "workflows", `${rd.runId}.json`));
    const fin = st0?.status && !/^(running|pending|queued|in_progress|started)$/i.test(st0.status) ? st0 : st0 ? { ...st0, status: undefined } : undefined;
    const script = this.script(rd) ?? fin?.meta;
    if (fin?.status) {
      for (const a of agents) if (a.status === 'running') {
        a.status = 'stale';
        a.statusBasis = `OBSERVED: run ended (${fin.status}) before this agent returned a result`;
        a.currentTool = undefined;
      }
    }
    const firsts = agents.map(a => a.firstAt).filter((x): x is number => x !== undefined);
    const lasts = agents.map(a => a.lastAt).filter((x): x is number => x !== undefined);
    const jStat = stat(path.join(rd.dir, 'journal.jsonl'));
    const startedAt = fin?.startTime ?? (firsts.length ? Math.min(...firsts) : jStat && jStat.birthtimeMs > 0 ? jStat.birthtimeMs : undefined);
    const lastAt = (fin?.startTime && fin.durationMs !== undefined ? fin.startTime + fin.durationMs : undefined) ?? (Math.max(...lasts, jStat?.mtimeMs ?? 0) || undefined);
    let status: WfRunStatus;
    if (fin?.status) status = /^(completed|done|succeeded|success)$/i.test(fin.status) ? 'done' : /kill|cancel|abort|stop/i.test(fin.status) ? 'killed' : 'failed';
    else if (agents.some(a => a.status === 'running')) status = 'running';
    else if (agents.length && agents.every(a => a.status === 'done' || a.status === 'failed')) status = 'done';
    else if (!agents.length && recs.launched && lastAt && now - lastAt < LIVE_WINDOW_MS) status = 'running';
    else status = 'stale';
    const phases = script?.phases.length ? script.phases.slice() : [];
    for (const a of agents) if (a.phase && !phases.some(p => p.title === a.phase)) phases.push({ title: a.phase });
    return {
      runId: rd.runId,
      sessionId: rd.sessionId,
      parentKey: `claude:${rd.sessionId}`,
      projectSlug: rd.slug,
      name: script?.name ?? fin?.name,
      description: script?.description,
      finalStatus: fin?.status,
      error: fin?.error,
      phases,
      scriptPath: this.scripts.get(rd.dir)?.file,
      startedAt,
      lastAt,
      status,
      agents,
    };
  }

  private journal(file: string): JournalRecs {
    const st = stat(file);
    const empty: JournalRecs = { launched: false, started: new Map(), results: new Map() };
    if (!st) return empty;
    const c = this.journals.get(file);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.recs;
    if (st.size > MAX_JOURNAL_BYTES) {
      this.diags.push(`journal too large, skipped: ${path.basename(path.dirname(file))}`);
      return c?.recs ?? empty;
    }
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return c?.recs ?? empty;
    }
    const recs = parseJournal(text);
    this.journals.set(file, { size: st.size, mtimeMs: st.mtimeMs, recs });
    return recs;
  }

  /** workflows/<runId>.json, written when a run ends. Only small fields are kept (never result / logs). */
  private runState(file: string): RunState | undefined {
    const st = stat(file);
    if (!st) return undefined;
    const c = this.states.get(file);
    if (c && c.mtimeMs === st.mtimeMs) return c.state;
    let state: RunState | undefined;
    if (st.size <= MAX_STATE_BYTES) {
      try {
        state = parseRunState(fs.readFileSync(file, 'utf8'));
      } catch {
        this.diags.push(`run state unreadable: ${path.basename(file)}`);
      }
    }
    this.states.set(file, { mtimeMs: st.mtimeMs, state });
    return state;
  }

  private meta(file: string): AgentMeta {
    const st = stat(file);
    if (!st || st.size > MAX_META_BYTES) return {};
    const c = this.metas.get(file);
    if (c && c.mtimeMs === st.mtimeMs) return c.meta;
    let meta: AgentMeta = {};
    try {
      meta = parseAgentMeta(fs.readFileSync(file, 'utf8'));
    } catch {
      /* unreadable */
    }
    this.metas.set(file, { mtimeMs: st.mtimeMs, meta });
    return meta;
  }

  private script(rd: RunDir): ScriptMeta | undefined {
    const dir = path.join(rd.sessionDir, 'workflows', 'scripts');
    const c = this.scripts.get(rd.dir);
    const dm = mtime(dir) ?? 0;
    if (c && c.mtimeMs === dm) return c.meta;
    let file: string | undefined;
    try {
      const f = fs.readdirSync(dir).find(n => n.endsWith(`-${rd.runId}.js`) || n === `${rd.runId}.js`);
      if (f) file = path.join(dir, f);
    } catch {
      /* no scripts dir */
    }
    let meta: ScriptMeta | undefined;
    if (file) {
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(MAX_SCRIPT_BYTES);
          const n = fs.readSync(fd, buf, 0, MAX_SCRIPT_BYTES, 0);
          meta = parseScriptMeta(buf.subarray(0, n).toString('utf8'));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        this.diags.push(`script unreadable: ${path.basename(file)}`);
      }
    }
    this.scripts.set(rd.dir, { file, mtimeMs: dm, meta });
    return meta;
  }

  private transcript(file: string): TranscriptState | undefined {
    const st = stat(file);
    if (!st) return this.transcripts.get(file);
    let t = this.transcripts.get(file);
    if (t && t.cursor && t.cursor.size === st.size && t.cursor.mtimeMs === st.mtimeMs) return t;
    if (!t) {
      t = newTranscript();
      this.transcripts.set(file, t);
    }
    const cur = t;
    try {
      const res = readNewLines(file, cur.cursor, line => transcriptLine(cur, line));
      if (res.reset) {
        const fresh = newTranscript();
        this.transcripts.set(file, fresh);
        readNewLines(file, undefined, line => transcriptLine(fresh, line));
        fresh.cursor = { ...res.cursor };
        fresh.mtimeMs = st.mtimeMs;
        return fresh;
      }
      cur.cursor = res.cursor;
    } catch {
      this.diags.push(`transcript unreadable: ${path.basename(file)}`);
    }
    cur.mtimeMs = st.mtimeMs;
    return cur;
  }
}

// ---------------------------------------------------------------- pure parsers (tested)

export interface JournalRecs {
  launched: boolean;
  started: Map<string, { label?: string; phase?: string }>;
  results: Map<string, { summary: string; failed: boolean }>;
}

export function parseJournal(text: string): JournalRecs {
  const recs: JournalRecs = { launched: false, started: new Map(), results: new Map() };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const o = safeParse(line);
    if (!o) continue;
    if (o.type === 'launched') recs.launched = true;
    const id = typeof o.agentId === 'string' ? o.agentId.slice(0, 80) : undefined;
    if (!id) continue;
    if (o.type === 'started') recs.started.set(id, { label: str(o.label, 80), phase: str(o.phase, 60) });
    else if (o.type === 'result') recs.results.set(id, summarizeResult(o.result));
  }
  return recs;
}

const FAIL_RE = /\b(fail(ed|ure)?|error|blocked|abort(ed)?|crash(ed)?)\b/i;
const STATUS_KEYS = ['status', 'state', 'outcome', 'verdict'];
const TEXT_KEYS = ['line', 'summary', 'notes', 'note', 'result', 'message', 'lines'];

/** ≤ 160 chars, redacted, single line. Never the raw result. */
export function summarizeResult(r: unknown): { summary: string; failed: boolean } {
  if (r === null || r === undefined) return { summary: '(no result)', failed: false };
  if (typeof r === 'string') {
    const first = r.split('\n').find(l => l.trim()) ?? '';
    return { summary: bounded(first.replace(/[*`#>]/g, ''), 160), failed: /^\s*(error|failed|fail)\b/i.test(r) };
  }
  if (typeof r !== 'object') return { summary: bounded(String(r), 160), failed: r === false };
  if (Array.isArray(r)) return { summary: `${r.length} item${r.length === 1 ? '' : 's'}`, failed: false };
  const o = r as Record<string, unknown>;
  let status: string | undefined;
  for (const k of STATUS_KEYS) if (typeof o[k] === 'string') { status = o[k] as string; break; }
  let failed = (status !== undefined && FAIL_RE.test(status)) || o.ok === false || o.success === false || typeof o.error === 'string';
  let text: string | undefined;
  for (const k of TEXT_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) { text = v.split('\n').find(l => l.trim()); break; }
    if (Array.isArray(v) && typeof v[0] === 'string') { text = `${v[0]}${v.length > 1 ? ` (+${v.length - 1})` : ''}`; break; }
  }
  if (!text) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(o).slice(0, 6)) {
      if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
      else if (typeof v === 'string') parts.push(`${k}: ${v.slice(0, 40)}`);
      else parts.push(k);
    }
    text = parts.join(' · ');
  }
  if (!failed && status === undefined && typeof text === 'string' && /^\s*(error|failed)\b/i.test(text)) failed = true;
  const s = [status, text].filter(Boolean).join(' · ');
  return { summary: bounded(s.replace(/[*`#>]/g, ''), 160), failed };
}

export interface RunState {
  name?: string;
  status?: string;
  startTime?: number;
  durationMs?: number;
  error?: string;
  meta?: ScriptMeta;
}

export function parseRunState(text: string): RunState | undefined {
  const o = safeParse(text);
  if (!o) return undefined;
  const err = o.error;
  return {
    name: str(o.workflowName, 80),
    status: str(o.status, 30),
    startTime: toMs(o.startTime) ?? toMs(o.timestamp),
    durationMs: typeof o.durationMs === 'number' && o.durationMs >= 0 ? o.durationMs : undefined,
    error: typeof err === 'string' ? bounded(err, 160) : err && typeof err === 'object' && typeof err.message === 'string' ? bounded(err.message, 160) : undefined,
    meta: typeof o.script === 'string' ? parseScriptMeta(o.script.slice(0, MAX_SCRIPT_BYTES)) : undefined,
  };
}

export interface AgentMeta {
  agentType?: string;
  description?: string;
  workflowPhase?: string;
  worktreePath?: string;
  spawnDepth?: number;
}

export function parseAgentMeta(text: string): AgentMeta {
  const m = safeParse(text);
  if (!m) return {};
  return {
    agentType: str(m.agentType, 60),
    description: str(m.description, 120),
    workflowPhase: str(m.workflowPhase, 60),
    worktreePath: typeof m.worktreePath === 'string' && m.worktreePath.length < 400 ? m.worktreePath : undefined,
    spawnDepth: typeof m.spawnDepth === 'number' ? m.spawnDepth : undefined,
  };
}

export interface ScriptMeta {
  name?: string;
  description?: string;
  phases: WfPhase[];
}

const STRING_LIT = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;

/** Extracts `export const meta = {...}` by brace matching (strings respected) and reads its fields with regexes. Never evaluates. */
export function parseScriptMeta(src: string): ScriptMeta | undefined {
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(src);
  if (!m) return undefined;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  let q: string | undefined;
  for (let i = start; i < src.length && i < start + 32_000; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const body = src.slice(start + 1, end);
  const pm = /\bphases\s*:\s*\[/.exec(body);
  let phasesText = '';
  let top = body;
  if (pm) {
    let d = 0;
    let e = body.length;
    let qq: string | undefined;
    for (let i = pm.index + pm[0].length - 1; i < body.length; i++) {
      const ch = body[i];
      if (qq) {
        if (ch === '\\') i++;
        else if (ch === qq) qq = undefined;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') qq = ch;
      else if (ch === '[') d++;
      else if (ch === ']' && --d === 0) {
        e = i;
        break;
      }
    }
    phasesText = body.slice(pm.index, e + 1);
    top = body.slice(0, pm.index) + body.slice(e + 1);
  }
  const field = (text: string, key: string) => {
    const r = new RegExp(String.raw`\b${key}\s*:\s*` + STRING_LIT).exec(text);
    return r ? str(unescapeJs(r[2]), key === 'name' ? 80 : 200) : undefined;
  };
  const phases: WfPhase[] = [];
  const objRe = /\{([^{}]*)\}/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(phasesText)) && phases.length < 40) {
    const title = field(om[1], 'title');
    if (title) phases.push({ title: title.slice(0, 60), detail: field(om[1], 'detail') });
  }
  if (!phases.length) {
    // phases: ['A', 'B'] form
    const sr = new RegExp(STRING_LIT, 'g');
    let sm: RegExpExecArray | null;
    while ((sm = sr.exec(phasesText.replace(/^phases\s*:/, ''))) && phases.length < 40) phases.push({ title: bounded(unescapeJs(sm[2]), 60) });
  }
  return { name: field(top, 'name'), description: field(top, 'description'), phases };
}

function unescapeJs(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? ' ' : c));
}

export function newTranscript(): TranscriptState {
  return { usage: new Map(), output: new Map(), open: new Map(), tools: 0, toolErrors: 0, mtimeMs: 0 };
}

/** One transcript line into the running stats. Exported for tests. */
export function transcriptLine(t: TranscriptState, line: string): void {
  if (line.length > MAX_PARSE_LINE) {
    // Huge records are tool outputs: keep the timestamp and close the tool call they answer.
    const ts = /"timestamp":"([^"]{10,40})"/.exec(line.slice(-4000)) ?? /"timestamp":"([^"]{10,40})"/.exec(line.slice(0, 4000));
    touch(t, toMs(ts?.[1]));
    const ids = line.slice(0, 8000).match(/"tool_use_id":"([^"]{1,100})"/g) ?? [];
    for (const m of ids) t.open.delete(m.slice(15, -1));
    if (/"is_error":true/.test(line.slice(0, 8000))) t.toolErrors++;
    return;
  }
  const o = safeParse(line);
  if (!o) return;
  const at = toMs(o.timestamp);
  touch(t, at);
  const msg = o.message;
  if (o.type === 'assistant' && msg && typeof msg === 'object') {
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') t.model = msg.model.slice(0, 60);
    const u = msg.usage;
    if (u && typeof u === 'object' && typeof msg.id === 'string') {
      const n = (x: unknown) => (typeof x === 'number' && x >= 0 ? x : 0);
      t.usage.set(msg.id, n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens));
      t.output.set(msg.id, n(u.output_tokens));
    }
  }
  if (!Array.isArray(msg?.content)) return;
  for (const c of msg.content) {
    if (c?.type === 'tool_use' && typeof c.name === 'string') {
      t.tools++;
      const label = toolLabel(c.name, c.input);
      t.lastTool = label;
      t.lastToolAt = at ?? t.lastAt;
      if (typeof c.id === 'string') t.open.set(c.id, { name: label, at });
    } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      t.open.delete(c.tool_use_id);
      if (c.is_error === true) t.toolErrors++;
    }
  }
}

function toolLabel(name: string, input: any): string {
  const n = bounded(name, 40);
  if (!input || typeof input !== 'object') return n;
  const d = typeof input.description === 'string' ? input.description
    : typeof input.file_path === 'string' ? path.basename(input.file_path)
    : typeof input.pattern === 'string' ? input.pattern
    : typeof input.command === 'string' ? input.command
    : typeof input.url === 'string' ? input.url.replace(/[?#].*$/, '')
    : '';
  const detail = bounded(d, 60);
  return detail ? `${n} · ${detail}` : n;
}

function touch(t: TranscriptState, at: number | undefined): void {
  if (at === undefined) return;
  if (t.firstAt === undefined || at < t.firstAt) t.firstAt = at;
  if (t.lastAt === undefined || at > t.lastAt) t.lastAt = at;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? bounded(v, max) : undefined;
}

function idx(order: string[], id: string): number {
  const i = order.indexOf(id);
  return i < 0 ? 1e9 : i;
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function mtime(p: string): number | undefined {
  return stat(p)?.mtimeMs;
}

const scanners = new Map<string, WorkflowScanner>();
/** One scanner (with its caches) per projects dir. */
export function workflowScanner(projectsDir: string): WorkflowScanner {
  let s = scanners.get(projectsDir);
  if (!s) scanners.set(projectsDir, (s = new WorkflowScanner(projectsDir)));
  return s;
}
