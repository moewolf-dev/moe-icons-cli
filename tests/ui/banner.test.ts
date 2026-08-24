import { describe, expect, it } from "vitest";
import { MOEICONS_BANNER, renderBannerText } from "../../src/ui/banner.js";
import { main } from "../../src/cli.js";

function makeRuntime(options: { isTTY?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => "/non-existent-project",
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => options.isTTY ?? false,
      readLine: async () => "",
      readKey: async () => "",
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

  it("renderBannerText includes the constant and product line", () => {
    const text = renderBannerText();
    expect(text).toContain(MOEICONS_BANNER);
    expect(text).toContain("Moeicons icon library — CLI");
  });

  it("prints the banner in TTY human wizard mode", async () => {
    const fixture = makeRuntime({ isTTY: true });
    fixture.runtime.readLine = async () => "0";
    await main([], fixture.runtime);
    expect(fixture.out.join("")).toContain(MOEICONS_BANNER);
  });

  it("does not print the banner for --json or non-TTY wizard", async () => {
    const json = makeRuntime({ isTTY: true });
    await main(["--json"], json.runtime);
    expect(json.out.join("")).not.toContain("___");
    expect(json.out.join("")).not.toContain(MOEICONS_BANNER.trim());

    const nonTty = makeRuntime({ isTTY: false });
    await main([], nonTty.runtime);
    expect(nonTty.out.join("")).not.toContain(MOEICONS_BANNER.trim());
    expect(nonTty.out.join("")).not.toContain("Moeicons icon library");
  });
});
