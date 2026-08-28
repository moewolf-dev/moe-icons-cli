import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isCancel } from "@clack/core";
import {
  brandedConfirm,
  brandedSelect,
  renderConfirmFrame,
  renderSelectFrame,
} from "../../src/ui/branded-prompts.js";
import { ANSI_FG_RESET, createTheme } from "../../src/ui/theme.js";

const theme = createTheme(true);
const plain = createTheme(false);
const CHOICES = [
  { value: "pro", label: "Install moeicons pro" },
  { value: "free", label: "Install moeicons free" },
  { value: "manage", label: "Manage project icons" },
];

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function fakeTty() {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode() {
      return undefined;
    },
  });
  let text = "";
  output.on("data", (chunk: Buffer | string) => {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  return {
    input,
    output,
    get text() {
      return text;
    },
  };
}

async function writeKeys(input: PassThrough, keys: string[], delayMs = 30): Promise<void> {
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    input.write(key);
  }
}

describe("select renderer", () => {
  it("keeps label order and paints only the active row blue", () => {
    const frame = renderSelectFrame(
      { state: "active", cursor: 1, options: CHOICES },
      "Choose an option",
      theme,
    );
    const lines = frame.split("\n");
    expect(lines[0]).toBe("Choose an option");
    expect(stripAnsi(lines[1] ?? "")).toBe("  Install moeicons pro");
    expect(stripAnsi(lines[2] ?? "")).toBe("› Install moeicons free");
    expect(stripAnsi(lines[3] ?? "")).toBe("  Manage project icons");
    expect(lines[1]).not.toContain("\x1b[38;2;59;130;246m");
    expect(lines[2]).toContain("\x1b[38;2;59;130;246m");
    expect(lines[2]).toContain(ANSI_FG_RESET);
    expect(lines[3]).not.toContain("\x1b[38;2;");
    expect(frame).not.toContain("\x1b[38;2;239;68;68m");
  });

  it("renders a one-line blue submit state and a red cancel state", () => {
    expect(stripAnsi(renderSelectFrame({ state: "submit", cursor: 0, options: CHOICES }, "m", theme))).toBe(
      "◆ Install moeicons pro",
    );
    expect(renderSelectFrame({ state: "submit", cursor: 0, options: CHOICES }, "m", theme)).toContain(
      "\x1b[38;2;59;130;246m",
    );
    const cancelled = renderSelectFrame({ state: "cancel", cursor: 0, options: CHOICES }, "m", theme);
    expect(stripAnsi(cancelled)).toBe("■ Cancelled");
    expect(cancelled).toContain("\x1b[38;2;239;68;68m");
    expect(cancelled).not.toContain("\x1b[38;2;59;130;246m");
  });

  it("keeps the same symbols without ANSI when color is off", () => {
    expect(renderSelectFrame({ state: "active", cursor: 0, options: CHOICES }, "m", plain)).toContain(
      "› Install moeicons pro",
    );
    expect(renderSelectFrame({ state: "cancel", cursor: 0, options: CHOICES }, "m", plain)).toBe("■ Cancelled");
    expect(renderSelectFrame({ state: "active", cursor: 0, options: CHOICES }, "m", plain)).not.toContain("\x1b[");
  });
});

describe("select prompt keys", () => {
  it("moves with up/down, submits the current value, and preserves choice order", async () => {
    const io = fakeTty();
    const pending = brandedSelect({
      message: "Choose an option",
      choices: CHOICES,
      theme,
      input: io.input,
      output: io.output,
    });
    await writeKeys(io.input, ["\x1b[B", "\x1b[B", "\r"]);
    await expect(pending).resolves.toBe("manage");
    expect(io.text).toContain("Install moeicons pro");
    expect(io.text).toContain("Install moeicons free");
    expect(io.text.indexOf("Install moeicons pro")).toBeLessThan(io.text.indexOf("Install moeicons free"));
  });

  it("returns the cancel symbol for Esc and Ctrl+C", async () => {
    const esc = fakeTty();
    const escPending = brandedSelect({
      message: "Choose an option",
      choices: CHOICES,
      theme,
      input: esc.input,
      output: esc.output,
    });
    await writeKeys(esc.input, ["\x1b"]);
    const escValue = await escPending;
    expect(isCancel(escValue)).toBe(true);
    expect(stripAnsi(esc.text)).toContain("■ Cancelled");
    expect(esc.text).toContain("\x1b[38;2;239;68;68m");

    const ctrl = fakeTty();
    const ctrlPending = brandedSelect({
      message: "Choose an option",
      choices: CHOICES,
      theme,
      input: ctrl.input,
      output: ctrl.output,
    });
    await writeKeys(ctrl.input, ["\x03"]);
    expect(isCancel(await ctrlPending)).toBe(true);
    expect(stripAnsi(ctrl.text)).toContain("■ Cancelled");
  });
});

describe("confirm renderer", () => {
  it("defaults to a blue active Yes and red inactive No", () => {
    const frame = renderConfirmFrame({ state: "active", value: true }, "Install here?", theme);
    expect(stripAnsi(frame)).toBe("Install here?\n● Yes  No");
    expect(frame).toContain("\x1b[38;2;59;130;246m");
    expect(frame).toContain("\x1b[38;2;239;68;68m");
  });

  it("switches to a red active No and blue inactive Yes", () => {
    const frame = renderConfirmFrame({ state: "active", value: false }, "Install here?", theme);
    expect(stripAnsi(frame)).toBe("Install here?\nYes  ● No");
  });

  it("submits Yes as Confirmed and No or cancel as Cancelled", () => {
    expect(stripAnsi(renderConfirmFrame({ state: "submit", value: true }, "m", theme))).toBe("◆ Confirmed");
    expect(renderConfirmFrame({ state: "submit", value: true }, "m", theme)).toContain("\x1b[38;2;59;130;246m");
    expect(stripAnsi(renderConfirmFrame({ state: "submit", value: false }, "m", theme))).toBe("■ Cancelled");
    expect(renderConfirmFrame({ state: "submit", value: false }, "m", theme)).toContain("\x1b[38;2;239;68;68m");
    expect(stripAnsi(renderConfirmFrame({ state: "cancel", value: true }, "m", theme))).toBe("■ Cancelled");
  });
});

describe("confirm prompt keys", () => {
  it("submits the default Yes with Enter", async () => {
    const io = fakeTty();
    const pending = brandedConfirm({ message: "Install here?", theme, input: io.input, output: io.output });
    await writeKeys(io.input, ["\r"]);
    await expect(pending).resolves.toBe(true);
    expect(stripAnsi(io.text)).toContain("◆ Confirmed");
  });

  it("submits No after toggling", async () => {
    const io = fakeTty();
    const pending = brandedConfirm({ message: "Install here?", theme, input: io.input, output: io.output });
    await writeKeys(io.input, ["\x1b[C", "\r"]);
    await expect(pending).resolves.toBe(false);
    expect(stripAnsi(io.text)).toContain("■ Cancelled");
  });

  it("cancels with Esc and Ctrl+C", async () => {
    const esc = fakeTty();
    const escPending = brandedConfirm({
      message: "Install here?",
      theme,
      input: esc.input,
      output: esc.output,
    });
    await writeKeys(esc.input, ["\x1b"]);
    expect(isCancel(await escPending)).toBe(true);

    const ctrl = fakeTty();
    const ctrlPending = brandedConfirm({
      message: "Install here?",
      theme,
      input: ctrl.input,
      output: ctrl.output,
    });
    await writeKeys(ctrl.input, ["\x03"]);
    expect(isCancel(await ctrlPending)).toBe(true);
  });
});

