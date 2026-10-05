// Add-on screen "Topology". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const topologyView: ExtraView = {
  id: 'topology',
  label: 'Topology',
  group: 'Sessions',
  hint: "Lead → workers → nested workers as a tree, with rolled-up tokens and cost.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
