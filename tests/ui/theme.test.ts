import { describe, expect, it } from "vitest";
import {
  ANSI_FG_RESET,
  BRAND_BLUE_RGB,
  BRAND_RED_RGB,
  createTheme,
  isThemeEnabled,
} from "../../src/ui/theme.js";

const BLUE = `\x1b[38;2;${BRAND_BLUE_RGB.r};${BRAND_BLUE_RGB.g};${BRAND_BLUE_RGB.b}m`;
const RED = `\x1b[38;2;${BRAND_RED_RGB.r};${BRAND_RED_RGB.g};${BRAND_RED_RGB.b}m`;

describe("theme", () => {
  it("enables color on a TTY without NO_COLOR or a dumb TERM", () => {
    expect(isThemeEnabled({}, true)).toBe(true);
    expect(createTheme(true).enabled).toBe(true);
  });

  it("disables color when NO_COLOR is present, even as an empty string", () => {
    expect(isThemeEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(isThemeEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("disables color when TERM is dumb or the output is not a TTY", () => {
    expect(isThemeEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(isThemeEnabled({}, false)).toBe(false);
  });

  it("paints exact 24-bit blue and red bytes and resets with ESC[39m", () => {
    const theme = createTheme(true);
    expect(theme.blue("Yes")).toBe(`${BLUE}Yes${ANSI_FG_RESET}`);
    expect(theme.red("No")).toBe(`${RED}No${ANSI_FG_RESET}`);
    expect(theme.blue("")).toBe(`${BLUE}${ANSI_FG_RESET}`);
  });

  it("leaves characters unchanged when color is disabled", () => {
    const theme = createTheme(false);
    expect(theme.blue("Yes")).toBe("Yes");
    expect(theme.red("No")).toBe("No");
    expect(theme.blue("")).toBe("");
  });
});
