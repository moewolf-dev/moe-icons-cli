import { describe, expect, it } from "vitest";
import {
  reportLibraryExportNameCollisions,
  reportProxyNameCollisions,
  toLibraryExportName,
  toProxyName,
} from "../src/core/icon-names.js";

/**
 * Shared naming contract with moe-icons-code-library/scripts/generator-core.cjs.
 * Keep these expected pairs identical to tests/generator-core.test.cjs.
 */
const NAMING_CASES = [
  ["ui-search", "UiSearch", "uiSearch"],
  ["arrow-chevron-right", "ArrowChevronRight", "arrowChevronRight"],
  ["pay-cash-1", "PayCash1", "payCash1"],
  ["image-360", "Image360", "image360"],
  ["archive", "Archive", "archive"],
  ["class", "IconClass", "iconClass"],
  ["default", "IconDefault", "iconDefault"],
  ["12-clock", "Icon12Clock", "icon12Clock"],
] as const;

describe("icon naming contract", () => {
  it("maps iconId to PascalCase proxy and camelCase library export", () => {
    for (const [iconId, proxyName, exportName] of NAMING_CASES) {
      expect(toProxyName(iconId), iconId).toBe(proxyName);
      expect(toLibraryExportName(iconId), iconId).toBe(exportName);
    }
  });

  it("keeps proxy and library names distinct for a typical icon", () => {
    expect(toProxyName("ui-search")).toBe("UiSearch");
    expect(toLibraryExportName("ui-search")).toBe("uiSearch");
    expect(toProxyName("ui-search")).not.toBe(toLibraryExportName("ui-search"));
  });

  it("reports reserved-word and leading-digit collisions across ids", () => {
    expect(reportProxyNameCollisions(["class", "icon-class"])).toEqual([
      'duplicate PascalCase name "IconClass" from "class" and "icon-class"',
    ]);
    expect(reportLibraryExportNameCollisions(["class", "icon-class"])).toEqual([
      'duplicate library export name "iconClass" from "class" and "icon-class"',
    ]);
    expect(reportProxyNameCollisions(["12-clock", "icon-12-clock"])).toEqual([
      'duplicate PascalCase name "Icon12Clock" from "12-clock" and "icon-12-clock"',
    ]);
    expect(reportLibraryExportNameCollisions(["foo", "Foo"])).toEqual([
      'duplicate library export name "foo" from "foo" and "Foo"',
    ]);
  });

  it("reports no collisions for the representative catalog ids", () => {
    expect(reportProxyNameCollisions(NAMING_CASES.map(([id]) => id))).toEqual([]);
    expect(reportLibraryExportNameCollisions(NAMING_CASES.map(([id]) => id))).toEqual([]);
  });
});
