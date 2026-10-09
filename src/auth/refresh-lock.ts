import { mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "../errors/index.js";

/** Coordinates refresh rotation across CLI processes without storing credentials. */
export async function withRefreshLock<T>(
  root: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "session-refresh.lock");
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (signal?.aborted) throw new CliError("CANCELLED", "session refresh cancelled");
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid }), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new CliError("NETWORK_ERROR", "session refresh coordination unavailable; retry");
      try {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new CliError(
            "AUTH_ERROR",
            "invalid session refresh lock; repair credential storage",
          );
        const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
          pid?: number;
        };
        if (Number.isInteger(owner.pid) && owner.pid! > 0) {
          try {
            process.kill(owner.pid!, 0);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
              throw new CliError(
                "NETWORK_ERROR",
                "a stopped process left a session refresh lock; repair credential storage before retrying",
              );
            }
          }
        }
      } catch (cause) {
        if (cause instanceof CliError) throw cause; /* Owner may still be writing its marker. */
      }
      if (Date.now() >= deadline)
        throw new CliError(
          "NETWORK_ERROR",
          "session refresh is busy; retry or repair a stale credential lock",
        );
      try {
        await delay(50, undefined, signal ? { signal } : undefined);
      } catch {
        throw new CliError("CANCELLED", "session refresh cancelled");
      }
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
