import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

describe("wizard bootstrap placement", () => {
  it("does not bootstrap in main() before dispatch, and bootstraps after the banner in runWizard", () => {
    const source = readFileSync(CLI, "utf8");
    const main = source.slice(source.indexOf("export async function main"), source.indexOf("async function runBootstrap"));
    expect(main).not.toContain("runBootstrap(");
    const wizard = source.slice(source.indexOf("async function runWizard"));
    const bannerAt = wizard.indexOf("renderBanner(");
    const bootstrapAt = wizard.indexOf("runBootstrap(");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(bannerAt);
    expect(wizard).toContain("runtime.readLine === undefined");
  });
});
