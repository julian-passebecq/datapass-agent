// Add-on screen "Settings". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const settingsView: ExtraView = {
  id: 'settings',
  label: 'Settings',
  group: 'System',
  hint: "Effective Claude Code and Codex configuration layers, agents and hooks (read-only, redacted).",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
