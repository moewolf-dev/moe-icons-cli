import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSvg, rootPaintAttributes } from "../src/generator/svg-model.js";

describe("canonical SVG model", () => {
  it("decodes entities once, preserves quoted delimiters, roots and fixed child widths", () => {
    const model = prepareSvg('<svg stroke-width="5" preserveAspectRatio="none"><text>A &amp; B &#x4e2d;</text><path id="a&amp;b" data-note="1 > 0" stroke-width="2" /></svg>', "outline");
    expect(model.children[0]).toMatchObject({ children: [{ text: "A & B 中" }] });
    expect(model.children[1]).toMatchObject({ attrs: [["id", "a&b"], ["data-note", "1 > 0"], ["stroke-width", "2"]] });
    expect(rootPaintAttributes(model.rootAttrs, "outline").get("stroke-width")).toBe("5");
    expect(rootPaintAttributes(model.rootAttrs, "outline").get("preserveAspectRatio")).toBe("none");
  });

  it("rejects malformed XML and unexpanded entities before emission", () => {
    for (const source of ['<svg><g></svg>', '<svg><path d=x /></svg>', '<svg><text>&missing;</text></svg>', '<svg><text>&#0;</text></svg>', '<!DOCTYPE svg [<!ENTITY x "bad">]><svg/>']) expect(() => prepareSvg(source, "mixed")).toThrow();
  });

  it("bundled parser digest is recorded and matches the canonical source when present", () => {
    const copied = readFileSync(resolve("src/generator/shared/svg-model.cjs"));
    const source = JSON.parse(readFileSync(resolve("src/generator/shared/SOURCE.json"), "utf8")) as { sha256: string };
    expect(createHash("sha256").update(copied).digest("hex")).toBe(source.sha256);
    const canonical = resolve("../moe-icons-code-library/scripts/svg-model.cjs");
    if (existsSync(canonical)) expect(copied.equals(readFileSync(canonical))).toBe(true);
  });

  it("packaging rejects a tampered parser and an uncommitted candidate source", async () => {
    const verifierPath = new URL("../scripts/verify-svg-model.mjs", import.meta.url).href;
    const { verifySvgModel } = await import(verifierPath) as { verifySvgModel: (options: { root: string; requireExact?: boolean }) => unknown };
    const directory = mkdtempSync(join(tmpdir(), "svg-model-provenance-"));
    try {
      const target = join(directory, "src/generator/shared");
      mkdirSync(target, { recursive: true });
      const bytes = Buffer.from("module.exports = {};\n");
      writeFileSync(join(target, "svg-model.cjs"), bytes);
      writeFileSync(join(target, "SOURCE.json"), JSON.stringify({ sourceRepo: "moewolf-dev/moe-icons-code-library", sourcePath: "scripts/svg-model.cjs", sourceCommit: "a".repeat(40), sourceCommitExact: false, sha256: createHash("sha256").update(bytes).digest("hex") }));
      expect(() => verifySvgModel({ root: directory })).not.toThrow();
      expect(() => verifySvgModel({ root: directory, requireExact: true })).toThrow(/committed source/);
      writeFileSync(join(target, "svg-model.cjs"), "tampered");
      expect(() => verifySvgModel({ root: directory })).toThrow(/digest/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
