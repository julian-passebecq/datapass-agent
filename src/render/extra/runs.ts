// Add-on screen "Run strips". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const runsView: ExtraView = {
  id: 'runs',
  label: 'Run strips',
  group: 'Time',
  hint: "One row per repository, one tick per session over 14 days, and concurrency per hour.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
