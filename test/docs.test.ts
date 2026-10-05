import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { allViews, viewLabel } from '../src/render/workspace';

const ROOT = path.resolve(__dirname, '..', '..');

test('README documents every screen of the rail in a screens table', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const missing = allViews().map(viewLabel).filter(l => !readme.includes(`| ${l} |`));
  assert.deepEqual(missing, []);
});

test('package.json points to the canonical agent-vscode repository', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.repository.url, /github\.com\/julian-passebecq\/agent-vscode\.git$/);
  assert.match(pkg.bugs.url, /agent-vscode\/issues$/);
  assert.match(pkg.homepage, /agent-vscode/);
});
