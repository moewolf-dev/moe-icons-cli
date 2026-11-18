import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const bin = join(root, "bin", "moeicons.js");
const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;

function run(
  args: string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** Build a minimal installed-like tree: bin + package + (optionally) dist. */
function fixture(kind: "missing-dependency" | "syntax-error" | "permission"): string {
  const dir = mkdtempSync(join(tmpdir(), "moeicons-startup-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(join(root, "bin", "moeicons.js"), join(dir, "bin", "moeicons.js"));
  cpSync(join(root, "bin", "check-node.cjs"), join(dir, "bin", "check-node.cjs"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "moeicons-fixture", version, type: "module" }),
  );
  if (kind !== "syntax-error") {
    cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  } else {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli.js"), "export const = ;\n");
  }
  if (kind === "permission") {
    chmodSync(join(dir, "dist", "cli.js"), 0o000);
  }
  return dir;
}

function runFixture(dir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(dir, "bin", "moeicons.js"), ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("REF-07 wrapper startup matrix", () => {
  it("aborts an active command on the first SIGINT and exits 130", async () => {
    const child = spawn(process.execPath, [bin, "mcp"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Let readline attach to stdin before signalling.
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 5_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(130);
    expect(stderr).not.toMatch(/fatal:|SyntaxError/);
    child.stdin.destroy();
  });
  afterEach(() => {
    delete process.env.MOEICONS_TEST_MODE;
  });

  it("prints the version on a supported Node without a stack", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    expect(result.stderr).not.toMatch(/SyntaxError|\n\s+at /);
  });

  it("fails Node 20/22 before importing dist, with actionable guidance", () => {
    for (const unsupported of ["v20.11.0", "v22.18.0"]) {
      const result = run(["--version"], {
        MOEICONS_TEST_MODE: "1",
        MOEICONS_TEST_NODE_VERSION: unsupported,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Node.js 24 or later");
      expect(result.stderr).toContain(unsupported);
      expect(result.stderr).toContain("node -v");
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.stderr).not.toMatch(/^\s+at /m);
    }
  });

  it("returns a stable JSON startup error for --json", () => {
    const result = run(["--json", "--version"], {
      MOEICONS_TEST_MODE: "1",
      MOEICONS_TEST_NODE_VERSION: "v22.0.0",
    });
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: "NODE_VERSION_UNSUPPORTED", required: ">=24" });
    expect(String(body.hint)).toContain("Node.js 24");
  });

  for (const kind of ["missing-dependency", "syntax-error", "permission"] as const) {
    it(`reports ${kind} as a structured startup failure`, () => {
      const dir = fixture(kind);
      try {
        const result = runFixture(dir, ["account", "--json"]);
        const body = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(result.code).toBe(1);
        expect(body).toMatchObject({ ok: false, code: "CLI_IMPORT_FAILED" });
        expect(String(body.hint)).toContain("reinstall");
        expect(result.stderr).not.toMatch(/^\s+at /m);
      } finally {
        try {
          chmodSync(join(dir, "dist", "cli.js"), 0o644);
        } catch {
          /* The syntax-error fixture has a readable file. */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("reports a missing dist as a structured startup failure, not a raw stack", () => {
    const fixture = mkdtempSync(join(tmpdir(), "moeicons-wrapper-"));
    try {
      mkdirSync(join(fixture, "bin"), { recursive: true });
      cpSync(join(root, "bin", "moeicons.js"), join(fixture, "bin", "moeicons.js"));
      cpSync(join(root, "bin", "check-node.cjs"), join(fixture, "bin", "check-node.cjs"));
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ name: "moeicons-fixture", version, type: "module" }),
      );
      let result: { code: number; stdout: string; stderr: string };
      try {
        const output = execFileSync(
          process.execPath,
          [join(fixture, "bin", "moeicons.js"), "--version"],
          {
            cwd: fixture,
            encoding: "utf8",
            stdio: "pipe",
          },
        );
        result = { code: 0, stdout: output, stderr: "" };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        result = {
          code: failure.status ?? 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
      // --version only reads package.json; missing dist must not affect it.
      expect(result.stdout.trim()).toBe(version);

      let commandFailure: { code: number; stdout: string; stderr: string };
      try {
        execFileSync(process.execPath, [join(fixture, "bin", "moeicons.js"), "account", "--json"], {
          cwd: fixture,
          encoding: "utf8",
          stdio: "pipe",
        });
        commandFailure = { code: 0, stdout: "", stderr: "" };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        commandFailure = {
          code: failure.status ?? 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
      expect(commandFailure.code).toBe(1);
      const body = JSON.parse(commandFailure.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, code: "CLI_IMPORT_FAILED" });
      expect(String(body.hint)).toContain("npm run build");
      expect(commandFailure.stderr).not.toMatch(/^\s+at /m);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
