import { CliError } from "../errors/index.js";
import { parseVersion } from "./update-policy.js";

const LIBRARY_VERSIONS_URL = "https://api.moeicons.com/v1/icon-library/versions";
const NPM_PACKAGE_URL = "https://registry.npmjs.org/moeicons";
const SHA256 = /^[a-f0-9]{64}$/;

export interface PublicTierVersion { readonly version: string; readonly releasedAt: string; readonly descriptorSha256: string }
export interface PublicLibraryVersions { readonly schemaVersion: 1; readonly free: PublicTierVersion | null; readonly pro: PublicTierVersion | null }

async function fixedFetch(url: string, fetchFn: typeof fetch, signal?: AbortSignal, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try { return await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal, redirect: "error" }); }
  catch { throw new CliError(signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", signal?.aborted ? "version check cancelled" : "version check failed"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function tier(value: unknown): PublicTierVersion | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.version === "string" && parseVersion(item.version) && typeof item.releasedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(item.releasedAt) && typeof item.descriptorSha256 === "string" && SHA256.test(item.descriptorSha256)
    ? item as unknown as PublicTierVersion : undefined;
}

export async function fetchLibraryVersions(deps: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PublicLibraryVersions> {
  const response = await fixedFetch(LIBRARY_VERSIONS_URL, deps.fetch ?? fetch, deps.signal, deps.timeoutMs);
  if (!response.ok) throw new CliError("NETWORK_ERROR", `version check failed with ${response.status}`);
  const value = await response.json() as Record<string, unknown>;
  const free = tier(value.free); const pro = tier(value.pro);
  if (value.schemaVersion !== 1 || free === undefined || pro === undefined || Object.keys(value).some((key) => !["schemaVersion", "free", "pro"].includes(key))) {
    throw new CliError("VALIDATION_ERROR", "invalid icon library versions response");
  }
  return { schemaVersion: 1, free, pro };
}

export async function fetchMoeiconsVersions(deps: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<readonly string[]> {
  const response = await fixedFetch(NPM_PACKAGE_URL, deps.fetch ?? fetch, deps.signal, deps.timeoutMs);
  if (!response.ok) throw new CliError("NETWORK_ERROR", `CLI version check failed with ${response.status}`);
  const value = await response.json() as { versions?: unknown };
  if (typeof value.versions !== "object" || value.versions === null || Array.isArray(value.versions)) throw new CliError("VALIDATION_ERROR", "invalid npm package metadata");
  return Object.keys(value.versions).filter((version) => parseVersion(version));
}

export function latestInChannel(current: string, versions: readonly string[]): string | undefined {
  const parsed = parseVersion(current); if (!parsed) return undefined;
  return versions.map((version) => ({ version, parsed: parseVersion(version) })).filter((item) => item.parsed?.channel === parsed.channel)
    .sort((a, b) => (b.parsed!.major - a.parsed!.major) || (b.parsed!.minor - a.parsed!.minor) || (b.parsed!.patch - a.parsed!.patch))[0]?.version;
}
