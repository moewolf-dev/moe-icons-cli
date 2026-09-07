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
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T;
  readonly requestId: string;
}

const SECRET_PATTERNS =
  /Bearer\s+[A-Za-z0-9._~+/-]+=*|access_token|refresh_token|pollingToken|exchangeCode|code_verifier|authorization/gi;

function redact(value: string): string {
  return value.replace(SECRET_PATTERNS, "[redacted]");
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

function summarizeBody(text: string, contentType: string | null): string {
  const kind = bodyKind(text, contentType);
  const preview = redact(text.replace(/\s+/g, " ").slice(0, 80));
  return `body=${kind}, ${text.length} bytes${preview ? `, preview=${JSON.stringify(preview)}` : ""}`;
}

function transportError(
  stage: string | undefined,
  status: number,
  contentType: string | null,
  text: string,
  reason: string,
): CliError {
  const stagePrefix = stage ? `${stage}: ` : "";
  const ct = contentType ?? "unknown";
  const message = `${stagePrefix}${reason} (HTTP ${status}, content-type=${ct}, ${summarizeBody(text, contentType)})`;
  if (status === 401) return new CliError("AUTH_ERROR", message);
  if (status === 403) return new CliError("FORBIDDEN", message);
  if (status === 404) return new CliError("NOT_FOUND", message);
  if (status === 0) return new CliError("NETWORK_ERROR", message);
  return new CliError("VALIDATION_ERROR", message);
}

/**
 * Perform a JSON request against the fixed base URL. Retries GET/idempotent
 * calls with capped exponential backoff on 5xx and network errors.
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
          throw new CliError(
            "NETWORK_ERROR",
            `${options.stage ? `${options.stage}: ` : ""}request timed out or was aborted`,
          );
        }
        throw new CliError(
          "NETWORK_ERROR",
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
        );
      }

      if (response.status === 401) {
        throw transportError(options.stage, response.status, contentType, text, "unauthorized");
      }
      if (response.status === 403) {
        throw transportError(options.stage, response.status, contentType, text, "forbidden");
      }
      if (response.status === 429) {
        throw new CliError(
          "NETWORK_ERROR",
          `${options.stage ? `${options.stage}: ` : ""}rate limited`,
        );
      }
      if (response.status >= 500 && retries > 0) {
        throw new RetryableStatus(response.status);
      }
      if (response.status >= 400) {
        throw transportError(
          options.stage,
          response.status,
          contentType,
          text,
          `request failed with ${response.status}`,
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
        // Do not retry auth / schema / validation failures.
        if (
          error.code === "AUTH_ERROR" ||
          error.code === "FORBIDDEN" ||
          error.code === "VALIDATION_ERROR" ||
          error.code === "NOT_FOUND"
        ) {
          throw error;
        }
        throw error;
      }
      if (error instanceof RetryableStatus && i < retries) {
        const backoff = Math.min(500 * 2 ** i, 4000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
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
