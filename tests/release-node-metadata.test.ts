import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  devDependencies?: Record<string, string>;
};

describe("P0-00 release metadata gate", () => {
  it("declares Node 24 engines and a pinned .nvmrc", () => {
    expect(pkg.engines?.node).toBe(">=24.0.0");
    expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toBe("24");
  });

  it("ships the wrapper preflight and dist in the tarball manifest", () => {
    expect(pkg.bin?.moeicons).toBe("bin/moeicons.js");
    expect(pkg.files).toEqual(expect.arrayContaining(["bin", "dist", "README.md", "LICENSE"]));
    const checkNode = readFileSync(join(root, "bin", "check-node.cjs"), "utf8");
    expect(checkNode).toContain("var MIN_MAJOR = 24");
    expect(checkNode).not.toMatch(/require\(["']\.\.\/dist/);
  });

  it("keeps every GitHub Actions Node version on 24", () => {
    const workflows = join(root, ".github", "workflows");
    const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(workflows, file), "utf8");
      for (const line of text.split("\n")) {
        const match = /node-version:\s*(.+)$/.exec(line);
        if (!match) continue;
        expect(match[1]!.trim()).toMatch(/^['"]?24(\.[x0-9]+)?['"]?$/);
      }
    }
  });

  it("does not claim Node 22 support in user-facing docs", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("Node.js **24 or later**");
    expect(readme).not.toMatch(/Node\.js \*\*22|Node 22 or later/);
    expect(readme).toContain("--accessible");
    expect(readme).toContain("--export-diagnostics");
    expect(readme).toContain("hard ceiling of **3 active");
  });

  it("documents the JSON compatibility and diagnostics contracts", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("ok/code/message");
    expect(readme).toMatch(/never creates a log\s+file/);
    expect(readme).toContain("24-hour expiry");
  });
});
