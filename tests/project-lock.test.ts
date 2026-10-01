import { describe, expect, it } from "vitest";
import { withProjectLock, withProjectLockSync, type ProjectLockIo } from "../src/project/project-lock.js";

function memoryIo(initial?: string, alive = true) {
  let value = initial;
  const io: ProjectLockIo = {
    exists: () => value !== undefined,
    read: () => value ?? "",
    createExclusive: (_path, content) => { if (value !== undefined) throw new Error("EEXIST"); value = content; },
    remove: () => { value = undefined; },
    isProcessAlive: () => alive,
    now: () => 2_000_000,
    pid: 42,
  };
  return { io, value: () => value };
}

describe("shared project operation lock", () => {
  it("explicit recovery reclaims a recent dead lock but refuses a live owner", () => {
    const value = JSON.stringify({ pid: 9, createdAt: 1_999_999 });
    const dead = memoryIo(value, false);
    expect(withProjectLockSync("/project", "recover", () => "recovered", dead.io)).toBe("recovered");
    const live = memoryIo(value, true);
    expect(() => withProjectLockSync("/project", "recover", () => undefined, live.io)).toThrow("already running");
    expect(live.value()).toBe(value);
  });
  it("holds one lock across work and clears it on success or failure", async () => {
    const success = memoryIo();
    await expect(withProjectLock("/project", "install", async () => {
      expect(success.value()).toContain('"operation":"install"');
      return 7;
    }, success.io)).resolves.toBe(7);
    expect(success.value()).toBeUndefined();

    const failure = memoryIo();
    await expect(withProjectLock("/project", "update", () => { throw new Error("boom"); }, failure.io)).rejects.toThrow("boom");
    expect(failure.value()).toBeUndefined();
  });

  it("rejects a live lock and recovers a sufficiently old dead-process lock", async () => {
    const live = memoryIo(JSON.stringify({ pid: 9, createdAt: 0 }), true);
    await expect(withProjectLock("/project", "reload", () => undefined, live.io)).rejects.toThrow("already running");
    const stale = memoryIo(JSON.stringify({ pid: 9, createdAt: 0 }), false);
    await expect(withProjectLock("/project", "reload", () => "ok", stale.io)).resolves.toBe("ok");
    expect(stale.value()).toBeUndefined();
  });
});
