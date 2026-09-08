import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCreateLoginResponse,
  parseExchangeLoginResponse,
  parsePollLoginResponse,
} from "../src/auth/login-schemas.js";

/**
 * E2E-H1 consumer side: the CLI parses exactly the bytes frozen by the Worker's
 * shared `cli-login-state-machine.v1.json`. A drift in either side fails here.
 */

const FIXTURE_PATH = join(__dirname, "fixtures", "contracts", "cli-login-state-machine.v1.json");
const CONTRACT_SHA256 = "c7fd8f2b9dacce9dc7c0ed10bb4535a94cbe1d395bfba6c3165e9d7eeb3c2f63";

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  schemaVersion: number;
  transitions: Array<{ id: string; response: { required: string[]; statusValue?: string } }>;
  errorCodes: string[];
};

function required(id: string): string[] {
  const item = fixture.transitions.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing transition ${id}`);
  return item.response.required;
}

describe("E2E-H1 CLI login contract consumer", () => {
  it("validates the shared fixture bytes", () => {
    const bytes = readFileSync(FIXTURE_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(CONTRACT_SHA256);
    expect(fixture.schemaVersion).toBe(1);
    for (const code of ["SESSION_EXPIRED", "SESSION_REPLAYED", "RATE_LIMITED"]) {
      expect(fixture.errorCodes).toContain(code);
    }
  });

  it("parses create/pending/complete/exchange bodies with the declared fields", () => {
    const create = parseCreateLoginResponse({
      ok: true,
      loginId: "id",
      pollingToken: "poll",
      browserUrl: "https://moeicons.com/cli-login?loginId=id",
      intervalSeconds: 5,
      expiresAt: "2099-01-01T00:00:00Z",
    });
    for (const field of required("create")) {
      expect(create, `create.${field}`).toHaveProperty(field === "ok" ? "loginId" : field);
    }

    expect(parsePollLoginResponse({ ok: true, status: "pending", expiresAt: "2099-01-01T00:00:00Z" })).toEqual({ status: "pending" });
    expect(parsePollLoginResponse({ ok: true, status: "complete", exchangeCode: "exchange" })).toEqual({ status: "complete", exchangeCode: "exchange" });

    const exchange = parseExchangeLoginResponse({
      ok: true,
      accountId: "auth0|user",
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 900,
      tokenType: "Bearer",
    });
    for (const field of required("exchange")) {
      expect(exchange, `exchange.${field}`).toHaveProperty(field === "ok" ? "accountId" : field);
    }
  });

  it("rejects malformed bodies that would violate the contract", () => {
    expect(() => parseCreateLoginResponse({ loginId: "id", pollingToken: "p", browserUrl: "u" })).toThrow();
    expect(() => parsePollLoginResponse({ status: "complete" })).toThrow();
    expect(() => parseExchangeLoginResponse({ accountId: "a", accessToken: "x", refreshToken: "y", expiresIn: 0 })).toThrow();
  });
});
