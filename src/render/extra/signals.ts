// Add-on screen "Signals". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const signalsView: ExtraView = {
  id: 'signals',
  label: 'Signals',
  group: 'Quality',
  hint: "Failure signals with an observed basis: unsolved, blocked, permissions, swallowed, looping.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
