import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { bounded, isCredentialPath, isSecretKeyName, MARK, redact, redactDeep } from '../src/util/redact';
import { toJsonl, transitions } from '../src/activity/audit';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// The workspace owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { clearTranscriptCache, readTranscript } from '../src/providers/transcript';
import { toMarkdown, transcriptView } from '../src/render/extra/transcript';
import { tmpDir } from './helpers';

// Every sample from audit A2 (security / privacy), plus the formats the package names. [input, secret that must go].
const LEAKS: [string, string][] = [
  // P0-1 JSON-quoted secrets
  ['{"apiKey":"abcdef123456"}', 'abcdef123456'],
  ['{"password":"hunter2"}', 'hunter2'],
  ['{"token": "tok_9f8e7d6c5b4a"}', 'tok_9f8e7d6c5b4a'],
  ['{"client_secret":"cs-0123456789"}', 'cs-0123456789'],
  ['{"api_key": "zzz-api-key-value"}', 'zzz-api-key-value'],
  ['{\\"apiKey\\":\\"escapedsecret99\\"}', 'escapedsecret99'],
  ["{'password': 'singleq-pass'}", 'singleq-pass'],
  ['{"credentials": "plain-cred-string"}', 'plain-cred-string'],
  // P0-2 env / cloud names
  ['AZURE_OPENAI_KEY=0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ['OPENAI_API_KEY=not-sk-format-value', 'not-sk-format-value'],
  ['DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcdEFGH1234==;EndpointSuffix=core.windows.net', 'abcdEFGH1234=='],
  ['Server=db;Database=x;User Id=sa;pwd=hunter2;', 'hunter2'],
  ['Password=Pa55word!;Server=x', 'Pa55word!'],
  ['curl -H "Ocp-Apim-Subscription-Key: 0f0f0f0f0f0f0f0f" https://x', '0f0f0f0f0f0f0f0f'],
  ['curl -H "x-api-key: abc123xyz789" https://api', 'abc123xyz789'],
  ['Cookie: session=abc123cookieval; theme=dark', 'abc123cookieval'],
  ['Set-Cookie: sid=s3ss10nval; HttpOnly', 's3ss10nval'],
  ['"Authorization": "Bearer abcdefghijklmnop123456"', 'abcdefghijklmnop123456'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
  ['session_id=9a8b7c6d5e4f', '9a8b7c6d5e4f'],
  ['SharedAccessSignature=sv=2020&sig=abcSIGvalue', 'abcSIGvalue'],
  // P0-3 token formats
  ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL', 'github_pat_11ABCDEFG0123456789'],
  ['ghp_abcdefghijklmnopqrstuvwxyz123', 'ghp_abcdefghijklmnopqrstuvwxyz123'],
  ['gho_abcdefghijklmnopqrstuvwxyz123', 'gho_abcdefghijklmnopqrstuvwxyz123'],
  ['glpat-abcdefghij0123456789', 'glpat-abcdefghij0123456789'],
  ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['key AIzaSyA-abcdefghijklmnopqrstuvwxyz12345', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz12345'],
  ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-proj-abcdefghijklmnopqrstuvwx'],
  ['sk-ant-api03-ABCDEFGHIJKLMNOP', 'sk-ant-api03-ABCDEFGHIJKLMNOP'],
  ['xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
  ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
  ['aws configure: AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['export AWS creds wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['sk_live_abcdefghijklmnop', 'sk_live_abcdefghijklmnop'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  // P0-4 query strings
  ['https://x.com/a?x=1&key=abc123secret', 'abc123secret'],
  ['https://x.com/a?x=1&amp;key=amp3ncodedsecret', 'amp3ncodedsecret'],
  ['https://x.com/cb?code=oauthc0de&state=1', 'oauthc0de'],
  ['https://x.com/?token=qstok3n', 'qstok3n'],
  // P0-5 URL credentials and CLI passwords
  ['postgres://user:p@ss@host/db', 'p@ss'],
  ['postgres://user:p@ss@host/db', 'ss@host'],
  ['mongodb://admin:s3cr3t@localhost:27017', 's3cr3t'],
  ['https://user:pa55w0rd@host/x', 'pa55w0rd'],
  ['mysql -uroot -phunter2 db', 'hunter2'],
  ['mysql -u root -p hunter2', 'hunter2'],
  ['tool --password hunter2', 'hunter2'],
  ['tool --token=abcdef', 'abcdef'],
  // PEM blocks (multi-line, JSON-escaped, truncated)
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretbody\nmoresecretlines\n-----END RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEAsecretbody'],
  ['"-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAA\\n-----END OPENSSH PRIVATE KEY-----"', 'b3BlbnNzaC1rZXktdjEAAAA'],
  ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANtruncated', 'MIIEvQIBADANtruncated'],
  ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGpgpbody\n-----END PGP PRIVATE KEY BLOCK-----', 'lQOYBGpgpbody'],
];

test('redact: every audit sample and named token format is removed', () => {
  for (const [input, secret] of LEAKS) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `leaked ${JSON.stringify(secret)} in ${JSON.stringify(out)}`);
    assert.ok(out.includes(MARK), `marker missing for ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.ok(!bounded(input, 500).includes(secret), `bounded leaked ${secret}`);
  }
});

test('redact: structure and harmless text survive', () => {
  assert.equal(redact('{"apiKey":"abcdef123456","name":"x"}'), '{"apiKey":"[REDACTED]","name":"x"}');
  assert.equal(redact('postgres://user:p@ss@host/db'), 'postgres://user:[REDACTED]@host/db');
  assert.equal(redact('https://x.com/a?token=abc&x=1'), 'https://x.com/a?token=[REDACTED]&x=1', 'query secret no longer swallows the rest');
  assert.equal(redact('AccountName=acct;AccountKey=abc==;EndpointSuffix=core'), 'AccountName=acct;AccountKey=[REDACTED];EndpointSuffix=core');
  for (const keep of [
    'npm test && git status',
    'mkdir -p src/util',
    'git add -p',
    '{"input_tokens": 1234, "max_tokens": 4096}',
    'commit 3f2a9c1b7e4d5f60718293a4b5c6d7e8f9012345 on aws branch',
    'Fix the session list ordering',
    '{"author":"Julian","title":"fix login"}',
    'https://github.com/org/repo/pull/12',
  ])
    assert.equal(redact(keep), keep, keep);
  assert.equal(redact(undefined as unknown as string), '');
});

test('redact: linear on 1 MB adversarial inputs', () => {
  const big = [
    'a'.repeat(1 << 20),
    'password'.repeat(1 << 17),
    'aws '.repeat(1 << 18),
    '://u:'.repeat(1 << 18),
    'mysql '.repeat(1 << 17),
    '-----BEGIN PRIVATE KEY-----'.repeat(1 << 15),
    '"token":"'.repeat(1 << 17),
    'x_key_'.repeat(1 << 17),
  ];
  for (const s of big) {
    const t = Date.now();
    redact(s);
    assert.ok(Date.now() - t < 1500, `slow on ${s.slice(0, 12)}…: ${Date.now() - t} ms`);
  }
});

test('redactDeep: secret-named keys and every nested string', () => {
  const v = redactDeep({ headers: { Authorization: 'Bearer zzzzzzzzzzzzzzzz', 'x-api-key': 'k' }, env: { AZURE_OPENAI_KEY: 'v1', PATH: '/bin' }, usage: { input_tokens: 5 }, list: ['ghp_abcdefghijklmnopqrstuvwxyz123'], ok: true });
  assert.deepEqual(v, { headers: { Authorization: MARK, 'x-api-key': MARK }, env: { AZURE_OPENAI_KEY: MARK, PATH: '/bin' }, usage: { input_tokens: 5 }, list: [MARK], ok: true });
  assert.ok(isSecretKeyName('client_secret') && isSecretKeyName('Ocp-Apim-Subscription-Key') && !isSecretKeyName('author'));
});

test('isCredentialPath: auth and credential files are refused', () => {
  for (const p of ['C:\\Users\\u\\.claude\\.credentials.json', '/home/u/.codex/auth.json', '/r/.env', '/r/.env.local', '/u/.aws/credentials', '/u/.ssh/id_ed25519', '/u/.netrc', '/r/server.pem', '/r/x.key', '/u/.git-credentials'])
    assert.ok(isCredentialPath(p), p);
  for (const p of ['/r/src/auth.ts', '/r/README.md', '/u/.claude/settings.json', '/r/keys.ts', '/r/environment.ts'])
    assert.ok(!isCredentialPath(p), p);
});

// ---- rendered and exported output pass through the same layer

const SECRETS = ['abcdef123456', 'hunter2', 'github_pat_11ABCDEFG0123456789_abc', 'AzureK3yValue', 'p@ss', 'qsk3y'];

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

test('transcript screen and markdown export never show a secret from tool inputs, results or text', () => {
  const dir = tmpDir('redact');
  const file = path.join(dir, '77777777-7777-4777-8777-777777777777.jsonl');
  const at = '2026-10-05T10:00:00Z';
  const lines = [
    { type: 'user', timestamp: at, uuid: 'u1', message: { role: 'user', content: 'connect with {"apiKey":"abcdef123456"} and pwd=hunter2' } },
    {
      type: 'assistant', timestamp: at, uuid: 'a1',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [
        { type: 'text', text: 'Using github_pat_11ABCDEFG0123456789_abcdefghijklmnop' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'curl "https://x.com/a?x=1&key=qsk3y" -H "x-api-key: abcdef123456"', description: 'AccountKey=AzureK3yValue;' } },
      ] },
    },
    { type: 'user', timestamp: at, uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'postgres://user:p@ss@host/db {"password":"hunter2"}' }] } },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  clearTranscriptCache();
  const t = readTranscript(file, 'claude');
  assert.ok(t.entries.length >= 3, `parsed ${t.entries.length}`);
  const s = snap({ key: 'claude:77777777-7777-4777-8777-777777777777', sessionId: '77777777-7777-4777-8777-777777777777', artifactPath: file, title: 'deploy with password=hunter2' });
  // Providers bound (and so redact) titles at the source; the markdown export also redacts a raw one.
  const shown = { ...s, title: bounded(s.title, 80) };
  const d: WsData = { sessions: [shown], providers: [], events: [], now: Date.parse('2026-10-05T12:00:00Z'), ternAvailable: false };
  const outs = [toMarkdown(s, t), JSON.stringify(t.entries)];
  for (const mode of ['chat', 'log', 'tools']) outs.push(transcriptView.render(d, { view: 'transcript', selected: s.key, opts: { 'transcript.mode': mode } }));
  outs.forEach((o, i) => { for (const sec of SECRETS) { const at = o.indexOf(sec); assert.ok(at < 0, `transcript output ${i} leaked ${sec}: ${o.slice(Math.max(0, at - 120), at + 40)}`); } });
});

test('audit JSONL export never carries a secret from titles or labels', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const s = snap({ key: 'codex:a', provider: 'codex', title: 'fix {"apiKey":"abcdef123456"}', repository: 'D:/PROJ/app', startedAt: NOW - 3_600_000, lastActivityAt: NOW - 60_000, endedAt: NOW - 60_000, commits: [{ sha: 'b'.repeat(40), at: NOW - 120_000, subject: 'use AccountKey=AzureK3yValue; github_pat_11ABCDEFG0123456789_abcdef', attribution: 'during-session' }] });
  const ev: TimelineEvent[] = [{ at: NOW - 30 * 60_000, type: 'PROCESS_ACTIVITY', label: '$ mysql -uroot -phunter2 -e "select 1" postgres://user:p@ss@host/db?x=1&key=qsk3y', provider: 'codex', sessionKey: 'codex:a', kind: 'OBSERVED' }];
  const rows = transitions([s], ev, { now: NOW });
  assert.ok(rows.length >= 2);
  const out = toJsonl(rows);
  for (const sec of SECRETS) assert.ok(!out.includes(sec), `audit export leaked ${sec}`);
});
