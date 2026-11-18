import { describe, expect, it } from "vitest";
import { createAccessibleUi, type AccessibleUiRuntime } from "../../src/ui/accessible.js";
import { detectCapabilities, nonInteractiveCapabilities } from "../../src/ui/capabilities.js";

function runtime(lines: Array<string | Error>): AccessibleUiRuntime & { output: string[] } {
  const output: string[] = [];
  let index = 0;
  return {
    output,
    write: (text) => output.push(text),
    async readLine() {
      const next = lines[index++];
      if (next instanceof Error) throw next;
      return next ?? "";
    },
    isTTY: () => true,
  };
}

const choices = Array.from({ length: 12 }, (_, index) => ({
  value: `choice-${index + 1}`,
  label: `Choice ${index + 1}`,
}));

const signal = () => new AbortController().signal;

describe("REF-02 accessible adapter", () => {
  it("accepts a multi-digit number and validates out-of-range input", async () => {
    const io = runtime(["99", "abc", "12"]);
    const ui = createAccessibleUi(io, {
      capabilities: detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true }),
    });
    await expect(ui.promptSelect!("Pick", choices, signal())).resolves.toEqual({
      kind: "submit",
      value: "choice-12",
    });
    expect(io.output.join("")).toContain("12. Choice 12");
    expect(io.output.join("")).toContain("Invalid choice");
  });

  it("maps 0/Esc words to cancel, not to a missing value", async () => {
    for (const word of ["0", "cancel", "q"]) {
      const ui = createAccessibleUi(runtime([word]), {
        capabilities: detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true }),
      });
      await expect(ui.promptSelect!("Pick", choices, signal())).resolves.toEqual({
        kind: "cancel",
      });
    }
  });

  it("maps EOF/closed input to cancel", async () => {
    const ui = createAccessibleUi(runtime([new Error("readline was closed")]), {
      capabilities: detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true }),
    });
    await expect(ui.promptSelect!("Pick", choices, signal())).resolves.toEqual({ kind: "cancel" });
  });

  it("maps an external abort to abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const ui = createAccessibleUi(runtime([]), {
      capabilities: detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true }),
    });
    await expect(ui.promptSelect!("Pick", choices, controller.signal)).resolves.toEqual({
      kind: "abort",
    });
  });

  it("confirms with Enter=default, n=no and 0=cancel", async () => {
    const capabilities = detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true });
    await expect(
      createAccessibleUi(runtime([""]), { capabilities }).promptConfirm!("Sure?", signal()),
    ).resolves.toEqual({
      kind: "submit",
      value: true,
    });
    await expect(
      createAccessibleUi(runtime(["n"]), { capabilities }).promptConfirm!("Sure?", signal()),
    ).resolves.toEqual({
      kind: "submit",
      value: false,
    });
    await expect(
      createAccessibleUi(runtime(["0"]), { capabilities }).promptConfirm!("Sure?", signal()),
    ).resolves.toEqual({
      kind: "cancel",
    });
  });

  it("rejects a non-TTY instead of waiting for input", async () => {
    const ui = createAccessibleUi(
      { write: () => undefined, readLine: async () => "", isTTY: () => false },
      { capabilities: nonInteractiveCapabilities() },
    );
    await expect(ui.promptSelect!("Pick", choices, signal())).rejects.toMatchObject({
      code: "NOT_TTY",
    });
  });

  it("emits no ANSI escape when colour is disabled", async () => {
    const io = runtime(["1"]);
    const ui = createAccessibleUi(io, {
      capabilities: detectCapabilities({ env: { NO_COLOR: "1" }, stdinTTY: true, stdoutTTY: true }),
    });
    await ui.promptSelect!("Pick", choices, signal());
    expect(io.output.join("")).not.toMatch(/\x1b\[/);
  });
});

describe("REF-02/03 capability detection", () => {
  it("judges stdin/stdout independently", () => {
    expect(detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: false }).interactiveInput).toBe(
      false,
    );
    expect(detectCapabilities({ env: {}, stdinTTY: false, stdoutTTY: true }).interactiveInput).toBe(
      false,
    );
    expect(detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true }).interactiveInput).toBe(
      true,
    );
  });

  it("treats zero/NaN columns as unknown instead of a tiny terminal", () => {
    expect(
      detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true, columns: 0 }).columns,
    ).toBeUndefined();
    expect(
      detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true, columns: Number.NaN }).columns,
    ).toBeUndefined();
    expect(
      detectCapabilities({ env: {}, stdinTTY: true, stdoutTTY: true, columns: 120 }).columns,
    ).toBe(120);
  });

  it("honours NO_COLOR, TERM=dumb, CI, ASCII and accessible overrides", () => {
    expect(
      detectCapabilities({ env: { NO_COLOR: "" }, stdinTTY: true, stdoutTTY: true }).color,
    ).toBe(false);
    expect(
      detectCapabilities({ env: { TERM: "dumb" }, stdinTTY: true, stdoutTTY: true }).color,
    ).toBe(false);
    expect(
      detectCapabilities({ env: { TERM: "dumb" }, stdinTTY: true, stdoutTTY: true }).unicode,
    ).toBe(false);
    const ci = detectCapabilities({
      env: { CI: "true", TERM: "xterm-256color" },
      stdinTTY: true,
      stdoutTTY: true,
    });
    expect(ci.ci).toBe(true);
    expect(ci.dynamicRedraw).toBe(false);
    expect(ci.reducedMotion).toBe(true);
    expect(
      detectCapabilities({ env: { MOEICONS_ASCII: "1" }, stdinTTY: true, stdoutTTY: true }).unicode,
    ).toBe(false);
    expect(
      detectCapabilities({ env: { MOEICONS_ACCESSIBLE: "1" }, stdinTTY: true, stdoutTTY: true })
        .accessible,
    ).toBe(true);
  });
});
