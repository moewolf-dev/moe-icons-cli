import { describe, expect, it, vi } from "vitest";
import { createTheme } from "../../src/ui/theme.js";

const cancel = Symbol("clack-cancel");
const brandedConfirm = vi.fn();
const brandedSelect = vi.fn(async () => cancel);

vi.mock("@clack/core", () => ({
  isCancel: (value: unknown) => value === cancel,
}));

vi.mock("../../src/ui/branded-prompts.js", () => ({
  brandedSelect,
  brandedConfirm,
}));

vi.mock("@clack/prompts", () => ({
  text: async () => cancel,
  note: () => undefined,
  spinner: () => ({ start() { return undefined; }, stop() { return undefined; } }),
  isCancel: (value: unknown) => value === cancel,
}));

const { createClackUi } = await import("../../src/ui/clack.js");

describe("clack adapter", () => {
  const signal = new AbortController().signal;
  const theme = createTheme(false);

  it("maps Clack cancel to undefined", async () => {
    brandedConfirm.mockResolvedValueOnce(cancel);
    const ui = createClackUi({ yes: false, theme });
    expect(await ui.select("Choose", [{ value: "free", label: "Free" }], signal)).toBeUndefined();
    expect(await ui.confirm("Sure?", signal)).toBeUndefined();
  });

  it("skips Clack confirm when --yes is set", async () => {
    brandedConfirm.mockClear();
    const ui = createClackUi({ yes: true, theme });
    expect(await ui.confirm("Sure?", signal)).toBe(true);
    expect(brandedConfirm).not.toHaveBeenCalled();
  });
});
