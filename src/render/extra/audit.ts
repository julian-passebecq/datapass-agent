// Add-on screen "Audit trail". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const auditView: ExtraView = {
  id: 'audit',
  label: 'Audit trail',
  group: 'System',
  hint: "Chronological observed transitions, exportable locally.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
