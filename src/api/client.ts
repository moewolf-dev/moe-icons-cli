import { CliError } from "../errors/index.js";

/**
 * Typed backend client. Fixed configured base URL, timeout/abort, auth
 * injection, JSON/content-type/size validation, request ID capture, and retry
 * for GET/idempotent calls with capped backoff.
 */

export interface ApiConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export interface RequestJsonOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly auth?: string; // Bearer token or API key header value
  readonly authHeader?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly retries?: number;
  readonly requestId?: string;
  /** Optional stage label included in transport diagnostics (e.g. login create). */
  readonly stage?: string;
  /**
   * Opt-in debug only. Default user-facing errors never include response body
   * text (kind + byte length only). When true, JSON bodies may include a
   * recursively redacted preview; HTML/opaque bodies are still omitted.
   */
  readonly debugBodyPreview?: boolean;
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T;
  readonly requestId: string;
}

const SECRET_KEY =
  /^(access[_-]?token|refresh[_-]?token|polling[_-]?token|exchange[_-]?code|code[_-]?verifier|authorization|password|secret|cookie|set-cookie|email)$/i;
const JWT_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_LIKE = /^Bearer\s+\S+/i;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "DELETE";
}

function bodyKind(text: string, contentType: string | null): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "empty";
  const lower = (contentType ?? "").toLowerCase();
  if (lower.includes("text/html") || /^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return "html";
  }
  if (lower.includes("application/json") || lower.includes("+json")) return "json-declared";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json-looking";
  if (lower.includes("text/plain")) return "text/plain";
  return "opaque";
}

/** Recursively redact secret keys and secret-shaped leaf values for debug previews only. */
export function redactJsonForPreview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonForPreview);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactJsonForPreview(nested);
    }
    return out;
  }
  if (typeof value === "string") {
    if (JWT_LIKE.test(value) || BEARER_LIKE.test(value) || EMAIL_LIKE.test(value)) return "[redacted]";
    if (/[?&](access_token|refresh_token|code|token)=/i.test(value)) return "[redacted-url]";
    return value;
  }
  return value;
}

function summarizeBody(
  text: string,
  contentType: string | null,
  debugBodyPreview: boolean,
): string {
  const kind = bodyKind(text, contentType);
  const base = `body=${kind}, ${text.length} bytes`;
  if (!debugBodyPreview) return base;
  if (kind === "html" || kind === "opaque" || kind === "empty" || kind === "text/plain") {
    return base;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const redacted = redactJsonForPreview(parsed);
    const preview = JSON.stringify(redacted).replace(/\s+/g, " ").slice(0, 120);
    return `${base}, preview=${JSON.stringify(preview)}`;
  } catch {
    return base;
  }
}

function transportError(
  stage: string | undefined,
  status: number,
  contentType: string | null,
  text: string,
  reason: string,
  debugBodyPreview: boolean,
): CliError {
  const stagePrefix = stage ? `${stage}: ` : "";
  const ct = contentType ?? "unknown";
  const message = `${stagePrefix}${reason} (HTTP ${status}, content-type=${ct}, ${summarizeBody(text, contentType, debugBodyPreview)})`;
  if (status === 401) return new CliError("AUTH_ERROR", message);
  if (status === 403) return new CliError("FORBIDDEN", message);
  if (status === 404) return new CliError("NOT_FOUND", message);
  if (status === 0) return new CliError("NETWORK_ERROR", message);
  return new CliError("VALIDATION_ERROR", message);
}

/**
 * Perform a JSON request against the fixed base URL. Retries GET/DELETE
 * (idempotent) calls with capped exponential backoff on 5xx and network errors.
 * POST/PUT never retry. External AbortSignal stops immediately without retry.
 */
export async function requestJson<T>(
  config: ApiConfig,
  path: string,
  options: RequestJsonOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  const retries = options.retries ?? 0;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const requestId =
    options.requestId ?? `req-${Math.random().toString(36).slice(2, 10)}`;
  const debugBodyPreview = options.debugBodyPreview === true;
  const canRetry = isIdempotentMethod(method) && retries > 0;

  const attempt = async (): Promise<ApiResult<T>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = options.signal;
    const abortHandler = () => controller.abort();
    externalSignal?.addEventListener("abort", abortHandler, { once: true });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
    };
    if (options.auth) {
      headers[options.authHeader ?? "authorization"] = options.auth;
    }

    try {
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (externalSignal?.aborted) {
            throw new CliError(
              "NETWORK_ERROR",
              `${options.stage ? `${options.stage}: ` : ""}request was aborted`,
            );
          }
          throw new RetryableTransportError(
            `${options.stage ? `${options.stage}: ` : ""}request timed out`,
          );
        }
        throw new RetryableTransportError(
          `${options.stage ? `${options.stage}: ` : ""}network error (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      const text = await response.text();
      const contentType = response.headers.get("content-type");
      if (text.length > (config.maxBodyBytes ?? 5 * 1024 * 1024)) {
        throw new CliError("VALIDATION_ERROR", "response body exceeds size limit");
      }

      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          throw transportError(
            options.stage,
            response.status,
            contentType,
            text,
            "response is not valid JSON",
            debugBodyPreview,
          );
        }
      } else if (response.ok) {
        data = null;
      } else {
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          "empty error response",
          debugBodyPreview,
        );
      }

      if (response.status === 401) {
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          "unauthorized",
          debugBodyPreview,
        );
      }
      if (response.status === 403) {
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          "forbidden",
          debugBodyPreview,
        );
      }
      if (response.status === 429) {
        if (canRetry) {
          throw new RetryableTransportError(
            `${options.stage ? `${options.stage}: ` : ""}rate limited`,
          );
        }
        throw new CliError(
          "NETWORK_ERROR",
          `${options.stage ? `${options.stage}: ` : ""}rate limited`,
        );
      }
      if (response.status >= 500) {
        if (canRetry) {
          throw new RetryableStatus(response.status);
        }
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          `request failed with ${response.status}`,
          debugBodyPreview,
        );
      }
      if (response.status >= 400) {
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          `request failed with ${response.status}`,
          debugBodyPreview,
        );
      }
      return { status: response.status, data: data as T, requestId };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortHandler);
    }
  };

  let lastError: unknown;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof CliError) {
        // Auth / schema / validation / not-found never retry.
        throw error;
      }
      if (options.signal?.aborted) {
        throw new CliError(
          "NETWORK_ERROR",
          `${options.stage ? `${options.stage}: ` : ""}request was aborted`,
        );
      }
      const retryable =
        canRetry &&
        i < retries &&
        (error instanceof RetryableStatus || error instanceof RetryableTransportError);
      if (retryable) {
        const backoff = Math.min(500 * 2 ** i, 4000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      if (error instanceof RetryableTransportError) {
        throw new CliError("NETWORK_ERROR", error.message);
      }
      if (error instanceof RetryableStatus) {
        throw new CliError(
          "NETWORK_ERROR",
          `${options.stage ? `${options.stage}: ` : ""}request failed with ${error.status}`,
        );
      }
      lastError = error;
    }
  }
  throw lastError;
}

class RetryableStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`retryable status ${status}`);
    this.status = status;
  }
}

class RetryableTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableTransportError";
  }
}

export interface ApiKeyEntitlement {
  readonly valid: boolean;
  readonly tier: "free" | "pro" | "ent";
  readonly accountId: string;
}

/**
 * Verify an API key. Trim once, never log, send via the configured header,
 * map 401/403/429/5xx distinctly. No persistent storage by default.
 */
export async function verifyApiKey(
  config: ApiConfig,
  key: string,
  options: { verifyPath?: string; signal?: AbortSignal } = {},
): Promise<ApiKeyEntitlement> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new CliError("VALIDATION_ERROR", "API key must not be empty");
  }
  const result = await requestJson<ApiKeyEntitlement>(
    config,
    options.verifyPath ?? "/v1/apikey/verify",
    {
      method: "POST",
      body: { key: trimmed },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return result.data;
}
