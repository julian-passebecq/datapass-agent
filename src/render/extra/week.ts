// Add-on screen "Week". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const weekView: ExtraView = {
  id: 'week',
  label: 'Week',
  group: 'Time',
  hint: "Sessions on a Monday–Sunday calendar.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
