import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * W3-A/C: `runLibraryUpdate` and `runGenerate` are private to `cli.ts`, and the
 * clack adapter implements BOTH `progressBar` and `task` with `p.spinner()`.
 * Driving them together would stack two spinners over stdout — a real-TTY bug
 * that injected-stream tests cannot observe. These source-level guards pin the
 * intended wiring:
 *   - library update: exactly one progress surface (the bar), never `task`;
 *   - generate: no bar, so the strict `task` status is used and a throwing use
 *     case always settles it (`task.fail`) instead of leaking the spinner.
 */

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts"), "utf8");

function functionSource(name: string): string {
  const match = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(SRC);
  if (!match) throw new Error(`could not locate function ${name} in src/cli.ts`);
  return match[0];
}

describe("W3 progress/task wiring in cli.ts", () => {
  it("runLibraryUpdate uses a single progress surface and no task spinner", () => {
    const source = functionSource("runLibraryUpdate");
    expect(source).toContain("startResourceProgress");
    expect(source).toContain("progress.stop(");
    expect(source).not.toMatch(/ui\.task/);
    expect(source).not.toMatch(/\.task\?\./);
  });

  it("runGenerate settles its task on both result and thrown error", () => {
    const source = functionSource("runGenerate");
    expect(source).toContain("ui.task?.");
    expect(source).toMatch(/catch[\s\S]*?task\?\.fail/);
    expect(source).toContain("task?.succeed(");
  });
});
