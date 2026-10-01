import { CliError } from "../errors/index.js";
import { parseVersion } from "./update-policy.js";

const LIBRARY_VERSIONS_URL = "https://api.moeicons.com/v1/icon-library/versions";
const NPM_PACKAGE_URL = "https://registry.npmjs.org/@moewolf%2fmoe-icons-cli";
const SHA256 = /^[a-f0-9]{64}$/;
/** A-1b: local-test candidate versions; only accepted with an explicit local context. */
const LOCAL_TEST_VERSION = /^\d+\.\d+\.\d+-test$/;
const CLI_VERSION_CACHE_TTL_MS = 5 * 60 * 1_000;
let cliVersionCache:
  { readonly expiresAt: number; readonly versions: readonly string[] } | undefined;

/**
 * Test seam (candidate acceptance): `MOEICONS_LIBRARY_VERSIONS_URL` overrides
 * the public versions endpoint. Only an https URL or a loopback http URL is
 * accepted, so production behavior is unchanged.
 */
export function resolveVersionsEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.MOEICONS_LIBRARY_VERSIONS_URL;
  if (!override) return LIBRARY_VERSIONS_URL;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_LIBRARY_VERSIONS_URL is not a valid URL");
  }
  const loopback =
    parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new CliError(
      "VALIDATION_ERROR",
      "MOEICONS_LIBRARY_VERSIONS_URL must be https or loopback http",
    );
  }
  return override;
}

export interface PublicTierVersion {
  readonly version: string;
  readonly releasedAt: string;
  readonly descriptorSha256: string;
  /** A-1b: present only for an accepted local-test candidate. */
  readonly channel?: "local-test";
  readonly publishable?: boolean;
}
export interface PublicLibraryVersions {
  readonly schemaVersion: 1;
  readonly free: PublicTierVersion | null;
  readonly pro: PublicTierVersion | null;
}

async function fixedJson(
  url: string,
  fetchFn: typeof fetch,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectAbort(
      new CliError(
        signal?.aborted ? "CANCELLED" : "NETWORK_ERROR",
        signal?.aborted ? "version check cancelled" : "version check timed out",
      ),
    );
  };
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  const operation = async () => {
    if (signal?.aborted) throw new CliError("CANCELLED", "version check cancelled");
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CliError("NETWORK_ERROR", `version check failed with ${response.status}`);
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new CliError("VALIDATION_ERROR", "version response exceeds size limit");
    }
    if (!response.body) throw new CliError("VALIDATION_ERROR", "empty version response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new CliError("VALIDATION_ERROR", "version response exceeds size limit");
      }
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new CliError("VALIDATION_ERROR", "invalid version response JSON");
    }
  };
  try {
    return await Promise.race([operation(), interrupted]);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      signal?.aborted ? "CANCELLED" : "NETWORK_ERROR",
      signal?.aborted ? "version check cancelled" : "version check failed",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function tier(value: unknown, allowLocalTest: boolean): PublicTierVersion | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const baseValid =
    typeof item.version === "string" &&
    typeof item.releasedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(item.releasedAt) &&
    typeof item.descriptorSha256 === "string" &&
    SHA256.test(item.descriptorSha256);
  if (!baseValid) return undefined;
  const version = item.version as string;
  if (parseVersion(version)) {
    // A formal (stable/alpha/beta) version must never carry the local-test marker.
    if (item.channel !== undefined || item.publishable !== undefined) return undefined;
    return item as unknown as PublicTierVersion;
  }
  // A-1b: an `X.Y.Z-test` version is only accepted when the caller proved a
  // local-only context and the release explicitly declares the local-test model.
  if (
    allowLocalTest &&
    LOCAL_TEST_VERSION.test(version) &&
    item.channel === "local-test" &&
    item.publishable === false
  ) {
    return item as unknown as PublicTierVersion;
  }
  return undefined;
}

export async function fetchLibraryVersions(
  deps: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: Readonly<Record<string, string | undefined>>;
    allowLocalTest?: boolean;
  } = {},
): Promise<PublicLibraryVersions> {
  const url = resolveVersionsEndpoint(deps.env ?? {});
  const allowLocalTest = deps.allowLocalTest === true;
  const raw = await fixedJson(url, deps.fetch ?? fetch, 32 * 1024, deps.signal, deps.timeoutMs);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CliError("VALIDATION_ERROR", "invalid icon library versions response");
  const value = raw as Record<string, unknown>;
  const free = tier(value.free, allowLocalTest);
  const pro = tier(value.pro, allowLocalTest);
  if (
    value.schemaVersion !== 1 ||
    free === undefined ||
    pro === undefined ||
    Object.keys(value).some((key) => !["schemaVersion", "free", "pro"].includes(key))
  ) {
    throw new CliError("VALIDATION_ERROR", "invalid icon library versions response");
  }
  return { schemaVersion: 1, free, pro };
}

export async function fetchMoeiconsVersions(
  deps: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<readonly string[]> {
  const raw = await fixedJson(
    NPM_PACKAGE_URL,
    deps.fetch ?? fetch,
    8 * 1024 * 1024,
    deps.signal,
    deps.timeoutMs,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CliError("VALIDATION_ERROR", "invalid npm package metadata");
  const value = raw as { versions?: unknown };
  if (
    typeof value.versions !== "object" ||
    value.versions === null ||
    Array.isArray(value.versions)
  )
    throw new CliError("VALIDATION_ERROR", "invalid npm package metadata");
  return Object.keys(value.versions).filter((version) => parseVersion(version));
}

/** Keep the interactive startup check cheap when the wizard is opened repeatedly. */
export async function fetchMoeiconsVersionsCached(
  deps: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<readonly string[]> {
  if (cliVersionCache && cliVersionCache.expiresAt > Date.now()) return cliVersionCache.versions;
  const versions = await fetchMoeiconsVersions(deps);
  cliVersionCache = { versions, expiresAt: Date.now() + CLI_VERSION_CACHE_TTL_MS };
  return versions;
}

export function latestInChannel(current: string, versions: readonly string[]): string | undefined {
  const parsed = parseVersion(current);
  if (!parsed) return undefined;
  return versions
    .map((version) => ({ version, parsed: parseVersion(version) }))
    .filter((item) => item.parsed?.channel === parsed.channel)
    .sort(
      (a, b) =>
        b.parsed!.major - a.parsed!.major ||
        b.parsed!.minor - a.parsed!.minor ||
        b.parsed!.patch - a.parsed!.patch,
    )[0]?.version;
}
