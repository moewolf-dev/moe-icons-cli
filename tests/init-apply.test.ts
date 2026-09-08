import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { main } from "../src/cli.js";
import { applyPlannedChanges } from "../src/project/anchors/apply.js";

let dir: string;

function makeRuntime(opts?: { yes?: boolean; isTTY?: boolean; readLine?: () => Promise<string> }) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => dir,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => opts?.isTTY ?? false,
      readLine: opts?.readLine ?? (async () => ""),
      readKey: async () => "",
    },
    out,
    err,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-init-apply-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeReactProject(): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "p",
      version: "1.0.0",
      dependencies: { react: "^18", "react-dom": "^18" },
      devDependencies: { vite: "^6" },
    }),
  );
  writeFileSync(join(dir, "package-lock.json"), "{}");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.tsx"),
    'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
  );
  writeFileSync(join(dir, "src", "index.css"), "");
}

describe("init apply (E2E-B5)", () => {
  it("non-TTY without --yes refuses to write", async () => {
    makeReactProject();
    const { runtime, err } = makeRuntime();
    const code = await main(["init"], runtime);
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/pass --yes|TTY/i);
    expect(readdirSync(dir)).not.toContain("moeicons.config.jsonc");
  });

  it("init --yes applies config + entry + style fixes", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["init", "--yes"], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "moeicons.config.jsonc"))).toBe(true);
    const mainTsx = readFileSync(join(dir, "src", "main.tsx"), "utf8");
    expect(mainTsx).toContain("MoeiconsProvider");
    const css = readFileSync(join(dir, "src", "index.css"), "utf8");
    expect(css).toContain("moeicons/styles.css");
    expect(out.join("")).toMatch(/Applied|moeicons\.config\.jsonc/);
  });

  it("init --dry-run prints diffs and writes nothing", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["init", "--dry-run"], runtime);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Moeicons config");
    expect(text).toMatch(/\*\*\* create moeicons\.config\.jsonc|--- \/dev\/null/);
    expect(readdirSync(dir)).not.toContain("moeicons.config.jsonc");
  });

  it("init --json --dry-run uses relative paths (no absolute home)", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["init", "--json", "--dry-run"], runtime);
    expect(code).toBe(0);
    const raw = out.join("");
    expect(raw).not.toContain(homedir());
    const parsed = JSON.parse(raw) as {
      projectRoot?: string;
      mode?: string;
      anchors: Array<{ path?: string; candidates: string[]; fixes: Array<{ path: string }> }>;
      diffs: unknown[];
    };
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.projectRoot).toBe(".");
    for (const anchor of parsed.anchors) {
      if (anchor.path) {
        expect(anchor.path.startsWith("/")).toBe(false);
        expect(anchor.path).not.toContain(homedir());
      }
      for (const c of anchor.candidates) {
        expect(c.startsWith("/")).toBe(false);
      }
    }
    expect(parsed.diffs.length).toBeGreaterThan(0);
  });

  it("doctor --json never embeds absolute home paths", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["doctor", "--json"], runtime);
    expect(code).toBe(0);
    const raw = out.join("");
    expect(raw).not.toContain(homedir());
    const parsed = JSON.parse(raw) as { projectRoot?: string; anchors: Array<{ path?: string }> };
    expect(parsed.projectRoot).toBe(".");
    for (const anchor of parsed.anchors) {
      if (anchor.path) expect(anchor.path.startsWith("/")).toBe(false);
    }
  });

  it("second init --yes is idempotent (already configured)", async () => {
    makeReactProject();
    const first = makeRuntime();
    expect(await main(["init", "--yes"], first.runtime)).toBe(0);
    const configBytes = readFileSync(join(dir, "moeicons.config.jsonc"));
    const mainBytes = readFileSync(join(dir, "src", "main.tsx"));
    const cssBytes = readFileSync(join(dir, "src", "index.css"));
    const second = makeRuntime();
    const code = await main(["init", "--yes"], second.runtime);
    expect(code).toBe(0);
    expect(second.out.join("")).toMatch(/already configured/i);
    expect(Buffer.compare(configBytes, readFileSync(join(dir, "moeicons.config.jsonc")))).toBe(0);
    expect(Buffer.compare(mainBytes, readFileSync(join(dir, "src", "main.tsx")))).toBe(0);
    expect(Buffer.compare(cssBytes, readFileSync(join(dir, "src", "index.css")))).toBe(0);
  });

  it("TTY decline cancels with zero writes", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime({
      isTTY: true,
      readLine: async () => "n",
    });
    const code = await main(["init"], runtime);
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/[Cc]ancel/);
    expect(readdirSync(dir)).not.toContain("moeicons.config.jsonc");
  });

  it("apply rollback restores originals when a mid-write fails", () => {
    const original = "original content";
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "one.txt"), original);
    const fs_ = {
      existsSync: (p: string) => existsSync(p),
      readTextFileSync: (p: string) => readFileSync(p, "utf8"),
      mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      writeTextFileSync: (p: string, c: string) => {
        if (p.endsWith("two.txt")) throw new Error("boom");
        writeFileSync(p, c);
      },
      renameSync: (a: string, b: string) => require("node:fs").renameSync(a, b),
      rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) =>
        rmSync(p, { recursive: true, force: true }),
    };
    const result = applyPlannedChanges(
      dir,
      [
        { kind: "replace", path: "a/one.txt", before: original, after: "changed" },
        { kind: "create", path: "b/two.txt", before: undefined, after: "x" },
      ],
      fs_,
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, "a", "one.txt"), "utf8")).toBe(original);
    expect(existsSync(join(dir, "b", "two.txt"))).toBe(false);
  });
});
