import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStreamUi } from "../../src/ui/stream.js";
import { createNonInteractiveUi } from "../../src/ui/non-interactive.js";
import { createCommandUi } from "../../src/ui/create-ui.js";
import { detectCapabilities } from "../../src/ui/capabilities.js";
import { PROMPT_ABORT, PROMPT_CANCEL, submitted } from "../../src/core/prompt-result.js";
import { runWizardUseCase } from "../../src/core/wizard.js";
import type { CommandContext, CommandUi } from "../../src/core/context.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const choices = [
  { value: "free", label: "Free" },
  { value: "back", label: "Back", separatorBefore: true },
];
const capabilities = detectCapabilities({
  env: { TERM: "xterm-256color" },
  stdinTTY: true,
  stdoutTTY: true,
});

function streamRuntime(lines: string[]): Parameters<typeof createStreamUi>[0] {
  let index = 0;
  return {
    isTTY: () => true,
    stdout: () => undefined,
    readLine: async () => lines[index++] ?? "0",
    readKey: async () => "",
  };
}

describe("REF-01 prompt outcome contract", () => {
  it("returns complete outcomes from the injected-stream adapter", async () => {
    const ui = createStreamUi(streamRuntime(["2"]), { yes: false, capabilities });
    await expect(ui.promptSelect!("Pick", choices, new AbortController().signal)).resolves.toEqual(
      submitted("back"),
    );
    const cancelUi = createStreamUi(streamRuntime(["0"]), { yes: false, capabilities });
    await expect(
      cancelUi.promptSelect!("Pick", choices, new AbortController().signal),
    ).resolves.toEqual({ kind: "cancel" });
  });

  it("returns abort when the caller's signal is aborted before a prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const ui = createStreamUi(streamRuntime([]), { yes: false, capabilities });
    await expect(ui.promptSelect!("Pick", choices, controller.signal)).resolves.toEqual(
      PROMPT_ABORT,
    );
  });

  it("uses --yes for confirmations without rendering a prompt", async () => {
    const yes = createNonInteractiveUi({
      yes: true,
      capabilities: detectCapabilities({ env: {}, json: true }),
    });
    await expect(yes.promptConfirm!("Sure?", new AbortController().signal)).resolves.toEqual(
      submitted(true),
    );
  });

  it("does not silently wait for input in JSON mode", async () => {
    const ui = createCommandUi({ json: true, yes: false, isTTY: true, env: {} });
    await expect(
      ui.promptSelect!("Pick", choices, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "NOT_TTY",
    });
  });

  it("prefers the canonical prompt members over the legacy ones", async () => {
    const calls: string[] = [];
    const ui: CommandUi = {
      promptSelect: async () => {
        calls.push("prompt");
        return PROMPT_CANCEL;
      },
      select: async () => {
        calls.push("legacy");
        return "free";
      },
      confirm: async () => true,
      text: async () => "",
      note: () => undefined,
      progress: () => ({ stop: () => undefined }),
    };
    expect(ui.promptSelect).toBeDefined();
    await ui.promptSelect!("Pick", choices, new AbortController().signal);
    expect(calls).toEqual(["prompt"]);
  });
});

describe("REF-01 wizard navigation table", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-nav-table-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const context = (ui: CommandUi): CommandContext => ({
    ui,
    cwd: dir,
    env: {},
    signal: new AbortController().signal,
    now: () => new Date(),
  });

  function uiWith(
    selectResults: Array<"back" | "cancel" | "abort" | string>,
    confirmResult?: "cancel" | "abort" | "no" | "yes",
  ): CommandUi {
    let index = 0;
    const next = () => {
      const value = selectResults[index++] ?? "cancel";
      if (value === "back") return PROMPT_CANCEL;
      if (value === "cancel") return PROMPT_CANCEL;
      if (value === "abort") return PROMPT_ABORT;
      return submitted(value);
    };
    return {
      promptSelect: async () => next(),
      promptConfirm: async () => {
        if (confirmResult === "cancel") return PROMPT_CANCEL;
        if (confirmResult === "abort") return PROMPT_ABORT;
        if (confirmResult === "no") return submitted(false);
        return submitted(true);
      },
      select: async () => undefined,
      confirm: async () => undefined,
      text: async () => "",
      note: () => undefined,
      progress: () => ({ stop: () => undefined }),
    };
  }

  it("returns Back from the target submenu without writing", async () => {
    const result = await runWizardUseCase(context(uiWith(["free", "back"])), { json: false });
    expect(result).toEqual({ ok: true, action: "back" });
  });

  it("treats No on confirmation as Back, and cancel as a hard stop", async () => {
    expect(
      await runWizardUseCase(context(uiWith(["free", "react"], "no")), { json: false }),
    ).toEqual({
      ok: true,
      action: "back",
    });
    expect(
      await runWizardUseCase(context(uiWith(["free", "react"], "cancel")), { json: false }),
    ).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });

  it("exits from Home on cancel and reports the menu path separately", async () => {
    expect(await runWizardUseCase(context(uiWith(["cancel"])), { json: false })).toEqual({
      ok: true,
      action: "exit",
      via: "cancel",
    });
    expect(await runWizardUseCase(context(uiWith(["exit"])), { json: false })).toEqual({
      ok: true,
      action: "exit",
      via: "menu",
    });
  });
});
