// Add-on screen "Token rhythm". Stub until its package lands (ready: false hides it from the rail).
import type { ExtraView } from './kit';

export const tokensView: ExtraView = {
  id: 'tokens',
  label: 'Token rhythm',
  group: 'Usage',
  hint: "Tokens per minute / hour / day by provider, model and session; burn rate and context growth.",
  ready: false,
  render: () => '<div class="empty">Not built yet.</div>',
};
