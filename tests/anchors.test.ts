import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectProjectManifest } from "../src/project/anchors/project-manifest.js";
import { inspectMoeiconsConfig } from "../src/project/anchors/moeicons-config.js";
import { inspectApplicationAnchor } from "../src/project/anchors/application.js";
import { inspectStyleAnchor } from "../src/project/anchors/style.js";
import { diagnoseProject } from "../src/project/anchors/diagnose.js";
import { realDetectorIo } from "../src/project/anchors/helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-anchors-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", ...extra }));
}

describe("manifest anchor", () => {
  it("returns missing outside a project", () => {
    const result = inspectProjectManifest({ cwd: "/Volumes", io: realDetectorIo });
    expect(result.kind).toBe("manifest");
    expect(result.status).toBe("missing");
    expect(result.fixes).toEqual([]);
  });

  it("detects a react/vite single package", () => {
    writePkg({ dependencies: { react: "^18", "react-dom": "^18" }, devDependencies: { vite: "^6" } });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const result = inspectProjectManifest({ cwd: dir, io: realDetectorIo });
    expect(result.status).toBe("ok");
    expect(result.evidence.join("\n")).toContain("adapter: vite-react");
  });

  it("distinguishes a pnpm workspace root with vue member", () => {
    writePkg({ workspaces: ["apps/*"] });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify({ name: "web", dependencies: { vue: "^3.4", vite: "^6" } }),
    );
    const rootResult = inspectProjectManifest({ cwd: dir, io: realDetectorIo });
    expect(rootResult.status).toBe("ok");
    expect(rootResult.evidence.join("\n")).toContain("packageManager: pnpm");
    const member = inspectProjectManifest({
      cwd: join(dir, "apps", "web"),
      io: realDetectorIo,
    });
    expect(member.evidence.join("\n")).toContain("adapter: vite-vue");
  });
});

describe("config anchor", () => {
  it("missing config returns a create plan only when a project exists", () => {
    writePkg({ dependencies: { react: "^18" } });
    const result = inspectMoeiconsConfig({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("missing");
    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0]).toMatchObject({ kind: "create", path: "moeicons.config.jsonc" });
    expect(result.fixes[0]?.after).toContain('"schemaVersion": 2');
  });

  it("reports invalid without an overwrite plan", () => {
    writePkg();
    writeFileSync(join(dir, "moeicons.config.jsonc"), '{ "schemaVersion": 2, "target": "react",');
    const result = inspectMoeiconsConfig({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("invalid");
    expect(result.fixes).toEqual([]);
  });

  it("accepts an existing v2 config", () => {
    writePkg();
    writeFileSync(
      join(dir, "moeicons.config.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        tier: "free",
        target: "react",
        outputDir: "src/moeicons",
        defaultTheme: "outline",
        themes: { outline: { styleGroup: "moe-outline" } },
        icons: ["ui-search"],
      }),
    );
    const result = inspectMoeiconsConfig({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("ok");
    expect(result.fixes).toEqual([]);
  });

  it("reads a v3 config with integration as ok", () => {
    writePkg();
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
        integration: { adapter: "vite-react", entry: "src/main.tsx" },
      }),
    );
    const result = inspectMoeiconsConfig({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("ok");
  });
});

describe("application anchor", () => {
  function writeReactEntry(source: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.tsx"), source);
  }

  it("plans a provider wrap for a unique vite react root", () => {
    writePkg({ dependencies: { react: "^18", "react-dom": "^18" }, devDependencies: { vite: "^6" } });
    writeReactEntry(`import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`);
    const result = inspectApplicationAnchor({ root: dir, adapter: "vite-react", io: realDetectorIo });
    expect(result.status).toBe("missing");
    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0]?.after).toContain("<MoeiconsProvider>");
    expect(result.fixes[0]?.after).toContain('from "./moeicons"');
  });

  it("is ok when the provider is already imported", () => {
    writePkg({ dependencies: { react: "^18" } });
    writeReactEntry(`import { MoeiconsProvider } from "./moeicons";
import { createRoot } from "react-dom/client";
import App from "./App";
createRoot(document.getElementById("root")!).render(<MoeiconsProvider><App /></MoeiconsProvider>);
`);
    const result = inspectApplicationAnchor({ root: dir, adapter: "vite-react", io: realDetectorIo });
    expect(result.status).toBe("ok");
    expect(result.fixes).toEqual([]);
  });

  it("returns ambiguous on multiple createRoot calls", () => {
    writePkg({ dependencies: { react: "^18" } });
    writeReactEntry(`import { createRoot } from "react-dom/client";
createRoot(document.getElementById("a")!).render(<A />);
createRoot(document.getElementById("b")!).render(<B />);
`);
    const result = inspectApplicationAnchor({ root: dir, adapter: "vite-react", io: realDetectorIo });
    expect(result.status).toBe("ambiguous");
    expect(result.fixes).toEqual([]);
  });

  it("reports invalid on a syntax error (no regex guessing)", () => {
    writePkg({ dependencies: { react: "^18" } });
    writeReactEntry(`import { createRoot } from "react-dom/client";
createRoot( <App
`);
    const result = inspectApplicationAnchor({ root: dir, adapter: "vite-react", io: realDetectorIo });
    expect(result.status).toBe("invalid");
  });

  it("unsupported for next-app (detect-only, no fixes)", () => {
    writePkg({ dependencies: { next: "^14", react: "^18" } });
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "layout.tsx"), "export default function Layout(){return null;}\n");
    const result = inspectApplicationAnchor({ root: dir, adapter: "next-app", io: realDetectorIo });
    expect(result.status).toBe("unsupported");
    expect(result.fixes).toEqual([]);
  });

  it("not-required for assets-only", () => {
    writePkg();
    const result = inspectApplicationAnchor({
      root: dir,
      adapter: "assets-only",
      assetsOnly: true,
      io: realDetectorIo,
    });
    expect(result.status).toBe("not-required");
  });
});

describe("style anchor", () => {
  it("finds a css entry and reports ok when moeicons is imported", () => {
    writePkg();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.css"), '@import "./moeicons/styles.css";\n');
    const result = inspectStyleAnchor({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("ok");
  });

  it("reports missing css (warning, not failure) and offers a safe import fix", () => {
    writePkg();
    const result = inspectStyleAnchor({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("missing");
    expect(result.fixes.length).toBe(0); // no css file to append to
  });

  it("reports ambiguous with multiple css candidates", () => {
    writePkg();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.css"), "");
    writeFileSync(join(dir, "src", "style.css"), "");
    const result = inspectStyleAnchor({ root: dir, io: realDetectorIo });
    expect(result.status).toBe("ambiguous");
  });
});

describe("diagnoseProject orchestrator", () => {
  it("returns stable report and fixes when config is missing in a react project", () => {
    writePkg({ dependencies: { react: "^18", "react-dom": "^18" }, devDependencies: { vite: "^6" } });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.css"), "");
    writeFileSync(
      join(dir, "src", "main.tsx"),
      'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
    );
    const { ok, report, fixes } = diagnoseProject({ cwd: dir });
    expect(ok).toBe(false);
    expect(report.anchors.map((a) => a.kind)).toEqual([
      "manifest",
      "config",
      "application",
      "style",
    ]);
    expect(report.anchors[0]?.status).toBe("ok");
    expect(report.anchors[1]?.status).toBe("missing");
    expect(fixes.some((f) => f.path === "moeicons.config.jsonc")).toBe(true);
  });

  it("does not evaluate downstream anchors without a manifest", () => {
    const { ok, report, fixes } = diagnoseProject({ cwd: "/Volumes" });
    expect(ok).toBe(false); // cannot write without a project manifest
    expect(report.anchors[0]?.status).toBe("missing");
    expect(report.anchors.slice(1).every((a) => a.status === "not-required")).toBe(true);
    expect(fixes).toEqual([]);
  });
});
