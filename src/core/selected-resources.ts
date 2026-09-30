import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { sha256Bytes } from "../project/install-metadata.js";
import { CliError } from "../errors/index.js";
import { cacheArtifact, type CacheIo } from "./cache.js";
import { resolveIconTheme } from "./icon-selection.js";
import { findCatalogStyleGroup, type IconCatalog } from "../catalog/catalog.js";
import { toProxyName } from "./icon-names.js";
import { resolveResourceVariant } from "./resource-variant.js";
import type { MoeiconsConfigFile } from "../project/config.js";

export interface ResourceRef {
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}
export interface ResourceRefs {
  readonly schemaVersion: 1;
  readonly index: ResourceRef;
  readonly bundle: ResourceRef;
}
export interface ResourceFile {
  readonly offset: number;
  readonly compressedSize: number;
  readonly compressedSha256: string;
  readonly size: number;
  readonly sha256: string;
  readonly requires: readonly string[];
}
export interface ResourceIndex {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly tier: "free" | "pro";
  readonly artifactSha256: string;
  readonly bundle: ResourceRef;
  readonly files: Readonly<Record<string, ResourceFile>>;
}
const SHA = /^[a-f0-9]{64}$/;
const safe = (path: string) =>
  /^(react|vue|vanilla|assets)\/[A-Za-z0-9_./-]+$/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => {
  throw new CliError("VALIDATION_ERROR", message);
};
export function parseResourceRefs(value: unknown): ResourceRefs {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some((k) => !["schemaVersion", "index", "bundle"].includes(k))
  )
    return fail("invalid selected resource contract");
  for (const kind of ["index", "bundle"]) {
    const ref = value[kind];
    if (
      !record(ref) ||
      Object.keys(ref).some((k) => !["filename", "size", "sha256"].includes(k)) ||
      typeof ref.filename !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(ref.filename) ||
      typeof ref.size !== "number" ||
      !Number.isSafeInteger(ref.size) ||
      ref.size < 1 ||
      typeof ref.sha256 !== "string" ||
      !SHA.test(ref.sha256)
    )
      return fail(`invalid resources.${kind}`);
  }
  if ((value.index as ResourceRef).size > 8 * 1024 * 1024)
    return fail("resource index exceeds 8 MiB compressed limit");
  return value as unknown as ResourceRefs;
}
export function parseResourceIndex(
  bytes: Uint8Array,
  refs: ResourceRefs,
  expected: { version: string; tier: "free" | "pro"; artifactSha256: string },
): ResourceIndex {
  if (bytes.length !== refs.index.size || sha256Bytes(bytes) !== refs.index.sha256)
    return fail("resource index length/SHA-256 mismatch");
  let raw: unknown;
  try {
    raw = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  } catch {
    return fail("invalid or oversized compressed resource index");
  }
  if (
    !record(raw) ||
    Object.keys(raw).some(
      (k) => !["schemaVersion", "version", "tier", "artifactSha256", "bundle", "files"].includes(k),
    ) ||
    raw.schemaVersion !== 1 ||
    raw.version !== expected.version ||
    raw.tier !== expected.tier ||
    raw.artifactSha256 !== expected.artifactSha256 ||
    !record(raw.bundle) ||
    Object.keys(raw.bundle).some((k) => !["filename", "size", "sha256"].includes(k)) ||
    raw.bundle.filename !== refs.bundle.filename ||
    raw.bundle.sha256 !== refs.bundle.sha256 ||
    raw.bundle.size !== refs.bundle.size ||
    !record(raw.files)
  )
    return fail("resource index release identity mismatch");
  if (Object.keys(raw.files).length > 250000) return fail("too many indexed resources");
  const folded = new Set<string>();
  const intervals: Array<[number, number]> = [];
  for (const [name, value] of Object.entries(raw.files)) {
    if (!safe(name) || folded.has(name.toLowerCase()) || !record(value))
      return fail(`unsafe/duplicate indexed path: ${name}`);
    folded.add(name.toLowerCase());
    if (
      Object.keys(value).some(
        (k) =>
          !["offset", "compressedSize", "compressedSha256", "size", "sha256", "requires"].includes(
            k,
          ),
      ) ||
      ![value.offset, value.compressedSize, value.size].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n),
      ) ||
      (value.offset as number) < 0 ||
      (value.compressedSize as number) < 1 ||
      (value.size as number) < 0 ||
      (value.size as number) > 32 * 1024 * 1024 ||
      typeof value.sha256 !== "string" ||
      !SHA.test(value.sha256) ||
      typeof value.compressedSha256 !== "string" ||
      !SHA.test(value.compressedSha256) ||
      !Array.isArray(value.requires) ||
      value.requires.length > 10000 ||
      value.requires.some(
        (d) =>
          typeof d !== "string" ||
          !safe(d) ||
          d.split("/")[0] !== name.split("/")[0] ||
          !Object.hasOwn(raw.files as object, d),
      )
    )
      return fail(`invalid indexed resource: ${name}`);
    const end = (value.offset as number) + (value.compressedSize as number);
    if (!Number.isSafeInteger(end) || end > refs.bundle.size)
      return fail(`resource range escapes bundle: ${name}`);
    intervals.push([value.offset as number, end]);
  }
  for (const name of folded) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (folded.has(parts.slice(0, i).join("/")))
        return fail(`indexed file/directory collision: ${name}`);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  if (
    intervals[0]?.[0] !== 0 ||
    intervals.at(-1)?.[1] !== refs.bundle.size ||
    intervals.some((interval, i) => i > 0 && interval[0] !== intervals[i - 1]![1])
  )
    return fail("resource ranges overlap or leave unindexed bytes");
  return raw as unknown as ResourceIndex;
}
export function planSelectedResources(
  config: MoeiconsConfigFile,
  catalog: IconCatalog,
  index: ResourceIndex,
): {
  paths: readonly string[];
  payloadBytes: number;
  expandedBytes: number;
  fallbacks: readonly string[];
} {
  if (config.tier !== index.tier)
    return fail(`config.tier=${config.tier} does not match resource tier=${index.tier}`);
  const chosen = new Set<string>();
  const fallbacks = new Set<string>();
  const visit = (name: string) => {
    const pending = [name];
    while (pending.length) {
      const path = pending.pop()!;
      if (chosen.has(path)) continue;
      const entry = index.files[path];
      if (!entry)
        return fail(
          `configured resource is missing from this release: ${path}; check icons/themes/target or choose another fixed release`,
        );
      chosen.add(path);
      if (chosen.size > 20000)
        return fail(
          "selected resources exceed 20,000 files; reduce icons/themes or explicitly use downloadMode=full",
        );
      pending.push(...entry.requires);
    }
  };
  if (config.target !== "assets") visit(`${config.target}/types.d.ts`);
  let assets = false;
  for (const id of config.icons)
    for (const requested of Object.keys(config.themes)) {
      const actual = resolveIconTheme(config, catalog, requested, id);
      if (!actual)
        return fail(
          `icons[${id}]: no selected variant for themes.${requested}; register/select a variant or change missingIconPolicy`,
        );
      if (actual !== requested) fallbacks.add(`${id}: ${requested} -> ${actual}`);
      const theme = config.themes[actual]!;
      const group = findCatalogStyleGroup(theme.styleGroup, catalog)!;
      if (group.type === "bitmap") {
        if (config.target === "vanilla")
          return fail(
            `themes.${actual}: Vanilla does not support bitmap icons; choose assets/react/vue`,
          );
        const variant = resolveResourceVariant(group.id, {
          ...(theme.format ? { format: theme.format } : {}),
          ...(theme.imageSize ? { imageSize: theme.imageSize } : {}),
        });
        visit(`assets/${variant.resourceVariantId}/${id}.${variant.format}`);
        assets = true;
      } else if (config.target === "assets") {
        visit(`assets/${group.id}/${id}.svg`);
        assets = true;
      } else {
        const base = `${config.target}/${group.id}/${toProxyName(id)}${config.target === "vue" ? ".vue" : ""}`;
        visit(`${base}.js`);
        visit(`${base}.d.ts`);
        if (config.target === "vanilla") {
          visit(`assets/${group.id}/${id}.svg`);
          assets = true;
        }
      }
    }
  if (assets) visit("assets/manifest.json");
  const paths = [...chosen].sort();
  const payloadBytes = paths.reduce((sum, p) => sum + index.files[p]!.compressedSize, 0);
  const expandedBytes = paths.reduce((sum, p) => sum + index.files[p]!.size, 0);
  if (paths.length > 20000 || expandedBytes > 512 * 1024 * 1024 || payloadBytes > 512 * 1024 * 1024)
    return fail(
      "selected resources exceed 20,000 files/512 MiB budget; reduce icons/themes or explicitly use downloadMode=full",
    );
  return { paths, payloadBytes, expandedBytes, fallbacks: [...fallbacks].sort() };
}
export function verifyResource(bytes: Uint8Array, entry: ResourceFile, name: string): Uint8Array {
  if (bytes.length !== entry.compressedSize || sha256Bytes(bytes) !== entry.compressedSha256)
    return fail(`compressed resource length/SHA-256 mismatch: ${name}`);
  let expanded: Uint8Array;
  try {
    expanded = gunzipSync(bytes, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    return fail(`invalid compressed resource: ${name}`);
  }
  if (expanded.length !== entry.size || sha256Bytes(expanded) !== entry.sha256)
    return fail(`resource length/SHA-256 mismatch: ${name}`);
  return expanded;
}
export async function downloadSelectedResources(
  index: ResourceIndex,
  indexSha256: string,
  paths: readonly string[],
  deps: {
    io: CacheIo;
    cacheDir: string;
    fetch: typeof fetch;
    signal: AbortSignal;
    allowedHosts: readonly string[];
    allowLoopback?: boolean;
    offline?: boolean;
    getBundleUrl: () => Promise<string>;
    readRange?: (start: number, size: number) => Promise<Uint8Array>;
  },
): Promise<{ files: Record<string, Uint8Array>; networkBytes: number; cacheHits: number }> {
  const files: Record<string, Uint8Array> = {};
  let networkBytes = 0;
  let cacheHits = 0;
  let cursor = 0;
  let urlPromise: Promise<string> | undefined;
  let failure: unknown;
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal.addEventListener("abort", abort, { once: true });
  if (deps.signal.aborted) controller.abort();
  const getUrl = () => (urlPromise ??= deps.getBundleUrl());
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (cursor < paths.length && !failure) {
          const name = paths[cursor++]!;
          const entry = index.files[name]!;
          const cached = join(
            deps.cacheDir,
            "resources",
            index.tier,
            index.version,
            indexSha256,
            entry.compressedSha256,
          );
          try {
            if (controller.signal.aborted)
              throw new CliError("CANCELLED", "selected resource download cancelled");
            if (deps.io.existsSync(cached) && deps.io.readFileSync) {
              try {
                files[name] = verifyResource(deps.io.readFileSync(cached), entry, name);
                cacheHits++;
                continue;
              } catch {
                /* corrupt cache is never used */
              }
            }
            if (deps.offline)
              throw new CliError(
                "NETWORK_ERROR",
                `offline resource is missing or corrupt: ${name}; reconnect and run moeicons install, then retry offline`,
              );
            let bytes: Uint8Array | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (controller.signal.aborted)
                throw new CliError("CANCELLED", "selected resource download cancelled");
              try {
                if (deps.readRange)
                  bytes = await deps.readRange(entry.offset, entry.compressedSize);
                else {
                  let url = new URL(await getUrl());
                  let response: Response | undefined;
                  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
                  for (let redirects = 0; redirects <= 5; redirects++) {
                    const loopback =
                      deps.allowLoopback &&
                      url.protocol === "http:" &&
                      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
                    if (
                      (url.protocol !== "https:" && !loopback) ||
                      url.username ||
                      url.password ||
                      !deps.allowedHosts.includes(url.host)
                    )
                      return fail("resource URL uses an untrusted host or protocol");
                    response = await deps.fetch(url, {
                      headers: {
                        Range: `bytes=${entry.offset}-${entry.offset + entry.compressedSize - 1}`,
                        "Accept-Encoding": "identity",
                      },
                      redirect: "manual",
                      signal,
                    });
                    if ([301, 302, 303, 307, 308].includes(response.status)) {
                      const location = response.headers.get("location");
                      await response.body?.cancel();
                      if (!location || redirects === 5)
                        return fail("resource redirect limit exceeded");
                      url = new URL(location, url);
                      continue;
                    }
                    break;
                  }
                  if (!response) throw new Error("resource response unavailable");
                  if ([401, 403].includes(response.status)) {
                    await response.body?.cancel();
                    if (attempt === 2)
                      throw new CliError(
                        "AUTH_ERROR",
                        "resource URL expired or access revoked; retry moeicons install/login",
                      );
                    urlPromise = undefined;
                    continue;
                  }
                  if ([429, 500, 502, 503, 504].includes(response.status)) {
                    await response.body?.cancel();
                    throw new Error(`resource service returned ${response.status}`);
                  }
                  if (
                    response.status !== 206 ||
                    response.headers.get("content-range") !==
                      `bytes ${entry.offset}-${entry.offset + entry.compressedSize - 1}/${index.bundle.size}` ||
                    (response.headers.get("content-encoding") &&
                      response.headers.get("content-encoding") !== "identity")
                  ) {
                    await response.body?.cancel();
                    return fail(
                      `server did not honor the exact resource Range for ${name}; retry or explicitly set downloadMode=full`,
                    );
                  }
                  const length = response.headers.get("content-length");
                  if (length && Number(length) !== entry.compressedSize) {
                    await response.body?.cancel();
                    return fail(`resource response length mismatch: ${name}`);
                  }
                  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
                  if (!reader) return fail("resource response has no body");
                  const chunks: Uint8Array[] = [];
                  let lengthRead = 0;
                  try {
                    for (;;) {
                      const part = await reader.read();
                      if (part.done) break;
                      lengthRead += part.value.length;
                      if (lengthRead > entry.compressedSize) {
                        await reader.cancel();
                        return fail(`oversized resource response: ${name}`);
                      }
                      chunks.push(part.value);
                    }
                  } finally {
                    reader.releaseLock();
                  }
                  bytes = Buffer.concat(chunks);
                  networkBytes += lengthRead;
                }
                break;
              } catch (error) {
                if (error instanceof CliError || attempt === 2 || controller.signal.aborted)
                  throw error;
                await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
              }
            }
            if (!bytes) throw new CliError("NETWORK_ERROR", `resource download failed: ${name}`);
            files[name] = verifyResource(bytes, entry, name);
            cacheArtifact(deps.io, cached, bytes, entry.compressedSha256);
          } catch (error) {
            failure ??= error;
            controller.abort();
          }
        }
      }),
    );
    if (failure) throw failure;
    return { files, networkBytes, cacheHits };
  } finally {
    deps.signal.removeEventListener("abort", abort);
  }
}
