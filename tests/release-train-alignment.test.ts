import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
  version: string;
  packages: Record<string, { version?: string }>;
};
const resource = JSON.parse(
  readFileSync(resolve(root, "src/catalog/resource-release.json"), "utf8"),
) as {
  resourceVersion: string;
  packageSets?: { resourceVersion?: string };
};

function compare(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

describe("release train alignment", () => {
  it("never pre-bumps the CLI above the pinned resource version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resource.resourceVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The publish workflow allocates the version from the resource train. A
    // manual `npm version`/CHANGELOG bump above the pin makes
    // RESOURCE_VERSION <= CURRENT_VERSION, so CI silently emits
    // should_release=0 and no release is produced.
    expect(
      compare(pkg.version, resource.resourceVersion),
      `CLI ${pkg.version} is above resource ${resource.resourceVersion}; restore the baseline and let the publish workflow allocate the next version`,
    ).toBeLessThanOrEqual(0);
  });

  it("keeps package-lock and resource package sets coherent", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
    if (resource.packageSets?.resourceVersion) {
      expect(resource.packageSets.resourceVersion).toBe(resource.resourceVersion);
    }
  });
});
