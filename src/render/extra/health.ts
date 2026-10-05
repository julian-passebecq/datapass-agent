// Add-on screen "Health". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const healthView: ExtraView = {
  id: 'health',
  label: 'Health',
  group: 'Quality',
  hint: "Test pass rate, commits per session and context use, with sparklines.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
