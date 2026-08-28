import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  generateLogoAscii,
  mapPixel,
  parseArgv,
  LogoGenerateError,
  MAX_COLS,
  MAX_ROWS,
} from "../../scripts/generate-logo-ascii.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "tests/fixtures/logo");
const SCRIPT = join(ROOT, "scripts/generate-logo-ascii.mjs");
const BANNER_SCRIPT = join(ROOT, "scripts/generate-banner.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "logo-ascii-"));
  dirs.push(dir);
  return dir;
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

describe("generate-logo-ascii", () => {
  it("maps luma from light to dark as . : * # and treats transparent or white as space", () => {
    expect(mapPixel(255, 0)).toBe(" ");
    expect(mapPixel(250, 255)).toBe(" ");
    expect(mapPixel(200, 255)).toBe(".");
    expect(mapPixel(150, 255)).toBe(":");
    expect(mapPixel(90, 255)).toBe("*");
    expect(mapPixel(10, 255)).toBe("#");
  });

  it("requires --input", () => {
    expect(() => parseArgv([])).toThrow(LogoGenerateError);
    expect(() => parseArgv(["--input"])).toThrow(/--input is required/);
    const result = runScript([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("error: --input is required");
  });

  it("fails when the SVG does not exist", () => {
    const result = runScript(["--input", join(FIXTURES, "missing.svg")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/error: SVG not found/);
  });

  it("fails when Sharp cannot decode the input", () => {
    const dir = tempDir();
    const bogus = join(dir, "not.svg");
    writeFileSync(bogus, "not an image");
    const result = runScript(["--input", bogus]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/error: failed to decode SVG/);
  });

  it("treats a transparent canvas as spaces and trims to the ink", async () => {
    const dir = tempDir();
    const output = join(dir, "logo.ts");
    const { lines } = await generateLogoAscii({
      input: join(FIXTURES, "transparent.svg"),
      output,
    });
    expect(lines.join("\n")).toMatch(/[#*:.]/);
    expect(lines.every((line) => line.length <= MAX_COLS)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(MAX_ROWS);
  });

  it("maps a gray ramp from dark # through * : to light .", async () => {
    const dir = tempDir();
    const { lines } = await generateLogoAscii({
      input: join(FIXTURES, "gray-ramp.svg"),
      output: join(dir, "logo.ts"),
    });
    const joined = lines.join("");
    expect(joined).toContain("#");
    expect(joined).toContain("*");
    expect(joined).toContain(":");
    expect(joined).toContain(".");
    const firstInk = joined.search(/[#*:.]/);
    const lastHash = joined.lastIndexOf("#");
    const lastDot = joined.lastIndexOf(".");
    expect(lastHash).toBeGreaterThanOrEqual(0);
    expect(lastDot).toBeGreaterThan(lastHash);
    expect(firstInk).toBeGreaterThanOrEqual(0);
  });

  it("uses a 1:2 terminal aspect so a tall source is taller than a wide source", async () => {
    const dir = tempDir();
    const tall = await generateLogoAscii({
      input: join(FIXTURES, "tall.svg"),
      output: join(dir, "tall.ts"),
    }).catch((error: unknown) => error);
    const wide = await generateLogoAscii({
      input: join(FIXTURES, "wide.svg"),
      output: join(dir, "wide.ts"),
    });
    expect(tall).toBeInstanceOf(LogoGenerateError);
    expect(String(tall)).toMatch(/exceeds 36x18/);
    expect(wide.lines.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(Math.max(...wide.lines.map((line) => line.length))).toBeLessThanOrEqual(MAX_COLS);
  });

  it("is idempotent for the same input and writes no absolute paths", async () => {
    const dir = tempDir();
    const output = join(dir, "logo.ts");
    const first = await generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output });
    const second = await generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output });
    expect(second.source).toBe(first.source);
    expect(readFileSync(output, "utf8")).toBe(first.source);
    expect(first.source).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
    expect(first.source).toContain("source: dot.svg");
    expect(first.source).toContain("vscale: 0.5");
    expect(first.source).toContain('gradient: " .:*#"');
  });

  it("uses unique temp files and leaves no leftover tmp after concurrent writes", async () => {
    const dir = tempDir();
    const output = join(dir, "logo.ts");
    await Promise.all([
      generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output: join(dir, "a.ts") }),
      generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output: join(dir, "b.ts") }),
      generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output }),
    ]);
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(readFileSync(output, "utf8")).toContain("MOEICONS_LOGO_ASCII");
  });
});

describe("banner and logo generators", () => {
  it("writes stable SHA-256 output twice from in-repo fixtures and does not rewrite banner.ts", async () => {
    const bannerPath = join(ROOT, "src/ui/banner.ts");
    const wordmarkPath = join(ROOT, "src/ui/generated/wordmark.ts");
    const committedLogo = join(ROOT, "src/ui/generated/logo-ascii.ts");
    const hashOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const beforeBanner = hashOf(bannerPath);
    const beforeWordmark = hashOf(wordmarkPath);
    const beforeLogo = hashOf(committedLogo);
    const firstBanner = spawnSync(process.execPath, [BANNER_SCRIPT], { encoding: "utf8", cwd: ROOT });
    expect(firstBanner.status, firstBanner.stderr).toBe(0);
    const secondBanner = spawnSync(process.execPath, [BANNER_SCRIPT], { encoding: "utf8", cwd: ROOT });
    expect(secondBanner.status, secondBanner.stderr).toBe(0);
    expect(hashOf(wordmarkPath)).toBe(beforeWordmark);
    const dir = tempDir();
    const output = join(dir, "logo.ts");
    const first = await generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output });
    const second = await generateLogoAscii({ input: join(FIXTURES, "dot.svg"), output });
    expect(second.source).toBe(first.source);
    expect(hashOf(bannerPath)).toBe(beforeBanner);
    expect(hashOf(committedLogo)).toBe(beforeLogo);
  });

  it("does not mention a sibling logo directory in default tests or npm test", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const sibling = ["moe-icons", "logo"].join("-");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.test).not.toContain("verify:brand-source");
    expect(pkg.scripts.test).not.toContain(sibling);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (readFileSync(path, "utf8").includes(sibling)) hits.push(path);
      }
    };
    walk(join(ROOT, "tests"));
    expect(hits).toEqual([]);
  });
});
