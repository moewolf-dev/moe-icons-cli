# Changelog

## 0.0.49

### Supported platforms (first release candidate)

- Requires Node 24+ (`engines.node >= 24.0.0`). Officially tested: Linux x64 and macOS ARM64 on Node 24.
- **Windows is not certified** for this first release candidate (CLI-OPT-0827
  release exception). Package/bin/PATH behavior on Windows is unverified; do
  not treat Linux/macOS CI as Windows coverage. A dedicated Windows runner
  follow-up is required before claiming Windows support.

### Tooling

- Upgraded Vitest to 4.1.11 (Vite 8) so `npm audit` reports 0 vulnerabilities
  in both production and development dependency trees. Packed-install matrix
  tests use a 60s Vitest timeout to match cold `npm`/`pnpm` installs.

### Node.js support

The published CLI now requires **Node.js 24 or later**. Node 20 and 22 are no longer supported and do not receive security patches on this line, so they are not part of the supported product line. The `moeicons` bin checks the Node
major version before loading the ESM program and prints the current version,
the minimum version, and the LTS download URL instead of a `SyntaxError`.

Primary CI uses Node 24. Runtime APIs (`fetch`, ESM, AbortSignal, ES2022) and
runtime dependency engines (Commander `>=18`, others unconstrained) would have
allowed Node 18/20; the floor is a maintenance and security decision, not an
API requirement. We will not lower `engines` to recapture an EOL user base.
See https://nodejs.org/en/about/eol
