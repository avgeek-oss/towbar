compose_for() {
  local release_dir="$1" commit="$2" env_file="$3" compose_profiles
  local api_image worker_image web_app_image
  shift 3
  compose_profiles="$(env_value "$env_file" COMPOSE_PROFILES)"
  api_image="$(metadata_value "$release_dir" API_IMAGE)"
  worker_image="$(metadata_value "$release_dir" WORKER_IMAGE)"
  web_app_image="$(metadata_value "$release_dir" WEB_APP_IMAGE)"
  TOWBAR_IMAGE_TAG="$commit" \
    TOWBAR_API_IMAGE="$api_image" \
    TOWBAR_WORKER_IMAGE="$worker_image" \
    TOWBAR_WEB_APP_IMAGE="$web_app_image" \
    SOURCE_COMMIT="$commit" \
    COMPOSE_PROFILES="${compose_profiles:-local}" \
    docker compose \
      --env-file "$env_file" \
      --project-directory "$release_dir" \
      --file "$release_dir/docker-compose.yml" \
      "$@"
}

gateway_service_for() {
  local env_file="$1" install_mode
  install_mode="$(env_value "$env_file" TOWBAR_INSTALL_MODE)"
  if [[ "$install_mode" == public ]]; then
    printf 'gateway-public\n'
  else
    printf 'gateway\n'
  fi
}

validate_config_for() {
  local release_dir="$1" env_file="${2:-$TOWBAR_ENV_FILE}" commit install_mode profiles domain api_domain app_url api_url bind_address port api_port
  [[ -f "$env_file" ]] || fail "$env_file is missing"
  install_mode="$(env_value "$env_file" TOWBAR_INSTALL_MODE)"
  profiles="$(env_value "$env_file" COMPOSE_PROFILES)"
  domain="$(env_value "$env_file" TOWBAR_GATEWAY_DOMAIN)"
  api_domain="$(env_value "$env_file" TOWBAR_GATEWAY_API_DOMAIN)"
  app_url="$(env_value "$env_file" TOWBAR_APP_BASE_URL)"
  api_url="$(env_value "$env_file" TOWBAR_API_BASE_URL)"
  bind_address="$(env_value "$env_file" TOWBAR_BIND_ADDRESS)"
  port="$(env_value "$env_file" TOWBAR_PORT)"
  api_port="$(env_value "$env_file" TOWBAR_API_PORT)"
  case "${install_mode:-local}" in
    local)
      [[ "${profiles:-local}" == local ]] ||
        fail "COMPOSE_PROFILES must be local when TOWBAR_INSTALL_MODE is local"
      [[ "$app_url" == http://localhost:4021 ]] ||
        fail "a local installation must use http://localhost:4021"
      [[ "$api_url" == http://localhost:4020 ]] ||
        fail "a local installation must use http://localhost:4020 for the API"
      [[ "${bind_address:-127.0.0.1}" == 127.0.0.1 && "${port:-4021}" == 4021 && "${api_port:-4020}" == 4020 ]] ||
        fail "a local installation must bind 127.0.0.1:4021 and 127.0.0.1:4020"
      ;;
    public)
      [[ "$profiles" == public ]] ||
        fail "COMPOSE_PROFILES must be public when TOWBAR_INSTALL_MODE is public"
      validate_https_url "$app_url" "TOWBAR_APP_BASE_URL"
      validate_https_url "$api_url" "TOWBAR_API_BASE_URL"
      [[ "$domain" == "${app_url#https://}" ]] ||
        fail "TOWBAR_GATEWAY_DOMAIN must match the public Towbar URL"
      [[ "$api_domain" == "${api_url#https://}" && "$api_domain" != "$domain" ]] ||
        fail "TOWBAR_GATEWAY_API_DOMAIN must match a separate public API URL"
      ;;
    *) fail "TOWBAR_INSTALL_MODE must be local or public" ;;
  esac
  commit="$(metadata_value "$release_dir" COMMIT)"
  compose_for "$release_dir" "$commit" "$env_file" config --quiet
}

set_current_release() {
  local release_dir="$1" pending_link="$TOWBAR_ROOT/.current.next"
  rm -f "$pending_link"
  ln -s "$release_dir" "$pending_link"
  mv -Tf "$pending_link" "$CURRENT_LINK"
}

verify_running_release() {
  local release_dir="$1" commit="$2" service container_id health_status expected_image running_image gateway_service compose_config
  compose_config="$(compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" config --format json)"
  for service in api worker web-app; do
    container_id="$(compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" ps -q "$service")"
    if [[ -z "$container_id" ]]; then
      printf 'Towbar: %s container was not created\n' "$service" >&2
      return 1
    fi
    health_status="$(
      docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id"
    )"
    if [[ "$health_status" != healthy ]]; then
      printf 'Towbar: %s finished with status %s\n' "$service" "$health_status" >&2
      return 1
    fi
    expected_image="$(jq -r --arg service "$service" '.services[$service].image' <<<"$compose_config")"
    running_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
    if [[ "$running_image" != "$expected_image" ]]; then
      printf \
        'Towbar: %s runs %s instead of %s\n' \
        "$service" "$running_image" "$expected_image" >&2
      return 1
    fi
  done

  gateway_service="$(gateway_service_for "$TOWBAR_ENV_FILE")"
  container_id="$(
    compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" ps -q "$gateway_service"
  )"
  if [[ -z "$container_id" ]]; then
    printf 'Towbar: %s container was not created\n' "$gateway_service" >&2
    return 1
  fi
  health_status="$(
    docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container_id"
  )"
  if [[ "$health_status" != healthy ]]; then
    printf 'Towbar: %s finished with status %s\n' "$gateway_service" "$health_status" >&2
    return 1
  fi

  container_id="$(compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" ps -q api)"
  api_version="$(
    docker exec "$container_id" node -e \
      'fetch("http://127.0.0.1:4020/health").then((response) => response.json()).then((body) => process.stdout.write(body.version ?? ""))'
  )"
  if [[ "$api_version" != "$commit" ]]; then
    printf 'Towbar: API reports %s instead of %s\n' "$api_version" "$commit" >&2
    return 1
  fi
}

verify_public_https() {
  local release_dir="$1" commit="$2" app_url api_url hostname api_hostname gateway_service container_id url name
  [[ "$(env_value "$TOWBAR_ENV_FILE" TOWBAR_INSTALL_MODE)" == public ]] || return 0
  app_url="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_APP_BASE_URL)"
  api_url="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_API_BASE_URL)"
  hostname="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_DOMAIN)"
  api_hostname="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_API_DOMAIN)"
  gateway_service="$(gateway_service_for "$TOWBAR_ENV_FILE")"

  for url in "$app_url" "$api_url"; do
  name="${url#https://}"
  if ! curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry 24 \
    --retry-all-errors \
    --retry-delay 5 \
    --connect-timeout 10 \
    --max-time 30 \
    --noproxy '*' \
    --proto '=https' \
    --resolve "$name:443:127.0.0.1" \
    --tlsv1.2 \
    "$url/health" >/dev/null; then
    compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
      logs --tail 100 "$gateway_service" >&2 || true
    ui_failure_step "Let's Encrypt certificate issuance or HTTPS verification failed"
    printf \
      'Towbar: HTTPS verification failed. Confirm %s points to this server and ports 80 and 443 are reachable.\n' \
      "$name" >&2
    return 1
  fi
  done

  container_id="$(
    compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" ps -q "$gateway_service"
  )"
  docker exec "$container_id" caddy validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  for name in "$hostname" "$api_hostname"; do
    docker exec "$container_id" sh -eu -c \
      'test -n "$(find /data/caddy/certificates -type f -name "$1.crt" -print -quit)"' \
      sh "$name" || return 1
  done
}

rehearse_public_https_restart() {
  local release_dir="$1" commit="$2" gateway_service app_url api_url hostname api_hostname url name
  [[ "${CONFIG_CREATED:-false}" == true && "${INSTALL_MODE:-}" == public ]] || return 0
  gateway_service="$(gateway_service_for "$TOWBAR_ENV_FILE")"
  app_url="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_APP_BASE_URL)"
  api_url="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_API_BASE_URL)"
  hostname="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_DOMAIN)"
  api_hostname="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_API_DOMAIN)"
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" restart "$gateway_service"
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    up --detach --wait "$gateway_service"
  for url in "$app_url" "$api_url"; do
  name="${url#https://}"
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --retry 12 \
    --retry-all-errors \
    --retry-delay 2 \
    --connect-timeout 10 \
    --max-time 30 \
    --noproxy '*' \
    --proto '=https' \
    --resolve "$name:443:127.0.0.1" \
    --tlsv1.2 \
    "$url/health" >/dev/null || return 1
  done
}

install_cli_from_release() {
  local release_dir="$1"
  install -o root -g root -m 0755 "$release_dir/infra/towbar" "$TOWBAR_BIN"
}

release_application_images() {
  local release_dir="$1" commit="$2" api_image worker_image web_app_image
  api_image="$(metadata_value "$release_dir" API_IMAGE)"
  worker_image="$(metadata_value "$release_dir" WORKER_IMAGE)"
  web_app_image="$(metadata_value "$release_dir" WEB_APP_IMAGE)"
  if [[ -n "$api_image" && -n "$worker_image" && -n "$web_app_image" ]]; then
    printf '%s\n' "$api_image" "$worker_image" "$web_app_image"
  else
    printf '%s\n' \
      "towbar/api:$commit" \
      "towbar/worker:$commit" \
      "towbar/web-app:$commit"
  fi
}

cleanup_old_releases() {
  local current_release="$1" previous_release="$2" candidate resolved
  while IFS= read -r -d '' candidate; do
    resolved="$(readlink -f "$candidate")"
    if [[ "$resolved" == "$current_release" || "$resolved" == "$previous_release" ]]; then
      continue
    fi
    if rm -rf -- "$resolved"; then
      ui_note "Removed old release $(basename "$resolved")."
    else
      ui_note "Could not remove old release $resolved."
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print0)
}

is_towbar_application_repository() {
  [[ "$1" =~ ^towbar/(api|worker|web-app)$ ||
    "$1" =~ ^ghcr\.io/[^/]+/towbar-(api|worker|web-app)$ ]]
}

cleanup_old_application_images() {
  local current_release="$1" current_commit="$2" previous_release="$3" previous_commit="$4"
  local repository image_id keep_id
  local -a keep_ids=()
  local -A seen_ids=()
  while IFS= read -r image_ref; do
    keep_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null || true)"
    [[ -z "$keep_id" ]] || keep_ids+=("$keep_id")
  done < <(
    release_application_images "$current_release" "$current_commit"
    if [[ -n "$previous_release" ]]; then
      release_application_images "$previous_release" "$previous_commit"
    fi
  )

  while read -r repository image_id; do
    is_towbar_application_repository "$repository" || continue
    [[ -z "${seen_ids[$image_id]:-}" ]] || continue
    seen_ids[$image_id]=1
    for keep_id in "${keep_ids[@]}"; do
      [[ "$image_id" == "$keep_id" ]] && continue 2
    done
    if docker image rm "$image_id" >/dev/null; then
      ui_note "Removed an obsolete $repository image."
    else
      ui_note "Kept $repository because Docker still references it."
    fi
  done < <(docker image ls --no-trunc --format '{{.Repository}} {{.ID}}' | sort -u)
}

cleanup_installation_artifacts() {
  local current_release="$1" current_commit="$2" previous_release="$3" previous_commit="$4"
  cleanup_old_application_images \
    "$current_release" "$current_commit" "$previous_release" "$previous_commit"
  cleanup_old_releases "$current_release" "$previous_release"
}

retire_host_upgrade_service() {
  if [[ -f /etc/systemd/system/towbar-upgrade.service ]]; then
    systemctl disable --now towbar-upgrade.service
    rm -f -- /etc/systemd/system/towbar-upgrade.service
    systemctl daemon-reload
  fi
  rm -f -- "$TOWBAR_CONFIG_DIR/upgrade-compose.yml"
}

upgrade_release() {
  local requested_version="${1:-latest}" version commit release_dir
  require_root upgrade
  [[ ! -f /.dockerenv && ! -f /run/.containerenv ]] || fail "run upgrades on the host"
  local previous_release="" previous_commit="" containers_changed=false
  local config_path_migrated=false had_legacy_config=false

  restore_upgrade_config_path() {
    if [[ "$config_path_migrated" == true && -f "$TOWBAR_YAML_FILE" && ! -e "$TOWBAR_LEGACY_YAML_FILE" ]]; then
      mv -- "$TOWBAR_YAML_FILE" "$TOWBAR_LEGACY_YAML_FILE"
    fi
  }

  trap 'restore_upgrade_config_path' EXIT

  require_linux
  require_runtime_tools
  validate_repository
  acquire_lock

  if [[ "$requested_version" == latest ]]; then
    ui_pending_step "Resolving the latest stable release"
    version="$(resolve_latest_version)"
  else
    version="$requested_version"
    validate_version "$version"
  fi
  verify_release "$version"
  commit="$(resolve_release_commit "$version")"
  ui_step "Verified $version at immutable commit ${commit:0:12}"
  release_dir="$(download_release "$version" "$commit")"
  if [[ -f "$TOWBAR_LEGACY_YAML_FILE" && ! -e "$TOWBAR_YAML_FILE" ]]; then
    had_legacy_config=true
  fi
  migrate_runtime_config_path
  if [[ "$had_legacy_config" == true ]]; then
    config_path_migrated=true
  fi
  generate_config "$release_dir"
  prepare_runtime_config "$release_dir"
  if [[ -n "${INSTALL_MODE:-}" ]]; then
    python3 "$(config_helper_for "$release_dir")" set-installation \
      --yaml "$TOWBAR_YAML_FILE" \
      --mode "$INSTALL_MODE" \
      --app-url "$INSTALL_APP_URL" \
      --api-base-url "$INSTALL_API_BASE_URL"
    python3 "$(config_helper_for "$release_dir")" render \
      --yaml "$TOWBAR_YAML_FILE" --env "$TOWBAR_PENDING_ENV_FILE"
    if [[ "$CONFIG_CREATED" == true ]]; then
      ui_step "Created the runtime configuration"
    else
      ui_step "Updated the installation access settings"
    fi
  fi
  validate_config_for "$release_dir"

  if [[ -L "$CURRENT_LINK" ]]; then
    previous_release="$(readlink -f "$CURRENT_LINK")"
    [[ -f "$previous_release/.towbar-release" ]] ||
      fail "the current release is missing Towbar metadata"
    previous_commit="$(metadata_value "$previous_release" COMMIT)"
  fi

  rollback_upgrade() {
    local exit_code="${1:-1}"
    trap - ERR INT TERM
    set +e
    if [[ -n "$previous_release" ]]; then
      log "Upgrade failed; restoring $(metadata_value "$previous_release" VERSION)"
      set_current_release "$previous_release"
      if [[ "$containers_changed" == true ]]; then
        compose_for "$previous_release" "$previous_commit" "$TOWBAR_COMMITTED_ENV_FILE" \
          up --detach --wait --remove-orphans
      fi
    elif [[ "$containers_changed" == true ]]; then
      compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" down --remove-orphans
      rm -f "$CURRENT_LINK"
    fi
    if [[ "$INSTALL_FAILURE_CONTEXT" == public_https ]]; then
      printf '\n' >&2
      if [[ -n "$previous_release" ]]; then
        printf '%sThe new release did not pass HTTPS verification.%s\n' \
          "$STYLE_RED" "$STYLE_RESET" >&2
        printf 'The previous Towbar release was restored.\n' >&2
        printf 'Inspect the Caddy output above, correct the problem, and run: sudo towbar upgrade\n' >&2
      else
        printf '%sTowbar could not finish HTTPS setup.%s\n' \
          "$STYLE_RED" "$STYLE_RESET" >&2
        printf 'No public HTTP fallback was enabled, and ports 80 and 443 were released.\n' >&2
        printf 'The generated secrets, downloaded release, and ACME state were preserved.\n' >&2
        printf 'Confirm the A record points to this server and that inbound ports 80 and 443 are open.\n' >&2
        printf 'After correcting the problem, run: sudo towbar install\n' >&2
      fi
    fi
    exit "$exit_code"
  }
  trap 'rollback_upgrade $?' ERR
  trap 'rollback_upgrade 130' INT
  trap 'rollback_upgrade 143' TERM

  ui_pending_step "Downloading the control-plane images"
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    pull --quiet api worker web-app
  ui_step "Downloaded the control-plane images"
  retire_host_upgrade_service
  set_current_release "$release_dir"
  containers_changed=true
  ui_pending_step "Applying the database schema and starting $version"
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    up --detach --wait --remove-orphans
  ui_step "Started the control plane"
  if [[ "$(env_value "$TOWBAR_ENV_FILE" TOWBAR_INSTALL_MODE)" == public ]]; then
    ui_pending_step "Issuing and verifying the Let's Encrypt certificate"
    INSTALL_FAILURE_CONTEXT=public_https
    verify_public_https "$release_dir" "$commit"
    ui_step "Verified HTTPS and automatic certificate renewal"
    if [[ "$CONFIG_CREATED" == true && "${INSTALL_MODE:-}" == public ]]; then
      ui_pending_step "Rehearsing an HTTPS gateway restart"
      rehearse_public_https_restart "$release_dir" "$commit"
      ui_step "HTTPS recovered with the persisted certificate"
    fi
    INSTALL_FAILURE_CONTEXT=""
  fi
  ui_pending_step "Verifying the API, worker and dashboard"
  verify_running_release "$release_dir" "$commit"
  ui_step "Verified the API, worker and dashboard"

  install_cli_from_release "$release_dir"
  commit_runtime_config
  printf '%s\n' "$version" >"$VERSION_FILE"
  trap - ERR INT TERM EXIT
  cleanup_installation_artifacts \
    "$release_dir" "$commit" "$previous_release" "$previous_commit"
  log "$version is healthy at $commit"
}

current_release_dir() {
  [[ -L "$CURRENT_LINK" ]] || fail "Towbar is not installed"
  readlink -f "$CURRENT_LINK"
}

preflight_runtime_configuration() {
  local release_dir="$1" commit="$2" gateway_service gateway_image gateway_config gateway_domain gateway_api_domain
  gateway_service="$(gateway_service_for "$TOWBAR_ENV_FILE")"

  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    run --rm --no-deps --entrypoint node api \
    --input-type=module --eval \
    'const { getEnv } = await import("./dist/env.js");
     const { getRuntimeIntegrations } = await import("./dist/infrastructure/runtime-integrations.js");
     const { getRuntimeNotifications } = await import("./dist/infrastructure/runtime-notifications.js");
     getEnv(); getRuntimeIntegrations(); getRuntimeNotifications();' ||
    return 1
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    run --rm --no-deps --entrypoint node worker \
    --input-type=module --eval \
    'const { getEnv } = await import("./dist/env.js"); getEnv();' ||
    return 1

  gateway_image="$(
    compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
      config --format json |
      jq -r --arg service "$gateway_service" '.services[$service].image'
  )" || return 1
  if [[ -z "$gateway_image" || "$gateway_image" == null ]]; then
    printf 'Towbar: could not resolve the %s image\n' "$gateway_service" >&2
    return 1
  fi
  gateway_config="$release_dir/infra/gateway/Caddyfile"
  gateway_domain="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_DOMAIN)"
  gateway_api_domain="$(env_value "$TOWBAR_ENV_FILE" TOWBAR_GATEWAY_API_DOMAIN)"
  if [[ "$gateway_service" == gateway-public ]]; then
    gateway_config="$release_dir/infra/gateway/Caddyfile.public"
  fi
  docker run --rm --interactive \
    --entrypoint caddy \
    --env "TOWBAR_GATEWAY_DOMAIN=$gateway_domain" \
    --env "TOWBAR_GATEWAY_API_DOMAIN=$gateway_api_domain" \
    "$gateway_image" \
    validate --config - --adapter caddyfile <"$gateway_config" || return 1
}

restart_preflight_failure() {
  ui_failure_step "Configuration preflight failed"
  printf 'Towbar: Running services were not restarted.\n' >&2
  printf 'Towbar: Run sudo towbar doctor to inspect the installation.\n' >&2
}

restart_release() {
  require_root restart
  require_runtime_tools
  acquire_lock
  restart_release_locked
}

restart_release_locked() {
  local release_dir commit
  release_dir="$(current_release_dir)"
  commit="$(metadata_value "$release_dir" COMMIT)"

  prepare_runtime_config "$release_dir"
  log "Validating $TOWBAR_YAML_FILE before restarting"
  if ! (validate_config_for "$release_dir"); then
    restart_preflight_failure
    return 1
  fi
  if ! preflight_runtime_configuration "$release_dir" "$commit"; then
    restart_preflight_failure
    return 1
  fi

  log "Configuration preflight passed; restarting Towbar"
  if ! compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    up --detach --wait --remove-orphans; then
    ui_failure_step "Towbar did not become healthy after restart"
    printf 'Towbar: Run sudo towbar doctor to inspect the failure.\n' >&2
    return 1
  fi
  if ! verify_running_release "$release_dir" "$commit"; then
    ui_failure_step "The restarted services did not pass release verification"
    printf 'Towbar: Run sudo towbar doctor to inspect the failure.\n' >&2
    return 1
  fi
  commit_runtime_config
  log "Configuration applied"
}

config_command() {
  local release_dir commit
  case "${1:-}" in
    path)
      if [[ -f "$TOWBAR_YAML_FILE" ]]; then
        printf '%s\n' "$TOWBAR_YAML_FILE"
      elif [[ -f "$TOWBAR_LEGACY_YAML_FILE" ]]; then
        printf '%s\n' "$TOWBAR_LEGACY_YAML_FILE"
      elif [[ -f "$TOWBAR_ENV_FILE" ]]; then
        printf '%s\n' "$TOWBAR_ENV_FILE"
      else
        printf '%s\n' "$TOWBAR_YAML_FILE"
      fi
      ;;
    validate)
      require_root config validate
      require_runtime_tools
      acquire_lock
      release_dir="$(current_release_dir)"
      commit="$(metadata_value "$release_dir" COMMIT)"
      prepare_runtime_config "$release_dir"
      validate_config_for "$release_dir"
      preflight_runtime_configuration "$release_dir" "$commit"
      discard_runtime_config
      log "Configuration is valid"
      ;;
    *) fail "usage: towbar config {path|validate}" ;;
  esac
}
