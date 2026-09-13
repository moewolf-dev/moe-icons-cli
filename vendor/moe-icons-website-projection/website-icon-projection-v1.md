# Contract: Website Icon Projection v1 (`WEBSITE-ICON-PROJECTION-V1`, 2026-09-12)

> Task: `BITMAP-WEBSITE-0912` / `DEV-A01`. Freezes the cross-repo contract for the
> `code-library production pack → Worker projection → website delivery bucket →
> Worker API → Website Icons page` chain. It is the authoritative field/key/route
> contract; implementations may not mint synonyms or fallback flows.

## 0. Sources of truth

- Frozen decisions and work packages: [`docs/TODO-2026-09-12-BITMAP-WEBSITE-RELEASE-OPTIMIZATION.md`](../TODO-2026-09-12-BITMAP-WEBSITE-RELEASE-OPTIMIZATION.md) §3～§5, `DEC-34/35/41～51`.
- JSON Schemas (this directory):
  - `website-catalog-v1.schema.json`
  - `website-release-v1.schema.json`
  - `website-activation-receipt-v1.schema.json`
  - `website-api-v1.schema.json`
- Upstream media/release contracts: `media-format-v2.md`, `r2-release-layout-v1.md`, `release-event-v1.md`, `source-manifest-v2.schema.json`.

## 1. Ownership and isolation

| Repo | Sole responsibility |
|---|---|
| `moe-icons-code-library` | Build deterministic `website` archive (catalog, snippets, assets, indexes, manifest) from the same build as code/assets/metadata; emit descriptor v3. |
| `moe-icons-web-worker` | **Only** owner of the website projection publish: verify production activation receipt, copy into the website delivery bucket, D1/CAS, auth API, rollback. |
| `moe-icons-website` | UI, Auth0 token acquisition, on-demand Worker calls, docs PR intake. **No R2/D1 credentials.** |
| `moe-icons-library` | Source files, media schema v2 manifest, Free four-group presentation/allowlist. |
| `moe-icons` | Free Release, public docs source, docs sync sender. |

Rules: the production release bucket is a read-only trusted source; the website
delivery bucket is a derived target with a separate binding (`WEBSITE_ICON_BUCKET`),
prefix and credentials (`DEC-02`). Browser never receives R2 keys, bucket names,
S3 endpoints or presigned URLs (`DEC-29/30`).

## 2. R2 key contract (`DEC-03`, section 4.1)

```text
moeicons/website/v1/releases/<version>/release.json
moeicons/website/v1/releases/<version>/free/catalog.json
moeicons/website/v1/releases/<version>/pro/catalog.json
moeicons/website/v1/releases/<version>/<tier>/snippets/<styleGroupId>/<iconId>.json
moeicons/website/v1/releases/<version>/<tier>/assets/<resourceVariantId>/<iconId>.<format>
moeicons/website/v1/releases/<version>/<tier>/indexes/<styleGroupId>/search.json
moeicons/website/v1/index/activations/<websiteActivationId>.json
moeicons/website/v1/index/active.json
```

- SVG: `resourceVariantId == styleGroupId`, `format=svg`. Bitmap: full canonical
  `resourceVariantId` (`<styleGroupId>-<imageSize>-<format>`).
- `release.json` lists every sub-object's `key`, `tier`, `mediaType`, `size`,
  `sha256`, sorted by `key` (byte order). It **never** contains an activationId.
- No object may appear in both Free and Pro-only sets. A shared Free group may
  appear in the Pro catalog only with byte-identical contents.
- Production source bucket gains `.../<version>/<tier>/website/moe-icons-<tier>-website-<version>.tgz`
  (descriptor v3). The website delivery bucket stores only the unpacked,
  manifest-whitelisted objects, never the tgz.

## 3. `website-catalog-v1`

Per-tier, activation-neutral. Exact shape in `website-catalog-v1.schema.json`.
Required: `schemaVersion:1`, `resourceVersion`, `tier`, `styleGroups[]`, `icons[]`.

- `styleGroups[]`: `id`, `label`, `order`, `mediaType` (`vector|bitmap`), `tiers`,
  `previewVariantId`, `variants[]` (`id`, `format`, `imageSize`).
- `icons[]`: `id`, `label`, `aliases[]`, `keywords[]`, `categories[]`,
  `styleGroupIds[]`, `targets[]` (`react|vue|vanilla|assets`).
- `categories[]` is required in the projection catalog; missing categories are
  filled by the code-library builder from icon-id prefixes, never at runtime.
- Free catalog serialized text must contain no Pro-only style group, variant,
  key, icon metadata or snippet.
- `previewVariantId` is written by the projection builder per `DEC-22`
  (bitmap logical group: prefer `moe-3d-metal-128-webp`; C1/C2 may express
  "preview unavailable").
- For one logical style group, all variants must carry an identical icon set.

## 4. `website-release-v1`

`<version>/release.json` is the object manifest and identity binder. Exact shape
in `website-release-v1.schema.json`:
`schemaVersion`, `resourceVersion`, `sourceCommit`, `generatorCommit`,
`privateDescriptorSha256`, `publicDescriptorSha256`, `objects[]`. The API-facing
`releaseSha256` is the SHA-256 of the canonical `release.json` bytes; it is not a
field inside the file.

## 5. `website-activation-receipt-v1`

Exact shape in `website-activation-receipt-v1.schema.json`. Required:
`schemaVersion`, `websiteActivationId` (`wact-<64hex>`),
`previousWebsiteActivationId` (`wact-<64hex>|null`), `productionActivationId`
(`act-<64hex>`), `resourceVersion`, `sourceCommit`, `generatorCommit`,
`privateDescriptorSha256`, `publicDescriptorSha256`, `websiteReleaseSha256`,
`websiteBucketIdentityId`, `objectCount`, `totalBytes`, `workflow`
(`repository/workflowPath/runId/runAttempt/headSha`), `createdAt`.

- Stored as a GitHub Actions artifact, written to the job summary, and the same
  canonical SHA + necessary fields persisted in D1.
- Never contains bucket names, object-key lists, tokens or signed URL query.

## 6. Worker API (`section 5`)

Identity layering: `groups` returns current `resourceVersion + releaseSha256 +
websiteActivationId`; versioned icons/detail/snippet return
`resourceVersion + releaseSha256` (they do not claim a historical immutable
release is still the current activation); asset responses carry
`ETag / X-Moeicons-Resource-Version / X-Moeicons-Release-Sha256`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/website-icons/groups` | anonymous | current activation's Free groups + Pro-only minimal locked metadata |
| `GET /v1/website-icons/<version>/icons?styleGroupId=&categoryId=&q=&cursor=&limit=` | Free / Pro bearer | paged style group, query-scoped category aggregate, icon summaries |
| `GET /v1/website-icons/<version>/icons/<styleGroupId>/<iconId>` | same tier | single-icon detail + variants/targets (no R2 key) |
| `GET /v1/website-icons/<version>/assets/<styleGroupId>/<variantId>/<iconId>` | Free Origin / Pro bearer | versioned streaming preview/download; `download=1` only affects Content-Disposition |
| `GET /v1/website-icons/<version>/snippets/<styleGroupId>/<iconId>?target=` | same tier | frozen snippet; bitmap Vanilla → 409 `TARGET_UNSUPPORTED` |
| `GET /v1/account/entitlement` | bearer | minimal tier/status snapshot |
| `GET /v1/account/profile` | bearer+Pro | minimal Pro profile |
| `GET /v1/account/orders` | bearer+Pro | JWT-subject-owned orders only |
| `POST /v1/account/subscription/cancel` | bearer+Pro | server resolves subscription by subject |

`icons` success body (frozen):
`{ok:true,resourceVersion,releaseSha256,styleGroupId,categoryId,query,items,total,categoryCounts,nextCursor}`.
`items.length<=limit`, unique icon ids; `total` is the style+normalized-query+
category intersection; `categoryCounts` is stable-ordered and begins with
`{categoryId:"all",count:<style+query total>}`; `nextCursor` is string|null; empty
results are `200` with empty `items` and exact counts.

Error codes: `AUTH_REQUIRED(401)`, `TOKEN_INVALID(401)`, `PRO_REQUIRED(403)`,
`ORIGIN_DENIED(403)`, `NOT_FOUND(404)`, `TARGET_UNSUPPORTED(409)`,
`VERSION_CHANGED(409)`, `RATE_LIMITED(429)`, `UPSTREAM_UNAVAILABLE(503)`.
Authorize before catalog lookup; never enumerate Pro icons via 404 or size.
`429`/`503` carry integer-second `Retry-After` in `1..900`.

### 6.1 Examples

`GET /v1/website-icons/groups` (anonymous):

```json
{
  "ok": true,
  "resourceVersion": "0.0.18",
  "releaseSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "websiteActivationId": "wact-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "groups": [
    { "id": "moe-outline", "label": "Moe Outline", "order": 0, "mediaType": "vector", "tiers": ["free", "pro"], "locked": false, "previewVariantId": "moe-outline", "variants": [{ "id": "moe-outline", "format": "svg", "imageSize": null }] },
    { "id": "moe-3d-metal", "label": "Moe 3D Metal", "order": 100, "mediaType": "bitmap", "tiers": ["pro"], "locked": true, "previewVariantId": "moe-3d-metal-128-webp", "variants": [] }
  ]
}
```

`GET /v1/website-icons/0.0.18/icons?styleGroupId=moe-outline&categoryId=all&q=&limit=60`:

```json
{
  "ok": true,
  "resourceVersion": "0.0.18",
  "releaseSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "styleGroupId": "moe-outline",
  "categoryId": "all",
  "query": "",
  "items": [{ "id": "ui-search", "label": "UI Search", "categories": ["ui"], "styleGroupIds": ["moe-outline"] }],
  "total": 1,
  "categoryCounts": [{ "categoryId": "all", "count": 1 }, { "categoryId": "ui", "count": 1 }],
  "nextCursor": null
}
```

Error body:

```json
{ "ok": false, "code": "PRO_REQUIRED", "message": "pro entitlement required", "requestId": "req-abc" }
```

`download=1` asset response headers (frozen, `DEC-63`):

```text
Content-Type: image/webp
X-Moeicons-Resource-Version: 0.0.18
X-Moeicons-Release-Sha256: 0123...cdef
Content-Disposition: attachment; filename="ui-search__moe-3d-metal-128-webp.webp"
Cache-Control: private, no-store        # Pro; Free uses versioned immutable public caching
Vary: Origin, Authorization
```

## 7. Caching and CORS (`DEC-30/31/41`)

- New website/account requests require an exact Origin from
  `WEBSITE_ALLOWED_ORIGINS` plus `X-Moeicons-Website: 1`; Pro additionally a
  bearer. No Origin/`null`/suffix match is rejected. CORS never `*`/credentials.
- Free versioned assets may be publicly cached (`caches.default` after the gate)
  with a cache key including normalized Origin, `X-Moeicons-Website` presence and
  full asset identity. Pro responses are `Cache-Control: private, no-store`.
- All responses `Vary: Origin`; Pro also `Vary: Authorization`. Cache keys must
  include version/tier/styleGroup/variant/icon identity.

## 8. Version compatibility

- release descriptor: v1/v2 read historical versions but never trigger website
  projection; v3 adds the required per-tier `website` archive (`DEC-34`).
- website archive contents (`DEC-35`): `website/catalog.json`,
  `website/snippets/**`, `website/assets/**`, `website/indexes/**`,
  `website/manifest.json`, each byte-bound by SHA to the same build.
- Everything in the website archive/catalog/release manifest is
  activation-neutral; activationId lives only in D1/R2 activation projection,
  API envelope and receipt (`DEC-48`).
