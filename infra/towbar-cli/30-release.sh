download_release_artifact() {
  local version="$1" name="$2" output="${3:-}"
  if [[ "${TOWBAR_RELEASE_SMOKE:-false}" == true && -n "${TOWBAR_RELEASE_DIRECTORY:-}" ]]; then
    if [[ -n "$output" ]]; then
      cp "$TOWBAR_RELEASE_DIRECTORY/$name" "$output"
    else
      cat "$TOWBAR_RELEASE_DIRECTORY/$name"
    fi
  else
    set --
    if [[ -n "$output" ]]; then set -- --output "$output"; fi
    curl --fail --silent --show-error --location --retry 4 --retry-all-errors \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "$TOWBAR_RELEASES_URL/download/$version/$name" "$@"
  fi
}

fetch_release_manifest() {
  download_release_artifact "$1" release.json
}

resolve_latest_version() {
  local version
  version="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "$TOWBAR_RELEASES_API_URL/latest" | jq -er 'select(.draft == false and .prerelease == false) | .tag_name')"
  validate_version "$version"
  printf '%s\n' "$version"
}

verify_release() {
  local version="$1" candidate=false
  if [[ "${TOWBAR_RELEASE_SMOKE:-false}" == true && -n "${TOWBAR_RELEASE_DIRECTORY:-}" ]]; then
    candidate=true
  else
    if ! curl --fail --silent --show-error --location --retry 4 --retry-all-errors \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "$TOWBAR_RELEASES_API_URL/tags/$version" | jq -e --arg version "$version" \
      '.tag_name == $version and .draft == false and .prerelease == false' >/dev/null; then
      fail "$version is not a published stable GitHub release"
    fi
  fi
  if ! fetch_release_manifest "$version" | jq -e --arg version "$version" \
    --argjson candidate "$candidate" \
    '.schemaVersion == 1 and .version == $version and (.validated == true or $candidate == true) and (.commit | test("^[0-9a-f]{40}$"))' >/dev/null; then
    fail "$version is not a validated stable release"
  fi
}

resolve_release_commit() {
  local version="$1" commit
  commit="$(fetch_release_manifest "$version" | jq -er .commit)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve $version to a commit"
  printf '%s\n' "$commit"
}

metadata_value() {
  local release_dir="$1" key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' \
    "$release_dir/.towbar-release"
}

download_release() {
  local version="$1" commit="$2" release_dir staging archive source_dir package_version
  local image_manifest image_prefix release_manifest artifact expected
  release_dir="$RELEASES_DIR/$version"
  if [[ -d "$release_dir" ]]; then
    [[ -f "$release_dir/.towbar-release" ]] ||
      fail "$release_dir exists without Towbar release metadata"
    [[ "$(metadata_value "$release_dir" COMMIT)" == "$commit" ]] ||
      fail "$release_dir does not match the published release commit"
    printf '%s\n' "$release_dir"
    return
  fi

  install -d -m 0755 "$RELEASES_DIR"
  staging="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")"
  archive="$staging/source.tar.gz"
  release_manifest="$staging/release.json"
  image_manifest="$staging/towbar-images.json"
  cleanup_download() {
    rm -rf "$staging"
  }
  trap cleanup_download EXIT

  log "Downloading $version at immutable commit $commit" >&2
  fetch_release_manifest "$version" >"$release_manifest"
  jq -e --arg version "$version" --arg commit "$commit" \
    '.version == $version and .commit == $commit' "$release_manifest" >/dev/null || fail "release identity changed during download"
  for artifact in source.tar.gz towbar-images.json; do
    expected="$(jq -er --arg artifact "$artifact" '.artifacts[$artifact]' "$release_manifest")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail "release is missing the $artifact checksum"
    download_release_artifact "$version" "$artifact" "$staging/$artifact"
    printf '%s  %s\n' "$expected" "$staging/$artifact" | sha256sum --check --status || fail "$artifact checksum verification failed"
  done

  if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    fail "release archive contains an unsafe path"
  fi
  tar -xzf "$archive" -C "$staging"
  source_dir="$(find "$staging" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$source_dir" ]] || fail "release archive did not contain a source directory"
  [[ -f "$source_dir/docker-compose.yml" && -f "$source_dir/infra/runtime_config.py" && -f "$source_dir/infra/towbar" ]] ||
    fail "release archive is missing Towbar installation files"

  package_version="$(jq -r .version "$source_dir/package.json")"
  [[ "$package_version" == "${version#v}" ]] ||
    fail "$version contains package version $package_version"
  image_prefix="$TOWBAR_IMAGE_REGISTRY"
  # Release rehearsals install locally built images from a throwaway registry.
  if [[ "${TOWBAR_RELEASE_SMOKE:-false}" == true && -n "${TOWBAR_RELEASE_SMOKE_REGISTRY:-}" ]]; then
    image_prefix="$TOWBAR_RELEASE_SMOKE_REGISTRY"
  fi
  jq -e \
    --arg version "$version" \
    --arg commit "$commit" \
    --arg api "$image_prefix/towbar-api@" \
    --arg worker "$image_prefix/towbar-worker@" \
    --arg web "$image_prefix/towbar-web-app@" \
    '.version == $version and .commit == $commit and
      (.images | keys == ["api", "web-app", "worker"]) and
      (.images.api | startswith($api) and test("@sha256:[0-9a-f]{64}$")) and
      (.images.worker | startswith($worker) and test("@sha256:[0-9a-f]{64}$")) and
      (.images["web-app"] | startswith($web) and test("@sha256:[0-9a-f]{64}$"))' \
    "$image_manifest" >/dev/null ||
    fail "$version does not contain a valid immutable image manifest"
  cat >"$source_dir/.towbar-release" <<EOF
VERSION=$version
COMMIT=$commit
REPOSITORY=$TOWBAR_REPOSITORY
API_IMAGE=$(jq -r '.images.api' "$image_manifest")
WORKER_IMAGE=$(jq -r '.images.worker' "$image_manifest")
WEB_APP_IMAGE=$(jq -r '.images["web-app"]' "$image_manifest")
EOF
  mv "$source_dir" "$release_dir"
  trap - EXIT
  cleanup_download
  printf '%s\n' "$release_dir"
}

generate_config() {
  local release_dir="$1"
  CONFIG_CREATED=false
  [[ ! -e "$TOWBAR_ENV_FILE" && ! -e "$TOWBAR_YAML_FILE" && ! -e "$TOWBAR_LEGACY_YAML_FILE" ]] || return 0

  install -d -m 0700 "$TOWBAR_CONFIG_DIR"
  ensure_yaml_tooling
  python3 "$(config_helper_for "$release_dir")" init --yaml "$TOWBAR_YAML_FILE"
  CONFIG_CREATED=true
  log "Generated installation secrets"
}
