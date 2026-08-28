import { describe, expect, it } from "vitest";
import {
  MOEICONS_BANNER,
  centerLines,
  renderBannerText,
  renderNoticeBox,
  visibleWidth,
} from "../../src/ui/banner.js";
import { MOEICONS_LOGO_ASCII } from "../../src/ui/generated/logo-ascii.js";
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

function banner(columns: number, color = false): string {
  return renderBannerText({ columns, color });
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

  it("centers on a 47-column canvas without trailing padding", () => {
    const [line] = centerLines(["abc"]);
    expect(line).toBe(`${" ".repeat(22)}abc`);
    expect(line?.endsWith("abc")).toBe(true);
    expect(visibleWidth(line ?? "")).toBe(25);
  });

  it("renders logo plus figlet at 52/80/120 columns", () => {
    for (const columns of [52, 80, 120]) {
      const text = banner(columns);
      expect(text).toContain(MOEICONS_LOGO_ASCII.split("\n")[0]);
      expect(text).toContain(MOEICONS_BANNER.trim());
      expect(text).toContain("Run moeicons from your project root.");
      expect(text.indexOf(MOEICONS_LOGO_ASCII.split("\n")[0] ?? "")).toBeLessThan(
        text.indexOf(MOEICONS_BANNER.trim()),
      );
      const lines = text.trimEnd().split("\n");
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(columns, 20) + 4);
      }
    }
  });

  it("treats 0, negative, and NaN columns as 80", () => {
    const full = banner(80);
    expect(banner(0)).toBe(full);
    expect(banner(-3)).toBe(full);
    expect(banner(Number.NaN)).toBe(full);
  });

  it("falls back to a single-line title below 52 columns", () => {
    for (const columns of [51, 32, 20, 1]) {
      const text = banner(columns);
      expect(text.startsWith("MOEICONS\n")).toBe(true);
      expect(text).not.toContain(MOEICONS_LOGO_ASCII.split("\n")[0]);
      expect(text).not.toContain("___ ____ ___");
      expect(text).toContain("┌");
      const boxWidth = visibleWidth(text.split("\n")[1] ?? "");
      expect(boxWidth).toBeLessThanOrEqual(Math.max(20, columns));
    }
    expect(banner(51)).toContain("Run moeicons from your project root.");
  });

  it("colors the logo with brand blue and leaves the figlet uncolored", () => {
    const colored = banner(80, true);
    expect(colored).toContain("\x1b[38;2;59;130;246m");
    expect(colored).toContain("\x1b[39m");
    expect(colored).toContain(MOEICONS_BANNER.trim());
    const figletIndex = colored.indexOf(MOEICONS_BANNER.trim());
    const afterFiglet = colored.slice(figletIndex, figletIndex + MOEICONS_BANNER.trim().length);
    expect(afterFiglet).not.toContain("\x1b[");
  });

  it("renderBannerText includes the constant and dependency notice", () => {
    const text = banner(80);
    expect(text).toContain(MOEICONS_BANNER.trim());
    expect(text).toContain("Run moeicons from your project root.");
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
    const box = renderNoticeBox([
      "A newer Moeicons CLI is available. Update with the command below.",
      "Current 0.1.0 / Latest 0.1.1 / Update: npx --yes @moewolf/moe-icons-cli@0.1.1",
    ], { width: 120 });
    expect(box).toContain("A newer Moeicons CLI is available");
    expect(box).toContain("Current 0.1.0 / Latest 0.1.1 / Update: npx --yes @moewolf/moe-icons-cli@0.1.1");
    expect(box.split("\n").filter((line) => line.startsWith("│")).length).toBe(2);
  });

  it("prints the banner in TTY human wizard mode", async () => {
    const fixture = makeRuntime({ isTTY: true, columns: 80 });
    fixture.runtime.readLine = async () => "0";
    await main([], fixture.runtime);
    expect(fixture.out.join("")).toContain(MOEICONS_BANNER.trim());
    expect(fixture.out.join("")).toContain(MOEICONS_LOGO_ASCII.split("\n")[0]);
  });

  it("does not print the banner for --json or non-TTY wizard", async () => {
    const json = makeRuntime({ isTTY: true, columns: 80 });
    await main(["--json"], json.runtime);
    expect(json.out.join("")).not.toContain("___");
    expect(json.out.join("")).not.toContain(MOEICONS_BANNER.trim());
    expect(json.out.join("")).not.toContain(MOEICONS_LOGO_ASCII.split("\n")[0]);
    expect(() => JSON.parse(json.out.join(""))).not.toThrow();
    expect(json.out.join("")).not.toContain("\x1b[");

    const nonTty = makeRuntime({ isTTY: false, columns: 80 });
    await main([], nonTty.runtime);
    expect(nonTty.out.join("")).not.toContain(MOEICONS_BANNER.trim());
    expect(nonTty.out.join("")).not.toContain("Moeicons icon library");
    expect(nonTty.out.join("")).not.toContain("\x1b[");
    expect(nonTty.out.join("")).not.toContain(MOEICONS_LOGO_ASCII.split("\n")[0]);
  });

  it("omits ANSI from the TTY banner when NO_COLOR is set", async () => {
    const fixture = makeRuntime({ isTTY: true, columns: 80, env: { NO_COLOR: "1" } });
    fixture.runtime.readLine = async () => "0";
    await main([], fixture.runtime);
    const text = fixture.out.join("");
    expect(text).toContain(MOEICONS_BANNER.trim());
    expect(text).not.toContain("\x1b[");
  });
});
