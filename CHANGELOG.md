# Changelog

## Unreleased

### Tooling

- Upgraded Vitest to 4.1.11 (Vite 8) so `npm audit` reports 0 vulnerabilities
  in both production and development dependency trees. Packed-install matrix
  tests use a 60s Vitest timeout to match cold `npm`/`pnpm` installs.

### Node.js support

The published CLI now requires **Node.js 22 or later**. Node 20 reached
end-of-life on 2026-03-24 and no longer receives security patches, so it is
not part of the supported product line. The `moeicons` bin checks the Node
major version before loading the ESM program and prints the current version,
the minimum version, and the LTS download URL instead of a `SyntaxError`.

Primary CI uses Node 24. Runtime APIs (`fetch`, ESM, AbortSignal, ES2022) and
runtime dependency engines (Commander `>=18`, others unconstrained) would have
allowed Node 18/20; the floor is a maintenance and security decision, not an
API requirement. We will not lower `engines` to recapture an EOL user base.
See https://nodejs.org/en/about/eol
