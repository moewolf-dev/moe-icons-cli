import { sha256Bytes } from "../project/install-metadata.js";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { CliError } from "../errors/index.js";
import { runAccessTokenUseCase, type AuthUseCaseDependencies } from "./auth.js";
import { downloadSignedArtifact, parseSignedDescriptor } from "./signed-artifact.js";
import {
  parseResourceRefs,
  parseResourceIndex,
  planSelectedResources,
  downloadSelectedResources,
  type ResourceRef,
} from "./selected-resources.js";
import {
  resolveProDescriptorEndpoint,
  proSignedDownloadOptions,
  extractProMetadata,
  fetchProDescriptor,
  type ProArtifactDescriptor,
} from "./pro-download.js";
import {
  validateConfigDocument,
  type ConfigDocument,
  type MoeiconsConfigFile,
} from "../project/config.js";
import { parseCatalog } from "../catalog/catalog.js";
import { cacheArtifact } from "./cache.js";
import type { CommandContext } from "./context.js";
import type { SelectedResourceDownload } from "./free-download.js";
import { homedir } from "node:os";

interface ResourceDescriptor extends ResourceRef {
  url: string;
  expiresAt: string;
  parentArtifactSha256: string;
}
export async function downloadProSelected(
  context: CommandContext,
  auth: AuthUseCaseDependencies,
  descriptor: ProArtifactDescriptor,
  selection: { config: MoeiconsConfigFile; document: ConfigDocument },
  deps: { fetch?: typeof fetch; allowedHosts?: readonly string[] },
): Promise<
  | {
      selected: SelectedResourceDownload;
      catalogJson: string;
      manifestJson: string;
      manualMd: string;
      metadataBytes: Uint8Array;
    }
  | undefined
> {
  const fetchFn = deps.fetch ?? fetch;
  const endpointInfo = resolveProDescriptorEndpoint(context.env);
  const endpoint = new URL(
    endpointInfo.url.replace(/\/artifact-descriptor$/, "/resource-descriptor"),
  );
  if (endpoint.origin !== "https://api.moeicons.com" && !endpointInfo.allowLoopback)
    throw new CliError(
      "VALIDATION_ERROR",
      "resource descriptor endpoint must be the trusted API or a test loopback",
    );
  const getDescriptor = async (
    kind: "resource-index" | "resource-bundle",
  ): Promise<ResourceDescriptor | undefined> => {
    let token = await runAccessTokenUseCase(context, auth);
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            version: descriptor.version,
            descriptorSha256: descriptor.descriptorSha256,
            kind,
          }),
          redirect: "error",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]),
        });
      } catch {
        if (context.signal.aborted)
          throw new CliError("CANCELLED", "selected resource download cancelled");
        if (attempt === 2)
          throw new CliError(
            "NETWORK_ERROR",
            "resource authorization request failed after 3 attempts; retry the same fixed release",
          );
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      if (response.status === 401 && !refreshed) {
        await response.body?.cancel();
        token = await runAccessTokenUseCase(context, auth, true);
        refreshed = true;
        continue;
      }
      if (response.status === 403) {
        await response.body?.cancel();
        throw new CliError("FORBIDDEN", "active pro entitlement required for selected resources");
      }
      // Bound JSON reads independently of Content-Length.
      const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!reader) throw new CliError("NETWORK_ERROR", "empty resource descriptor response");
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8192) {
            await reader.cancel();
            throw new CliError("VALIDATION_ERROR", "resource descriptor exceeds 8 KiB");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      let value: Record<string, unknown>;
      try {
        const parsed:unknown = JSON.parse(Buffer.concat(chunks).toString());
        if(typeof parsed!=="object"||parsed===null||Array.isArray(parsed))throw new Error("invalid JSON object");
        value = parsed as Record<string,unknown>;
      } catch {
        throw new CliError("VALIDATION_ERROR", "invalid resource descriptor JSON");
      }
      if (response.status === 404 && value?.code === "RESOURCE_NOT_AVAILABLE") return undefined;
      if (response.status === 401)
        throw new CliError(
          "AUTH_ERROR",
          "resource authentication failed after refresh; run moeicons login",
        );
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      if (response.status !== 200)
        throw new CliError(
          "NETWORK_ERROR",
          `resource descriptor request failed (${response.status}); no full archive was downloaded`,
        );
      const filename =
        kind === "resource-index"
          ? `moe-icons-pro-resource-index-${descriptor.version}.json.gz`
          : `moe-icons-pro-resources-${descriptor.version}.bin`;
      if (
        !value ||
        Array.isArray(value) ||
        value.ok !== true ||
        value.tier !== "pro" ||
        value.kind !== kind ||
        value.version !== descriptor.version ||
        value.descriptorSha256 !== descriptor.descriptorSha256 ||
        value.parentArtifactSha256 !== descriptor.sha256 ||
        value.filename !== filename ||
        (kind === "resource-index" &&
          (value.sha256 !== descriptor.resources!.index.sha256 ||
            value.size !== descriptor.resources!.index.size)) ||
        Object.keys(value).some(
          (k) =>
            ![
              "ok",
              "tier",
              "kind",
              "version",
              "descriptorSha256",
              "filename",
              "parentArtifactSha256",
              "url",
              "expiresAt",
              "size",
              "sha256",
            ].includes(k),
        )
      )
        throw new CliError(
          "VALIDATION_ERROR",
          "resource descriptor identity changed; retry the original fixed release",
        );
      const signed = parseSignedDescriptor(
        { url: value.url, expiresAt: value.expiresAt, size: value.size, sha256: value.sha256 },
        context.now().getTime(),
        { allowLoopback: endpointInfo.allowLoopback },
      );
      return { ...signed, filename, parentArtifactSha256: descriptor.sha256 };
    }
    throw new CliError("NETWORK_ERROR", "resource descriptor retry budget exhausted");
  };
  const indexDescriptor = await getDescriptor("resource-index");
  if (!indexDescriptor)
    throw new CliError(
      "VALIDATION_ERROR",
      "release advertises selected resources but the resource endpoint is unavailable; retry the same release or explicitly set downloadMode=full. No full archive was downloaded",
    );
  if (indexDescriptor.size > 8 * 1024 * 1024)
    throw new CliError("VALIDATION_ERROR", "compressed resource index exceeds 8 MiB");
  if (!descriptor.metadata) throw new CliError("VALIDATION_ERROR", "pro metadata is missing");
  const downloadOptions = proSignedDownloadOptions(context, deps);
  const expired = (error: unknown) =>
    error instanceof CliError &&
    /HTTP (?:401|403)\b|failed with (?:401|403)\b|expired/i.test(error.message);
  const originalMetadata = descriptor.metadata;
  let currentMetadata = originalMetadata;
  let metadataBytes: Uint8Array | undefined;
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      metadataBytes = await downloadSignedArtifact(currentMetadata, downloadOptions);
      break;
    } catch (error) {
      if (!expired(error) || attempt === 2) throw error;
      const renewed = await fetchProDescriptor(
        context,
        auth,
        { version: descriptor.version, descriptorSha256: descriptor.descriptorSha256 },
        deps,
      );
      if (
        renewed.sha256 !== descriptor.sha256 ||
        !renewed.metadata ||
        renewed.metadata.sha256 !== originalMetadata.sha256 ||
        renewed.metadata.size !== originalMetadata.size ||
        JSON.stringify(renewed.resources) !== JSON.stringify(descriptor.resources)
      )
        throw new CliError(
          "VALIDATION_ERROR",
          "release identity changed during metadata URL renewal",
        );
      currentMetadata = renewed.metadata;
    }
  if (!metadataBytes) throw new CliError("NETWORK_ERROR", "metadata URL renewal failed");
  const metadata = extractProMetadata(metadataBytes, descriptor.catalogSha256, descriptor.version);
  const catalog = parseCatalog(JSON.parse(metadata.catalogJson));
  const strict = validateConfigDocument(selection.document, catalog);
  if (strict.kind !== "ok")
    throw new CliError(
      "VALIDATION_ERROR",
      strict.kind === "invalid" ? strict.message : `config state: ${strict.kind}`,
    );
  const cacheDir = context.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
  const io = {
    mkdirSync: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    writeFileSync,
    readFileSync,
    existsSync,
    renameSync,
    rmSync,
    readdirSync,
  };
  const cached = join(
    cacheDir,
    "resources",
    "pro",
    descriptor.version,
    indexDescriptor.sha256,
    "index.json.gz",
  );
  let indexBytes = existsSync(cached) ? readFileSync(cached) : undefined;
  if (
    !indexBytes ||
    indexBytes.length !== indexDescriptor.size ||
    sha256Bytes(indexBytes) !== indexDescriptor.sha256
  ) {
    let signed = indexDescriptor;
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        indexBytes = Buffer.from(
          await downloadSignedArtifact(
            {
              url: signed.url,
              expiresAt: signed.expiresAt,
              size: signed.size,
              sha256: signed.sha256,
            },
            downloadOptions,
          ),
        );
        break;
      } catch (error) {
        if (!expired(error) || attempt === 2) throw error;
        const renewed = await getDescriptor("resource-index");
        if (
          !renewed ||
          renewed.sha256 !== indexDescriptor.sha256 ||
          renewed.size !== indexDescriptor.size
        )
          throw new CliError("VALIDATION_ERROR", "resource index changed during URL renewal");
        signed = renewed;
      }
  }
  if (!indexBytes) throw new CliError("NETWORK_ERROR", "resource index URL renewal failed");
  let bundle: unknown;
  try {
    const parsed:unknown = JSON.parse(gunzipSync(indexBytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
    if(typeof parsed!=="object"||parsed===null||Array.isArray(parsed))throw new Error("invalid index object");
    bundle = (parsed as Record<string,unknown>).bundle;
  } catch {
    throw new CliError("VALIDATION_ERROR", "invalid compressed resource index");
  }
  const refs = parseResourceRefs({
    schemaVersion: 1,
    index: {
      filename: indexDescriptor.filename,
      size: indexDescriptor.size,
      sha256: indexDescriptor.sha256,
    },
    bundle,
  });
  if (
    refs.bundle.sha256 !== descriptor.resources!.bundle.sha256 ||
    refs.bundle.size !== descriptor.resources!.bundle.size ||
    refs.bundle.filename !== descriptor.resources!.bundle.filename
  )
    throw new CliError(
      "VALIDATION_ERROR",
      "resource index bundle does not match advertised release",
    );
  const index = parseResourceIndex(indexBytes, refs, {
    version: descriptor.version,
    tier: "pro",
    artifactSha256: descriptor.sha256,
  });
  const plan = planSelectedResources(strict.config, catalog, index);
  context.ui.note(
    `Download plan: pro/${strict.config.target}, ${strict.config.icons.length} registered icons, ${Object.keys(strict.config.themes).length} themes, ${plan.paths.length} resource files, up to ${plan.payloadBytes} compressed bytes (verified cache reduces network traffic).${plan.fallbacks.length ? ` Fallbacks: ${plan.fallbacks.join("; ")}` : ""}`,
    context.signal,
  );
  cacheArtifact(io, cached, indexBytes, refs.index.sha256);
  const downloaded = await downloadSelectedResources(index, refs.index.sha256, plan.paths, {
    io,
    cacheDir,
    fetch: fetchFn,
    signal: context.signal,
    allowedHosts: downloadOptions.allowedHosts,
    ...(endpointInfo.allowLoopback ? { allowLoopback: true } : {}),
    getBundleUrl: async () => {
      const signed = await getDescriptor("resource-bundle");
      if (
        !signed ||
        signed.sha256 !== refs.bundle.sha256 ||
        signed.size !== refs.bundle.size ||
        signed.filename !== refs.bundle.filename
      )
        throw new CliError("VALIDATION_ERROR", "resource bundle changed after index verification");
      return signed.url;
    },
  });
  return {
    ...metadata,
    metadataBytes,
    selected: {
      ...downloaded,
      refs,
      indexBytes,
      payloadBytes: plan.payloadBytes,
      fallbacks: plan.fallbacks,
    },
  };
}
