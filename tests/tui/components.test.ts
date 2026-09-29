import { describe, expect, it } from "vitest";
import {
  CONFIRM_KEY_HINTS,
  PROGRESS_GLYPHS,
  SELECT_KEY_HINTS,
  TASK_RUNNING_FRAMES,
  formatRate,
  renderHistoryBar,
  renderKeyHints,
  renderProgressBar,
  renderTaskStatus,
} from "../../src/tui/components.js";
import { ANSI_DIM_OPEN, ANSI_DIM_RESET, ANSI_FG_RESET, BRAND_BLUE_RGB, BRAND_RED_RGB, createTheme } from "../../src/ui/theme.js";

const BLUE = `\x1b[38;2;${BRAND_BLUE_RGB.r};${BRAND_BLUE_RGB.g};${BRAND_BLUE_RGB.b}m`;
const RED = `\x1b[38;2;${BRAND_RED_RGB.r};${BRAND_RED_RGB.g};${BRAND_RED_RGB.b}m`;

describe("W3-A progress bar", () => {
  it("renders a deterministic bar with percentage and bytes", () => {
    const line = renderProgressBar({ label: "Download", done: 50, total: 100, theme: createTheme(false), barWidth: 10 });
    expect(line).toBe(`Download ${PROGRESS_GLYPHS.filled.repeat(5)}${PROGRESS_GLYPHS.empty.repeat(5)}  50% 50 B/100 B`);
  });

  it("never fakes a percentage when the total is unknown", () => {
    const line = renderProgressBar({ label: "Download", done: 1024, theme: createTheme(false), barWidth: 10 });
    expect(line).toBe("Download 1.0 KiB");
    expect(line).not.toContain("%");
  });

  it("degrades to a single log line when columns <= 0 (non-TTY)", () => {
    expect(renderProgressBar({ label: "Download", done: 50, total: 100, theme: createTheme(false), columns: 0 })).toBe(
      "Download 50 B/100 B",
    );
  });

  it("adds a transfer rate and detail suffix", () => {
    const line = renderProgressBar({
      label: "Download",
      done: 1024,
      total: 2048,
      theme: createTheme(false),
      barWidth: 8,
      elapsedMs: 1000,
      detail: "128x128 webp",
    });
    expect(line).toContain("1.0 KiB/s");
    expect(line).toContain("128x128 webp");
  });

  it("paints the filled span blue and the remainder dim when colour is on", () => {
    const line = renderProgressBar({ label: "D", done: 50, total: 100, theme: createTheme(true), barWidth: 4 });
    expect(line).toContain(`${BLUE}${PROGRESS_GLYPHS.filled.repeat(2)}${ANSI_FG_RESET}`);
    expect(line).toContain(`${ANSI_DIM_OPEN}${PROGRESS_GLYPHS.empty.repeat(2)}${ANSI_DIM_RESET}`);
  });

  it("formats rates only for positive finite inputs", () => {
    expect(formatRate(1000, 1000)).toBe("1000 B/s");
    expect(formatRate(0, 1000)).toBeUndefined();
    expect(formatRate(1000, 0)).toBeUndefined();
  });
});

describe("W3-C task status", () => {
  it("renders all four strict states", () => {
    const theme = createTheme(false);
    expect(renderTaskStatus({ state: "success", label: "Install", theme })).toBe("✔ Install");
    expect(renderTaskStatus({ state: "failure", label: "Install", detail: "boom", theme })).toBe("✖ Install boom");
    expect(renderTaskStatus({ state: "timeout", label: "Install", theme })).toBe("⏱ Install");
    expect(renderTaskStatus({ state: "running", label: "Install", frame: 0, theme })).toBe(`${TASK_RUNNING_FRAMES[0]} Install`);
  });

  it("uses blue for success and red for failure/timeout", () => {
    const theme = createTheme(true);
    expect(renderTaskStatus({ state: "success", label: "X", theme })).toBe(`${BLUE}✔${ANSI_FG_RESET} X`);
    expect(renderTaskStatus({ state: "failure", label: "X", theme })).toBe(`${RED}✖${ANSI_FG_RESET} X`);
    expect(renderTaskStatus({ state: "timeout", label: "X", theme })).toBe(`${RED}⏱${ANSI_FG_RESET} X`);
  });
});

describe("W3-D key hints", () => {
  it("renders dim hints and stays plain with colour off", () => {
    expect(renderKeyHints(SELECT_KEY_HINTS, createTheme(false))).toBe("↑/↓ move · 1-9 select · Enter submit · Esc cancel");
    const colored = renderKeyHints(CONFIRM_KEY_HINTS, createTheme(true));
    expect(colored.startsWith(ANSI_DIM_OPEN)).toBe(true);
    expect(colored.endsWith(ANSI_DIM_RESET)).toBe(true);
  });
});

describe("W3-E history bar", () => {
  it("returns undefined with no history", () => {
    expect(renderHistoryBar(undefined, createTheme(false))).toBeUndefined();
  });

  it("renders one colour-coded status line", () => {
    const theme = createTheme(true);
    expect(renderHistoryBar({ label: "Install pro (react)", state: "success" }, theme)).toBe(
      `${BLUE}✔${ANSI_FG_RESET} Install pro (react)`,
    );
    expect(renderHistoryBar({ label: "Generate", state: "failure", detail: "boom" }, createTheme(false))).toBe(
      "✖ Generate boom",
    );
  });
});
