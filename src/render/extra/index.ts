// Registry of add-on workspace screens. Every planned screen has its own file already registered here,
// so packages only edit their own file. A screen with ready: false stays out of the rail.
import { ExtraView, KIT_CSS } from './kit';
import { auditView } from './audit';
import { backlogView } from './backlog';
import { changesView } from './changes';
import { exploreView } from './explore';
import { forecastView } from './forecast';
import { healthView } from './health';
import { historyView } from './history';
import { launcherView } from './launcher';
import { limitsView } from './limits';
import { liveView } from './live';
import { pipelinesView } from './pipelines';
import { projectsView } from './projects';
import { replayView } from './replay';
import { reposView } from './repos';
import { reviewView } from './review';
import { rolesView } from './roles';
import { runsView } from './runs';
import { settingsView } from './settings';
import { signalsView } from './signals';
import { tokensView } from './tokens';
import { transcriptView } from './transcript';
import { topologyView } from './topology';
import { weekView } from './week';
import { workflowsView } from './workflows';

// Built lazily: screens import render/workspace, which imports this file, so the list must not be
// read while modules are still initialising (whichever module a test loads first).
let all: ExtraView[] | undefined;
export function allExtra(): ExtraView[] {
  return (all ??= [
  auditView,
  backlogView,
  changesView,
  exploreView,
  forecastView,
  healthView,
  historyView,
  launcherView,
  limitsView,
  liveView,
  pipelinesView,
  projectsView,
  replayView,
  reposView,
  reviewView,
  rolesView,
  runsView,
  settingsView,
  signalsView,
  tokensView,
  transcriptView,
  topologyView,
  weekView,
  workflowsView,
]);
}

/** Screens that are built (ready !== false), in registry order. */
export function extraViews(): ExtraView[] {
  return allExtra().filter(v => v.ready !== false);
}

export function extraCss(): string {
  return KIT_CSS + extraViews().map(v => v.css ?? '').join('\n');
}
