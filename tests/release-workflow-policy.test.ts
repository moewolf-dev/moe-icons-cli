import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * FIX-26-D: the CLI publish workflow must scan the actual packed bytes for Pro
 * leakage before npm publish.
 */
describe("CLI publish leak gate", () => {
  const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "publish.yml"), "utf8");

  it("runs scan-bundle on the candidate before upload and before npm publish", () => {
    expect(existsSync(join(process.cwd(), "scripts", "scan-bundle.mjs"))).toBe(true);
    const scanIndex = workflow.indexOf("scan-bundle.mjs");
    const publishIndex = workflow.indexOf("name: Publish to npm");
    expect(scanIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(scanIndex).toBeLessThan(publishIndex);
    expect(workflow).toMatch(/--forbid-prefix\s+"?moe-3d-metal/);
  });

  it("scans the immutable candidate produced by npm pack, not a synthetic file", () => {
    expect(workflow).toMatch(/npm pack/);
    expect(workflow).toMatch(/scan-bundle\.mjs/);
    expect(workflow.match(/scan-bundle\.mjs/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("checks out the candidate commit before the publish-job scan (FIX-29-B)", () => {
    const checkoutIndex = workflow.indexOf("actions/checkout@");
    const secondScan = workflow.lastIndexOf("scan-bundle.mjs");
    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(secondScan).toBeGreaterThan(-1);
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*needs\.pack\.outputs\.cli_commit\s*\}\}/);
    expect(checkoutIndex).toBeLessThan(secondScan);
  });

  it("scans with derived evidence and fails closed on a real publish without tokens (AUD-BLOCK-46/48)", () => {
    expect(existsSync(join(process.cwd(), "scripts", "derive-forbid-evidence.mjs"))).toBe(true);
    expect(workflow).toMatch(/derive-forbid-evidence\.mjs/);
    expect(workflow).toMatch(/--forbid-file/);
    expect(workflow).toMatch(/refusing to publish/);
    // the same evidence bytes are verified by SHA before scanning
    expect(workflow).toMatch(/shasum -a 256 -c forbid-evidence\.json\.sha256/);
    expect(workflow).toMatch(/forbid-evidence\.json\.sha256/);
    // AUD-OBS-03: the candidate artifact uploads a single flat staging dir
    expect(workflow).toMatch(/path:\s*\$\{\{\s*runner\.temp\s*\}\}\/candidate/);
    expect(workflow).not.toMatch(/path:\s*\|\s*\n\s*\$\{\{\s*steps\.pack\.outputs\.tgz\s*\}/);
  });

  it("reads the forbid evidence from same candidate/ path it wrote (P1 path mismatch)", () => {
    // derive writes to $RUNNER_TEMP/candidate/... so the scan must read there too.
    expect(workflow).toMatch(/--out "\$RUNNER_TEMP\/candidate\/forbid-evidence\.json"/);
    expect(workflow).toMatch(/--forbid-file "\$RUNNER_TEMP\/candidate\/forbid-evidence\.json"/);
    expect(workflow).not.toMatch(/--forbid-file "\$RUNNER_TEMP\/forbid-evidence\.json"/);
  });

  it("records payloadHash in the frozen release commit so a rerun can recover it (P1)", () => {
    expect(workflow).toMatch(/p\.payloadHash=process\.argv\[2\]/);
    expect(workflow).toMatch(/"\$NEXT_VERSION" "\$PAYLOAD_HASH"/);
  });

  it("emits a canonical publish receipt after npm publish/finalize (P1-1)", () => {
    expect(workflow).toMatch(/cli-publish-receipt\.json/);
    expect(workflow).toMatch(/name:\s*cli-publish-receipt-\$\{\{\s*needs\.pack\.outputs\.release_tag\s*\}\}/);
    expect(workflow).toMatch(/npmIntegrity/);
    expect(workflow).toMatch(/attestations/);
    // The receipt is written after the Release is finalized and npm is published.
    const finalizeAt = workflow.indexOf("gh release edit \"\$TAG\" --draft=false");
    const receiptAt = workflow.indexOf("cli-publish-receipt.json");
    expect(finalizeAt).toBeGreaterThanOrEqual(0);
    expect(receiptAt).toBeGreaterThan(finalizeAt);
  });
});

describe("CLI single version owner", () => {
  const pinWorkflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "resource-pin.yml"),
    "utf8",
  );

  it("resource-pin updates only resource files and never bumps the CLI version", () => {
    expect(pinWorkflow).not.toMatch(/--apply-version/);
    expect(pinWorkflow).not.toMatch(/git add[^\n]*package\.json/);
    expect(pinWorkflow).toMatch(/git add src\/catalog\/catalog\.json src\/catalog\/resource-release\.json/);
    // the pin commit message must not claim a CLI version bump
    expect(pinWorkflow).not.toMatch(/for resources/);
  });

  it("resource-pin uploads a receipt with the exact pushed commit (P1)", () => {
    expect(pinWorkflow).toMatch(/cli-pin-receipt\.json/);
    expect(pinWorkflow).toMatch(/name:\s*cli-resource-pin-receipt-/);
    expect(pinWorkflow).toMatch(/git rev-parse HEAD/);
  });
});
