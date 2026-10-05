import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { allViews, RAIL_GROUPS, renderWorkspace, screenIndex, viewHint, viewLabel, WsData } from '../src/render/workspace';
import { page } from '../src/render/html';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const data: WsData = { sessions: [], providers: [], events: [], now: NOW, ternAvailable: false };

/** Screen ids the webview picker reads, from the hidden source list in the rendered workspace. */
function pickerIds(html: string): string[] {
  const at = html.indexOf('<ul class="gp-src"');
  const src = html.slice(at, html.indexOf('</ul>', at));
  return [...src.matchAll(/data-gp="([^"]+)"/g)].map(m => m[1]);
}

test('picker lists every registered screen id exactly once (webview source and command list)', () => {
  const ids = screenIndex().map(s => s.id);
  assert.equal(ids.length, allViews().length);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate in screenIndex');
  assert.deepEqual([...ids].sort(), [...allViews()].sort());
  const html = pickerIds(renderWorkspace(data, { view: 'overview' }));
  assert.equal(html.length, allViews().length);
  assert.equal(new Set(html).size, html.length, 'no duplicate in the webview list');
  assert.deepEqual([...html].sort(), [...allViews()].sort());
  assert.ok(allViews().length >= 43, `expected the 43 screens, got ${allViews().length}`);
});

test('picker entries carry label, group and hint, in rail group order', () => {
  const list = screenIndex();
  for (const s of list) {
    assert.equal(s.label, viewLabel(s.id));
    assert.equal(s.hint, viewHint(s.id));
    assert.ok(RAIL_GROUPS.includes(s.group), `${s.id} in a rail group (${s.group})`);
  }
  const gi = list.map(s => RAIL_GROUPS.indexOf(s.group));
  assert.deepEqual(gi, [...gi].sort((a, b) => a - b));
});

test('picker source is hidden, after the rail, and never a [data-nav] element', () => {
  const html = renderWorkspace(data, { view: 'board' });
  const at = html.indexOf('<ul class="gp-src"');
  assert.ok(at > html.indexOf('</nav>'));
  const src = html.slice(at, html.indexOf('</ul>', at));
  assert.match(src, /hidden/);
  assert.doesNotMatch(src, /data-nav=/);
});

test('webview script wires "g" and Ctrl+K to the picker and stays valid JavaScript', () => {
  const p = page('vscode-resource:', '<div></div>', { filter: true });
  const open = p.indexOf('>', p.indexOf('<script nonce="')) + 1;
  const script = p.slice(open, p.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function('acquireVsCodeApi', script));
  assert.ok(script.includes("if (e.key === 'g') { gpOpen();"));
  assert.ok(script.includes("(e.key === 'k' || e.key === 'K')) { gpOpen();"));
  assert.ok(script.includes('role="listbox"'));
});

test('package.json contributes "Agent: Go to screen…" with a keybinding in the workspace webview', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'agent.goToScreen');
  assert.equal(cmd?.title, 'Agent: Go to screen…');
  const kb = pkg.contributes.keybindings.find((k: { command: string }) => k.command === 'agent.goToScreen');
  assert.ok(kb?.key);
  assert.match(kb.when, /activeWebviewPanelId == 'agent\.workspace'/);
});
