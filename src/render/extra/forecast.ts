// Add-on screen "Forecast". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const forecastView: ExtraView = {
  id: 'forecast',
  label: 'Forecast',
  group: 'Time',
  hint: 'Gantt of running workflows, agents and sessions with projected end times from your own history (no AI).',
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
