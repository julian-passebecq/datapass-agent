import { bounded } from '../util/redact';
import { SessionStatus } from '../model';

const VERIFY = [
  /\b(npm|pnpm|yarn|bun)(\.cmd)?\s+(run\s+)?(test|tests|check|build|lint|smoke|typecheck|verify)(\b|:)/i,
  /\bnpx\s+(vitest|jest|playwright\s+test|tsc|mocha)\b/i,
  /\b(vitest|jest|mocha)\b(\s|$)/i,
  /\bpytest\b/i,
  /\bpython[0-9.]*\s+-m\s+(pytest|unittest)\b/i,
  /\bgo\s+(test|vet|build)\b/i,
  /\bcargo\s+(test|build|check|clippy)\b/i,
  /\bdotnet\s+(test|build)\b/i,
  /\bnode\s+--test\b/i,
  /\b(mvn|mvnw)\s+(\S+\s+)*(test|verify)\b/i,
  /\bgradlew?\s+(\S+\s+)*(test|check|build)\b/i,
  /(^|[\s;&|])tsc(\s|$)/i,
];

/** A command counts as a verification only by what it runs, never by what its output says. */
export function isVerificationCommand(cmd: string): boolean {
  if (!cmd) return false;
  // Heredoc bodies are data (scripts, file contents), not commands: drop them before matching.
  const lines = stripHeredocs(cmd).slice(0, 4000);
  return VERIFY.some(re => re.test(lines));
}

/** The segment of a command chain that is the verification, e.g. "npm test" out of "printf … > a.js && npm test && git commit". */
export function verificationLabel(cmd: string): string {
  const segs = stripHeredocs(cmd).split(/\r?\n|&&|\|\||;/).map(x => commandLabel(x.trim())).filter(Boolean);
  return segs.find(x => VERIFY.some(re => re.test(x))) ?? commandLabel(cmd);
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
    if (age > 2 * 60_000) return { status: 'ENDED', reason: 'no live registry entry (process exited)' };
    return { status: 'UNKNOWN', reason: 'recent activity but no live registry entry yet' };
  }
  if (s.oneShotDone) return { status: 'ENDED', reason: 'non-interactive run completed its turn' };
  if (s.openTurn && age <= idleMs) return { status: 'RUNNING', reason: 'turn started, not completed, recent activity' };
  if (s.openTurn) return { status: 'UNKNOWN', reason: 'turn open but no activity recently (crashed or stalled?)' };
  if (age <= idleMs) return { status: 'IDLE', reason: 'last turn completed recently; thread still open' };
  return { status: 'UNKNOWN', reason: 'no end event exposed by provider; inactive' };
}

/** Bounded, redacted test label. A chained test is marked: its outcome is the whole chain's status. */
export function testLabel(cmd: string): string {
  const v = verificationLabel(cmd);
  // A pipe also hides the test's exit status behind the last command's (e.g. `npm test | tail`).
  const chained = v.trim() !== commandLabel(cmd).trim() || /[^|]\|[^|]/.test(v);
  return bounded(v, 90) + (chained ? ' · in command chain' : '');
}
