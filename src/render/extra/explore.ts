// Add-on screen "Explore". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const exploreView: ExtraView = {
  id: 'explore',
  label: 'Explore',
  group: 'Usage',
  hint: "Pivot sessions by any dimension and metric, as bars, table, treemap or heatmap.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
