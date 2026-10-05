// Add-on screen "Repositories". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const reposView: ExtraView = {
  id: 'repos',
  label: 'Repositories',
  group: 'Git',
  hint: "Every repository agents touched: branches, worktrees, dirty state, ahead / behind.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
