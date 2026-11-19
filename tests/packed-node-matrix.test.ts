import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P0-00 packed-tarball Node matrix.
 *
 * Runs the packed artifact with real Node 20/22/24 binaries when they are
 * installed locally (nvm paths or MOEICONS_NODE20_BIN / MOEICONS_NODE22_BIN).
 * The unsupported versions must fail in the zero-dependency wrapper before
 * `dist/` is imported, in both human and `--json` modes.
 */

const root = process.cwd();
const npmCache = process.env.MOEICONS_NPM_CACHE ?? join(root, "..", ".tmp-npm-cache");

function findNode(version: "20" | "22" | "24"): string | undefined {
  const override = process.env[`MOEICONS_NODE${version}_BIN`];
  if (override && existsSync(override)) return override;
  const base = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(base)) return undefined;
  for (const entry of readdirSync(base)) {
    if (entry.startsWith(`v${version}.`)) {
      const candidate = join(base, entry, "bin", "node");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const node20 = findNode("20");
const node22 = findNode("22");
const node24 = findNode("24") ?? process.execPath;
const nodeMajor = (path: string): number =>
  Number(
    execFileSync(path, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).trim(),
  );

let extractRoot = "";
let bin = "";
let packageVersion = "";

function run(
  nodePath: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(nodePath, [bin, ...args], {
      cwd: options.cwd ?? root,
      encoding: "utf8",
      env: { ...process.env, ...(options.env ?? {}) },
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

beforeAll(() => {
  if (!existsSync(join(root, "dist", "cli.js"))) {
    execSync("npm run build", { cwd: root, stdio: "inherit" });
  }
  const packDir = mkdtempSync(join(tmpdir(), "moeicons-node-matrix-pack-"));
  const output = execSync(`npm pack --pack-destination "${packDir}" 2>/dev/null`, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  const tarball = output.trim().split("\n").pop() ?? "";
  extractRoot = mkdtempSync(join(root, ".tmp-packed-matrix-"));
  execSync(`tar -xzf "${join(packDir, tarball)}" -C "${extractRoot}"`, { stdio: "pipe" });
  rmSync(packDir, { recursive: true, force: true });
  bin = join(extractRoot, "package", "bin", "moeicons.js");
  packageVersion = (
    JSON.parse(readFileSync(join(extractRoot, "package", "package.json"), "utf8")) as {
      version: string;
      engines: { node: string };
    }
  ).version;
});

afterAll(() => {
  if (extractRoot) rmSync(extractRoot, { recursive: true, force: true });
});

describe("P0-00 packed Node matrix", () => {
  it("packs Node 24 engines and the wrapper preflight", () => {
    const pkg = JSON.parse(readFileSync(join(extractRoot, "package", "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(">=24.0.0");
    expect(readFileSync(join(extractRoot, "package", "bin", "check-node.cjs"), "utf8")).toContain(
      "var MIN_MAJOR = 24",
    );
  });

  it("runs normally on the packed artifact with Node 24", () => {
    expect(nodeMajor(node24)).toBe(24);
    const version = run(node24, ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(packageVersion);
    const help = run(node24, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--export-diagnostics");

    const project = mkdtempSync(join(tmpdir(), "moeicons-packed-project-"));
    try {
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "packed-fixture", version: "1.0.0" }),
      );
      const diagnostics = run(node24, ["doctor", "--export-diagnostics", "--json"], {
        cwd: project,
        env: { MOEICONS_CACHE_DIR: join(project, "cache") },
      });
      expect(diagnostics.code).toBe(0);
      expect(JSON.parse(diagnostics.stdout)).toMatchObject({ ok: true, exported: true });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  for (const [label, nodePath] of [
    ["Node 20", node20],
    ["Node 22", node22],
  ] as const) {
    const available = nodePath !== undefined;
    it.skipIf(!available)(`fails ${label} before importing dist (human and JSON)`, () => {
      const versionMajor = nodeMajor(nodePath!);
      expect(String(versionMajor)).toBe(label === "Node 20" ? "20" : "22");

      const human = run(nodePath!, ["--version"]);
      expect(human.code).toBe(1);
      expect(human.stderr).toContain("Node.js 24 or later");
      expect(human.stderr).toContain(`v${versionMajor}.`);
      expect(human.stderr).toContain("node -v");
      expect(human.stderr).not.toContain("SyntaxError");
      expect(human.stdout).toBe("");

      const json = run(nodePath!, ["--json", "--version"]);
      expect(json.code).toBe(1);
      const body = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        code: "NODE_VERSION_UNSUPPORTED",
        required: ">=24",
      });
      expect(String(body.message)).toContain("Node.js 24 or later");
      expect(String(body.hint)).toContain("Node.js 24");
    });
  }
});
