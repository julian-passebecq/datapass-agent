import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before screen modules (screens import workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { DIGIT_VIEWS, digitOf, loadNote, page, STYLE } from '../src/render/html';
import { loadError, loading, LOAD_TIMEOUT_S, KIT_CSS } from '../src/render/extra/kit';
import { clearFeeds } from '../src/render/extra/feeds';
import { renderWorkflows, workflowsView } from '../src/render/extra/workflows';
import { renderForecast, forecastView } from '../src/render/extra/forecast';
import { catalogView } from '../src/render/extra/catalog';
import { settingsView } from '../src/render/extra/settings';
import { changesView } from '../src/render/extra/changes';

const NOW = Date.parse('2026-10-05T12:00:00Z');

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'RUNNING', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], startedAt: NOW - 600_000, lastActivityAt: NOW - 1000, cwd: 'D:\\PROJ\\demo', ...p };
}
const data = (sessions = [snap({}), snap({ key: 'codex:b', provider: 'codex', sessionId: 'b' })]): WsData => ({ sessions, providers: [], events: [], now: NOW, ternAvailable: false, config: <T>(_k: string, f: T) => f });

test('ux: loading marker carries id, timeout, UNKNOWN evidence and a hidden Retry; error state has Retry', () => {
  const h = loading('cat<x>', 'Scanning <folders>…', { retry: 'refresh' });
  assert.ok(h.includes('data-loading="cat&lt;x&gt;"') && h.includes(`data-timeout="${LOAD_TIMEOUT_S}"`));
  assert.ok(h.includes('Scanning &lt;folders&gt;…'), 'escaped');
  assert.ok(/class="chip ev UNKNOWN"/.test(h), 'absence is UNKNOWN, never OBSERVED');
  assert.ok(h.includes('data-act="refresh"') && h.includes('ld-retry'));
  assert.ok(/^<span /.test(loading('x', 'y', { inline: true })), 'inline variant');
  assert.ok(loading('x', 'y').includes('data-cmd="refresh"'), 'without a screen action Retry uses the global refresh');
  assert.ok(loading('x', 'y', { timeoutS: 5 }).includes('data-timeout="5"'));
  const e = loadError('boom <b>', 'refresh');
  assert.ok(e.includes('role="alert"') && e.includes('boom &lt;b&gt;') && e.includes('data-act="refresh"') && e.includes('UNKNOWN'));
  assert.ok(!e.includes('ld-retry'), 'error Retry is always visible');
  assert.ok(KIT_CSS.includes('.ld.ld-late .ld-retry'), 'Retry shows only after the timeout');
});

test('ux: loadNote shows elapsed seconds, then a timeout note', () => {
  assert.deepEqual(loadNote(0, 60), { text: '', late: false });
  assert.deepEqual(loadNote(5_900, 60), { text: ' · 5 s', late: false });
  const late = loadNote(60_000, 60);
  assert.equal(late.late, true);
  assert.ok(late.text.includes('no answer after 60 s'));
  assert.equal(loadNote(-5, 60).late, false);
});

test('ux: feed-backed screens show a loading marker, then an error state, each with Retry', () => {
  clearFeeds();
  const d = data();
  const st = { view: 'x', opts: {} };
  for (const v of [workflowsView, catalogView, settingsView, changesView]) {
    const h = v.render(d, { ...st, view: v.id });
    assert.ok(h.includes('data-loading="'), `${v.id}: loading marker`);
    assert.ok(typeof v.actions?.refresh === 'function', `${v.id}: has a refresh action for Retry`);
  }
  const fc = forecastView.render(d, { ...st, view: 'forecast' });
  assert.ok(fc.includes('data-loading="forecast.workflows"') && forecastView.actions?.refresh, 'forecast: marker + action');
  assert.ok(renderWorkflows(d, st, undefined, 'EACCES').includes('class="empty ld-err"'), 'workflows: error state');
  assert.ok(renderForecast(d, st, undefined, 'EACCES').includes('ld-err'), 'forecast: error state');
  assert.ok(!renderWorkflows(d, st, undefined, 'EACCES').includes('data-loading'), 'an error is not shown as still loading');
  clearFeeds();
});

test('ux: rail shows fixed digit shortcuts; header hint has a title; filter is not fixed over the header', () => {
  const html = renderWorkspace(data(), { view: 'overview', opts: {} });
  assert.equal(digitOf('overview'), '1');
  assert.equal(digitOf('workflows'), '0');
  assert.equal(digitOf('flow'), '');
  assert.equal(DIGIT_VIEWS.length, 10);
  assert.ok(/data-nav="overview"[^>]*title="Shortcut: 1"[^>]*>Overview.*?<kbd class="dk">1<\/kbd>/.test(html));
  assert.ok(/data-nav="attention"[^>]*>Attention.*?<kbd class="dk">2<\/kbd>/.test(html));
  assert.ok(!/data-nav="flow"[^>]*>[^<]*<kbd/.test(html), 'screens without a shortcut have no digit');
  assert.ok(/<span class="muted hint" title="[^"]+">/.test(html), 'subtitle has its full text as a tooltip');
  assert.ok(html.includes('<b>1–0</b> screens with a number in the rail'));
  // Collapsing a group does not shift digits: the mapping is by id, not by rail position.
  const closed = renderWorkspace(data(), { view: 'board', opts: { 'rail.now': 'closed' } });
  assert.ok(!closed.includes('data-nav="overview"') && /data-nav="board"[^>]*>Board.*?<kbd class="dk">4<\/kbd>/.test(closed));
  assert.ok(!/\.q \{[^}]*position: fixed/.test(STYLE), 'filter box is laid out in the header');
});

test('ux: client script has keyboard focus, tabindex, digit map, loading clock and valid JS', () => {
  const html = page('x', '<p>x</p>', { filter: true });
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1];
  assert.doesNotThrow(() => new Function('acquireVsCodeApi', 'document', 'window', script), 'script parses');
  assert.ok(script.includes(`const DIGITS = ${JSON.stringify(DIGIT_VIEWS)}`));
  assert.ok(/const loadNote = function/.test(script), 'helper bound by value (survives minified names)');
  assert.ok(script.includes("setAttribute('tabindex', '0')"), 'rows become tabbable');
  assert.ok(script.includes('next.focus({ preventScroll: true })'), 'j/k moves focus');
  assert.ok(script.includes("e.key !== 'Enter' && e.key !== ' '"), 'Enter and Space on focused rows');
  assert.ok(script.includes('document.body.dataset.ready'), 'ready flag for the smoke harness');
  // The inlined helper behaves like the exported one.
  const src = /const loadNote = ([\s\S]*?);\n\/\/ Loading markers/.exec(script)![1];
  const fn = new Function(`return (${src});`)();
  assert.deepEqual(fn(61_000, 60), loadNote(61_000, 60));
});

test('ux: style has visible focus, reduced motion, narrow-width rules and no white-on-colour badges', () => {
  assert.ok(STYLE.includes(':focus-visible { outline: 2px solid var(--vscode-focusBorder, #0078d4)'));
  assert.ok(!/\.row:focus \{[^}]*outline: none/.test(STYLE), 'rows no longer hide focus');
  assert.ok(STYLE.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(/@media \(max-width: 900px\) \{ \.mainw table \{ display: block; max-width: 100%; overflow-x: auto; \}/.test(STYLE), 'tables scroll in their own box');
  assert.ok(/@media \(max-width: 700px\) \{[^\n]*\.rail \{[^}]*overflow-x: auto/.test(STYLE), 'rail scrolls horizontally on narrow widths');
  assert.ok(!STYLE.includes('#fff'), 'no hard-coded white text');
  assert.ok(STYLE.includes('.chip.OBSERVED') && STYLE.includes('.chip.UNKNOWN') && !STYLE.includes('.OBSERVED { }'));
  for (const m of STYLE.matchAll(/font-size: (\d+)px/g)) assert.ok(+m[1] >= 11, `font-size floor 11 px (found ${m[1]})`);
});

test('ux: board empty column, card title tooltip, footer cap and Sankey labels without overlap', () => {
  const one = renderWorkspace(data([snap({ title: 'A very long session title that the card clips' })]), { view: 'board', opts: {} });
  assert.ok(one.includes('No session in this column.'), 'empty column says so');
  assert.ok(one.includes('<b title="A very long session title that the card clips">'));
  // 12 live repos: footer shows 8 chips and "+4".
  const many = Array.from({ length: 12 }, (_, i) => snap({ key: `claude:r${i}`, sessionId: `r${i}`, cwd: `D:\\PROJ\\repo-${i}` }));
  const ov = renderWorkspace(data(many), { view: 'overview', opts: {} });
  const strip = /<footer class="strip">[\s\S]*?<\/footer>/.exec(ov)![0];
  assert.equal((strip.match(/class="tk"/g) ?? []).length, 8);
  assert.ok(strip.includes('>+4</span>'));
  // One big repo and many single-session repos: small nodes keep their tooltip but not an overlapping label.
  const big = Array.from({ length: 60 }, (_, i) => snap({ key: `claude:m${i}`, sessionId: `m${i}`, status: 'ENDED', cwd: 'D:\\PROJ\\main' }));
  const small = Array.from({ length: 30 }, (_, i) => snap({ key: `claude:s${i}`, sessionId: `s${i}`, status: 'ENDED', cwd: `D:\\PROJ\\small-${i}` }));
  const fl = renderWorkspace(data([...big, ...small]), { view: 'flow', opts: {} });
  const svg = /<svg class="flow"[\s\S]*?<\/svg>/.exec(fl)![0];
  const ys = [...svg.matchAll(/<text class="halo" x="(\d+(?:\.\d+)?)" y="([\d.]+)"/g)].map(m => [+m[1], +m[2]]);
  const byX = new Map<number, number[]>();
  for (const [x, y] of ys) byX.set(x, [...(byX.get(x) ?? []), y]);
  for (const col of byX.values()) for (let i = 1; i < col.length; i++) assert.ok(col[i] - col[i - 1] >= 14, 'labels do not overlap');
  assert.ok((svg.match(/<g class="fn/g) ?? []).length > ys.length, 'some small nodes rely on their tooltip');
  assert.ok(/small-\d+: 1 · click to list/.test(svg), 'tooltip has name and count');
});
