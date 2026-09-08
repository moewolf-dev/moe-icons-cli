import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * E2E-G2/P0-5/P0-6: the publish workflow must pack exactly once on the frozen
 * release commit, share that artifact with acceptance/npm/GitHub, and recover
 * in the order draft -> upload+readback -> npm -> finalize.
 */

const workflow = readFileSync(
  join(__dirname, "..", ".github", "workflows", "publish.yml"),
  "utf8",
);

describe("P0-5 single immutable CLI candidate", () => {
  it("packs once in the pack job and uploads the artifact", () => {
    expect(workflow).toMatch(/npm pack --pack-destination/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toMatch(/name: cli-candidate-\$\{\{ needs\.decide\.outputs\.next_version \}\}/);
    // The release commit is frozen before packing.
    const bumpAt = workflow.indexOf("chore(release): cli v$NEXT_VERSION");
    const packAt = workflow.indexOf("npm pack --pack-destination");
    expect(bumpAt).toBeGreaterThanOrEqual(0);
    expect(packAt).toBeGreaterThan(bumpAt);
  });

  it("acceptance and publish consume the artifact instead of re-packing", () => {
    const acceptance = workflow.slice(workflow.indexOf("\n  acceptance:"), workflow.indexOf("\n  publish:"));
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    expect(acceptance).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
    expect(acceptance).not.toMatch(/pack:cli|npm pack --pack-destination/);
    expect(publish).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
    expect(publish).not.toMatch(/npm run build|npm pack --pack-destination/);
  });
});

describe("P0-6 draft-first CLI release recovery", () => {
  it("creates a draft, publishes npm, then finalizes", () => {
    const draftAt = workflow.indexOf("gh release create \"$TAG\" --draft");
    const npmAt = workflow.indexOf("npm publish \"$tgz\"");
    const finalizeAt = workflow.indexOf("gh release edit \"$TAG\" --draft=false");
    expect(draftAt).toBeGreaterThanOrEqual(0);
    expect(npmAt).toBeGreaterThan(draftAt);
    expect(finalizeAt).toBeGreaterThan(npmAt);
  });

  it("verifies an existing npm version and reuses a draft on rerun", () => {
    expect(workflow).toMatch(/npm view "@moewolf\/moe-icons-cli@\$\{version\}"/);
    expect(workflow).toMatch(/is_draft.*--jq \.isDraft|isDraft --jq \.isDraft/);
    expect(workflow).toMatch(/gh release upload "\$TAG"/);
    expect(workflow).toMatch(/registry file list differs|file list/);
  });
});
