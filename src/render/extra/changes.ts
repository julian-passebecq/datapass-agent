// Add-on screen "Changes". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const changesView: ExtraView = {
  id: 'changes',
  label: 'Changes',
  group: 'Git',
  hint: "Files changed by sessions: per-file +/− and uncommitted work.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
