import { bounded } from '../util/redact';
import type { EvidenceKind, SessionStatus, TestObservation, TestOutcome } from '../model';

/** What a checking command is. Only `test` counts as a test; builds, lints and type checks are their own kinds. */
export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build';

const PM = String.raw`(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run(?:-script)?\s+)?`;
const RUNNER = String.raw`(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn)(?:\.cmd)?\s+(?:--?\S+\s+)*`;
// Every pattern is anchored at command position: the start of one command of the line (see commandSegments).
const KINDS: [CheckKind, RegExp][] = [
  ['test', new RegExp(String.raw`^${PM}(?:test|tests|smoke|verify|e2e)(?:[\s:]|$)`, 'i')],
  ['test', new RegExp(String.raw`^${RUNNER}(?:vitest|jest|mocha|ava|playwright\s+test)\b`, 'i')],
  ['test', /^(?:vitest|jest|mocha)(?:\.cmd)?(?:\s|$)/i],
  ['test', /^(?:pytest|py\.test)(?:\.exe)?\b/i],
  ['test', /^(?:python[0-9.]*|py)(?:\.exe)?\s+(?:-\S+\s+)*-m\s+(?:pytest|unittest)\b/i],
  ['test', /^uv\s+run\s+(?:pytest|python\s+-m\s+pytest)\b/i],
  ['test', /^go\s+test\b/i],
  ['test', /^cargo\s+(?:test|nextest)\b/i],
  ['test', /^dotnet\s+test\b/i],
  ['test', /^node\s+--test\b/i],
  ['test', /^(?:mvn|mvnw)(?:\.cmd)?\s+(?:\S+\s+)*(?:test|verify)\b/i],
  ['test', /^gradlew?(?:\.bat)?\s+(?:\S+\s+)*(?:test|check)\b/i],
  ['typecheck', new RegExp(String.raw`^${PM}(?:typecheck|type-check|check|tsc)(?:[\s:]|$)`, 'i')],
  ['typecheck', new RegExp(String.raw`^(?:${RUNNER})?tsc(?:\.cmd)?(?:\s|$)`, 'i')],
  ['typecheck', /^(?:mypy|pyright)\b/i],
  ['lint', new RegExp(String.raw`^${PM}lint(?:[\s:]|$)`, 'i')],
  ['lint', new RegExp(String.raw`^(?:${RUNNER})?(?:eslint|biome|ruff|flake8|pylint)(?:\.cmd)?\b`, 'i')],
  ['lint', /^cargo\s+clippy\b/i],
  ['lint', /^go\s+vet\b/i],
  ['build', new RegExp(String.raw`^${PM}build(?:[\s:]|$)`, 'i')],
  ['build', /^go\s+build\b/i],
  ['build', /^cargo\s+(?:build|check)\b/i],
  ['build', /^dotnet\s+build\b/i],
  ['build', /^gradlew?(?:\.bat)?\s+(?:\S+\s+)*build\b/i],
  ['build', /^(?:mvn|mvnw)(?:\.cmd)?\s+(?:\S+\s+)*(?:package|compile|install)\b/i],
];

/** One command of a shell line. `masked` has quoted strings emptied; `sep` is the separator before it. */
export interface CommandSegment {
  text: string;
  masked: string;
  sep: '' | 'newline' | '&&' | '||' | ';' | '|';
}

/**
 * Splits a shell line into commands at newline, `&&`, `||`, `;` and `|` outside quotes (heredoc bodies dropped).
 * `2>&1` and other redirections are not separators.
 */
export function commandSegments(cmd: string): CommandSegment[] {
  const src = stripHeredocs(cmd || '').slice(0, 4000);
  const out: CommandSegment[] = [];
  let text = '', masked = '', sep: CommandSegment['sep'] = '';
  let q = '';
  const push = (next: CommandSegment['sep']) => {
    if (text.trim()) out.push({ text: text.trim(), masked: masked.trim(), sep });
    text = masked = '';
    sep = next;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      text += c;
      if (c === q) { q = ''; masked += c; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; text += c; masked += c; continue; }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(two); i++; continue; }
    if (c === '\n') { push('newline'); continue; }
    if (c === ';') { push(';'); continue; }
    if (c === '|') { push('|'); continue; }
    text += c;
    masked += c;
  }
  push('');
  return out;
}

/** Program part of a masked command: drops `cd x` prefixes handled elsewhere, env assignments, `&`, time / env. */
function program(masked: string): string {
  return masked
    .replace(/^[({\s]+/, '')
    .replace(/^&\s+/, '')
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    .replace(/^(?:time|env|command|exec|sudo)\s+/i, '')
    .replace(/^(?:\.{1,2}[\/]|[^\s"']*[\/])(?=[\w.-]+(?:\s|$))/, '');
}

/** Kind of one command (matched at command position only), or undefined when it is not a check. */
export function segmentKind(seg: CommandSegment): CheckKind | undefined {
  const p = program(seg.masked);
  return KINDS.find(([, re]) => re.test(p))?.[0];
}

/** Kind of a shell line: `test` when any command of it is a test, else the first build / lint / typecheck. */
export function checkKind(cmd: string): CheckKind | undefined {
  const kinds = commandSegments(cmd).map(segmentKind).filter((k): k is CheckKind => !!k);
  return kinds.includes('test') ? 'test' : kinds[0];
}

/**
 * A command counts as a test only by the program it runs at command position, never by what its arguments,
 * quoted strings or output say (`grep -rn tsc`, `echo go build`, `git log --grep="npm test"` are not tests).
 * Builds, lints and type checks are not tests (TestObservation has no kind field to keep them apart).
 */
export function isVerificationCommand(cmd: string): boolean {
  if (!cmd) return false;
  return commandSegments(cmd).some(s => segmentKind(s) === 'test');
}

/** The test command of a line plus the commands it pipes into, e.g. "npm test" out of "printf … > a.js && npm test && git commit". */
export function verificationLabel(cmd: string): string {
  const segs = commandSegments(cmd);
  const i = segs.findIndex(s => segmentKind(s) === 'test');
  if (i < 0) return commandLabel(cmd);
  let j = i + 1;
  while (j < segs.length && segs[j].sep === '|') j++;
  return segs.slice(i, j).map(s => commandLabel(s.text)).join(' | ');
}

/** True when the test of `cmd` pipes into another command: its own exit status is hidden behind the pipeline's. */
export function isPipedTest(cmd: string): boolean {
  const segs = commandSegments(cmd);
  const i = segs.findIndex(s => segmentKind(s) === 'test');
  return i >= 0 && segs[i + 1]?.sep === '|';
}

export function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(\n\s*\2\s*(\n|$)|$)/g, '<<heredoc\n');
}

/** Display form of a command: drops a leading `cd <dir> &&` that only sets the working directory. */
export function commandLabel(cmd: string): string {
  return cmd.replace(/^\s*(cd|Set-Location|pushd)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/i, '');
}

export function isGitCommit(cmd: string): boolean {
  return /\bgit(\.exe)?\s+(-[cC]\s+\S+\s+)*commit\b/i.test(cmd);
}

/** Codex wraps commands as ["powershell.exe","-Command","..."] or ["bash","-lc","..."]; keep the script part. */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    const parts = cmd.filter((x): x is string => typeof x === 'string');
    const i = parts.findIndex(p => /^-(c|lc|command)$/i.test(p));
    return i >= 0 && parts[i + 1] ? parts.slice(i + 1).join(' ') : parts.join(' ');
  }
  return '';
}

export interface LiveSignal {
  /** Provider says the session is ended (or its artifact was archived). */
  explicitEnded?: boolean;
  /** Live registry entry exists and its process is alive. */
  registryAlive?: boolean;
  registryStatus?: string;
  /** A turn started and has not completed/aborted. */
  openTurn?: boolean;
  lastActivityAt?: number;
  /** Process for a non-interactive run is known to have finished (e.g. codex exec turn complete). */
  oneShotDone?: boolean;
  /** The provider exposes a live registry, so its absence means the process is gone. */
  providerHasRegistry?: boolean;
}

/** Conservative status derivation (documented in README "Live status"). */
export function deriveStatus(s: LiveSignal, now: number, idleMs: number): { status: SessionStatus; reason: string } {
  const age = s.lastActivityAt ? now - s.lastActivityAt : Infinity;
  if (s.explicitEnded) return { status: 'ENDED', reason: 'provider marked the session ended' };
  if (s.registryAlive) {
    const st = (s.registryStatus || '').toLowerCase();
    if (st === 'busy' || st === 'running') return { status: 'RUNNING', reason: `live registry: ${st}` };
    if (st === 'idle') return { status: 'IDLE', reason: 'live registry: idle' };
    if (/wait|input|permission|blocked|approval/.test(st)) return { status: 'NEEDS_INPUT', reason: `live registry: ${st}` };
    return { status: 'UNKNOWN', reason: `live registry status "${st || 'none'}" not recognised` };
  }
  if (s.providerHasRegistry) {
    // Registry gone: process no longer running. Grace period covers registry write lag.
    if (age > 2 * 60_000) return { status: 'ENDED', reason: REGISTRY_GONE };
    return { status: 'UNKNOWN', reason: 'recent activity but no live registry entry yet' };
  }
  if (s.oneShotDone) return { status: 'ENDED', reason: 'non-interactive run completed its turn' };
  if (s.openTurn && age <= idleMs) return { status: 'RUNNING', reason: 'turn started, not completed, recent activity' };
  if (s.openTurn) return { status: 'UNKNOWN', reason: 'turn open but no activity recently (crashed or stalled?)' };
  if (age <= idleMs) return { status: 'IDLE', reason: 'last turn completed recently; thread still open' };
  return { status: 'UNKNOWN', reason: 'no end event exposed by provider; inactive' };
}

/** Reason of an end inferred from the absence of a live registry entry (no end event was recorded). */
export const REGISTRY_GONE = 'no live registry entry: process no longer active (inferred, no end recorded)';

/** True when an ENDED status is only inferred (registry entry gone), not recorded by the provider. */
export function endInferred(s: { status: SessionStatus; statusReason?: string }): boolean {
  return s.status === 'ENDED' && /no live registry entry/i.test(s.statusReason ?? '');
}

export const CHAIN_MARK = ' · in command chain';
export const PIPE_MARK = ' · piped';

/**
 * Bounded, redacted test label. A chained test is marked (its recorded outcome is the whole chain's status);
 * a piped test is marked "piped" (its own exit status is hidden behind the pipeline's).
 */
export function testLabel(cmd: string): string {
  const v = verificationLabel(cmd);
  const piped = isPipedTest(cmd);
  const chained = !piped && commandSegments(commandLabel(cmd)).length > 1;
  return bounded(v, 90) + (piped ? PIPE_MARK : chained ? CHAIN_MARK : '');
}

export interface TestVerdict {
  outcome: TestOutcome;
  kind: EvidenceKind;
  basis: string;
}

/**
 * Outcome of one test observation as far as it is evidence for the test itself. A chained or piped command
 * whose provider only recorded a tool error flag gets UNKNOWN (the flag is the last command's status, not the
 * test's). With a recorded exit code the outcome stays, labelled as the exit status of the whole line.
 */
export function testVerdict(t: Pick<TestObservation, 'command' | 'outcome' | 'source'>): TestVerdict {
  const piped = t.command.endsWith(PIPE_MARK) || (/\s\|\s/.test(t.command) && t.command.endsWith(CHAIN_MARK));
  const chained = !piped && t.command.endsWith(CHAIN_MARK);
  if (t.outcome === 'UNKNOWN') return { outcome: 'UNKNOWN', kind: 'UNKNOWN', basis: 'test ran, outcome not recorded' };
  if (piped || chained) {
    const what = piped ? 'pipeline' : 'command chain';
    if (t.source !== 'provider-exit-code') return { outcome: 'UNKNOWN', kind: 'UNKNOWN', basis: `${what}: the tool error flag is the last command's status, not the test's (recorded ${t.outcome})` };
    return { outcome: t.outcome, kind: 'OBSERVED', basis: `exit status of the whole ${what}` };
  }
  return { outcome: t.outcome, kind: 'OBSERVED', basis: t.source === 'provider-exit-code' ? 'exit code recorded by the provider' : 'tool error flag recorded by the provider' };
}
