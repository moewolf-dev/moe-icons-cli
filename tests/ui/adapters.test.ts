import { describe, expect, it } from "vitest";
import { createNonInteractiveUi } from "../../src/ui/non-interactive.js";
import { createCommandUi } from "../../src/ui/create-ui.js";
import { CliError } from "../../src/errors/index.js";

const signal = new AbortController().signal;

describe("non-interactive UI", () => {
  it("rejects select without a TTY", async () => {
    const ui = createNonInteractiveUi({ yes: false });
    await expect(ui.select("Choose", [{ value: "free", label: "Free" }], signal)).rejects.toMatchObject({
      code: "NOT_TTY",
    });
  });

  it("does not confirm with a default value unless --yes is set", async () => {
    const ui = createNonInteractiveUi({ yes: false });
    await expect(ui.confirm("Install?", signal)).rejects.toMatchObject({ code: "NOT_TTY" });
    await expect(createNonInteractiveUi({ yes: true }).confirm("Install?", signal)).resolves.toBe(true);
  });
});

describe("createCommandUi", () => {
  it("uses the non-interactive adapter for --json even on a TTY", async () => {
    const ui = createCommandUi({ json: true, yes: false, isTTY: true, env: {} });
    await expect(ui.select("Choose", [{ value: "free", label: "Free" }], signal)).rejects.toBeInstanceOf(CliError);
  });
});
