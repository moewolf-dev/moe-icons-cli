import { describe, expect, it } from "vitest";
import {
  describeAuthEnvironment,
  resolveAuthEnvironment,
} from "../src/core/auth.js";
import type { CommandContext } from "../src/core/context.js";

function context(env: Record<string, string>): CommandContext {
  return {
    cwd: ".",
    env,
    signal: new AbortController().signal,
    now: () => new Date(),
    ui: {} as CommandContext["ui"],
  };
}

const LOCAL = {
  MOEICONS_API_BASE_URL: "http://127.0.0.1:8787",
  MOEICONS_WEBSITE_ORIGIN: "http://localhost:5173",
};

describe("H5 resolveAuthEnvironment", () => {
  it("defaults to production endpoints", () => {
    const resolved = resolveAuthEnvironment({});
    expect(resolved.mode).toBe("production");
    expect(resolved.label).toBe("production");
    expect(resolved.apiBaseUrl).toBe("https://api.moeicons.com");
    expect(resolved.websiteOrigin).toBe("https://moeicons.com");
  });

  it("infers local only when both API and website are loopback http", () => {
    const resolved = resolveAuthEnvironment(LOCAL);
    expect(resolved.mode).toBe("local");
    expect(resolved.label).toBe("local (dev)");
  });

  it("rejects mixed loopback/production endpoints in both directions", () => {
    expect(() =>
      resolveAuthEnvironment({ MOEICONS_API_BASE_URL: "http://127.0.0.1:8787" }),
    ).toThrow(/both be loopback/);
    expect(() =>
      resolveAuthEnvironment({ MOEICONS_WEBSITE_ORIGIN: "http://localhost:5173" }),
    ).toThrow(/both be loopback/);
  });

  it("honors MOEICONS_ENV when it agrees with the endpoints", () => {
    expect(resolveAuthEnvironment({ ...LOCAL, MOEICONS_ENV: "local" }).mode).toBe("local");
    expect(resolveAuthEnvironment({ MOEICONS_ENV: "production" }).mode).toBe("production");
  });

  it("rejects MOEICONS_ENV that conflicts with the endpoints", () => {
    expect(() => resolveAuthEnvironment({ ...LOCAL, MOEICONS_ENV: "production" })).toThrow(/conflicts/);
    expect(() => resolveAuthEnvironment({ MOEICONS_ENV: "local" })).toThrow(/conflicts/);
  });

  it("rejects unknown MOEICONS_ENV and non-loopback http", () => {
    expect(() => resolveAuthEnvironment({ MOEICONS_ENV: "staging" })).toThrow(/local or production/);
    expect(() =>
      resolveAuthEnvironment({ MOEICONS_API_BASE_URL: "http://api.example.com" }),
    ).toThrow(/https or loopback/);
  });

  it("describeAuthEnvironment reads the command context env", () => {
    expect(describeAuthEnvironment(context({ ...LOCAL }))).toBe("local (dev)");
    expect(describeAuthEnvironment(context({}))).toBe("production");
  });
});
