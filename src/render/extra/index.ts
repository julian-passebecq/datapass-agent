// Registry of add-on workspace screens. Every planned screen has its own file already registered here,
// so packages only edit their own file. A screen with ready: false stays out of the rail.
import { ExtraView, KIT_CSS } from './kit';
import { auditView } from './audit';
import { backlogView } from './backlog';
import { changesView } from './changes';
import { exploreView } from './explore';
import { healthView } from './health';
import { historyView } from './history';
import { launcherView } from './launcher';
import { liveView } from './live';
import { pipelinesView } from './pipelines';
import { projectsView } from './projects';
import { replayView } from './replay';
import { reposView } from './repos';
import { reviewView } from './review';
import { runsView } from './runs';
import { settingsView } from './settings';
import { signalsView } from './signals';
import { tokensView } from './tokens';
import { topologyView } from './topology';
import { weekView } from './week';

export const ALL_EXTRA: ExtraView[] = [
  auditView,
  backlogView,
  changesView,
  exploreView,
  healthView,
  historyView,
  launcherView,
  liveView,
  pipelinesView,
  projectsView,
  replayView,
  reposView,
  reviewView,
  runsView,
  settingsView,
  signalsView,
  tokensView,
  topologyView,
  weekView,
];

export const EXTRA_VIEWS: ExtraView[] = ALL_EXTRA.filter(v => v.ready !== false);

export function extraCss(): string {
  return KIT_CSS + EXTRA_VIEWS.map(v => v.css ?? '').join('\n');
}
