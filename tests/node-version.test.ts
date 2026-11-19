import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const check = require(
  join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "check-node.cjs"),
) as {
  MIN_MAJOR: number;
  assertSupportedNode: (
    version: string,
    options?: { env?: Record<string, string | undefined> },
  ) => {
    ok: boolean;
    major: number | null;
    code: string;
    current: string;
    required: string;
    hint: string;
    message: string;
  };
  startupFailureJson: (result: {
    code?: string;
    message: string;
    current?: string;
    required?: string;
    hint?: string;
  }) => Record<string, unknown>;
};

describe("bin Node version guard", () => {
  it("rejects Node 18, 20 and 22 with a no-stack LTS message", () => {
    for (const version of ["v18.20.8", "v20.11.0", "v22.18.0"]) {
      const result = check.assertSupportedNode(version);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Node.js 24 or later");
      expect(result.message).toContain(version);
      expect(result.message).toContain("https://nodejs.org/en/download");
      expect(result.message).toContain("node -v");
      expect(result.message).not.toContain("SyntaxError");
      expect(result.message).not.toMatch(/^\s*at /m);
    }
  });

  it("accepts Node 24", () => {
    expect(check.assertSupportedNode("v24.18.0").ok).toBe(true);
    expect(check.MIN_MAJOR).toBe(24);
  });

  it("only suggests a manager command when that manager is detected", () => {
    const withNvm = check.assertSupportedNode("v22.0.0", { env: { NVM_DIR: "/tmp/nvm" } });
    expect(withNvm.message).toContain("nvm install 24");
    const unknown = check.assertSupportedNode("v22.0.0", { env: {} });
    expect(unknown.message).not.toContain("nvm install");
    expect(unknown.message).not.toContain("sudo");
  });

  it("emits the detected manager's own upgrade command only", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ NVM_DIR: "/tmp/nvm" }, "nvm install 24"],
      [{ FNM_MULTISHELL_PATH: "/tmp/fnm" }, "fnm install 24"],
      [{ VOLTA_HOME: "/tmp/volta" }, "volta install node@24"],
      [{ ASDF_DIR: "/tmp/asdf" }, "asdf install nodejs latest:24"],
    ];
    for (const [env, command] of cases) {
      const result = check.assertSupportedNode("v22.0.0", { env });
      expect(result.message).toContain(command);
      for (const other of ["nvm install", "fnm install", "volta install", "asdf install"]) {
        if (!command.startsWith(other)) expect(result.message).not.toContain(other);
      }
    }
    const unknown = check.assertSupportedNode("v22.0.0", { env: {} });
    expect(unknown.message).toContain("https://nodejs.org/en/download");
    for (const command of ["nvm install", "fnm install", "volta install", "asdf install"]) {
      expect(unknown.message).not.toContain(command);
    }
  });

  it("returns a stable startup JSON contract for --json", () => {
    const result = check.assertSupportedNode("v22.0.0");
    expect(check.startupFailureJson(result)).toMatchObject({
      ok: false,
      code: "NODE_VERSION_UNSUPPORTED",
      current: "v22.0.0",
      required: ">=24",
    });
  });
});
