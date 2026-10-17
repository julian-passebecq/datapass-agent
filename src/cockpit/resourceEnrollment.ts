import { digest } from './policy';
import type { SelectedFileResource } from './resources';

export type EnabledAssertion = 'UNKNOWN' | 'ENABLED' | 'DISABLED';
export const RESOURCE_ENABLED_CHOICES = [
  { id: 'UNKNOWN' as const, label: 'UNKNOWN — enabled state not asserted', detail: 'Only selected-file metadata is observed. No resource is changed or executed.' },
  { id: 'ENABLED' as const, label: 'Enabled — reviewer assertion only', detail: 'HOST_REVIEWED_ASSERTION: not observed runtime state. No resource is changed or executed.' },
  { id: 'DISABLED' as const, label: 'Disabled — reviewer assertion only', detail: 'HOST_REVIEWED_ASSERTION: not observed runtime state. No resource is changed, re-enabled or executed.' },
] as const;

interface EnrollmentHost {
  chooseFiles(): Promise<string[] | undefined>;
  reviewEnabled(choices: typeof RESOURCE_ENABLED_CHOICES): Promise<EnabledAssertion | undefined>;
  stillAuthorized(): boolean;
  register(items: SelectedFileResource[]): void;
}

/** Host UI assertions are metadata, never an enabled-state probe or an execution instruction. */
export async function enrollDiagnosticResources(host: EnrollmentHost): Promise<boolean> {
  const files = await host.chooseFiles();
  if (!files?.length || !host.stillAuthorized()) return false;
  const assertion = await host.reviewEnabled(RESOURCE_ENABLED_CHOICES);
  if (!assertion || !RESOURCE_ENABLED_CHOICES.some(choice => choice.id === assertion) || !host.stillAuthorized()) return false;
  const enabled = assertion === 'UNKNOWN' ? null : assertion === 'ENABLED';
  host.register(files.slice(0, 50).map(file => ({
    id: 'resource:' + digest(file).slice(0, 24), file,
    kind: /\.lock$/i.test(file) ? 'LOCK' : /\.(py|ps1|js|mjs)$/i.test(file) ? 'SCRIPT' : 'FILE',
    enabled, staleAfterMs: 3600000,
  })));
  return true;
}
