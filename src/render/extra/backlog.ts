// Add-on screen "Backlog". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const backlogView: ExtraView = {
  id: 'backlog',
  label: 'Backlog',
  group: 'Quality',
  hint: "Plans and packages found in repositories (handoff/PLAN.md, ROADMAP.md): state, age, and the sessions that worked on them.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
