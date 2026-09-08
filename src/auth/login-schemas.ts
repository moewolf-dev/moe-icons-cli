import { CliError } from "../errors/index.js";

export interface CreateLoginResponse {
  readonly loginId: string;
  readonly pollingToken: string;
  readonly browserUrl: string;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
}

export interface PollLoginResponse {
  readonly status: "pending" | "complete";
  readonly exchangeCode?: string;
}

export interface ExchangeLoginResponse {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: "Bearer";
}

function asRecord(data: unknown, stage: string): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError("VALIDATION_ERROR", `${stage}: response schema is not an object`);
  }
  return data as Record<string, unknown>;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  stage: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("VALIDATION_ERROR", `${stage}: missing or invalid ${field}`);
  }
  return value;
}

/** Validate create-session JSON before opening a browser or storing anything. */
export function parseCreateLoginResponse(data: unknown): CreateLoginResponse {
  const stage = "login create";
  const record = asRecord(data, stage);
  const loginId = requireNonEmptyString(record, "loginId", stage);
  const pollingToken = requireNonEmptyString(record, "pollingToken", stage);
  const browserUrl = requireNonEmptyString(record, "browserUrl", stage);
  const expiresAt = requireNonEmptyString(record, "expiresAt", stage);
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new CliError("VALIDATION_ERROR", `${stage}: expiresAt is not a valid date`);
  }
  const intervalSeconds = record.intervalSeconds;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    intervalSeconds > 60
  ) {
    throw new CliError("VALIDATION_ERROR", `${stage}: invalid polling interval`);
  }
  return { loginId, pollingToken, browserUrl, intervalSeconds, expiresAt };
}

/** Validate poll JSON; complete requires a non-empty exchangeCode. */
export function parsePollLoginResponse(data: unknown): PollLoginResponse {
  const stage = "login poll";
  const record = asRecord(data, stage);
  const status = record.status;
  if (status !== "pending" && status !== "complete") {
    throw new CliError("VALIDATION_ERROR", `${stage}: unknown status`);
  }
  if (status === "pending") {
    return { status: "pending" };
  }
  const exchangeCode = requireNonEmptyString(record, "exchangeCode", stage);
  return { status: "complete", exchangeCode };
}

/** Validate exchange JSON before writing the token store. */
export function parseExchangeLoginResponse(data: unknown): ExchangeLoginResponse {
  const stage = "login exchange";
  const record = asRecord(data, stage);
  const accountId = requireNonEmptyString(record, "accountId", stage);
  const accessToken = requireNonEmptyString(record, "accessToken", stage);
  const refreshToken = requireNonEmptyString(record, "refreshToken", stage);
  const expiresIn = record.expiresIn;
  if (
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    Number.isNaN(expiresIn)
  ) {
    throw new CliError("VALIDATION_ERROR", `${stage}: invalid expiresIn`);
  }
  if (record.tokenType !== "Bearer") {
    throw new CliError("VALIDATION_ERROR", `${stage}: unsupported tokenType`);
  }
  return { accountId, accessToken, refreshToken, expiresIn, tokenType: "Bearer" };
}
