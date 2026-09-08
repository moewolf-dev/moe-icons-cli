import { describe, expect, it, vi } from "vitest";
import { loginWithDeviceSession } from "../src/auth/device-login.js";
import {
  parseCreateLoginResponse,
  parseExchangeLoginResponse,
  parsePollLoginResponse,
} from "../src/auth/login-schemas.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";

function memoryStore() {
  let value: StoredSession | undefined;
  const store: TokenStore = {
    get: () => value,
    getActive: () => value,
    set: (next) => {
      value = next;
    },
    delete: () => {
      value = undefined;
    },
    clear: () => {
      value = undefined;
    },
  };
  return { store, get: () => value };
}

const config = {
  apiBaseUrl: "https://api.moeicons.com",
  websiteOrigin: "https://moeicons.com",
  auth0Issuer: "https://tenant.auth0.com",
  auth0ClientId: "client",
};

const validCreate = {
  loginId: "id",
  pollingToken: "poll",
  browserUrl: "https://moeicons.com/cli-login?loginId=id",
  intervalSeconds: 5,
  expiresAt: "2099-08-24T00:10:00Z",
};

describe("login response schemas", () => {
  it("accepts valid create/poll/exchange payloads", () => {
    expect(parseCreateLoginResponse(validCreate)).toEqual(validCreate);
    expect(parsePollLoginResponse({ status: "pending" })).toEqual({ status: "pending" });
    expect(parsePollLoginResponse({ status: "complete", exchangeCode: "ex" })).toEqual({
      status: "complete",
      exchangeCode: "ex",
    });
    expect(
      parseExchangeLoginResponse({
        accountId: "a",
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 900,
        tokenType: "Bearer",
      }),
    ).toMatchObject({ accountId: "a", expiresIn: 900 });
  });

  it("rejects missing fields, bad dates, unknown status, and invalid expiresIn", () => {
    expect(() => parseCreateLoginResponse({ ...validCreate, loginId: "" })).toThrow(/loginId/);
    expect(() => parseCreateLoginResponse({ ...validCreate, expiresAt: "not-a-date" })).toThrow(
      /expiresAt/,
    );
    expect(() => parseCreateLoginResponse({ ...validCreate, intervalSeconds: 0 })).toThrow(
      /interval/,
    );
    expect(() => parsePollLoginResponse({ status: "done" })).toThrow(/unknown status/);
    expect(() => parsePollLoginResponse({ status: "complete" })).toThrow(/exchangeCode/);
    expect(() =>
      parseExchangeLoginResponse({
        accountId: "a",
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: -1,
      }),
    ).toThrow(/expiresIn/);
    expect(() =>
      parseExchangeLoginResponse({
        accountId: "a",
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: Number.NaN,
      }),
    ).toThrow(/expiresIn/);
  });
});

describe("device-style Auth0 login schema gates", () => {
  it("does not open the browser or write tokens when create schema is invalid", async () => {
    const memory = memoryStore();
    const openBrowser = vi.fn();
    await expect(
      loginWithDeviceSession(config, {
        request: async <T>() =>
          ({
            status: 201,
            data: { ...validCreate, intervalSeconds: Number.NaN },
          }) as { status: number; data: T },
        openBrowser,
        sleep: async () => undefined,
        tokenStore: memory.store,
        now: () => Date.parse("2026-08-24T00:00:00Z"),
      }),
    ).rejects.toThrow(/interval/);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(memory.get()).toBeUndefined();
  });

  it("does not write tokens when exchange schema is invalid", async () => {
    const memory = memoryStore();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 201, data: validCreate })
      .mockResolvedValueOnce({
        status: 200,
        data: { status: "complete", exchangeCode: "exchange" },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { accountId: "auth0|user", accessToken: "access", refreshToken: "refresh", expiresIn: 0 },
      })
      .mockResolvedValueOnce({ status: 200, data: { status: "cancelled" } });
    await expect(
      loginWithDeviceSession(config, {
        request,
        openBrowser: async () => undefined,
        sleep: async () => undefined,
        tokenStore: memory.store,
        now: () => Date.parse("2026-08-24T00:00:00Z"),
      }),
    ).rejects.toThrow(/expiresIn/);
    expect(memory.get()).toBeUndefined();
  });
});
