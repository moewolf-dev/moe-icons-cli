import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadGeneratedConfigPackage } from "../src/config-package/generated-config.js";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = join(cliRoot, "src", "config-package", "generated");
const catalogPath = join(cliRoot, "src", "catalog", "catalog.json");

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("A2 config-package generated copy", () => {
  it("SOURCE.json digests match the committed generated files", () => {
    const source: {
      schemaVersion: number;
      sourceRepo: string;
      files: Record<string, { sha256: string }>;
    } = JSON.parse(readFileSync(join(generatedDir, "SOURCE.json"), "utf8"));
    expect(source.schemaVersion).toBe(1);
    expect(source.sourceRepo).toBe("moewolf-dev/moe-icons-code-library");
    for (const [name, entry] of Object.entries(source.files)) {
      expect(sha256Of(join(generatedDir, name))).toBe(entry.sha256);
    }
  });

  it("renders a stable schema v3 skeleton offline through the bundled copy", () => {
    const generated = loadGeneratedConfigPackage();
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const free = generated.renderMoeiconsConfigJsonc({ target: "react", tier: "free", catalog });
    expect(free).toContain('"schemaVersion": 3,');
    expect(free).toContain('"target": "react"');
    const pro = generated.renderMoeiconsConfigJsonc({ target: "vue", tier: "pro", catalog });
    expect(pro).toContain('"tier": "pro"');
    // Deterministic.
    expect(
      generated.renderMoeiconsConfigJsonc({ target: "react", tier: "free", catalog }),
    ).toBe(free);
  });
});

// Drift gate: when a live moe-icons-code-library checkout is available
// (MOEICONS_CODE_LIBRARY_REPO or sibling), the bundled copy must be byte-identical
// to the canonical renderer for a fixed catalog, and file digests must match the
// code-library generated manifest. Skipped in CI without a code-library checkout.
describe("A2 config-package drift gate", () => {
  const repo =
    process.env.MOEICONS_CODE_LIBRARY_REPO ??
    (() => {
      const sibling = join(cliRoot, "..", "moe-icons-code-library");
      return existsSync(join(sibling, "package.json")) ? sibling : undefined;
    })();

  const run = repo && existsSync(join(repo, "config-package", "src", "render-config.cjs"));

  it.skipIf(!run)("generated copy digests match the code-library generated manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(repo!, "config-package", "generated", "manifest.json"), "utf8"),
    );
    const source = JSON.parse(readFileSync(join(generatedDir, "SOURCE.json"), "utf8"));
    for (const name of Object.keys(source.files)) {
      const canonicalRel = Object.keys(manifest.files).find((rel) => rel.endsWith(name));
      expect(canonicalRel).toBeTruthy();
      const bundled = source.files[name] as { sha256: string };
      expect(bundled.sha256).toBe(manifest.files[canonicalRel!].sha256);
    }
  });

  it.skipIf(!run)("SOURCE.json distinguishes exact commit bytes from a dirty checkout", () => {
    const source = JSON.parse(readFileSync(join(generatedDir, "SOURCE.json"), "utf8")) as {
      sourceCommit: string; sourceCommitExact: boolean; files: Record<string, { sha256: string }>;
    };
    const canonical: Record<string, string> = {
      "render-config.cjs": "src/render-config.cjs",
      "validate-config.cjs": "src/validate-config.cjs",
      "moeicons-config.schema.json": "schema/moeicons-config.schema.json",
      "moeicons.config.jsonc": "templates/moeicons.config.jsonc",
    };
    const exact = Object.entries(canonical).every(([name, rel]) => {
      const blob = execFileSync("git", ["-C", repo!, "show", `${source.sourceCommit}:config-package/${rel}`]);
      return createHash("sha256").update(blob).digest("hex") === source.files[name]?.sha256;
    });
    expect(source.sourceCommitExact).toBe(exact);
  });

  it.skipIf(!run)("bundled renderer byte-matches the canonical code-library renderer", () => {
    const canonicalPath = join(repo!, "config-package", "src", "render-config.cjs");
    const req = createRequire(import.meta.url);
    const canonical = req(canonicalPath) as {
      renderMoeiconsConfigJsonc: (o: { target: string; tier: string; catalog: unknown }) => string;
    };
    const bundled = loadGeneratedConfigPackage();
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const cases: Array<{ target: "react" | "vue"; tier: "free" | "pro" }> = [
      { target: "react", tier: "free" },
      { target: "vue", tier: "free" },
      { target: "react", tier: "pro" },
      { target: "vue", tier: "pro" },
    ];
    for (const { target, tier } of cases) {
      const canonicalOut = canonical.renderMoeiconsConfigJsonc({ target, tier, catalog });
      const bundledOut = bundled.renderMoeiconsConfigJsonc({ target, tier, catalog });
      expect(bundledOut).toBe(canonicalOut);
    }
  });
});
