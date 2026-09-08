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

describe("R-P0-3/R-P0-4 recoverable release commit and identity", () => {
  it("validates the candidate before pushing the frozen commit", () => {
    const packAt = workflow.indexOf("npm pack --pack-destination");
    const pushAt = workflow.indexOf("git push origin HEAD:main");
    expect(packAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeGreaterThan(packAt);
    expect(workflow).toMatch(/release-commit\.mjs find/);
    expect(workflow).toMatch(/release-commit\.mjs guard/);
  });

  it("binds the tag target and compares registry content", () => {
    expect(workflow).toMatch(/gh release create "\$TAG" --draft --target/);
    expect(workflow).toMatch(/registry content differs from candidate/);
    expect(workflow).toMatch(/candidate-manifest\.json/);
    expect(workflow).toMatch(/npm sbom/);
  });
});

describe("R-P0-2 kill switch cannot be bypassed manually", () => {
  it("manual dispatch requires the switch and an explicit break-glass", () => {
    expect(workflow).toMatch(/dry_run:/);
    expect(workflow).toMatch(/break_glass:/);
    expect(workflow).toMatch(/MOEICONS_AUTO_RELEASE_ENABLED/);
    expect(workflow).toMatch(/BREAK_GLASS.*PUBLISH|break_glass/);
    // workflow_dispatch must not be treated as unconditionally open.
    expect(workflow).not.toMatch(/github\.event_name.*!=.*workflow_dispatch/);
  });

  it("manual dry-run runs a zero-write validation job", () => {
    expect(workflow).toMatch(/validate:/);
    expect(workflow).toMatch(/npm pack --dry-run/);
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
    expect(workflow).toMatch(/registry content differs from candidate|candidate-digests/);
  });
});
