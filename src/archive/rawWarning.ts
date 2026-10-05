// One-time warning when raw transcript archiving (agent.archive.rawTranscripts) is first turned on:
// the gzip copies in <archive>/raw are NOT redacted. Pure logic with injected VS Code bits, so it is testable.

export const RAW_WARNED_KEY = 'agent.archive.rawWarned';
export const RAW_WARNING = 'Agent: raw transcript archiving is on. The copies in <archive>/raw are NOT redacted: they hold the full conversation text, including any key, token or password pasted in a prompt or printed by a tool. Keep the archive folder private.';

export interface RawWarnDeps {
  /** Current value of agent.archive.rawTranscripts. */
  enabled(): boolean;
  /** Persistent per-user state (ExtensionContext.globalState). */
  state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> | void };
  show(message: string): void;
}

/** Shows the warning once per user, the first time the setting is seen on. Returns true when it was shown. */
export function maybeWarnRaw(d: RawWarnDeps): boolean {
  if (!d.enabled() || d.state.get<boolean>(RAW_WARNED_KEY)) return false;
  void d.state.update(RAW_WARNED_KEY, true);
  d.show(RAW_WARNING);
  return true;
}
