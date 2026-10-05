// Add-on screen "Transcript". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const transcriptView: ExtraView = {
  id: 'transcript',
  label: 'Transcript',
  group: 'Sessions',
  hint: 'Read a session as a conversation: prompts, replies and tool calls, live, redacted, local only.',
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
