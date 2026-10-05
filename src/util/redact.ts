// Redaction for any provider-derived text Agent keeps (titles, command lines). Agent never stores raw transcripts.

const PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_\-]{12,}/g, // OpenAI/Anthropic/Stripe style keys
  /\bsk-ant-[A-Za-z0-9_\-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bglpat-[A-Za-z0-9_\-]{16,}/g, // GitLab tokens
  /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, // JWT
  /\b(authorization|proxy-authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+(\s+[^\s,;]+)?)/gi,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+\/\-]{12,}=*/gi,
  /\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
  /(--?(password|passwd|token|secret|api-key|apikey)[= ])(\S+)/gi,
  /(:\/\/[^\/\s:@]+:)[^@\s\/]+@/g, // credentials in URLs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, ...groups) => {
      if (re.source.startsWith('(:\\/\\/')) return `${groups[0]}[REDACTED]@`;
      if (re.source.startsWith('(--?')) return `${groups[0]}[REDACTED]`;
      if (re.source.includes('TOKEN|SECRET')) return `${groups[0]}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

/** Single-line, redacted, length-bounded. */
export function bounded(text: unknown, max = 100): string {
  if (typeof text !== 'string') return '';
  const one = redact(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** The only environment variables Agent ever reads. Never persist a full environment snapshot. */
export const ENV_ALLOW_LIST = ['USERPROFILE', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;

export function safeEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<(typeof ENV_ALLOW_LIST)[number], string>> {
  const out: Partial<Record<(typeof ENV_ALLOW_LIST)[number], string>> = {};
  for (const k of ENV_ALLOW_LIST) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}
