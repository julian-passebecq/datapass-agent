// Claude Code workflow runs and background subagents, read-only.
// Layout (all under ~/.claude/projects/<slug>/<sessionId>/):
//   subagents/workflows/<runId>/journal.jsonl          {"type":"launched"} / {"type":"started",agentId,label,phase} / {"type":"result",agentId,result}
//   subagents/workflows/<runId>/agent-<id>.jsonl       that agent's transcript (assistant records: model, usage, tool_use; user: tool_result)
//   subagents/workflows/<runId>/agent-<id>.meta.json   {agentType, description, workflowPhase, worktreePath, spawnDepth}
//   workflows/scripts/<name>-<runId>.js                the script; only its `export const meta = {...}` literal is parsed (never evaluated)
//   subagents/agent-<id>.jsonl + .meta.json            background subagents (Agent tool)
// Transcripts are tail-read (last 2 MB at first, then incrementally by byte cursor), all through fs.promises with
// regular yields so the extension host never blocks. Results are never kept raw: only a short redacted summary.
import * as fs from 'fs';
import * as path from 'path';
import { readNewLinesAsync, safeParse, toMs, Cursor, yielder } from '../../util/jsonl';
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
  /** Reasoning effort recorded for this agent (OBSERVED): assistant record .effort, else meta.json effort. */
  effort?: string;
  effortSource?: 'transcript' | 'meta';
  firstAt?: number;
  lastAt?: number;
  /**
   * DERIVED: sum over unique message ids of input + cache read + cache creation + output tokens. Cache reads
   * are re-counted on every call, so this is far above the new tokens processed; show outputTokens next to it.
   */
  tokens: number;
  /** OBSERVED output tokens, summed over unique message ids. */
  outputTokens: number;
  /** Only the transcript tail was read (file > TAIL_BYTES): tokens, calls and tools cover that tail only. */
  tokensPartial?: boolean;
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
/** Feed cadence: a full scan every 3 s while a run is live, else every 30 s (the cached snapshot is returned in between). */
export const LIVE_SCAN_MS = 3000;
export const IDLE_SCAN_MS = 30_000;
/** First read of an agent transcript covers at most its last 2 MB; later reads are incremental (by size). */
export const TAIL_BYTES = 2 << 20;
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
  effort?: string;
  firstAt?: number;
  lastAt?: number;
  /** File creation time: the start time when only the tail was read. */
  birthMs?: number;
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

interface BgFile {
  sessionId: string;
  mtimeMs: number;
  size: number;
  birthMs?: number;
}

interface Entry {
  name: string;
  dir: boolean;
  file: boolean;
}

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;

/** Cadence for the next scan: 3 s while a run is live, else 30 s. */
export function scanIntervalMs(snap: WorkflowsSnapshot): number {
  return snap.runs.some(r => r.status === 'running') ? LIVE_SCAN_MS : IDLE_SCAN_MS;
}

/**
 * Async, incremental scanner. All file access goes through fs.promises and the loops yield to the event
 * loop every ~12 ms, so the extension host is never blocked by a scan (first scan included).
 */
export class WorkflowScanner {
  private runDirs: RunDir[] = [];
  private bgFiles = new Map<string, BgFile>();
  private discoveredAt = -Infinity;
  private transcripts = new Map<string, TranscriptState>();
  private journals = new Map<string, { size: number; mtimeMs: number; recs: JournalRecs }>();
  private metas = new Map<string, { mtimeMs: number; meta: AgentMeta }>();
  private scripts = new Map<string, { file?: string; mtimeMs: number; meta?: ScriptMeta }>();
  private states = new Map<string, { mtimeMs: number; state?: RunState }>();
  /** Directory listings, re-read only when the directory mtime changes. */
  private dirs = new Map<string, { mtimeMs: number; entries: Entry[]; usedAt: number }>();
  /** Finished runs (final state written): reused while journal and state file are unchanged. */
  private finished = new Map<string, { key: string; run: WfRun }>();
  private diags: string[] = [];
  private inflight?: Promise<WorkflowsSnapshot>;
  private last?: WorkflowsSnapshot;
  private pause = yielder();

  constructor(private readonly projectsDir: string) {}

  /** The cached snapshot while it is fresher than its cadence (scanIntervalMs), else a new scan. */
  scanIfDue(now = Date.now()): Promise<WorkflowsSnapshot> {
    const l = this.last;
    if (l && now >= l.scannedAt && now - l.scannedAt < scanIntervalMs(l)) return Promise.resolve(l);
    return this.scan(now);
  }

  /** One scan at a time: a call during a scan gets that scan's result. */
  scan(now = Date.now()): Promise<WorkflowsSnapshot> {
    if (!this.inflight) {
      this.inflight = this.doScan(now).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async doScan(now: number): Promise<WorkflowsSnapshot> {
    const t0 = Date.now();
    this.diags = [];
    this.pause = yielder();
    if (now - this.discoveredAt >= DISCOVER_EVERY_MS) await this.discover(now);
    const runs: WfRun[] = [];
    for (const rd of this.runDirs) {
      const run = await this.readRun(rd, now);
      if (run) runs.push(run);
      await this.pause();
    }
    runs.sort((a, b) => (b.startedAt ?? b.lastAt ?? 0) - (a.startedAt ?? a.lastAt ?? 0));
    const background = await this.background(now);
    const snap: WorkflowsSnapshot = { runs, background, scannedAt: now, scanMs: Date.now() - t0, diagnostics: this.diags.slice(0, 20) };
    this.last = snap;
    return snap;
  }

  /** Background subagents: files that may still be written (< 10 min) are re-statted; the rest keep their discovery stat. */
  private async background(now: number): Promise<BgAgent[]> {
    const list: { file: string; f: BgFile }[] = [];
    for (const [file, f] of this.bgFiles) {
      if (now - f.mtimeMs < LIVE_WINDOW_MS) {
        const st = await statA(file);
        if (!st) {
          this.bgFiles.delete(file);
          continue;
        }
        f.mtimeMs = st.mtimeMs;
        f.size = st.size;
      }
      if (now - f.mtimeMs > HISTORY_MS || f.size === 0) continue;
      list.push({ file, f });
    }
    list.sort((a, b) => b.f.mtimeMs - a.f.mtimeMs);
    const out: BgAgent[] = [];
    for (const { file, f } of list.slice(0, MAX_BG)) {
      const id = AGENT_FILE.exec(path.basename(file))?.[1] ?? '';
      const meta = await this.meta(file.replace(/\.jsonl$/, '.meta.json'));
      out.push({
        agentId: id,
        sessionId: f.sessionId,
        parentKey: `claude:${f.sessionId}`,
        sessionKey: `claude:${f.sessionId}/agent-${id}`,
        agentType: meta.agentType,
        description: meta.description,
        transcript: file,
        bytes: f.size,
        mtimeMs: f.mtimeMs,
        birthMs: f.birthMs,
      });
    }
    return out;
  }

  /**
   * Walks projects/<slug>/<session>/subagents once every 30 s with cached listings. Sessions idle for 7 days
   * are skipped, background files are kept only when written in the last 7 days, and caches of runs and
   * transcripts that left the window are dropped.
   */
  private async discover(now: number): Promise<void> {
    this.discoveredAt = now;
    const cutoff = now - HISTORY_MS;
    const runDirs: RunDir[] = [];
    const bg = new Map<string, BgFile>();
    for (const slug of dirNames(await this.list(this.projectsDir, now))) {
      const pdir = path.join(this.projectsDir, slug);
      for (const sid of dirNames(await this.list(pdir, now))) {
        await this.pause();
        const sdir = path.join(pdir, sid);
        const sub = path.join(sdir, 'subagents');
        const subMt = await mtimeA(sub);
        if (subMt === undefined) continue;
        const wfDir = path.join(sub, 'workflows');
        const lastWrite = Math.max(subMt, (await mtimeA(path.join(pdir, `${sid}.jsonl`))) ?? 0, (await mtimeA(wfDir)) ?? 0);
        if (lastWrite < cutoff) continue;
        for (const e of (await this.list(sub, now)) ?? []) {
          if (e.file && AGENT_FILE.test(e.name)) {
            const file = path.join(sub, e.name);
            const st = await statA(file);
            if (!st || st.mtimeMs < cutoff) continue;
            bg.set(file, { sessionId: sid, mtimeMs: st.mtimeMs, size: st.size, birthMs: st.birthtimeMs > 0 ? st.birthtimeMs : undefined });
          } else if (e.dir && e.name === 'workflows') {
            for (const runId of dirNames(await this.list(wfDir, now))) {
              const dir = path.join(wfDir, runId);
              const mt = await mtimeA(dir);
              const jt = await mtimeA(path.join(dir, 'journal.jsonl'));
              if (Math.max(mt ?? 0, jt ?? 0) < cutoff) continue;
              runDirs.push({ dir, runId, sessionId: sid, slug, sessionDir: sdir });
            }
          }
        }
      }
    }
    this.runDirs = runDirs;
    this.bgFiles = bg;
    const runSet = new Set(runDirs.map(r => r.dir));
    const stateFiles = new Set(runDirs.map(r => stateFileOf(r)));
    const inRun = (f: string) => runSet.has(path.dirname(f));
    prune(this.transcripts, (f, t) => inRun(f) && t.mtimeMs >= cutoff);
    prune(this.journals, f => inRun(f));
    prune(this.metas, f => inRun(f) || bg.has(f.replace(/\.meta\.json$/, '.jsonl')));
    prune(this.states, f => stateFiles.has(f));
    prune(this.scripts, d => runSet.has(d));
    prune(this.finished, d => runSet.has(d));
    prune(this.dirs, (_, v) => now - v.usedAt <= 2 * DISCOVER_EVERY_MS);
  }

  /** readdir, cached by directory mtime (an added or removed entry changes it). Recently changed dirs are always re-read. */
  private async list(dir: string, now: number): Promise<Entry[] | undefined> {
    const st = await statA(dir);
    if (!st || !st.isDirectory()) {
      this.dirs.delete(dir);
      return undefined;
    }
    const c = this.dirs.get(dir);
    if (c && c.mtimeMs === st.mtimeMs && Date.now() - st.mtimeMs > 2000) {
      c.usedAt = now;
      return c.entries;
    }
    try {
      const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
      this.dirs.set(dir, { mtimeMs: st.mtimeMs, entries, usedAt: now });
      return entries;
    } catch {
      this.dirs.delete(dir);
      return undefined;
    }
  }

  private async readRun(rd: RunDir, now: number): Promise<WfRun | undefined> {
    if (!isInside(this.projectsDir, rd.dir)) return undefined;
    const jFile = path.join(rd.dir, 'journal.jsonl');
    const stateFile = stateFileOf(rd);
    const jStat = await statA(jFile);
    const sStat = await statA(stateFile);
    const key = `${jStat?.size}:${jStat?.mtimeMs}:${sStat?.mtimeMs}`;
    const done = this.finished.get(rd.dir);
    if (done && done.key === key) return done.run;
    const recs = await this.journal(jFile, jStat);
    const entries = await this.list(rd.dir, now);
    if (!entries) return undefined;
    const files = new Set(entries.filter(e => e.file && AGENT_FILE.test(e.name)).map(e => e.name));
    const ids = new Set<string>([...recs.started.keys(), ...[...files].map(f => AGENT_FILE.exec(f)![1])]);
    const agents: WfAgent[] = [];
    for (const id of ids) {
      const file = path.join(rd.dir, `agent-${id}.jsonl`);
      const started = recs.started.get(id);
      const meta = await this.meta(path.join(rd.dir, `agent-${id}.meta.json`));
      const tr = files.has(`agent-${id}.jsonl`) ? await this.transcript(file) : undefined;
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
      const partial = !!tr?.cursor?.from;
      agents.push({
        agentId: id,
        label: started?.label ?? meta.description ?? id,
        phase: started?.phase ?? meta.workflowPhase,
        agentType: meta.agentType,
        description: meta.description,
        worktree: meta.worktreePath,
        spawnDepth: meta.spawnDepth,
        model: tr?.model,
        effort: tr?.effort ?? meta.effort,
        effortSource: tr?.effort ? 'transcript' : meta.effort ? 'meta' : undefined,
        firstAt: partial ? (tr?.birthMs ?? tr?.firstAt) : tr?.firstAt,
        lastAt: tr?.lastAt,
        tokens,
        outputTokens: out,
        tokensPartial: partial || undefined,
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
      await this.pause();
    }
    // Journal order first (started order), unknown agents after.
    const order = [...recs.started.keys()];
    agents.sort((a, b) => idx(order, a.agentId) - idx(order, b.agentId) || (a.firstAt ?? 0) - (b.firstAt ?? 0));
    const st0 = await this.runState(stateFile, sStat);
    const fin = st0?.status && !/^(running|pending|queued|in_progress|started)$/i.test(st0.status) ? st0 : st0 ? { ...st0, status: undefined } : undefined;
    const script = (await this.script(rd, now)) ?? fin?.meta;
    if (fin?.status) {
      for (const a of agents) if (a.status === 'running') {
        a.status = 'stale';
        a.statusBasis = `OBSERVED: run ended (${fin.status}) before this agent returned a result`;
        a.currentTool = undefined;
      }
    }
    const firsts = agents.map(a => a.firstAt).filter((x): x is number => x !== undefined);
    const lasts = agents.map(a => a.lastAt).filter((x): x is number => x !== undefined);
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
    const run: WfRun = {
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
    // Once the final state is written nothing in the run depends on `now` any more.
    if (fin?.status) this.finished.set(rd.dir, { key, run });
    return run;
  }

  private async journal(file: string, st: fs.Stats | undefined): Promise<JournalRecs> {
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
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return c?.recs ?? empty;
    }
    const recs = parseJournal(text);
    this.journals.set(file, { size: st.size, mtimeMs: st.mtimeMs, recs });
    return recs;
  }

  /** workflows/<runId>.json, written when a run ends. Only small fields are kept (never result / logs). */
  private async runState(file: string, st: fs.Stats | undefined): Promise<RunState | undefined> {
    if (!st) return undefined;
    const c = this.states.get(file);
    if (c && c.mtimeMs === st.mtimeMs) return c.state;
    let state: RunState | undefined;
    if (st.size <= MAX_STATE_BYTES) {
      try {
        state = parseRunState(await fs.promises.readFile(file, 'utf8'));
      } catch {
        this.diags.push(`run state unreadable: ${path.basename(file)}`);
      }
    }
    this.states.set(file, { mtimeMs: st.mtimeMs, state });
    return state;
  }

  private async meta(file: string): Promise<AgentMeta> {
    const st = await statA(file);
    if (!st || st.size > MAX_META_BYTES) return {};
    const c = this.metas.get(file);
    if (c && c.mtimeMs === st.mtimeMs) return c.meta;
    let meta: AgentMeta = {};
    try {
      meta = parseAgentMeta(await fs.promises.readFile(file, 'utf8'));
    } catch {
      /* unreadable */
    }
    this.metas.set(file, { mtimeMs: st.mtimeMs, meta });
    return meta;
  }

  private async script(rd: RunDir, now: number): Promise<ScriptMeta | undefined> {
    const dir = path.join(rd.sessionDir, 'workflows', 'scripts');
    const c = this.scripts.get(rd.dir);
    const dm = (await mtimeA(dir)) ?? 0;
    if (c && c.mtimeMs === dm) return c.meta;
    const f = ((await this.list(dir, now)) ?? []).find(e => e.file && (e.name.endsWith(`-${rd.runId}.js`) || e.name === `${rd.runId}.js`));
    const file = f ? path.join(dir, f.name) : undefined;
    let meta: ScriptMeta | undefined;
    if (file) {
      try {
        const fh = await fs.promises.open(file, 'r');
        try {
          const buf = Buffer.alloc(MAX_SCRIPT_BYTES);
          const { bytesRead } = await fh.read(buf, 0, MAX_SCRIPT_BYTES, 0);
          meta = parseScriptMeta(buf.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await fh.close();
        }
      } catch {
        this.diags.push(`script unreadable: ${path.basename(file)}`);
      }
    }
    this.scripts.set(rd.dir, { file, mtimeMs: dm, meta });
    return meta;
  }

  /** First read: the last TAIL_BYTES only; then only appended bytes. A replaced or shrunk file starts over. */
  private async transcript(file: string): Promise<TranscriptState | undefined> {
    const st = await statA(file);
    if (!st) return this.transcripts.get(file);
    let t = this.transcripts.get(file);
    if (t && t.cursor && t.cursor.size === st.size && t.cursor.mtimeMs === st.mtimeMs) return t;
    if (!t) {
      t = newTranscript();
      this.transcripts.set(file, t);
    }
    if (t.birthMs === undefined && st.birthtimeMs > 0) t.birthMs = st.birthtimeMs;
    const cur = t;
    try {
      const res = await readNewLinesAsync(file, cur.cursor, line => transcriptLine(cur, line), { maxInitialBytes: TAIL_BYTES });
      if (res.reset) {
        const fresh = newTranscript();
        fresh.birthMs = st.birthtimeMs > 0 ? st.birthtimeMs : undefined;
        this.transcripts.set(file, fresh);
        const again = await readNewLinesAsync(file, undefined, line => transcriptLine(fresh, line), { maxInitialBytes: TAIL_BYTES });
        fresh.cursor = again.cursor;
        fresh.mtimeMs = again.cursor.mtimeMs;
        return fresh;
      }
      cur.cursor = res.cursor;
      cur.mtimeMs = res.cursor.mtimeMs;
    } catch {
      this.diags.push(`transcript unreadable: ${path.basename(file)}`);
      cur.mtimeMs = st.mtimeMs;
    }
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
  effort?: string;
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
    effort: str(m.effort, 20),
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
    if (typeof o.effort === 'string' && o.effort) t.effort = bounded(o.effort, 20);
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

function dirNames(entries: Entry[] | undefined): string[] {
  return (entries ?? []).filter(e => e.dir).map(e => e.name);
}

function stateFileOf(rd: RunDir): string {
  return path.join(rd.sessionDir, 'workflows', `${rd.runId}.json`);
}

function prune<V>(m: Map<string, V>, keep: (k: string, v: V) => boolean): void {
  for (const [k, v] of m) if (!keep(k, v)) m.delete(k);
}

async function statA(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return undefined;
  }
}

async function mtimeA(p: string): Promise<number | undefined> {
  return (await statA(p))?.mtimeMs;
}

const scanners = new Map<string, WorkflowScanner>();
/** One scanner (with its caches) per projects dir. */
export function workflowScanner(projectsDir: string): WorkflowScanner {
  let s = scanners.get(projectsDir);
  if (!s) scanners.set(projectsDir, (s = new WorkflowScanner(projectsDir)));
  return s;
}
