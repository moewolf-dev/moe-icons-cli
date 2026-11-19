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
moeicons generate           generate target-specific project files
moeicons doctor              diagnose project configuration/integration (read-only)
moeicons doctor --check      exit non-zero when a required anchor is not OK
moeicons doctor --export-diagnostics
                             write a short-lived local redacted diagnostic bundle
moeicons recover            recover an interrupted transaction
moeicons init               create moeicons.config.jsonc
moeicons update metadata    sync metadata for supported legacy installs
moeicons update             update the installed Free or Pro package set
moeicons mcp                start the MCP stdio server
moeicons --version          show version
moeicons --help             show help
```

## Requirements

Node.js **24 or later** (`engines.node >= 24.0.0`). Node 20 and 22 are not on
the supported line and no longer receive security patches. The zero-dependency
`bin/check-node.cjs` wrapper fails *before* importing `dist/`, prints the current
version, the `>=24` requirement, the official download page and (only when a
version manager is actually detected) its upgrade command. It never throws a
bare `SyntaxError`.

```sh
node -v            # expect v24.x or later
moeicons --version # verify after reopening the terminal
```

Primary development, CI, packaging and release use Node 24. The VS Code
extension is a separate runtime: its Extension Host is managed by VS Code and
does not require users to install Node 24. See https://nodejs.org/en/about/eol

**Platforms (current round):** macOS arm64 is the executed development/test
environment. Linux x64 and Windows x64 workflows are configured for Node 24, but
this round did not run those hosts; Windows interactive resize/PTY remains
unverified. Do not read CI configuration as a passed platform test.

## Install and upgrade

Fresh install (global):

```sh
npm install --global @moewolf/moe-icons-cli@latest
moeicons --version
```

Project-local (recommended when the project pins the CLI):

```sh
npm install --save-exact --save-dev @moewolf/moe-icons-cli@latest
npx moeicons --version
```

pnpm / yarn equivalents:

```sh
pnpm add --save-exact -D @moewolf/moe-icons-cli@latest
yarn add --exact -D @moewolf/moe-icons-cli@latest
```

Upgrade behaviour:

- The CLI checks **npm metadata** (the executable-install truth) and, independently,
  the GitHub Release feed. It never merges the two into one version number.
- When npm has a newer stable version, the interactive TUI shows the current
  version and the exact command for the detected install source (npm/pnpm/yarn,
  local/global/npx). When only GitHub has a newer release, it says so and links
  to the documentation; it does not claim `npm` can already upgrade.
- When the install source is unknown, only the documentation link is shown —
  the CLI never guesses a package manager.
- The CLI never replaces its own executable and never writes an update log.
  Checks are suppressed for JSON/non-TTY/CI and have bounded timeouts and an
  in-process 5-minute cache.
- `moeicons update` updates **icon resources**, not the CLI executable.

Rollback: install the previous exact version again
(`npm install --global @moewolf/moe-icons-cli@<previous>`), then run
`moeicons doctor` to confirm the project still matches its installed resources.

## Interaction, accessibility and machine output

- `--json`: machine output only; no banner, spinner or update notice. Existing
  `ok/code/message` error fields remain stable; `--debug` adds `operationId`.
- `--yes`: skip confirmations in non-interactive mode. Without it, a non-TTY
  confirmation fails with an actionable `NOT_TTY` error instead of waiting.
- `--accessible` (or `MOEICONS_ACCESSIBLE=1`): static numbered input with plain
  line editing: multi-digit numbers, `0` to cancel, `[Y/n]` confirmations, no
  animation and no raw mode. Useful for screen readers and limited terminals.
- `NO_COLOR`, `TERM=dumb` and `MOEICONS_ASCII=1` disable colour/Unicode without
  changing navigation.
- `--debug` writes redacted diagnostic events to stderr; it never creates a log
  file, never writes to stdout, and never changes the exit code.

Exit codes: `0` success/cancel, `1` validation, `2` auth, `3` network,
`4` not found, `5` unexpected/disk.

## Troubleshooting and diagnostics

1. `moeicons doctor` — read-only four-anchor project diagnosis (manifest,
   config, application, styling); project-relative paths only.
2. `moeicons doctor --check` — exit 1 when a required anchor is not OK.
3. `moeicons --debug <command>` — one-line error plus redacted phase/code events
   on stderr.
4. `moeicons doctor --export-diagnostics [--json]` — writes one local text
   bundle (no network). Limits: ≤1 MiB per bundle; ≤5 files / ≤5 MiB per
   directory; 24-hour expiry; stale bundles are pruned on the next start.
   Content: Node/OS/arch/shell/TTY/CI, CLI version and install source, package
   manager/lockfile, four anchors, config fields and the last 20 redacted
   events. It never contains tokens, e-mail addresses, signed URLs, response
   bodies, request headers or absolute home paths.

Network failures never block a business command: the version notice degrades to
"unavailable" for the affected source only. A 429/5xx or transient connection
error during a resource download is retried a bounded number of times; 401/403,
404, checksum/size failures and cancellation are not retried.

Downloads use a single process-wide scheduler with a hard ceiling of **3 active
resource-package requests**. A completed slot immediately starts the next queued
item; retries and backoff do not hold a slot. Metadata requests use a separate
bounded pool. Large archives stream to a verified temporary file with an
incremental SHA-256 and are extracted from that file; only small metadata stays
in memory. Successful cache writes are atomic and only after verification.

## Framework support

| Target | Current integration |
| --- | --- |
| Vite React / Vite Vue | Generated local proxies; use `init` → `install` → `generate` |
| Tailwind CSS 3 | Content glob added to a supported static config |
| Tailwind CSS 4 or no Tailwind | Core icon dimensions work without a Tailwind config rewrite |
| Next App Router / Nuxt SSR | Generated local components verified with single/multiple themes, production server rendering and browser hydration |
| Vanilla DOM | SVG factories and project runtime; bitmap style groups are unavailable |
| Windows x64 | Free React/Vue core flow verified on Node 24 with npm/pnpm |

Next Pages Router and custom Nuxt modules require their own integration checks.
Custom bootstrap shapes can require manual Provider placement; `doctor --check`
reports unsupported integration shapes.

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
the missing installed component if this step is skipped. Published releases
must provide bounded selected packages. A legacy descriptor without the new
package-set contract is rejected; the CLI never downloads a complete tier
archive as a fallback. See Download modes and resource selection below.
In this branch, Free and Pro installs resolve their stable package-set identity, verify the root and pages, then download only the selected package closure before the transactional install. Pro requests use the logged-in access token; the Worker checks current entitlement on identity, root, page, and package requests. Pro package cache files are private to the current OS user. `moeicons update` compares the installed package-set identity with the tier's Worker stable pointer and pins the exact set before reconciling files. `moeicons update metadata` refreshes only the selected metadata packages for the exact installed package-set, verifies the installed selection still matches the project config, and transactionally restores the derived catalog without fetching code or icon packages. The global Pro preview warm-up also uses separately addressed packages from the current package set. These changes are local to this branch; the Worker and CLI have not been deployed or published.

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

`moeicons update metadata` refreshes metadata for a pinned package-set install
by reading only its selected scoped metadata packages. Legacy installs continue
to use their version-pinned metadata archive. Neither path changes the installed
code or resource package selection.

## Pro resources

Project-level Pro installation uses authenticated, selected package sets and
does not require pre-downloading the full Pro library. The separate global
`Warm default Pro previews` action downloads only the current package set's
separately addressed 128-WebP bitmap tuple packages, after showing their total
compressed size and asking for confirmation. It does not pre-download a Pro
code archive. Project installs continue to fetch only their configured package
closure. Logging out keeps cached objects but blocks new package-set installs,
updates, and Pro preview warm-ups.

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
| `MOEICONS_TOKEN_STORE_DIR` | explicit file token store directory (with disabled keychain) |
| `MOEICONS_STATE_DIR` | session storage preference directory (default `~/.moeicons`) |
| `MOEICONS_DISABLE_SYSTEM_KEYCHAIN` | `1` disables OS keychain storage |
| `MOEICONS_AUTH0_ISSUER` / `MOEICONS_AUTH0_CLIENT_ID` | explicit Auth0 refresh/revoke overrides; official production defaults are bundled |
| `NO_COLOR` / `TERM=dumb` | disable brand colour and Unicode decorations |
| `MOEICONS_ACCESSIBLE` / `MOEICONS_STATIC` | static numbered input, no animation (same as `--accessible`) |
| `MOEICONS_ASCII` | force ASCII symbols |
| `MOEICONS_GITHUB_RELEASES_URL` | test-only GitHub releases endpoint override (https or loopback http) |

## Status

Metadata distribution (`MANUAL-DIST`) implemented: builder-generated manual,
catalog and manifest, per-tier archives and descriptors, Free bootstrap,
metadata-only sync, and authenticated Pro package-set install/update and
bounded preview warm-up.

### Download modes and resource selection

Set `downloadMode` in `moeicons.config.jsonc` (schemaVersion 3):

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

- `auto` (default): resolve only the fixed release's selected package set. A legacy descriptor without that contract fails before resource transfer.
- `icons`: require selected packages. Unsupported releases, authorization failures, invalid package identities and bad digests stop the operation; they never trigger a full archive download.
- `full`: retained only for explicit local `-test` fixtures. Published releases reject this mode because tier-wide archives are retired.

`icons` registers the allowed icon IDs. Install/update requires at least one global icon ID; an empty global list stops before version queries or downloads and preserves the existing installation. An individual theme may still use `icons: []`. A theme's `icons` restricts that theme to a subset; omitting it selects every registered ID available in the style group, and `[]` selects none. Fallback chooses the requested theme, then the default theme, then theme names in ASCII order. An icon with no selected variant fails validation. Bitmap themes also select `format` and `imageSize`; changing these fields may require new resources.

For package-set installs, the CLI reads the Worker identity and candidate root/pages before planning resources, so validation uses that candidate's catalog. It shows the target, registered icon/theme counts, required file count and compressed payload budget before reading selected package objects. Verified cache entries reduce traffic. `--json` reports `downloadMode`, `downloadNotes`, `selectedFiles` and `networkBytes` (resource payload only; identity and metadata traffic is separate).

Run `moeicons install free` or `moeicons install pro` after changing the selected icons, themes, bitmap format or size, then `moeicons generate`. `moeicons update` also reconciles the configuration when the release version is unchanged. Missing resources name the affected path and ask for reinstall; stale resources are removed only if still owned and unmodified. A configuration change during download stops before project writes; retry with the final configuration.

Generation works offline from the project's verified installed resources; `moeicons recover` also needs no network. Package-set installs and updates pin a verified tier candidate; every Pro identity and payload read checks current entitlement. A resource cache hit does not bypass the authenticated stable identity check, and there is no offline install flag. Corrupt cache entries are rejected and fetched again online. Interrupted downloads retain only verified cache members; project files change in one recoverable transaction after all required resources have verified.

Version queries have a deadline covering both response headers and body, with bounded JSON sizes. Invalid or unavailable version responses make update fail explicitly. Cache cleanup preserves staging files owned by a live process; disk-full and permission failures report actionable errors.

## MCP project integration

Run `moeicons mcp` in the project root containing `package.json`. Use a fixed,
installed CLI executable in your MCP client's command configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/node_modules/@moewolf/moe-icons-cli/bin/moeicons.js", "mcp"],
  "cwd": "/absolute/path/to/your/project"
}
```

The client must support a working directory for subprocesses. The server uses
stdio and needs no port. Log in with `moeicons login` outside the MCP server;
never place credentials in client configuration or browser source code.

Use `init_config` (explicit `target: "vue"` for mixed-framework projects), then
`get_project_config` to obtain the current config hash. `list_icon_groups` and
`find_icons` expose installed, verified catalog data when available; bundled
results are identified separately. Call `update_config` with `expectedHash` and
an explicit patch, `install` with the configured tier, then `generate`.
`update` updates icon resources, not the CLI executable. Changes to selection
require resource reconciliation before generation. Read `get_usage_guide` and
the installed manual before editing application code.

For example, add or remove selections without replacing the whole config:

```json
{
  "expectedHash": "<hash from get_project_config>",
  "patch": {
    "icons": { "add": ["dashboard"], "remove": ["weather-sun"] }
  },
  "dryRun": true
}
```

Review the dry-run diff, then call with `dryRun: false`. If the config changed,
read it again and revise the patch. Generated files are owned by the generator:
import their named exports rather than editing them. Install the runtime
`clsx` and a `tailwind-merge` version compatible with your Tailwind version.
For Vue, put `MoeiconsProvider` around all consuming components and bind its
`theme` to an exact configured theme key. Give decorative icons `aria-hidden`
and bitmap icons empty `alt`; icon-only controls require accessible labels.
Custom application bootstrap can require manual Provider placement; doctor
reports unsupported shapes rather than certifying them automatically.

Available tools: `list_icon_groups`, `get_account`, `get_project_config`,
`find_icons`, `get_usage_guide`, `init_config`, `update_config`, `install`,
`update`, and `generate`. The legacy `install_icon_group` tool remains an
explicit unsupported operation with migration guidance. Tool failures use
`isError`; malformed protocol arguments use JSON-RPC errors. The server binds
all operations to one project root and does not expose arbitrary shell commands.

### Session storage and refresh

When native credential storage is unavailable and you approve a file store,
the CLI remembers that selection in `session-store.json` (no credentials).
Later CLI processes and the VS Code extension use the same selection. Credential
store errors are reported, not silently replaced by an old fallback session.
Log out before switching storage methods. Official production refresh uses the
existing public Auth0 configuration; custom/local environments must provide
matching issuer and client ID. Account and refresh requests have a deadline
covering headers and body. Revoked refresh credentials require a new login.
Overlapping CLI processes coordinate refreshes and reuse the same renewed
session. A cancelled waiter does not cancel the refresh owned by another process.
After a process is forcibly stopped during refresh, a remaining
`session-refresh.lock` in the selected store directory (or the CLI state directory
for native credentials) reports an error. Confirm the PID in its `owner.json`
has stopped before removing that lock directory and retrying.

The VS Code extension reads credentials on its own host. For Remote SSH, WSL
or a container, run the CLI login on that host; local credentials are not copied.

### Independent CLI release and plugin recovery

A successful canonical publish triggers `plugin-update.yml`. It verifies the
published receipt and resource pin, sends a metadata-only CLI event and waits
for Marketplace verification. `PLUGIN_DISPATCH_TOKEN` must be configured in this
repository with Contents write for `moe-icons-plugins`. A failed notification is
replayed with `publish_run_id` in that workflow (and `published_version`
for the durable Release receipt after Actions artifact expiry), without republishing the CLI or
rebuilding resources. Temporary Actions receipts have a retention period; new
releases also retain a canonical receipt on their immutable GitHub Release.
