#!/usr/bin/env bash
# Generated from infra/install.sh.in and package.json; run pnpm cli:build.
set -Eeuo pipefail

TOWBAR_REPOSITORY="avgeek-oss/towbar"
TOWBAR_RELEASES_URL="https://github.com/$TOWBAR_REPOSITORY/releases"
INSTALLER_VERSION="v2.0.51"
TOWBAR_BIN="${TOWBAR_BIN:-/usr/local/bin/towbar}"

fail() {
  printf 'Towbar installer: %s\n' "$*" >&2
  exit 1
}

((EUID == 0)) || fail "run this installer as root"
[[ "$(uname -s)" == Linux ]] || fail "Towbar installation supports Linux hosts"
command -v curl >/dev/null || fail "curl is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"

temporary_dir="$(mktemp -d)"
cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT
download_artifact() {
  local name="$1" output="$2"
  if [[ "${TOWBAR_RELEASE_SMOKE:-false}" == true && -n "${TOWBAR_RELEASE_DIRECTORY:-}" ]]; then
    cp "$TOWBAR_RELEASE_DIRECTORY/$name" "$output"
  else
    curl --fail --silent --show-error --location --retry 4 --retry-all-errors \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "$TOWBAR_RELEASES_URL/download/$INSTALLER_VERSION/$name" --output "$output"
  fi
}
download_artifact SHA256SUMS "$temporary_dir/SHA256SUMS"
expected="$(awk '$2 == "towbar" && $1 ~ /^[a-f0-9]+$/ && length($1) == 64 { print $1 }' "$temporary_dir/SHA256SUMS")"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail "release does not contain a CLI checksum"
download_artifact towbar "$temporary_dir/towbar"
printf '%s  %s\n' "$expected" "$temporary_dir/towbar" | sha256sum --check --status || fail "CLI checksum verification failed"
bash -n "$temporary_dir/towbar"
install -o root -g root -m 0755 "$temporary_dir/towbar" "$TOWBAR_BIN"
trap - EXIT
cleanup

if [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
  exec env TOWBAR_REPOSITORY="$TOWBAR_REPOSITORY" TOWBAR_BIN="$TOWBAR_BIN" \
    "$TOWBAR_BIN" install </dev/tty
fi
exec env TOWBAR_NON_INTERACTIVE=1 TOWBAR_REPOSITORY="$TOWBAR_REPOSITORY" TOWBAR_BIN="$TOWBAR_BIN" \
  "$TOWBAR_BIN" install
