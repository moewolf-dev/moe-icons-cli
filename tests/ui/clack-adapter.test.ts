import { describe, expect, it, vi } from "vitest";

const cancel = Symbol("clack-cancel");
const confirm = vi.fn();

vi.mock("@clack/prompts", () => ({
  select: async () => cancel,
  confirm,
  text: async () => cancel,
  note: () => undefined,
  spinner: () => ({ start() { return undefined; }, stop() { return undefined; } }),
  isCancel: (value: unknown) => value === cancel,
}));

const { createClackUi } = await import("../../src/ui/clack.js");

describe("clack adapter", () => {
  const signal = new AbortController().signal;

  it("maps Clack cancel to undefined", async () => {
    const ui = createClackUi({ yes: false });
    expect(await ui.select("Choose", [{ value: "free", label: "Free" }], signal)).toBeUndefined();
    expect(await ui.confirm("Sure?", signal)).toBeUndefined();
  });

  it("skips Clack confirm when --yes is set", async () => {
    confirm.mockClear();
    const ui = createClackUi({ yes: true });
    expect(await ui.confirm("Sure?", signal)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
