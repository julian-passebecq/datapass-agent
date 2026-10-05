// Add-on screen "Review". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const reviewView: ExtraView = {
  id: 'review',
  label: 'Review',
  group: 'Git',
  hint: "Working / Needs you / In review / Ready to merge (PR state opt-in).",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
