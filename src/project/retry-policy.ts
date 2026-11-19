/**
 * REF-04: bounded retry policy for resource downloads.
 *
 * Only transient network faults and 408/425/429/5xx are retried. Authentication,
 * authorization, 404, checksum/size failures, cancellation and disk errors are
 * never retried blindly. Backoff is exponential with jitter and respects a
 * capped `Retry-After`. A retry never holds a scheduler slot while waiting.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 300;
export const MAX_BACKOFF_MS = 8_000;
export const MAX_RETRY_AFTER_MS = 30_000;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: BASE_BACKOFF_MS,
  maxDelayMs: MAX_BACKOFF_MS,
  maxRetryAfterMs: MAX_RETRY_AFTER_MS,
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Parse Retry-After seconds or an HTTP date; cap it so a server cannot stall the CLI. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1_000);
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Delay for the next attempt (1-based attempt number that just failed). Uses
 * full jitter so concurrent clients do not retry in lockstep.
 */
export function retryDelayMs(
  attempt: number,
  options: {
    readonly retryAfterMs?: number | undefined;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly maxRetryAfterMs?: number;
    readonly random?: () => number;
  } = {},
): number {
  const random = options.random ?? Math.random;
  const base = options.baseDelayMs ?? BASE_BACKOFF_MS;
  const max = options.maxDelayMs ?? MAX_BACKOFF_MS;
  const cap = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  if (options.retryAfterMs !== undefined) {
    return Math.min(cap, Math.max(0, options.retryAfterMs));
  }
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + (random() * exponential) / 2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
