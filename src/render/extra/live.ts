// Add-on screen "Live". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const liveView: ExtraView = {
  id: 'live',
  label: 'Live',
  group: 'Now',
  hint: "Who does what right now: every live Claude / Codex session and worker, current tool, tokens and pace.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
