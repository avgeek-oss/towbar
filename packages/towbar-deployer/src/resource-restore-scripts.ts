import { drainCentralizedLogsShell } from "./log-drain.js";
export const preflightRestoreScript = String.raw`
set -euo pipefail
container="$1"
deployable_id="$2"
logical_name="$3"
backup_size="$4"
kind="$5"
expected_major="$6"
test "$(docker inspect --format '{{index .Config.Labels "towbar.managed"}}' "$container")" = true
owned="$(docker inspect --format '{{index .Config.Labels "towbar.deployable"}}' "$container")"
test "$owned" = "$deployable_id"
state_dir="/var/lib/towbar/resources/$deployable_id/volumes"
sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$state_dir"
pointer="$state_dir/$logical_name.active"
legacy_volume="towbar-$deployable_id-$logical_name"
if ! test -s "$pointer"; then
  printf '%s\n' "$legacy_volume" >"$pointer.tmp"
  mv "$pointer.tmp" "$pointer"
fi
active_volume="$(cat "$pointer")"
case "$active_volume" in towbar-*) ;; *) exit 65 ;; esac
test "$(docker volume inspect --format '{{index .Labels "towbar.managed"}}' "$active_volume")" = true
test "$(docker volume inspect --format '{{index .Labels "towbar.deployable"}}' "$active_volume")" = "$deployable_id"
mounted="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$container")"
case " $mounted " in *" $active_volume "*) ;; *) exit 66 ;; esac
available="$(df -PB1 /var/lib/docker | awk 'NR==2 {print $4}')"
required=$((backup_size * 3))
if (( required < 1073741824 )); then required=1073741824; fi
if (( available < required )); then
  printf 'INSUFFICIENT_DISK:%s:%s\n' "$available" "$required" >&2
  exit 67
fi
case "$kind" in
  postgres) actual_major="$(docker exec "$container" postgres --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')" ;;
  mysql) actual_major="$(docker exec "$container" mysqld --version | sed -E 's/.*Ver ([0-9]+)(\..*)?.*/\1/')" ;;
  mariadb) actual_major="$(docker exec "$container" mariadb --version | sed -E 's/.*Distrib ([0-9]+)(\..*)?.*/\1/')" ;;
  mongodb) actual_major="$(docker exec "$container" mongod --version | awk '/db version/ {sub(/^v/, "", $3); split($3,v,"."); print v[1]; exit}')" ;;
  redis) actual_major="$(docker exec "$container" redis-server --version | sed -E 's/.*v=([0-9]+)(\..*)?.*/\1/')" ;;
  dragonfly) actual_major="$(docker exec "$container" dragonfly --version | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 | cut -d. -f1)" ;;
  keydb) actual_major="$(docker exec "$container" keydb-server --version | sed -E 's/.*v=([0-9]+)(\..*)?.*/\1/')" ;;
  clickhouse) actual_major="$(docker exec "$container" clickhouse-server --version | awk '{for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\./) {split($i,v,"."); print v[1]; exit}}')" ;;
  *) exit 64 ;;
esac
test "$actual_major" = "$expected_major"
printf '%s\n%s\n%s\n' "$active_volume" "$available" "$actual_major"
`;

export const prepareCandidateScript = String.raw`
set -euo pipefail
candidate_volume="$1"
deployable_id="$2"
source_id="$3"
docker volume create \
  --label towbar.managed=true \
  --label "towbar.deployable=$deployable_id" \
  --label "towbar.source=$source_id" \
  --label towbar.restore-candidate=true \
  "$candidate_volume" >/dev/null
`;

export const restoreCandidateScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
kind="$1"
container="$2"
volume="$3"
mount_path="$4"
backup_path="$5"
image="$6"
resource_cpus="$7"
resource_memory="$8"
runtime_dir="$9"
shift 9
towbar_drain_logs "$container"; docker rm -f "$container" >/dev/null 2>&1 || true
run_candidate() {
  runtime_args=(--mount "type=volume,src=$volume,dst=$mount_path")
  if test -n "$resource_cpus"; then runtime_args+=(--cpus "$resource_cpus"); fi
  if test -n "$resource_memory"; then runtime_args+=(--memory "$resource_memory"); fi
  command=(/usr/bin/docker run -d "${"$"}{runtime_args[@]}" --name "$container" --restart no "$image")
  if (( $# > 0 )); then command+=("$@"); fi
  /usr/bin/python3 - "$runtime_dir" "${"$"}{command[@]}" <<'PYTHON' >/dev/null
import os
from pathlib import Path
import sys

runtime_directory = Path(sys.argv[1])
command = sys.argv[2:]
runtime_arguments = []
for secret_path in sorted(runtime_directory.iterdir()):
    if secret_path.is_file():
        os.environ[secret_path.name] = secret_path.read_text(encoding="utf-8")
        runtime_arguments.extend(("--env", secret_path.name))
command[3:3] = runtime_arguments
os.execve(command[0], command, os.environ)
PYTHON
}
if test "$kind" = redis || test "$kind" = dragonfly || test "$kind" = keydb; then
  docker run --rm --user 0 \
    --mount "type=bind,src=$backup_path,dst=/tmp/towbar-restore.rdb,readonly" \
    --mount "type=volume,src=$volume,dst=$mount_path" \
    --entrypoint sh "$image" -c "cp /tmp/towbar-restore.rdb '$mount_path/dump.rdb'"
  if test "$kind" = redis; then
    run_candidate sh -c 'exec redis-server --appendonly no --requirepass "$REDIS_PASSWORD"'
  elif test "$kind" = keydb; then
    run_candidate sh -c 'exec keydb-server --appendonly no --requirepass "$REDIS_PASSWORD"'
  else
    run_candidate sh -c 'exec dragonfly --dir=/data --dbfilename=dump.rdb --requirepass="$REDIS_PASSWORD"'
  fi
else
  run_candidate "$@"
fi
candidate_ready() {
  case "$kind" in
    postgres) docker exec "$container" sh -c 'pg_isready -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}"' >/dev/null 2>&1 ;;
    mysql) docker exec "$container" sh -c 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1 ;;
    mariadb) docker exec "$container" sh -c 'mariadb-admin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1 ;;
    mongodb) docker exec "$container" sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.adminCommand({ping:1}).ok ? 0 : 1)"' >/dev/null 2>&1 ;;
    redis|dragonfly|keydb) docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning PING' | grep -Fxq PONG ;;
    clickhouse) docker exec "$container" sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1"' | grep -Fxq 1 ;;
    *) return 1 ;;
  esac
}
deadline=$((SECONDS + 120))
while true; do
  if candidate_ready; then break; fi
  if (( SECONDS >= deadline )); then exit 68; fi
  sleep 2
done
case "$kind" in
  postgres)
    docker cp "$backup_path" "$container:/tmp/towbar-restore.dump"
    docker exec "$container" sh -c 'exec pg_restore -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}" --clean --if-exists --no-owner --no-privileges /tmp/towbar-restore.dump'
    docker exec "$container" rm -f /tmp/towbar-restore.dump
    ;;
  mysql)
    docker cp "$backup_path" "$container:/tmp/towbar-restore.sql"
    docker exec "$container" sh -c 'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" < /tmp/towbar-restore.sql'
    docker exec "$container" rm -f /tmp/towbar-restore.sql
    ;;
  mariadb)
    docker cp "$backup_path" "$container:/tmp/towbar-restore.sql"
    docker exec "$container" sh -c 'exec mariadb -u root -p"$MYSQL_ROOT_PASSWORD" < /tmp/towbar-restore.sql'
    docker exec "$container" rm -f /tmp/towbar-restore.sql
    ;;
  mongodb)
    docker cp "$backup_path" "$container:/tmp/towbar-restore.archive.gz"
    docker exec "$container" sh -c 'exec mongorestore --drop --archive=/tmp/towbar-restore.archive.gz --gzip --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
    docker exec "$container" rm -f /tmp/towbar-restore.archive.gz
    ;;
  redis|keydb)
    if docker exec "$container" command -v redis-check-rdb >/dev/null 2>&1; then docker exec "$container" redis-check-rdb "$mount_path/dump.rdb" >/dev/null; fi
    docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE' | grep -Eq '^[0-9]+$'
    # The managed Redis and KeyDB runtimes use AOF. Convert the imported RDB
    # while the isolated candidate is running; otherwise enabling AOF during
    # promotion creates an empty base file instead of loading dump.rdb.
    docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning CONFIG SET appendonly yes' | grep -Fxq OK
    aof_deadline=$((SECONDS + 120))
    while true; do
      persistence="$(docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO persistence' | tr -d '\r')"
      if grep -Fxq 'aof_enabled:1' <<<"$persistence" && grep -Fxq 'aof_rewrite_in_progress:0' <<<"$persistence" && ! grep -Fxq 'aof_last_bgrewrite_status:err' <<<"$persistence"; then break; fi
      if (( SECONDS >= aof_deadline )); then exit 69; fi
      sleep 2
    done
    ;;
  dragonfly)
    if docker exec "$container" command -v redis-check-rdb >/dev/null 2>&1; then docker exec "$container" redis-check-rdb "$mount_path/dump.rdb" >/dev/null; fi
    docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE' | grep -Eq '^[0-9]+$'
    ;;
  clickhouse)
    docker cp "$backup_path" "$container:/var/lib/clickhouse/backups/towbar-restore.zip"
    docker exec "$container" sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "RESTORE ALL EXCEPT DATABASES system, INFORMATION_SCHEMA, information_schema FROM File('\''towbar-restore.zip'\'')"'
    docker exec "$container" rm -f /var/lib/clickhouse/backups/towbar-restore.zip
    ;;
esac
case "$kind" in
  postgres) docker exec "$container" sh -c 'psql -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}" -v ON_ERROR_STOP=1 -Atqc "SELECT 1"' | grep -Fxq 1 ;;
  mysql) docker exec "$container" sh -c 'mysql -N -B -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"' | grep -Fxq 1 ;;
  mariadb) docker exec "$container" sh -c 'mariadb -N -B -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"' | grep -Fxq 1 ;;
  mongodb) docker exec "$container" sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.getMongo().getDBNames().length >= 0 ? 0 : 1)"' >/dev/null ;;
  redis|dragonfly|keydb) docker exec "$container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE' | grep -Eq '^[0-9]+$' ;;
  clickhouse) docker exec "$container" sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT count() >= 0 FROM system.databases"' | grep -Fxq 1 ;;
  *) exit 64 ;;
esac
`;

export const promoteCandidateScript = String.raw`
set -euo pipefail
${drainCentralizedLogsShell}
kind="$1"
current_container="$2"
candidate_container="$3"
candidate_volume="$4"
previous_volume="$5"
pointer="$6"
mount_path="$7"
image="$8"
network_name="$9"
network_alias="${"$"}{10}"
host_port="${"$"}{11}"
container_port="${"$"}{12}"
resource_cpus="${"$"}{13}"
resource_memory="${"$"}{14}"
runtime_dir="${"$"}{15}"
deployable_id="${"$"}{16}"
manifest_id="${"$"}{17}"
source_id="${"$"}{18}"
deployment_id="${"$"}{19}"
commit_sha="${"$"}{20}"
shift 20
switch_pointer() {
  printf '%s\n' "$1" >"$pointer.tmp"
  mv "$pointer.tmp" "$pointer"
}
run_runtime() {
  selected_volume="$1"
  shift
  runtime_args=(--mount "type=volume,src=$selected_volume,dst=$mount_path")
  if test -n "$network_name"; then
    runtime_args+=(--network "$network_name")
    if test -n "$network_alias"; then runtime_args+=(--network-alias "$network_alias"); fi
  fi
  if test -n "$host_port" && test -n "$container_port"; then runtime_args+=(-p "127.0.0.1:$host_port:$container_port"); fi
  if test -n "$resource_cpus"; then runtime_args+=(--cpus "$resource_cpus"); fi
  if test -n "$resource_memory"; then runtime_args+=(--memory "$resource_memory"); fi
  command=(/usr/bin/docker run -d "${"$"}{runtime_args[@]}" \
    --name "$current_container" --restart unless-stopped \
    --add-host host.docker.internal:host-gateway \
    --env "SOURCE_COMMIT=$commit_sha" \
    --env "TOWBAR_APP_ID=$manifest_id" \
    --env "TOWBAR_COMMIT_SHA=$commit_sha" \
    --env "TOWBAR_DEPLOYMENT_ID=$deployment_id" \
    --label towbar.managed=true \
    --label "towbar.app=$deployable_id" \
    --label "towbar.resource=$deployable_id" \
    --label "towbar.deployable=$deployable_id" \
    --label "towbar.source=$source_id" \
    --label "towbar.deployment=$deployment_id" \
    "$image")
  if (( $# > 0 )); then command+=("$@"); fi
  /usr/bin/python3 - "$runtime_dir" "${"$"}{command[@]}" <<'PYTHON' >/dev/null
import os
from pathlib import Path
import sys

runtime_directory = Path(sys.argv[1])
command = sys.argv[2:]
runtime_arguments = []
for secret_path in sorted(runtime_directory.iterdir()):
    if secret_path.is_file():
        os.environ[secret_path.name] = secret_path.read_text(encoding="utf-8")
        runtime_arguments.extend(("--env", secret_path.name))
command[3:3] = runtime_arguments
os.execve(command[0], command, os.environ)
PYTHON
}
validate_runtime() {
  deadline=$((SECONDS + 120))
  while true; do
    case "$kind" in
      postgres) docker exec "$current_container" sh -c 'pg_isready -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}" && psql -U "${"$"}{POSTGRES_USER:-postgres}" -d "${"$"}{POSTGRES_DB:-postgres}" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null' && return 0 ;;
      mysql) docker exec "$current_container" sh -c 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent && mysql -N -B -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"' | grep -Fxq 1 && return 0 ;;
      mariadb) docker exec "$current_container" sh -c 'mariadb-admin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent && mariadb -N -B -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"' | grep -Fxq 1 && return 0 ;;
      mongodb) docker exec "$current_container" sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.adminCommand({ping:1}).ok ? 0 : 1)"' >/dev/null 2>&1 && return 0 ;;
      redis|dragonfly|keydb) docker exec "$current_container" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning PING' | grep -Fxq PONG && return 0 ;;
      clickhouse) docker exec "$current_container" sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1"' | grep -Fxq 1 && return 0 ;;
    esac
    if (( SECONDS >= deadline )); then return 1; fi
    sleep 2
  done
}
towbar_drain_logs "$candidate_container"; docker rm -f "$candidate_container" >/dev/null 2>&1 || true
towbar_drain_logs "$current_container"; docker rm -f "$current_container" >/dev/null
switch_pointer "$candidate_volume"
if run_runtime "$candidate_volume" "$@" && validate_runtime; then
  printf 'PROMOTED\n'
  exit 0
fi
towbar_drain_logs "$current_container"; docker rm -f "$current_container" >/dev/null 2>&1 || true
switch_pointer "$previous_volume"
if run_runtime "$previous_volume" "$@" && validate_runtime; then
  docker volume rm "$candidate_volume" >/dev/null 2>&1 || true
  printf 'ROLLED_BACK\n'
  exit 0
fi
printf 'ROLLBACK_FAILED\n' >&2
exit 70
`;

export const cleanupRestoreVolumesScript = String.raw`
set -euo pipefail
deployable_id="$1"
shift
state_dir="/var/lib/towbar/resources/$deployable_id/volumes"
active="$(cat "$state_dir"/*.active 2>/dev/null || true)"
cleaned=()
skipped=()
for volume in "$@"; do
  case "$volume" in towbar-*) ;; *) skipped+=("$volume"); continue ;; esac
  if grep -Fxq "$volume" <<<"$active"; then skipped+=("$volume"); continue; fi
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then skipped+=("$volume"); continue; fi
  if test "$(docker volume inspect --format '{{index .Labels "towbar.managed"}}' "$volume")" != true || test "$(docker volume inspect --format '{{index .Labels "towbar.deployable"}}' "$volume")" != "$deployable_id"; then
    skipped+=("$volume")
    continue
  fi
  if docker volume rm "$volume" >/dev/null 2>&1; then cleaned+=("$volume"); else skipped+=("$volume"); fi
done
python3 - "${"$"}{cleaned[*]}" "${"$"}{skipped[*]}" <<'PYTHON'
import json
import sys
print(json.dumps({"cleaned": sys.argv[1].split() if sys.argv[1] else [], "skipped": sys.argv[2].split() if sys.argv[2] else []}, separators=(",", ":")))
PYTHON
`;
