import { describe, it, expect, vi } from "vitest";
import {
  renderBanner,
  select,
  confirm,
  maskedInput,
  CancelledError,
  type TuiStreams,
} from "../src/tui/primitives.js";
import { CliError } from "../src/errors/index.js";

function makeStreams(overrides: Partial<TuiStreams> = {}): {
  streams: TuiStreams;
  written: string[];
} {
  const written: string[] = [];
  return {
    streams: {
      isTTY: () => true,
      write: (t) => written.push(t),
      readLine: async () => "",
      readKey: async () => "",
      ...overrides,
    },
    written,
  };
}

describe("renderBanner", () => {
  it("writes the banner even without a TTY", () => {
    const { streams, written } = makeStreams({ isTTY: () => false });
    renderBanner({ streams }, "BANNER");
    expect(written.join("")).toContain("BANNER");
  });
});

describe("select", () => {
  it("returns the chosen value", async () => {
    const { streams } = makeStreams({ readLine: async () => "2" });
    const result = await select(
      { streams },
      "Pick",
      { choices: [{ value: "free" as const, label: "Free" }, { value: "pro" as const, label: "Pro" }] },
    );
    expect(result).toBe("pro");
  });

  it("throws NOT_TTY without a TTY", async () => {
    const { streams } = makeStreams({ isTTY: () => false });
    await expect(
      select({ streams }, "Pick", { choices: [] }),
    ).rejects.toThrow(CliError);
  });

  it("throws CancelledError on cancel", async () => {
    const { streams } = makeStreams({ readLine: async () => "0" });
    await expect(
      select(
        { streams },
        "Pick",
        { choices: [{ value: "free" as const, label: "Free" }], canCancel: true },
      ),
    ).rejects.toThrow(CancelledError);
  });
});

describe("confirm", () => {
  it("accepts y", async () => {
    const { streams } = makeStreams({ readLine: async () => "y" });
    expect(await confirm({ streams }, "Sure?", false)).toBe(true);
  });

  it("returns default on empty answer", async () => {
    const { streams } = makeStreams({ readLine: async () => "" });
    expect(await confirm({ streams }, "Sure?", false)).toBe(false);
  });

  it("returns default without a TTY", async () => {
    const { streams } = makeStreams({ isTTY: () => false });
    expect(await confirm({ streams }, "Sure?", true)).toBe(true);
  });
});

describe("maskedInput", () => {
  it("masks input and returns the value", async () => {
    const keys = ["a", "b", "c", "\r"];
    let i = 0;
    const { streams, written } = makeStreams({
      readKey: async () => keys[i++] ?? "",
    });
    const value = await maskedInput({ streams }, "key: ");
    expect(value).toBe("abc");
    expect(written.filter((t) => t === "*").length).toBe(3);
  });

  it("handles backspace", async () => {
    const keys = ["a", "b", "\u007f", "c", "\r"];
    let i = 0;
    const { streams } = makeStreams({ readKey: async () => keys[i++] ?? "" });
    expect(await maskedInput({ streams }, "key: ")).toBe("ac");
  });

  it("throws CancelledError on Ctrl+C", async () => {
    const { streams } = makeStreams({ readKey: async () => "\u0003" });
    await expect(maskedInput({ streams }, "key: ")).rejects.toThrow(CancelledError);
  });

  it("throws NOT_TTY without a TTY", async () => {
    const { streams } = makeStreams({ isTTY: () => false });
    await expect(maskedInput({ streams }, "key: ")).rejects.toThrow(CliError);
  });
});
