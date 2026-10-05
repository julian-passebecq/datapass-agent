// Add-on screen "History". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const historyView: ExtraView = {
  id: 'history',
  label: 'History',
  group: 'Time',
  hint: "Long-term weekly rollups from the local archive (built by the weekly script), including archived Claude / Codex sessions.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
