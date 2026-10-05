import { test } from 'node:test';
import * as assert from 'node:assert/strict';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import { replayView } from '../src/render/extra/replay';
import { healthView } from '../src/render/extra/health';
import { runsView } from '../src/render/extra/runs';

/** Declarations of the first CSS rule whose selector list contains `sel` exactly (media blocks included). */
function rule(css: string, sel: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (m[1].split(',').map(s => s.trim()).includes(sel)) return m[2];
  return '';
}

// Narrow-window smoke (600 / 700 / 900 px) found these parts wider than the page: each must scroll or clip inside its own box.
test('replay: the moving playhead wrappers are clipped by their track, not by the page', () => {
  const css = replayView.css ?? '';
  for (const sel of ['.rp .rp-lbody', '.rp .rp-tks']) assert.match(rule(css, sel), /overflow:\s*clip/, sel);
});

test('health: the context rows scroll inside their list and shrink at narrow widths', () => {
  const css = healthView.css ?? '';
  assert.match(rule(css, '.hl .hl-ch'), /overflow-x:\s*auto/);
  assert.match(css, /@media \(max-width: 760px\) \{ \.hl \.hl-chr \{ grid-template-columns:/);
});

test('runs: the hour heatmap scrolls inside its box and the x axis labels are clipped', () => {
  const css = runsView.css ?? '';
  assert.match(rule(css, '.rn .rn-hm'), /overflow-x:\s*auto/);
  assert.match(rule(css, '.rn .rn-xax'), /overflow-x:\s*clip/);
});
