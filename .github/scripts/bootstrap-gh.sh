#!/usr/bin/env bash
set -euo pipefail
# Official fixed release + exact published asset SHA; no sudo or long-lived token.
version=2.102.0
sha=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_PATH:?}"
[[ "${RUNNER_OS:-Linux}" == Linux && "${RUNNER_ARCH:-X64}" == X64 ]]
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
work=$(mktemp -d "$RUNNER_TEMP/moe-gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-XXXXXX")
trap 'rm -rf -- "$work"' EXIT
asset="gh_${version}_linux_amd64.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  "https://github.com/cli/cli/releases/download/v${version}/${asset}" --output "$work/$asset"
printf '%s  %s\n' "$sha" "$work/$asset" | sha256sum --check --status
tar -xzf "$work/$asset" -C "$work"
bin="$RUNNER_TEMP/moe-gh-bin-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
mkdir -m 700 "$bin"
install -m 700 "$work/gh_${version}_linux_amd64/bin/gh" "$bin/gh"
"$bin/gh" --version
printf '%s\n' "$bin" >> "$GITHUB_PATH"
