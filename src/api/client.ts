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
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T;
  readonly requestId: string;
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
    options.requestId ??
    `req-${Math.random().toString(36).slice(2, 10)}`;

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
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > (config.maxBodyBytes ?? 5 * 1024 * 1024)) {
        throw new CliError("VALIDATION_ERROR", "response body exceeds size limit");
      }
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new CliError("VALIDATION_ERROR", "response is not valid JSON");
        }
      }
      if (response.status === 401) throw new CliError("AUTH_ERROR", "unauthorized");
      if (response.status === 403) throw new CliError("FORBIDDEN", "forbidden");
      if (response.status === 429) {
        throw new CliError("NETWORK_ERROR", "rate limited");
      }
      if (response.status >= 500 && retries > 0) {
        throw new RetryableStatus(response.status);
      }
      if (response.status >= 400) {
        throw new CliError("NETWORK_ERROR", `request failed with ${response.status}`);
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
      if (error instanceof CliError) throw error;
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
