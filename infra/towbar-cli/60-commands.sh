compose_command() {
  local release_dir commit
  require_root compose
  require_runtime_tools
  [[ $# -ge 2 ]] || fail "usage: towbar compose COMMAND [ARG...]"
  release_dir="$(current_release_dir)"
  commit="$(metadata_value "$release_dir" COMMIT)"
  shift
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" "$@"
}

status_command() {
  local release_dir commit
  require_root status
  require_runtime_tools
  release_dir="$(current_release_dir)"
  commit="$(metadata_value "$release_dir" COMMIT)"
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" ps
}

logs_command() {
  local release_dir commit
  require_root logs
  require_runtime_tools
  release_dir="$(current_release_dir)"
  commit="$(metadata_value "$release_dir" COMMIT)"
  shift
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" \
    logs --tail "${TOWBAR_LOG_TAIL:-200}" "$@"
}

exec_command() {
  local release_dir commit service
  require_root exec
  require_runtime_tools
  service="${2:-}"
  [[ -n "$service" && $# -ge 3 ]] ||
    fail "usage: towbar exec SERVICE COMMAND [ARG...]"
  release_dir="$(current_release_dir)"
  commit="$(metadata_value "$release_dir" COMMIT)"
  shift 2
  compose_for "$release_dir" "$commit" "$TOWBAR_ENV_FILE" exec "$service" "$@"
}

version_command() {
  if [[ -f "$VERSION_FILE" ]]; then
    printf 'Towbar %s\n' "$(cat "$VERSION_FILE")"
  else
    printf 'Towbar is not installed\n'
  fi
  printf 'CLI %s\n' "$CLI_VERSION"
}

install_command() {
  [[ $# -eq 0 ]] || fail "usage: towbar install"
  require_root install
  require_linux
  validate_repository
  [[ ! -L "$CURRENT_LINK" ]] || fail "Towbar is already installed; use sudo towbar upgrade"

  ui_brand
  collect_install_settings
  ui_heading "Installing Towbar"
  ui_pending_step "Inspecting the host and installing prerequisites"
  install_prerequisites
  ui_step "Host prerequisites are ready"
  verify_public_prerequisites
  upgrade_release "$CLI_RELEASE"

  printf '\n%s%sTowbar is ready%s\n' \
    "$STYLE_BOLD" "$STYLE_GREEN" "$STYLE_RESET"
  printf 'Open the dashboard at %s\n' "$INSTALL_APP_URL"
  printf '\n'
  ui_note "Next: configure optional integrations in the YAML configuration file."
  ui_note "Manage this installation with sudo towbar status, logs and upgrade."
}

usage() {
  cat <<'EOF'
Usage: towbar COMMAND [ARGUMENTS]

Commands:
  install                Install the release bundled with this CLI
  upgrade [VERSION]      Upgrade to the latest or selected stable release
  restart                Validate and restart with the current configuration
  compose COMMAND        Run a Docker Compose command for this installation
  config path            Print the configuration path
  config validate        Validate the current configuration
  doctor                 Run read-only installation diagnostics
  status                 Show Compose service status
  logs [SERVICE...]      Show recent service logs
  exec SERVICE COMMAND   Run a command in a Towbar service
  version                Show the installed release and CLI versions
  help                   Show this help
EOF
}

case "${1:-help}" in
  compose) compose_command "$@" ;;
  config) shift; config_command "$@" ;;
  doctor) shift; doctor_command "$@" ;;
  exec) exec_command "$@" ;;
  help | --help | -h) usage ;;
  install) shift; install_command "$@" ;;
  logs) logs_command "$@" ;;
  restart) restart_release ;;
  status) status_command ;;
  upgrade | update) shift; upgrade_release "${1:-latest}" ;;
  version | --version | -v) version_command ;;
  *) fail "unknown command: $1; run towbar help" ;;
esac
