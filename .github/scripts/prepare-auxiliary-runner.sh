#!/usr/bin/env bash
set -euo pipefail
# Job-local tools from authenticated Ubuntu metadata and a checksum-pinned
# official GitHub CLI release. No sudo or primary-runner changes are required.
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_PATH:?}"
for tool in git curl tar sha256sum python3; do
  command -v "$tool" >/dev/null || { echo "Missing auxiliary prerequisite: $tool" >&2; exit 1; }
done
if ! command -v unzip >/dev/null; then
  command -v apt-get >/dev/null && command -v dpkg-deb >/dev/null || {
    echo 'Install unzip or provide apt-get and dpkg-deb for job-local extraction' >&2; exit 1;
  }
  work=$(mktemp -d "$RUNNER_TEMP/moe-unzip-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-XXXXXX")
  # apt-get validates the download against the configured signed APT metadata.
  (cd "$work" && apt-get download unzip)
  packages=("$work"/unzip_*.deb)
  [ "${#packages[@]}" = 1 ] && [ -f "${packages[0]}" ]
  dpkg-deb -x "${packages[0]}" "$work/root"
  "$work/root/usr/bin/unzip" -v >/dev/null
  printf '%s\n' "$work/root/usr/bin" >> "$GITHUB_PATH"
  export PATH="$work/root/usr/bin:$PATH"
fi
if ! command -v gh >/dev/null; then
  bash .github/scripts/bootstrap-gh.sh
  export PATH="$RUNNER_TEMP/moe-gh-bin-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}:$PATH"
fi
for tool in unzip gh; do command -v "$tool" >/dev/null; done
