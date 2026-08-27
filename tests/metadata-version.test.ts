import { describe, expect, it } from "vitest";
import {
  compareVersions,
  formatBytes,
  cliCompatible,
  isVersionNewer,
} from "../src/metadata/version.js";

describe("metadata version comparison", () => {
  it("compares semver numerically, never as string dictionary order", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.10.0", "1.2.0")).toBe(1);
    expect(compareVersions("0.0.17", "0.0.17")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.3-alpha")).toBe(1);
    expect(compareVersions("1.2.3-alpha", "1.2.3-beta")).toBe(-1);
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(-1);
  });

  it("rejects malformed versions", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(/invalid version/);
    expect(() => compareVersions("not-a-version", "1.2.3")).toThrow(/invalid version/);
  });

  it("exposes isVersionNewer", () => {
    expect(isVersionNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isVersionNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("checks CLI compatibility against the builder-declared minimum", () => {
    expect(cliCompatible("0.1.0", "0.1.0")).toBe(true);
    expect(cliCompatible("0.1.0", "0.2.0")).toBe(true);
    expect(cliCompatible("0.1.0", "0.0.1")).toBe(false);
    expect(cliCompatible("not-a-version", "0.1.0")).toBe(false);
  });
});

describe("formatBytes (frozen MiB/KiB contract)", () => {
  it("formats bytes in MiB (1024-based, one decimal)", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MiB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300.0 MiB");
  });
  it("formats smaller sizes in KiB and B", () => {
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
  });
});
