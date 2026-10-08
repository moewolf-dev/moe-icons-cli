import { CliError } from "../errors/index.js";

/** One deadline covers headers and body; no credentials or upstream bodies in errors. */
export async function boundedResponse(request: typeof fetch, url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new CliError("CANCELLED", "account request cancelled"));
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new CliError("NETWORK_ERROR", "account request timed out; retry")), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (): void => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await Promise.race([request(url, { ...init, redirect: "error", signal: controller.signal }), interrupted]);
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), interrupted]);
        if (done) break;
        size += value.byteLength;
        if (size > 64_000) throw new CliError("VALIDATION_ERROR", "account response exceeds size limit");
        chunks.push(value);
      }
    }
    return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
  } finally {
    clearTimeout(timer); init.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
