// Add-on screen "Projects". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const projectsView: ExtraView = {
  id: 'projects',
  label: 'Projects',
  group: 'Now',
  hint: "Company → project → repository → sessions. Pick a scope for every screen.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
