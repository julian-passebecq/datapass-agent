// Add-on screen "Replay". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const replayView: ExtraView = {
  id: 'replay',
  label: 'Replay',
  group: 'Sessions',
  hint: "Step through one session's recorded events.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
