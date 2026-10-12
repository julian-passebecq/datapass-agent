// Redaction for any provider-derived text Agent keeps or shows (titles, command lines, transcript text, tool
// inputs / results, labels, exports). This is the ONE redaction layer: screens, exports and archive labels go through
// redact() / bounded() / redactDeep(). A redacted value is DERIVED from an OBSERVED one; the marker is always
// "[REDACTED]". Every pattern starts at a boundary and has no nested quantifier, so 1 MB inputs stay linear.

export const MARK = '[REDACTED]';

interface Rule {
  re: RegExp;
  /** Replacement; default replaces the whole match with MARK. */
  to?: (m: string, ...g: string[]) => string;
}

/**
 * Secret-bearing key names (env vars, JSON keys, YAML / TOML keys, connection-string fields, headers).
 * Matched case-insensitively as part of a longer name (AZURE_OPENAI_KEY, client_secret, x-api-key, AccountKey).
 */
const NAME_CORE =
  'token|secret|passw(?:or)?d|pwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|' +
  'shared[_-]?access[_-]?(?:key|signature)|subscription[_-]?key|client[_-]?secret|credentials?|' +
  'session[_-]?(?:id|token|key)|cookie|auth[_-]?(?:token|key|code)|signing[_-]?key|encryption[_-]?key|' +
  'conn(?:ection)?[_-]?string|[_-]key';
/** Whole key name: letters / digits / _ . - around one of the cores. */
const NAME = `[A-Za-z0-9_.-]{0,40}(?:${NAME_CORE})[A-Za-z0-9_.-]{0,40}`;
const NAME_RE = new RegExp(`^(?:${NAME})$`, 'i');
const HEADER_NAME = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|ocp-apim-subscription-key|set-cookie|cookie)$/i;
/** Count-like names (max_tokens, input_tokens, token_count) whose numeric values are not secrets. */
const COUNT_NAME = /tokens|_count$/i;

/** True when a key name (JSON / env / header) is one whose value Agent never shows. */
export function isSecretKeyName(name: string): boolean {
  if (typeof name !== 'string' || !name) return false;
  return NAME_RE.test(name) || HEADER_NAME.test(name);
}

/** Values: JSON-escaped quoted (\"..\"), double-quoted, single-quoted, or a bare run (not an object / array). */
const VALUE = `(\\\\"(?:(?!\\\\")[^\\n])*\\\\"|"(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|(?![{\\[])[^\\s,;}\\]&"'\\\\<>]+)`;

function keyValue(m: string, pre: string, name: string, value: string): string {
  if (COUNT_NAME.test(name) && /^\\?["']?\d{1,12}\\?["']?$/.test(value)) return m;
  if (value.startsWith('\\"')) return `${pre}\\"${MARK}\\"`;
  if (value.startsWith('"')) return `${pre}"${MARK}"`;
  if (value.startsWith("'")) return `${pre}'${MARK}'`;
  return `${pre}${MARK}`;
}

const quoted = (v: string) => (v.startsWith('"') ? `"${MARK}"` : v.startsWith("'") ? `'${MARK}'` : MARK);

const RULES: Rule[] = [
  // PEM private keys (RSA / EC / OPENSSH / ENCRYPTED / PGP ... BLOCK), real or JSON-escaped newlines; a block cut
  // by truncation (no END line) is redacted to the end of the text.
  { re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----|$)/g },
  // AWS secret access key without a label, on the same line as an access key id or the word "aws".
  {
    re: /(\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\baws\b)([^\n]{0,160}?)(?<![A-Za-z0-9/+])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    to: (m, a, mid, s) => (/[A-Z]/.test(s) && /[a-z]/.test(s) ? `${a}${mid}${MARK}` : m),
  },
  // Token formats.
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g }, // OpenAI (sk-, sk-proj-) and similar
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g }, // Stripe
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g }, // GitHub fine-grained PAT
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g }, // GitHub classic tokens
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g }, // GitLab
  { re: /\bnpm_[A-Za-z0-9]{30,}/g }, // npm
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g }, // Google API key
  { re: /\bya29\.[0-9A-Za-z_-]{20,}/g }, // Google OAuth access token
  { re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g }, // Slack
  { re: /\bxapp-[A-Za-z0-9-]{10,}/g }, // Slack app token
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g }, // AWS access key id
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g }, // JWT
  // Authorization headers ("Bearer xyz" / "Basic xyz" / quoted JSON value).
  {
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;"']+(?:[ \t]+[^\s,;"']+)?)/gi,
    to: (_m, pre, v) => `${pre}${quoted(v)}`,
  },
  // Secret headers: curl -H "x-api-key: ...", Cookie: a=b; c=d, Ocp-Apim-Subscription-Key: ...
  {
    re: /\b((?:x-api-key|api-key|x-auth-token|x-goog-api-key|ocp-apim-subscription-key|set-cookie|cookie)[ \t]*:[ \t]*)(?!["'\\])[^\r\n"'\\]+/gi,
    to: (_m, pre) => `${pre}${MARK}`,
  },
  { re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, to: (_m, kind) => `${kind} ${MARK}` },
  // Query-string secrets, also after &amp; in HTML-encoded URLs.
  {
    re: /([?&](?:amp;)?(?:key|sig|signature|code|auth|password|pwd|passwd|token|access_token|refresh_token|id_token|api_key|apikey|secret|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s#"'<>]+/gi,
    to: (_m, pre) => `${pre}${MARK}`,
  },
  // Credentials in URLs; the password may contain '@' (user:p@ss@host): it runs to the last '@' before the host.
  { re: /(:\/\/[^/\s:@]+:)[^\s/]*@(?=[^@\s/]*(?:[/?#\s"'<>]|$))/g, to: (_m, pre) => `${pre}${MARK}@` },
  // name = value / "name": "value" / name: value (env, JSON, escaped JSON, YAML, TOML, connection strings).
  {
    re: new RegExp(`(?<![A-Za-z0-9_.-])((\\\\?["']?)(${NAME})\\\\?["']?(\\s*[:=]\\s*))${VALUE}`, 'gi'),
    to: (m, pre, _q, name, _sep, value) => keyValue(m, pre, name, value),
  },
  // CLI flags: --password x, --token=x, -password x.
  { re: /(--?(?:password|passwd|pwd|token|secret|api-key|apikey|access-token|auth-token|client-secret)[= ])(\S+)/gi, to: (_m, pre) => `${pre}${MARK}` },
  // mysql-family -p<password> / -p <password> (only after a mysql command on the same line: -p means other things elsewhere).
  { re: /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]{0,200}?\s-p)([ \t]*)(?!-)(\S+)/g, to: (_m, pre, sp) => `${pre}${sp}${MARK}` },
];

export function redact(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  let out = text;
  for (const r of RULES) out = out.replace(r.re, (m: string, ...g: unknown[]) => (r.to ? r.to(m, ...(g as string[])) : MARK));
  // Archive gates scan token shapes anywhere, including tokens embedded in another word.
  // Keep this in the shared redaction layer; exports must not implement a weaker parallel policy.
  for (const re of [
    /sk-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g, /AKIA[0-9A-Z]{16}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  ]) out = out.replace(re, MARK);
  return out;
}

/** Single-line, redacted, length-bounded. */
export function bounded(text: unknown, max = 100): string {
  if (typeof text !== 'string') return '';
  const one = redact(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Native message bodies keep formatting; redact the complete unit before the UTF-8 byte bound. */
export function boundedMultiline(text:unknown,max=32*1024):string {
  if(typeof text!=='string')return '';
  const safe=redact(text),bytes=Buffer.from(safe);
  return bytes.length<=max?safe:bytes.subarray(0,Math.max(0,max-3)).toString('utf8').replace(/\uFFFD$/,'')+'…';
}

/**
 * Deep copy of a JSON-like value with every string redacted and every secret-named key's string value replaced by
 * MARK. Use before showing or exporting structured provider data.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 40) return MARK as unknown as T;
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keep = v === null || v === undefined || typeof v === 'boolean' || (typeof v === 'number' && COUNT_NAME.test(k));
      out[k] = isSecretKeyName(k) && !keep ? MARK : redactDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** The only environment variables Agent ever reads. Never persist a full environment snapshot. */
export const ENV_ALLOW_LIST = ['USERPROFILE', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;

export function safeEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<(typeof ENV_ALLOW_LIST)[number], string>> {
  const out: Partial<Record<(typeof ENV_ALLOW_LIST)[number], string>> = {};
  for (const k of ENV_ALLOW_LIST) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

/** Credential / auth files Agent never opens (ActCtx.openFile refuses them whatever screen asks). */
const CREDENTIAL_FILE =
  /(^|[\\/])(\.credentials\.jsonl?|auth\.jsonl?|credentials(\.jsonl?)?|(?:tokens?|cookies?|secrets?)\.jsonl?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(pem|key|pfx|p12))$/i;

export function isCredentialPath(file: string): boolean {
  return typeof file === 'string' && CREDENTIAL_FILE.test(file.replace(/[\\/]+$/, ''));
}
