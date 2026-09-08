import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

let dir: string;
function makeRuntime() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => dir,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
    },
    out,
    err,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-doctor-cmd-"));
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

describe("doctor command end-to-end", () => {
  it("prints all four anchor rows (manifest + config visible)", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["doctor"], runtime);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Project manifest");
    expect(text).toContain("Moeicons config");
    expect(text).toContain("Application integration");
    expect(text).toContain("Styling integration");
  });

  it("--json returns a stable machine report and never writes", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["doctor", "--json"], runtime);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; anchors: Array<{ kind: string; status: string }> };
    expect(parsed.anchors.map((a) => a.kind)).toEqual([
      "manifest",
      "config",
      "application",
      "style",
    ]);
    // No file created by a read-only doctor.
    const names = readdirSync(dir);
    expect(names).not.toContain("moeicons.config.jsonc");
  });

  it("init --dry-run prints the plan but writes nothing", async () => {
    makeReactProject();
    const { runtime, out } = makeRuntime();
    const code = await main(["init", "--dry-run"], runtime);
    expect(code).toBe(0);
    expect(out.join("")).toContain("Moeicons config");
    expect(readdirSync(dir)).not.toContain("moeicons.config.jsonc");
  });

  it("unknown option returns a stable validation error", async () => {
    makeReactProject();
    const { runtime, err } = makeRuntime();
    const code = await main(["doctor", "--nope"], runtime);
    expect(code).toBe(1);
    expect(err.join("")).toContain("unknown option: --nope");
  });

  it("doctor --check returns 1 when a required anchor is missing", async () => {
    makeReactProject();
    const { runtime } = makeRuntime();
    const code = await main(["doctor", "--check"], runtime);
    expect(code).toBe(1);
  });

  it("doctor --check returns 0 when the project is fully integrated", async () => {
    makeReactProject();
    writeFileSync(
      join(dir, "moeicons.config.jsonc"),
      JSON.stringify({
        schemaVersion: 3,
        tier: "free",
        target: "react",
        outputDir: "src/moeicons",
        defaultTheme: "outline",
        themes: { outline: { styleGroup: "moe-outline" } },
        icons: ["ui-search"],
        integration: { adapter: "vite-react", entry: "src/main.tsx", style: "src/index.css" },
      }),
    );
    writeFileSync(
      join(dir, "src", "main.tsx"),
      'import { MoeiconsProvider } from "./moeicons";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<MoeiconsProvider><App /></MoeiconsProvider>);\n',
    );
    writeFileSync(join(dir, "src", "index.css"), '@import "./moeicons/styles.css";\n');
    const { runtime } = makeRuntime();
    const code = await main(["doctor", "--check"], runtime);
    expect(code).toBe(0);
  });
});
