// Add-on screen "Launcher". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const launcherView: ExtraView = {
  id: 'launcher',
  label: 'Launcher',
  group: 'System',
  hint: "Start or resume a Claude / Codex session in a terminal Agent owns.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
