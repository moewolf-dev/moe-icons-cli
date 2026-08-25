import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors/index.js";

export interface ProjectLockIo {
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string;
  readonly createExclusive: (path: string, content: string) => void;
  readonly remove: (path: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly now: () => number;
  readonly pid: number;
}

const defaultIo: ProjectLockIo = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  createExclusive: (path, content) => { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, content); } finally { closeSync(fd); } },
  remove: unlinkSync,
  isProcessAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  now: Date.now,
  pid: process.pid,
};

export async function withProjectLock<T>(projectRoot: string, operation: "install" | "update" | "reload", work: () => Promise<T> | T, io: ProjectLockIo = defaultIo): Promise<T> {
  const path = join(projectRoot, ".moeicons.lock");
  if (io.exists(path)) {
    let stale = false;
    try {
      const value = JSON.parse(io.read(path)) as { pid?: unknown; createdAt?: unknown };
      stale = typeof value.pid === "number" && typeof value.createdAt === "number" && io.now() - value.createdAt > 30 * 60_000 && !io.isProcessAlive(value.pid);
    } catch { stale = false; }
    if (!stale) throw new CliError("VALIDATION_ERROR", "another moeicons install/update/reload operation is already running");
    io.remove(path);
  }
  try {
    io.createExclusive(path, JSON.stringify({ schemaVersion: 1, pid: io.pid, operation, createdAt: io.now() }));
  } catch {
    throw new CliError("VALIDATION_ERROR", "another moeicons install/update/reload operation is already running");
  }
  try { return await work(); }
  finally { if (io.exists(path)) io.remove(path); }
}

export function withProjectLockSync<T>(projectRoot: string, operation: "install" | "update" | "reload", work: () => T, io: ProjectLockIo = defaultIo): T {
  const path = join(projectRoot, ".moeicons.lock");
  if (io.exists(path)) {
    let stale = false;
    try {
      const value = JSON.parse(io.read(path)) as { pid?: unknown; createdAt?: unknown };
      stale = typeof value.pid === "number" && typeof value.createdAt === "number" && io.now() - value.createdAt > 30 * 60_000 && !io.isProcessAlive(value.pid);
    } catch { stale = false; }
    if (!stale) throw new CliError("VALIDATION_ERROR", "another moeicons install/update/reload operation is already running");
    io.remove(path);
  }
  try { io.createExclusive(path, JSON.stringify({ schemaVersion: 1, pid: io.pid, operation, createdAt: io.now() })); }
  catch { throw new CliError("VALIDATION_ERROR", "another moeicons install/update/reload operation is already running"); }
  try { return work(); }
  finally { if (io.exists(path)) io.remove(path); }
}
