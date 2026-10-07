import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
import { OV_WORKER_ROWS, renderWorkspace, runningWorkerRows, WsData, WsState } from '../src/render/workspace';
import { EXTRA_NAV, STYLE, validateMessage } from '../src/render/html';
import { clearFeeds } from '../src/render/extra/feeds';

const NOW = Date.parse('2026-10-07T12:00:00Z');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'RUNNING', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 10_000, ...p };
}

/** 2 Claude leads (one needs input), 1 Codex lead; the first Claude lead has 7 running, 1 idle and 1 ended worker. */
function data(): WsData {
  const lead = mk({ key: 'claude:lead', title: 'Claude lead' });
  const workers = Array.from({ length: 7 }, (_, i) =>
    mk({ key: `claude:w${i}`, parentSessionId: 'claude:lead', isWorker: true, workerLabel: 'Explore', title: `worker ${i}`, model: 'claude-sonnet-5-5', effort: 'low', startedAt: NOW - (i + 1) * 60_000, facts: i === 0 ? { currentTool: { name: 'Bash', detail: 'npm test', startedAt: NOW - 5000 } } : undefined }),
  );
  const idle = mk({ key: 'claude:wi', parentSessionId: 'claude:lead', isWorker: true, status: 'IDLE', title: 'idle worker' });
  const ended = mk({ key: 'claude:we', parentSessionId: 'claude:lead', isWorker: true, status: 'ENDED', endedAt: NOW - 600_000, title: 'ended worker' });
  const need = mk({ key: 'claude:need', title: 'Asks a question', status: 'NEEDS_INPUT' });
  const codex = mk({ key: 'codex:cx', title: 'Codex lead', status: 'NEEDS_INPUT' });
  return { sessions: [lead, ...workers, idle, ended, need, codex], providers: [], events: [], now: NOW, ternAvailable: false };
}

const ov = (opts: Record<string, string> = {}) => renderWorkspace(data(), { view: 'overview', opts } as WsState);
const head = (html: string, name: string) => new RegExp(`<button class="ovt" data-opt="${name.replace(/\./g, '\\.')}" data-val="([^"]*)" aria-expanded="(true|false)"[^>]*>.*?<span class="ovn">(\\d+)</span></button>`).exec(html);

test('overview: Needs attention is collapsible, count stays visible, state comes from WsState opts', () => {
  clearFeeds();
  const open = ov();
  const h = head(open, 'ov.attn')!;
  assert.ok(h, 'header button rendered');
  assert.deepEqual([h[1], h[2], h[3]], ['closed', 'true', '2'], 'two needs-input items; click collapses');
  assert.ok(open.includes('data-ovg="attn.claude"') && open.includes('class="att '));
  assert.ok(!open.includes('ov-wide'));
  const closed = ov({ 'ov.attn': 'closed' });
  const c = head(closed, 'ov.attn')!;
  assert.deepEqual([c[1], c[2], c[3]], ['', 'false', '2'], 'collapsed: count kept, click expands');
  assert.ok(!closed.includes('data-ovg="attn.'), 'items hidden');
  assert.ok(!/class="att /.test(closed.slice(closed.indexOf('ov-attn'))), 'no attention rows');
  assert.ok(closed.includes('cols ov-cols ov-wide'), 'live agents take the freed width');
  assert.ok(/\.ov-cols\.ov-wide \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(STYLE));
  // Header is a <button>: Enter / Space toggle it natively; its option name and value pass validation.
  assert.deepEqual(validateMessage({ type: 'opt', name: 'ov.attn', value: 'closed', key: '' }, () => false), { type: 'opt', name: 'ov.attn', value: 'closed', key: '' });
  for (const n of ['ov.attn.claude', 'ov.attn.codex', 'ov.live.claude', 'ov.live.codex']) assert.ok(validateMessage({ type: 'opt', name: n, value: '', key: '' }, () => false), n);
});

test('overview: attention and live agents grouped by provider with counts, each group collapsible', () => {
  clearFeeds();
  const html = ov();
  assert.equal(head(html, 'ov.attn.claude')![3], '1');
  assert.equal(head(html, 'ov.attn.codex')![3], '1');
  assert.equal(head(html, 'ov.live.claude')![3], '2', 'two live Claude leads (workers are not leads)');
  assert.equal(head(html, 'ov.live.codex')![3], '1');
  assert.ok(html.includes('>Claude Code <span class="ovn">') && html.includes('>Codex <span class="ovn">'));
  const live = html.slice(html.indexOf('class="ov-live"'), html.indexOf('class="ov-attn'));
  assert.ok(live.indexOf('Asks a question') < live.indexOf('Claude lead'), 'needs input first inside the Claude group');
  const cx = ov({ 'ov.live.codex': 'closed', 'ov.attn.claude': 'closed' });
  const cxLive = cx.slice(cx.indexOf('data-ovg="live.codex"'), cx.indexOf('class="ov-attn'));
  assert.ok(!cxLive.includes('data-select="codex:cx"'), 'collapsed Codex live group hides its cards');
  assert.equal(head(cx, 'ov.live.codex')![2], 'false');
  const attn = cx.slice(cx.indexOf('class="ov-attn'), cx.indexOf('Last 24 hours'));
  assert.ok(!attn.includes('data-select="claude:need"') && attn.includes('data-select="codex:cx"'), 'only the Claude attention group collapses');
});

test('overview: lead card lists running workers (max 5, then +n more to Topology), idle/ended only counted', () => {
  clearFeeds();
  const d = data();
  const rows = runningWorkerRows(d.sessions[0], d);
  assert.equal(rows.length, 7, 'only RUNNING workers');
  assert.equal(rows[0].key, 'claude:w0', 'newest first');
  assert.equal(rows[0].tool, '▸ Bash npm test');
  assert.equal(rows[0].me, 'Sonnet 5.5 · low');
  const html = ov();
  const card = html.slice(html.indexOf('data-select="claude:lead"'), html.indexOf('data-select="claude:need"', html.indexOf('data-select="claude:lead"')));
  assert.equal((card.match(/class="ovw"/g) ?? []).length, OV_WORKER_ROWS);
  assert.ok(card.includes('9 workers · <span class="pass">7 running</span> · 2 idle/ended'));
  assert.ok(!card.includes('idle worker') && !card.includes('ended worker'), 'idle and ended workers are not listed');
  assert.ok(/<button class="link ovmore" data-nav="topology" data-key="claude:lead"[^>]*>\+2 more<\/button>/.test(card));
  assert.ok(card.includes('data-select="claude:w0"') && card.includes('▸ Bash npm test') && card.includes('Sonnet 5.5 · low'));
  // nav with a known session key selects it on the target screen; unknown keys are rejected (the host registers add-on ids).
  EXTRA_NAV.add('topology');
  assert.deepEqual(validateMessage({ type: 'nav', view: 'topology', key: 'claude:lead' }, k => k === 'claude:lead'), { type: 'nav', view: 'topology', key: 'claude:lead' });
  assert.equal(validateMessage({ type: 'nav', view: 'topology', key: 'claude:nope' }, k => k === 'claude:lead'), undefined);
});

test('overview: worker rows do not force horizontal overflow (shrinkable flex cells)', () => {
  assert.ok(/\.ovw > span:not\(\.dot\) \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; \}/.test(STYLE));
  assert.ok(/\.ov-cols > div \{ min-width: 0; \}/.test(STYLE));
});
