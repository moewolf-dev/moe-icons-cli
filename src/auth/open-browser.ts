import { spawn } from "node:child_process";
import { CliError } from "../errors/index.js";

/** Open a trusted URL without invoking a shell. */
export function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    return Promise.reject(new CliError("AUTH_ERROR", "refusing to open an untrusted browser URL"));
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [parsed.toString()], { detached: true, stdio: "ignore" });
    child.once("error", () => reject(new CliError("AUTH_ERROR", "failed to open the browser")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
