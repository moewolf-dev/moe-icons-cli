import { describe, expect, it } from "vitest";
import {
  MOEICONS_BANNER,
  MOEICONS_WORDMARK_LARGE,
  WORDMARK_LARGE_GLYPHS,
  WORDMARK_LARGE_WIDTH,
  centerLines,
  paintWordmarkLarge,
  renderBannerText,
  renderNoticeBox,
  renderProjectNotice,
  renderWordmarkText,
  selectWordmarkTier,
  visibleWidth,
} from "../../src/ui/banner.js";
import { createTheme } from "../../src/ui/theme.js";
import { main } from "../../src/cli.js";

function makeRuntime(
  options: {
    isTTY?: boolean;
    columns?: number;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => "/non-existent-project",
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: options.env ?? {},
      isTTY: () => options.isTTY ?? false,
      columns: () => options.columns,
      readLine: async () => "",
      readKey: async () => "",
      fetchVersions: async () => [],
    },
    out,
    err,
  };
}

describe("MOEICONS banner", () => {
  it("keeps the committed figlet constant stable", () => {
    expect(MOEICONS_BANNER).toMatchInlineSnapshot(`
      "
        __  __  ___  _____ ___ ____ ___  _   _ ____
       |  \\/  |/ _ \\| ____|_ _/ ___/ _ \\| \\ | / ___|
       | |\\/| | | | |  _|  | | |  | | | |  \\| \\___ \\
       | |  | | |_| | |___ | | |__| |_| | |\\  |___) |
       |_|  |_|\\___/|_____|___\\____\\___/|_| \\_|____/
      "
    `);
  });

  it("freezes the large wordmark structure and glyph regions", () => {
    expect(MOEICONS_WORDMARK_LARGE).toHaveLength(8);
    expect(WORDMARK_LARGE_GLYPHS.map((g) => g.letter).join("")).toBe("MOEICONS");
    expect(WORDMARK_LARGE_GLYPHS.at(-1)?.end).toBe(WORDMARK_LARGE_WIDTH);
    for (const line of MOEICONS_WORDMARK_LARGE) {
      expect(line).toMatch(/^[\s█░]+$/u);
      expect(line.endsWith(" ")).toBe(false);
      expect(visibleWidth(line)).toBeLessThanOrEqual(WORDMARK_LARGE_WIDTH);
    }
    expect(Math.max(...MOEICONS_WORDMARK_LARGE.map((line) => visibleWidth(line)))).toBe(
      WORDMARK_LARGE_WIDTH,
    );
  });

  it("selects large / figlet / single tiers by column thresholds", () => {
    expect(selectWordmarkTier(40)).toBe("single");
    expect(selectWordmarkTier(51)).toBe("single");
    expect(selectWordmarkTier(52)).toBe("figlet");
    expect(selectWordmarkTier(80)).toBe("figlet");
    expect(selectWordmarkTier(100)).toBe("figlet");
    expect(selectWordmarkTier(101)).toBe("large");
    expect(selectWordmarkTier(120)).toBe("large");
    expect(selectWordmarkTier(0)).toBe("figlet");
    expect(selectWordmarkTier(-3)).toBe("figlet");
    expect(selectWordmarkTier(Number.NaN)).toBe("figlet");
  });

  it("centers on a 47-column canvas without trailing padding", () => {
    const [line] = centerLines(["abc"]);
    expect(line).toBe(`${" ".repeat(22)}abc`);
    expect(line?.endsWith("abc")).toBe(true);
    expect(visibleWidth(line ?? "")).toBe(25);
  });

  it("renders figlet at mid widths and large wordmark at 101+", () => {
    for (const columns of [52, 80, 100]) {
      const text = renderWordmarkText({ columns, color: false });
      expect(text).toContain(MOEICONS_BANNER.trim());
      expect(text).not.toContain("░░░░░");
    }
    for (const columns of [101, 120]) {
      const text = renderWordmarkText({ columns, color: false });
      expect(text).toContain(MOEICONS_WORDMARK_LARGE[0]);
      expect(text.split("\n")).toHaveLength(8);
      for (const line of text.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(WORDMARK_LARGE_WIDTH);
        expect(line.endsWith(" ")).toBe(false);
      }
    }
  });

  it("falls back to a single-line title below 52 columns", () => {
    for (const columns of [51, 40, 32, 20, 1]) {
      expect(renderWordmarkText({ columns, color: false })).toBe("MOEICONS");
    }
  });

  it("colors only shade characters by glyph and resets between regions", () => {
    const colored = paintWordmarkLarge([...MOEICONS_WORDMARK_LARGE], createTheme(true)).join("\n");
    expect(colored).toContain("\x1b[38;2;59;130;246m");
    expect(colored).toContain("\x1b[38;2;239;68;68m");
    expect(colored).toContain("\x1b[39m");
    const plain = paintWordmarkLarge([...MOEICONS_WORDMARK_LARGE], createTheme(false)).join("\n");
    expect(plain).not.toContain("\x1b[");
    expect(plain).toBe(MOEICONS_WORDMARK_LARGE.join("\n"));
  });

  it("marks moeicons as inline code in the project notice", () => {
    expect(renderProjectNotice(80)).toContain("Run `moeicons` from your project root.");
  });

  it("renderBannerText combines wordmark and notice", () => {
    const text = renderBannerText({ columns: 80, color: false });
    expect(text).toContain(MOEICONS_BANNER.trim());
    expect(text).toContain("Run `moeicons` from your project root.");
  });

  it("counts East Asian full-width characters as two visible columns", () => {
    expect(visibleWidth("猫")).toBe(2);
    expect(visibleWidth("猫a")).toBe(3);
    expect(visibleWidth("你好，世界")).toBe(10);
    expect(visibleWidth("abc")).toBe(3);
  });

  it("renders an empty notice list without invalid box math", () => {
    const box = renderNoticeBox([], { width: 8 });
    const lines = box.split("\n");
    expect(lines[0]).toContain("┌");
    expect(lines[lines.length - 1]!).toContain("┘");
    expect(lines[0]!.length).toBe(lines[lines.length - 1]!.length);
  });

  it("truncates long lines to the available width without splitting ANSI escapes", () => {
    const long = "abcdefghij";
    const box = renderNoticeBox(long, { width: 8 });
    const lines = box.split("\n");
    const inner = lines[1]!;
    expect(inner).toContain("…");
    expect(visibleWidth(inner)).toBe(lines[0]!.length);

    const colored = "\u001b[31mabcdefghij\u001b[0m";
    const coloredBox = renderNoticeBox(colored, { width: 8 });
    const coloredInner = coloredBox.split("\n")[1]!;
    expect(visibleWidth(coloredInner)).toBe(coloredBox.split("\n")[0]!.length);
    expect(coloredInner).toContain("\u001b[31m");
  });

  it("keeps notice borders aligned for ANSI and Unicode text", () => {
    const box = renderNoticeBox("\u001b[31m猫\u001b[0m", { width: 8 });
    const lines = box.split("\n");
    expect(lines[1]).toContain("猫");
    const borderWidth = lines[0]!.length;
    const innerVisible = visibleWidth(lines[1]!);
    expect(borderWidth).toBe(innerVisible);
    expect(borderWidth).toBe(6);
    expect(lines[0]).toContain("┌");
  });

  it("supports separate prompt and CLI update status lines", () => {
    const box = renderNoticeBox(
      [
        "A newer Moeicons CLI is available. Update with the command below.",
        "Current 0.1.0 / Latest 0.1.1 / Update: npx --yes @moewolf/moe-icons-cli@0.1.1",
      ],
      { width: 120 },
    );
    expect(box).toContain("A newer Moeicons CLI is available");
    expect(box).toContain(
      "Current 0.1.0 / Latest 0.1.1 / Update: npx --yes @moewolf/moe-icons-cli@0.1.1",
    );
    expect(box.split("\n").filter((line) => line.startsWith("│")).length).toBe(2);
  });

  it("prints wordmark then version then notice in TTY wizard mode", async () => {
    const fixture = makeRuntime({ isTTY: true, columns: 80 });
    fixture.runtime.readLine = async () => "6"; // Exit
    await main([], fixture.runtime);
    const text = fixture.out.join("");
    expect(text).toContain(MOEICONS_BANNER.trim());
    expect(text).toContain("CLI ");
    expect(text).toContain("Run `moeicons` from your project root.");
    expect(text.indexOf(MOEICONS_BANNER.trim())).toBeLessThan(text.indexOf("CLI "));
    expect(text.indexOf("CLI ")).toBeLessThan(text.indexOf("Run `moeicons`"));
    expect(text).not.toMatch(/\/\\_|_\\\//); // no old logo silhouette dependency
  });

  it("does not print the banner for --json or non-TTY wizard", async () => {
    const json = makeRuntime({ isTTY: true, columns: 80 });
    await main(["--json"], json.runtime);
    expect(json.out.join("")).not.toContain("___");
    expect(json.out.join("")).not.toContain(MOEICONS_BANNER.trim());
    expect(() => JSON.parse(json.out.join(""))).not.toThrow();
    expect(json.out.join("")).not.toContain("\x1b[");

    const nonTty = makeRuntime({ isTTY: false, columns: 80 });
    await main([], nonTty.runtime);
    expect(nonTty.out.join("")).not.toContain(MOEICONS_BANNER.trim());
    expect(nonTty.out.join("")).not.toContain("Moeicons icon library");
    expect(nonTty.out.join("")).not.toContain("\x1b[");
  });

  it("omits ANSI from the banner when NO_COLOR=1", async () => {
    const fixture = makeRuntime({ isTTY: true, columns: 101, env: { NO_COLOR: "1" } });
    fixture.runtime.readLine = async () => "6";
    await main([], fixture.runtime);
    const text = fixture.out.join("");
    expect(text).toContain(MOEICONS_WORDMARK_LARGE[0]);
    expect(text).not.toContain("\x1b[");
  });
});
