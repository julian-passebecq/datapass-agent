// Add-on screen "Pipelines". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const pipelinesView: ExtraView = {
  id: 'pipelines',
  label: 'Pipelines',
  group: 'Git',
  hint: "GitHub Actions and GitLab pipelines for the repositories agents touch: stages, jobs as a Gantt, what blocks (opt-in, read-only CLI).",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
