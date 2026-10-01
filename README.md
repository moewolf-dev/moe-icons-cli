# moeicons

Public CLI for the Moeicons icon library. Installs icon style groups into your
project, manages login/tokens, generates React/Vue proxy components, syncs the
AI manual + icon catalog, and exposes an MCP server for AI clients.

## Commands

```text
moeicons                    interactive guided flow (free / pro / login)
moeicons install [group]    install an icon group (free | pro)
moeicons login              browser login (PKCE)
moeicons logout             clear local session
moeicons account            show account/tier info
moeicons groups             list available icon groups
moeicons generate           generate target-specific project files
moeicons init               create moeicons.config.json
moeicons update metadata    sync MANUAL.md/catalog.json/manifest.json only
moeicons update             full code + metadata update
moeicons mcp                start the MCP stdio server
moeicons --version          show version
moeicons --help             show help
```

## Requirements

Node.js **22 or later**. Node 20 reached end-of-life on 2026-03-24 and is not
on the supported line (no security patches). The CLI fails fast with an install
link instead of a `SyntaxError` if the runtime is too old.

Primary development and CI use Node 24. See https://nodejs.org/en/about/eol

**Platforms (first release candidate):** Linux x64 and macOS ARM64 are covered
by CI on Node 22/24. **Windows is not certified** yet (explicit release
exception); do not assume Windows package/bin/PATH works until a dedicated
runner validates it.

## Framework support

| Target | Current integration |
| --- | --- |
| Vite React / Vite Vue | Generated local proxies; use `init` → `install` → `generate` |
| Tailwind CSS 3 | Content glob added to a supported static config |
| Tailwind CSS 4 or no Tailwind | Core icon dimensions work without a Tailwind config rewrite |
| Next App Router / Nuxt | Manual integration; automatic root wrapping and production image behavior are not certified |
| Vanilla DOM | SVG factories and project runtime; bitmap style groups are unavailable |
| Windows | Not certified; use a tested macOS or Linux environment for release builds |

## First run

On the first interactive start inside a project, the CLI offers to install the
Free icon library plus its metadata (manual + catalog + manifest). The
completion marker lives in the cache directory and is only written after a
successful install; failures print a retry command and never suppress retry.

For a React or Vue project, the explicit path is:

```sh
npm install -D @moewolf/moe-icons-cli
npx moeicons init
npx moeicons install free
npx moeicons generate
```

Edit `moeicons.config.jsonc` before generating to select the icon IDs and
themes you need. When changing React/Vue/Vanilla/assets target, edit the config
first, then run `moeicons install free --target <target>` and `moeicons generate`.
For React/Vue, installation now keeps only the configured SVG component modules
and their required files in `.moeicons/artifact`. After adding icon IDs to the
config, run `moeicons install` again before `moeicons generate`; generate reports
the missing installed component if this step is skipped. New releases support
selected-resource downloads as well as full archives; `downloadMode` controls
this choice. Legacy releases without resource indexes still use a full archive
in `auto` mode. See Download modes and resource selection below.
Each theme may select a subset of the registered project icons:

```json
{
  "icons": ["ui-search", "arrow-bold-right"],
  "defaultTheme": "outline",
  "missingIconPolicy": "fallback",
  "themes": {
    "outline": { "styleGroup": "moe-outline", "icons": ["ui-search"] },
    "solid": { "styleGroup": "moe-solid", "icons": ["arrow-bold-right"] }
  }
}
```

Omitting a theme's `icons` selects all registered icons; `[]` selects none.
Fallback searches the requested theme, then the default theme, then configured
themes in ASCII name order. An unregistered icon or an icon unavailable in every
selected theme fails validation/generation. `error` requires each theme to have
every registered icon. Adding a selected variant requires installing again.

Transactions preserve a recovery journal with original bytes in
`.moeicons/.reconcile-backup-<id>/files`. After a process interruption, run `moeicons recover` at the project root
before rerunning the original command. It reclaims a lock only when its owner
process is dead, restores the previous state, and requires a fresh plan. If a file changed after the interruption, recovery stops and retains both
the user's file and the backups; compare them before restoring manually. A
completed transaction is identified by its commit marker and is never rolled
back because backup cleanup failed. Do not delete these directories to bypass
a recovery conflict. Recovery covers process termination, not power loss or a
hostile filesystem replacing directories during filesystem operations.

The installer rejects a target that disagrees with the config. Import generated
PascalCase components from your configured `outputDir` (default `src/moeicons`):

```tsx
import { ArrowBoldRight, MoeiconsProvider } from './moeicons';

export function App() {
  return <MoeiconsProvider><ArrowBoldRight size={37} aria-label="Next" /></MoeiconsProvider>;
}
```

Vue uses the same generated names and output directory. The CLI imports the
version-pinned code in `.moeicons/artifact`; `generate` requires a completed
`install`. After generation, install any dependencies reported by the CLI with
your package manager before type checking or building. Commit the config,
generated source, `.moeicons/artifact` and install metadata together if CI must
build without downloading the library. Treat all of them as one versioned set.

## Metadata

Installing or updating a tier writes `<project>/.moeicons/`:

```text
.moeicons/
├── MANUAL.md       # human/agent manual (generated by the builder)
├── catalog.json    # machine-queryable icon catalog (JSON only)
├── manifest.json   # schema, tier, versions, dependencies, digests
├── install-metadata.json
└── artifact/<target>/
```

`moeicons update metadata` re-downloads only the small metadata archive for the
installed code version and reconciles the three files, without touching the
code artifact.

## Pro resources

After an authenticated login (TTY) the CLI offers a one-time pre-download of the
full Pro code + metadata. If skipped, the authenticated home screen shows the
resource state and offers `Download / Update / Repair Pro resources`. Logging
out keeps cached archives but blocks new unauthenticated installs/updates.

## Security

- Tokens are stored in the OS keychain where available.
- API keys are never logged, written in plaintext, passed to subprocesses, or
  embedded in `.moeicons/manifest.json`.
- Installation is transactional: failures never corrupt an existing project.
- Downloads verify SHA-256 and size, never shell out to `unzip`/`tar`, enforce
  host allowlists and bounded redirects/timeouts, and never forward API
  credentials to signed asset hosts.
- Code and metadata archives must pass a manifest compatibility check
  (tier/version/digests); mismatches fail loudly instead of mixing tiers.

## Environment

| variable | purpose |
| --- | --- |
| `MOEICONS_CACHE_DIR` | global artifact/metadata cache (default `~/.moeicons/cache`) |
| `MOEICONS_FREE_RELEASE_DIR` | test-only free release fixture directory |
| `MOEICONS_BOOTSTRAP_FILE` | override bootstrap completion marker path |
| `MOEICONS_PRO_DESCRIPTOR_URL` | test-only Pro descriptor endpoint override (https or loopback http) |
| `MOEICONS_LIBRARY_VERSIONS_URL` | test-only library versions endpoint override (https or loopback http) |
| `MOEICONS_TOKEN_STORE_DIR` | 0600 file token store directory |
| `MOEICONS_DISABLE_SYSTEM_KEYCHAIN` | `1` disables OS keychain storage |
| `MOEICONS_AUTH0_ISSUER` / `MOEICONS_AUTH0_CLIENT_ID` | Auth0 refresh/revoke |

## Status

Metadata distribution (`MANUAL-DIST`) implemented: builder-generated manual,
catalog and manifest, per-tier archives and descriptors, Free bootstrap,
metadata-only sync, and authenticated Pro pre-download/update.

### Download modes and resource selection

Set `downloadMode` in `moeicons.config.json` (schemaVersion 3):

```json
{
  "schemaVersion": 3,
  "tier": "free",
  "target": "react",
  "outputDir": "src/icons",
  "downloadMode": "auto",
  "icons": ["ui-search", "arrow-bold-right"],
  "defaultTheme": "outline",
  "themes": {
    "outline": { "styleGroup": "moe-outline", "icons": ["ui-search"] },
    "solid": { "styleGroup": "moe-solid", "icons": ["arrow-bold-right"] }
  },
  "missingIconPolicy": "fallback"
}
```

- `auto` (default): selected resources when the fixed release advertises them. A legacy release without this capability uses the full archive and explains why.
- `icons`: require selected resources. Unsupported releases, authorization failures, bad ranges and invalid digests stop the operation; they never trigger a full archive download.
- `full`: download and verify the complete archive, then install the configured target/resources.

`icons` registers the allowed icon IDs. Install/update requires at least one global icon ID; an empty global list stops before version queries or downloads and preserves the existing installation. An individual theme may still use `icons: []`. A theme's `icons` restricts that theme to a subset; omitting it selects every registered ID available in the style group, and `[]` selects none. Fallback chooses the requested theme, then the default theme, then theme names in ASCII order. An icon with no selected variant fails validation. Bitmap themes also select `format` and `imageSize`; changing these fields may require new resources.

The CLI reads the release metadata before planning resources, so validation uses that release's catalog. It shows the target, registered icon/theme counts, required file count and compressed payload budget before reading the data object. Verified cache entries reduce traffic. `--json` reports `downloadMode`, `downloadNotes`, `selectedFiles` and `networkBytes` (resource payload only; descriptor/metadata/index traffic is separate).

Run `moeicons install free` or `moeicons install pro` after changing the selected icons, themes, bitmap format or size, then `moeicons generate`. `moeicons update` also reconciles the configuration when the release version is unchanged. Missing resources name the affected path and ask for reinstall; stale resources are removed only if still owned and unmodified. A configuration change during download stops before project writes; retry with the final configuration.

Generation works offline from the project's verified installed resources; `moeicons recover` also needs no network. Install/update still consult the fixed descriptor and metadata, and Pro checks current entitlement. A resource cache hit does not bypass authorization, and there is no offline install flag. Corrupt cache entries are rejected and fetched again online. Interrupted downloads retain only verified cache members; project files change in one recoverable transaction after all required resources have verified.

Version queries have a deadline covering both response headers and body, with bounded JSON sizes. Invalid or unavailable version responses make update fail explicitly. Cache cleanup preserves staging files owned by a live process; disk-full and permission failures report actionable errors.
