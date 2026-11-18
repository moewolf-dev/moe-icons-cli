/**
 * P1-06 / REF-08: a single redaction layer for everything the CLI may print
 * (errors, `--debug` events and exported diagnostics).
 *
 * Secrets must never reach stdout/stderr or a diagnostics file. Redaction is
 * deliberately conservative: when a value looks like a credential, URL
 * signature or personal address, it is replaced with a stable placeholder.
 */

const REDACTED = "<redacted>";

const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const TOKEN_ASSIGNMENT =
  /\b(access_token|refresh_token|id_token|token|secret|password|api[_-]?key|license[_-]?key|client[_-]?secret)\b\s*[=:]\s*"?([^\s",}]{4,})"?/gi;
const SIGNED_QUERY =
  /([?&](?:x-amz-[a-z-]+|x-goog-[a-z-]+|sig|signature|token|key|expires|se|sp|sv|sr|st|spr|skoid|sktid|skt|ske|sks|skv))=([^&\s"']+)/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const HOME_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // macOS / Linux home directories.
  { pattern: /(?:^|[\s"'(=:])\/Users\/[^/\s"')]+/g, replacement: "<home>" },
  { pattern: /(?:^|[\s"'(=:])\/home\/[^/\s"')]+/g, replacement: "<home>" },
  { pattern: /(?:^|[\s"'(=:])\/root(?=\/|\b)/g, replacement: "<home>" },
  // Windows profiles.
  { pattern: /\b[A-Za-z]:\\Users\\[^\\\s"')]+/g, replacement: "<home>" },
];

export interface RedactOptions {
  /** Absolute working directory; emitted as `<cwd>` when possible. */
  readonly cwd?: string;
  /** Absolute home directory; emitted as `<home>`. */
  readonly home?: string;
  /** Project-relative form for a path, when known. */
  readonly projectRoot?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact a free-form diagnostic/error string. Order matters: explicit paths are
 * replaced before the generic token patterns.
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  let value = String(input);
  for (const path of [options.projectRoot, options.cwd, options.home]) {
    if (!path || path.length < 3) continue;
    value = value.replace(
      new RegExp(escapeRegExp(path), "g"),
      path === options.projectRoot ? "." : "<home>",
    );
  }
  for (const { pattern, replacement } of HOME_PATTERNS) {
    value = value.replace(pattern, (match) => {
      const prefix = /^[\s"'(=:]/.test(match) ? match[0] : "";
      return `${prefix}${replacement}`;
    });
  }
  value = value
    .replace(PRIVATE_KEY, "<redacted-private-key>")
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(NPM_TOKEN, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(AUTH_HEADER, (_match, name: string) => `${name}: ${REDACTED}`)
    .replace(TOKEN_ASSIGNMENT, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(SIGNED_QUERY, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(EMAIL, REDACTED);
  return value;
}

/** Keep origin + path; drop/collapse query and fragment (signatures live there). */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    const query = url.search ? `?${REDACTED}` : "";
    return `${url.origin}${url.pathname}${query}`;
  } catch {
    return redactText(input);
  }
}

/**
 * Recursively redact a JSON-like value with a depth and node budget so a hostile
 * exception object can never make diagnostics unbounded.
 */
export function redactValue(value: unknown, budget = { nodes: 500 }): unknown {
  if (budget.nodes <= 0) return "<truncated>";
  budget.nodes -= 1;
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, budget));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      result[key] = /token|secret|password|authorization|cookie|email/i.test(key)
        ? REDACTED
        : redactValue(item, budget);
    }
    return result;
  }
  return String(value);
}
