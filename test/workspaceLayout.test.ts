import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { chromium } from 'playwright-core';
import { AgentSessionSnapshot } from '../src/model';
import { renderWorkspace, WsData } from '../src/render/workspace';
import { STYLE } from '../src/render/html';

// Static renderer only: no VS Code instance, provider, user profile or native UI.
// An existing browser is required; this test never downloads one.
const browserPath = process.env.AGENT_LAYOUT_BROWSER ?? (process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '');
const now = Date.parse('2026-10-24T02:00:00Z');
const selected: AgentSessionSnapshot = {
  key: 'claude:layout-fixture', provider: 'claude', sessionId: 'layout-fixture',
  title: 'Generated workflow lead for result drawer layout qualification',
  status: 'ENDED', statusReason: 'Generated session has ended', isWorker: false,
  startedAt: now - 60_000, lastActivityAt: now - 1000, endedAt: now - 1000,
  cwd: '/generated/layout-fixture', branch: 'fixture-layout',
  commits: [], changedFiles: [], tests: [],
  counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 },
  evidence: [], artifactPath: '', diagnostics: [],
};
const data: WsData = { sessions: [selected], providers: [], events: [], now, ternAvailable: false };

type Rect = { left: number; right: number; top: number; bottom: number };
type Geometry = { rail: Rect; detail: Rect; width: number; height: number; scrollWidth: number; scrollY: number };
const geometry = `(() => {
  const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect();
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
  return {rail:rect('.rail'),detail:rect('.side'),width:document.documentElement.clientWidth,
    height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY};
})()`;
const overlap = (a: Rect, b: Rect, width: number, height: number) =>
  Math.min(a.right, b.right, width) - Math.max(a.left, b.left, 0) > 1 &&
  Math.min(a.bottom, b.bottom, height) - Math.max(a.top, b.top, 0) > 1;

test('workspace result drawer stays separate from navigation across responsive breakpoints',
  { skip: !browserPath || !fs.existsSync(browserPath) ? 'Set AGENT_LAYOUT_BROWSER to an existing Chromium browser' : false, timeout: 120_000 },
  async t => {
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      for (const width of [1090, 900, 701, 700, 600, 1200]) await t.test(`selected Board session at ${width}px`, async child => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, offline: true });
        try {
          await context.route('**/*', route => route.abort());
          const page = await context.newPage();
          await page.setContent(`<!doctype html><html><head><style>
            :root { --vscode-font-family:Arial,sans-serif; --vscode-font-size:13px;
              --vscode-editor-font-family:monospace; --vscode-foreground:#ddd; --vscode-editor-background:#111; }
            ${STYLE}
            </style></head><body>${renderWorkspace(data, { view: 'board', selected: selected.key })}</body></html>`);
          assert.equal(await page.locator('.side h3').textContent(), selected.title);
          for (const position of ['top', 'bottom']) {
            await page.evaluate(position === 'top' ? 'scrollTo(0,0)' : 'scrollTo(0,document.documentElement.scrollHeight)');
            await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const measured = await page.evaluate<Geometry>(geometry);
            child.diagnostic(JSON.stringify({ position, ...measured }));
            assert.ok(measured.scrollWidth <= measured.width + 1, 'Only inner tables/board may scroll horizontally');
            assert.equal(overlap(measured.rail, measured.detail, measured.width, measured.height), false,
              `${width}px ${position}: selected-session drawer intersects visible navigation`);
          }
          const inspect = page.locator('.side [data-open]').first();
          await inspect.scrollIntoViewIfNeeded();
          const hit = await page.evaluate<boolean>(`(() => {
            const element=document.querySelector('.side [data-open]');
            const r=element.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
            const top=document.elementFromPoint(x,y);
            return x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&(top===element||element.contains(top));
          })()`);
          assert.equal(hit, true, 'Open inspector is visible and not covered by navigation');
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
