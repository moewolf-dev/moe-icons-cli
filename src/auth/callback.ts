import { createServer, type Server } from "node:http";
import { parse } from "node:url";

/**
 * Loopback callback server for OAuth Authorization Code + PKCE. Binds loopback
 * only, serves one successful callback, cleans up on timeout/abort.
 */

export interface CallbackServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path: string; // e.g. /callback
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

export type CallbackOutcome =
  | { readonly ok: true; readonly value: CallbackResult }
  | { readonly ok: false; readonly code: "TIMEOUT" | "ABORTED" | "SERVER_ERROR" | "BAD_CALLBACK"; readonly message: string };

const LOOPBACK = "127.0.0.1";

export interface ActiveCallbackServer {
  readonly server: Server;
  /** The port the server is bound to (for building the redirect URL). */
  readonly port: number;
  /** Resolves when the single allowed callback arrives (or timeout/abort). */
  readonly outcome: Promise<CallbackOutcome>;
  readonly stop: () => void;
}

/**
 * Start a loopback callback server. The caller must build the authorization
 * URL with the returned port, then await `outcome`.
 */
export function startLoopbackCallbackServer(
  options: CallbackServerOptions,
): ActiveCallbackServer {
  const host = options.host ?? LOOPBACK;
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const timeoutMs = options.timeoutMs ?? 120_000;

  let stopCalled = false;
  let resolveOutcome: (value: CallbackOutcome) => void = () => undefined;
  const outcome = new Promise<CallbackOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  let boundPort = options.port ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const server: Server = createServer((req, res) => {
    const url = parse(req.url ?? "/", true);
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = typeof url.query.code === "string" ? url.query.code : undefined;
    const state = typeof url.query.state === "string" ? url.query.state : undefined;

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code or state");
      // a malformed callback is not the success callback; do not resolve yet
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Login successful</h1><p>You can close this tab and return to the terminal.</p></body></html>");
    stop();
    resolveOutcome({ ok: true, value: { code, state } });
  });

  server.on("error", (error) => {
    stop();
    resolveOutcome({
      ok: false,
      code: "SERVER_ERROR",
      message: error.message,
    });
  });

  server.listen(options.port ?? 0, host, () => {
    const address = server.address();
    if (typeof address === "object" && address !== null) {
      boundPort = address.port;
    }
    timer = setTimeout(() => {
      stop();
      resolveOutcome({ ok: false, code: "TIMEOUT", message: "login timed out" });
    }, timeoutMs);
  });

  const stop = () => {
    if (stopCalled) return;
    stopCalled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortHandler);
    server.close();
  };

  const abortHandler = () => {
    stop();
    resolveOutcome({ ok: false, code: "ABORTED", message: "login aborted" });
  };

  options.signal?.addEventListener("abort", abortHandler, { once: true });

  return { server, port: boundPort, outcome, stop };
}
