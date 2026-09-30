import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { recoverManagedReconcile } from "../src/project/install.js";
import { main } from "../src/cli.js";

const moduleUrl = pathToFileURL(resolve("dist/project/install.js")).href;
const child = `
import * as fs from 'node:fs';
import { executeManagedReconcile } from ${JSON.stringify(moduleUrl)};
const [root, point] = process.argv.slice(1);
const io = { ...fs,
 renameSync(from, to) {
  fs.renameSync(from, to);
  if ((point === 'backup' && String(to).includes('/files/')) || (point === 'install' && String(from).includes('.reconcile-staging-'))) process.exit(86);
 },
 rmSync(path, options) {
  if (point === 'commit' && String(path).includes('.reconcile-backup-')) process.exit(86);
  fs.rmSync(path, options);
 }
};
executeManagedReconcile(root, { 'src/icon.ts': 'new icon', 'package.json': 'new package', 'tailwind.config.js': 'new tailwind' }, ['obsolete.png'], io);
`;

function interrupted(point: string) {
  const root = fs.mkdtempSync(join(tmpdir(), "moe-crash-"));
  fs.mkdirSync(join(root, "src"));
  for (const [path, bytes] of Object.entries({ "src/icon.ts": "old icon", "package.json": "old package", "tailwind.config.js": "old tailwind", "obsolete.png": "old binary", "src/user.ts": "user" })) fs.writeFileSync(join(root, path), bytes);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child, root, point], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(86);
  return root;
}

describe("process termination recovery from the built writer", () => {
  it("exposes recovery as an offline CLI command with no project manifest required", async () => {
    const root = interrupted("backup");
    try {
      const output: string[] = [];
      const status = await main(["recover", "--json"], {
        cwd: () => root, env: {}, isTTY: () => false,
        stdout: (value) => output.push(value), stderr: (value) => output.push(value),
      });
      expect(status).toBe(0);
      expect(JSON.parse(output.join(""))).toEqual({ ok: true, recovered: 1 });
      expect(fs.readFileSync(join(root, "src/icon.ts"), "utf8")).toBe("old icon");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  for (const point of ["backup", "install", "commit"]) it(`recovers termination after ${point}`, () => {
    const root = interrupted(point);
    try {
      expect(recoverManagedReconcile(root, fs)).toBe(1);
      for (const [path, bytes] of Object.entries({ "src/icon.ts": point === "commit" ? "new icon" : "old icon", "package.json": point === "commit" ? "new package" : "old package", "tailwind.config.js": point === "commit" ? "new tailwind" : "old tailwind", "src/user.ts": "user" })) expect(fs.readFileSync(join(root, path), "utf8")).toBe(bytes);
      expect(fs.existsSync(join(root, "obsolete.png"))).toBe(point !== "commit");
      expect(recoverManagedReconcile(root, fs)).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves post-crash user edits and all original backups on conflict", () => {
    const root = interrupted("install");
    try {
      fs.writeFileSync(join(root, "src/icon.ts"), "user edit after crash");
      expect(() => recoverManagedReconcile(root, fs)).toThrow("recovery conflict");
      expect(fs.readFileSync(join(root, "src/icon.ts"), "utf8")).toBe("user edit after crash");
      const backup = fs.readdirSync(join(root, ".moeicons")).find((name) => name.startsWith(".reconcile-backup-"))!;
      expect(fs.readFileSync(join(root, ".moeicons", backup, "files/src/icon.ts"), "utf8")).toBe("old icon");
      expect(fs.existsSync(join(root, ".moeicons", backup, "recovery.json"))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
