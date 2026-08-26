import { describe, expect, it } from "vitest";
import { createTarGz } from "../src/project/tar-gz.js";
import { computeSubtreeHash, selectTargetSubtree } from "../src/core/target-subtree.js";

describe("selectTargetSubtree validation", () => {
  it("rejects an empty/missing target subtree even for legacy descriptors", () => {
    const archive = createTarGz({
      "catalog.json": "{}\n",
      "react/index.js": "export {};\n",
    });
    const result = selectTargetSubtree(archive, {}, "assets");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation");
      expect(result.message).toMatch(/empty or missing/);
    }
  });

  it("rejects modern descriptors that omit the selected target", () => {
    const files = { "index.js": "export {};\n" };
    const hash = computeSubtreeHash({
      "index.js": new TextEncoder().encode(files["index.js"]),
    });
    const archive = createTarGz({
      "catalog.json": "{}\n",
      "react/index.js": files["index.js"],
    });
    const result = selectTargetSubtree(
      archive,
      {
        targets: ["react", "vue"],
        targetMetadata: {
          react: { path: "react", sha256: hash.sha256, fileCount: hash.fileCount, byteCount: hash.byteCount },
        },
      },
      "vanilla",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/does not declare target "vanilla"/);
    }
  });

  it("rejects modern descriptors missing targetMetadata for the selected target", () => {
    const archive = createTarGz({
      "catalog.json": "{}\n",
      "vanilla/index.js": "export {};\n",
    });
    const result = selectTargetSubtree(
      archive,
      { targets: ["vanilla", "assets"], targetMetadata: {} },
      "vanilla",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/missing targetMetadata for "vanilla"/);
    }
  });

  it("rejects targetMetadata.path that does not match the target id", () => {
    const bytes = new TextEncoder().encode("export {};\n");
    const hash = computeSubtreeHash({ "index.js": bytes });
    const archive = createTarGz({
      "catalog.json": "{}\n",
      "assets/index.js": "export {};\n",
    });
    const result = selectTargetSubtree(
      archive,
      {
        targets: ["assets"],
        targetMetadata: {
          assets: { path: "static", sha256: hash.sha256, fileCount: hash.fileCount, byteCount: hash.byteCount },
        },
      },
      "assets",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/path must be "assets"/);
    }
  });

  it("accepts a modern descriptor with matching non-empty subtree metadata", () => {
    const content = "export const ok = true;\n";
    const bytes = new TextEncoder().encode(content);
    const hash = computeSubtreeHash({ "index.js": bytes });
    const archive = createTarGz({
      "catalog.json": "{}\n",
      "vanilla/index.js": content,
    });
    const result = selectTargetSubtree(
      archive,
      {
        targets: ["vanilla"],
        targetMetadata: {
          vanilla: { path: "vanilla", sha256: hash.sha256, fileCount: hash.fileCount, byteCount: hash.byteCount },
        },
      },
      "vanilla",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileCount).toBe(1);
      expect(result.sha256).toBe(hash.sha256);
    }
  });
});
