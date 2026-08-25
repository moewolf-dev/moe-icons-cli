import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

function runtime() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => ".",
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
    },
    out,
    err,
  };
}

describe("unimplemented command contract", () => {
  for (const command of ["groups"]) {
    it(`${command} returns a stable failure instead of success`, async () => {
      const fixture = runtime();
      expect(await main([command], fixture.runtime)).toBe(1);
      expect(fixture.err.join("")).toContain(`${command} is not implemented yet`);
      expect(fixture.out).toEqual([]);
    });
  }
});
