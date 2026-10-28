#!/usr/bin/env python3
"""Initialize and validate YAML configuration, and render its Compose environment."""

import argparse
import base64
import json
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
from urllib.parse import urlsplit
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("Towbar: python3-yaml is required to read config.yml")


class ConfigError(Exception):
    pass


def field(path, kind="string"):
    return (tuple(path.split(".")), kind)


FIELDS = {
    "ANTHROPIC_API_KEY": field("assistant.anthropicApiKey"),
    "AGENT_API_KEY": field("assistant.apiKey"),
    "AGENT_AUTH_TOKEN": field("assistant.authToken"),
    "AGENT_BASE_URL": field("assistant.baseUrl"),
    "AGENT_MODEL": field("assistant.model"),
    "AGENT_PROFILE": field("assistant.profile"),
    "AGENT_EFFORT": field("assistant.effort"),
    "AGENT_MAX_TOKENS": field("assistant.maxTokens", "integer"),
    "AGENT_HEADERS": field("assistant.headers", "json-object"),
    "TOWBAR_LOGS_CONFIG_JSON": field("observability.logs", "json-object"),
    "TOWBAR_INSTALL_MODE": field("installation.mode"),
    "TOWBAR_BIND_ADDRESS": field("installation.bindAddress"),
    "TOWBAR_PORT": field("installation.port", "integer"),
    "TOWBAR_API_PORT": field("installation.apiPort", "integer"),
    "TOWBAR_TEMPORAL_UI_PORT": field("installation.temporalUiPort", "integer"),
    "TOWBAR_NETWORK_NAME": field("installation.networkName"),
    "TOWBAR_APP_BASE_URL": field("installation.appUrl"),
    "TOWBAR_API_BASE_URL": field("installation.apiBaseUrl"),
    "TOWBAR_POSTGRES_PASSWORD": field("database.postgresPassword"),
    "TOWBAR_DATABASE_RUNTIME_PASSWORD": field("database.runtimePassword"),
    "TOWBAR_CREDENTIALS_KEY": field("security.credentialsKey"),
    "TOWBAR_INTERNAL_HMAC_SECRET": field("security.internalHmacSecret"),
    "TOWBAR_API_RATE_LIMIT_MAX": field("security.apiRateLimit.max", "integer"),
    "TOWBAR_API_RATE_LIMIT_WINDOW_SECONDS": field(
        "security.apiRateLimit.windowSeconds", "integer"
    ),
    "TOWBAR_PASSWORD_BREACH_CHECK": field("security.passwordBreachCheck", "boolean"),
    "TOWBAR_PASSWORD_VERIFY_CONCURRENCY": field(
        "security.passwordVerifyConcurrency", "integer"
    ),
    "TOWBAR_PASSWORD_VERIFY_QUEUE_LIMIT": field(
        "security.passwordVerifyQueueLimit", "integer"
    ),
    "TOWBAR_APP_ID": field("worker.appId"),
    "TOWBAR_WORKER_MAX_CONCURRENT_ACTIVITIES": field(
        "worker.maxConcurrentActivities", "integer"
    ),
    "TOWBAR_VULNERABILITY_SCANNING_ENABLED": field(
        "worker.vulnerabilityScanning.enabled", "boolean"
    ),
    "TOWBAR_VULNERABILITY_SCAN_MAX_AGE_HOURS": field(
        "worker.vulnerabilityScanning.maxAgeHours", "integer"
    ),
    "TOWBAR_TRIVY_IMAGE": field("worker.vulnerabilityScanning.trivyImage"),
    "TOWBAR_NOTIFICATIONS_ENABLED": field("notifications.enabled", "boolean"),
    "TOWBAR_NOTIFICATION_CONFIG_JSON": field("notifications", "json-object"),
}

PROVIDER_FIELDS = {
    "github": "ENABLED APP_ID APP_SLUG PRIVATE_KEY_BASE64 WEBHOOK_SECRET API_URL",
    "gitlab": "ENABLED BASE_URL ALLOW_PRIVATE_NETWORK OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET OAUTH_REDIRECT_URI WEBHOOK_SECRET",
    "registry": "ENABLED HOST USERNAME PASSWORD ALLOW_PRIVATE_NETWORK",
    "aws": "ENABLED REGION ACCESS_KEY_ID SECRET_ACCESS_KEY",
    "s3": "ENABLED ENDPOINT REGION BUCKET PREFIX ADDRESSING_STYLE ALLOW_PRIVATE_NETWORK CUSTOM_CA_BASE64 ACCESS_KEY_ID SECRET_ACCESS_KEY",
    "r2": "ENABLED ENDPOINT REGION BUCKET PREFIX ADDRESSING_STYLE ALLOW_PRIVATE_NETWORK CUSTOM_CA_BASE64 ACCESS_KEY_ID SECRET_ACCESS_KEY",
    "gcs": "ENABLED PROJECT_ID BUCKET PREFIX SERVICE_ACCOUNT_JSON_BASE64",
    "infisical": "ENABLED BASE_URL ALLOW_PRIVATE_NETWORK CLIENT_ID CLIENT_SECRET",
    "doppler": "ENABLED TOKEN",
    "cloudflare": "ENABLED ACCOUNT_ID ZONE_ID API_TOKEN CLOUDFLARED_IMAGE",
}


def camel(value):
    words = value.lower().split("_")
    return words[0] + "".join(word.capitalize() for word in words[1:])


for provider, names in PROVIDER_FIELDS.items():
    for name in names.split():
        kind = "boolean" if name in ("ENABLED", "ALLOW_PRIVATE_NETWORK") else "string"
        if name == "HEADERS_JSON":
            kind = "json-object"
        path_name = "headers" if name == "HEADERS_JSON" else camel(name)
        FIELDS[f"TOWBAR_{provider.upper()}_{name}"] = field(
            f"integrations.{provider}.{path_name}", kind
        )


def parse_env(path, remove_legacy_proxy=False):
    values = {}
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line)
        if not match:
            raise ConfigError(f"unsupported environment syntax on line {line_number}")
        key, raw = match.groups()
        if remove_legacy_proxy and key == "TOWBAR_TRUSTED_PROXY_HOPS":
            continue
        if key in values:
            raise ConfigError(f"duplicate environment key: {key}")
        if key not in FIELDS and key not in ("COMPOSE_PROFILES", "TOWBAR_GATEWAY_DOMAIN", "TOWBAR_GATEWAY_API_DOMAIN"):
            raise ConfigError(f"unsupported environment key: {key}")
        if raw.startswith("'"):
            if not raw.endswith("'") or len(raw) < 2:
                raise ConfigError(f"invalid quoted value for {key}")
            value = raw[1:-1].replace("\\'", "'")
        elif raw.startswith('"'):
            if not raw.endswith('"') or len(raw) < 2:
                raise ConfigError(f"invalid quoted value for {key}")
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                raise ConfigError(f"invalid quoted value for {key}") from None
            if "$" in value:
                raise ConfigError(f"interpolated value for {key} needs manual migration")
        else:
            value = re.split(r"\s+#", raw, maxsplit=1)[0].strip()
            if "$" in value:
                raise ConfigError(f"interpolated value for {key} needs manual migration")
        values[key] = value
    return values


def parse_value(key, value, kind):
    if kind == "boolean":
        if value not in ("true", "false"):
            raise ConfigError(f"{key} must be true or false")
        return value == "true"
    if kind == "integer":
        if not re.fullmatch(r"[0-9]+", value):
            raise ConfigError(f"{key} must be a non-negative integer")
        return int(value)
    if kind == "json-object":
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            raise ConfigError(f"{key} contains invalid JSON") from None
        if not isinstance(parsed, dict):
            raise ConfigError(f"{key} must contain a JSON object")
        return parsed
    return value


def nested_set(root, path, value, key):
    current = root
    for part in path[:-1]:
        current = current.setdefault(part, {})
        if not isinstance(current, dict):
            raise ConfigError(f"conflicting setting: {key}")
    if path[-1] in current:
        raise ConfigError(f"conflicting setting: {key}")
    current[path[-1]] = value


def from_env(values):
    config = {"version": 1}
    mode = values.get("TOWBAR_INSTALL_MODE", "local")
    if values.get("COMPOSE_PROFILES", mode) != mode:
        raise ConfigError("COMPOSE_PROFILES does not match TOWBAR_INSTALL_MODE")
    for key, (path, kind) in FIELDS.items():
        if key not in values:
            continue
        value = parse_value(key, values[key], kind)
        if key == "TOWBAR_NOTIFICATION_CONFIG_JSON":
            target = config.setdefault("notifications", {})
            for name, item in value.items():
                if name in target:
                    raise ConfigError(f"conflicting notification setting: {name}")
                target[name] = item
        else:
            nested_set(config, path, value, key)
    installation = config.setdefault("installation", {})
    if "TOWBAR_GATEWAY_DOMAIN" in values:
        expected_domain = gateway_domain(installation)
        if values["TOWBAR_GATEWAY_DOMAIN"] != expected_domain:
            raise ConfigError("TOWBAR_GATEWAY_DOMAIN must match installation.appUrl")
    installation.setdefault("apiBaseUrl", default_api_base_url(installation.get("appUrl", "http://localhost:4021")))
    gitlab = config.get("integrations", {}).get("gitlab", {})
    old_redirect = f"{installation.get('appUrl', 'http://localhost:4021')}/v1/core/gitlab/oauth/callback"
    if gitlab.get("oauthRedirectUri") == old_redirect:
        gitlab["oauthRedirectUri"] = f"{installation['apiBaseUrl']}/v1/core/gitlab/oauth/callback"
    return config


def default_api_base_url(app_url):
    if app_url == "http://localhost:4021":
        return "http://localhost:4020"
    match = re.fullmatch(r"https://([A-Za-z0-9-]+)\.([A-Za-z0-9.-]+)", app_url)
    if not match:
        raise ConfigError("installation.apiBaseUrl is required for this appUrl")
    return f"https://{match[1]}-api.{match[2]}"


def gateway_domain(installation):
    if installation.get("mode", "local") == "local":
        return ""
    match = re.fullmatch(r"https://([A-Za-z0-9.-]+)", installation.get("appUrl", ""))
    if not match:
        raise ConfigError("installation.appUrl must be an exact HTTPS origin")
    return match[1]


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if not isinstance(key, str) or key in result:
            raise ConfigError("YAML contains a duplicate or non-string mapping key")
        result[key] = loader.construct_object(value_node)
    return result


UniqueLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping
)


def nested_get(root, path):
    current = root
    for part in path:
        if not isinstance(current, dict):
            return (False, None)
        if part not in current:
            return (False, None)
        current = current[part]
    return (True, current)


def format_value(key, value, kind):
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ConfigError(f"{key} must be a boolean")
        return "true" if value else "false"
    if kind == "integer":
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ConfigError(f"{key} must be a non-negative integer")
        return str(value)
    if kind == "json-object":
        if not isinstance(value, dict):
            raise ConfigError(f"{key} must be a mapping")
        try:
            return json.dumps(
                value, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
        except (TypeError, ValueError):
            raise ConfigError(
                f"{key} must contain JSON-compatible values; quote dates and identifiers"
            ) from None
    if not isinstance(value, str):
        raise ConfigError(f"{key} must be a string")
    if "\n" in value or "\r" in value:
        raise ConfigError(f"{key} cannot contain a newline")
    return value


def validate_known_fields(config):
    allowed = {}
    for path, _kind in FIELDS.values():
        current = allowed
        for part in path[:-1]:
            current = current.setdefault(part, {})
        current[path[-1]] = None
    allowed["notifications"] = {
        "enabled": None,
        "providers": None,
        "routes": None,
    }

    def walk(value, schema, prefix=""):
        if schema is None:
            return
        if not isinstance(value, dict):
            raise ConfigError(f"{prefix or 'configuration'} must be a mapping")
        for name, child in value.items():
            path = f"{prefix}.{name}" if prefix else name
            if name not in schema:
                raise ConfigError(f"unknown YAML setting: {path}")
            walk(child, schema[name], path)

    walk({key: value for key, value in config.items() if key != "version"}, allowed)


def validate_logs_configuration(config):
    present, logs = nested_get(config, ("observability", "logs"))
    if not present:
        return
    if not isinstance(logs, dict) or set(logs) - {"retentionDays", "clickhouse"}:
        raise ConfigError("observability.logs must contain clickhouse and optional retentionDays")
    retention = logs.get("retentionDays", 7)
    if type(retention) is not int or not 1 <= retention <= 365:
        raise ConfigError("observability.logs.retentionDays must be an integer between 1 and 365")
    backend = logs.get("clickhouse")
    required = {"endpoint", "database", "username", "password"}
    if not isinstance(backend, dict) or set(backend) != required:
        raise ConfigError("observability.logs.clickhouse requires endpoint, database, username, and password")
    if any(not isinstance(backend[key], str) or not backend[key] for key in required):
        raise ConfigError("ClickHouse configuration values must be non-empty strings")
    url = urlsplit(backend["endpoint"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ConfigError("ClickHouse endpoint must be an HTTP(S) origin without credentials, path, query, or fragment")
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", backend["database"]):
        raise ConfigError("ClickHouse database must be a simple SQL identifier")


def to_env(config):
    if (
        not isinstance(config, dict)
        or type(config.get("version")) is not int
        or config["version"] != 1
    ):
        raise ConfigError("YAML must declare version: 1")
    validate_known_fields(config)
    validate_logs_configuration(config)
    values = {}
    for key, (path, kind) in FIELDS.items():
        if key == "TOWBAR_NOTIFICATION_CONFIG_JSON":
            notifications = config.get("notifications", {})
            if not isinstance(notifications, dict):
                raise ConfigError("notifications must be a mapping")
            content = {name: item for name, item in notifications.items() if name != "enabled"}
            if content:
                values[key] = format_value(key, content, kind)
            continue
        present, value = nested_get(config, path)
        if present:
            values[key] = format_value(key, value, kind)
    mode = values.get("TOWBAR_INSTALL_MODE", "local")
    if mode not in ("local", "public"):
        raise ConfigError("installation.mode must be local or public")
    values["TOWBAR_GATEWAY_DOMAIN"] = gateway_domain(config.get("installation", {}))
    api_url = values.get("TOWBAR_API_BASE_URL")
    if api_url is None:
        api_url = default_api_base_url(values.get("TOWBAR_APP_BASE_URL", "http://localhost:4021"))
        values["TOWBAR_API_BASE_URL"] = api_url
    if mode == "public":
        match = re.fullmatch(r"https://([A-Za-z0-9.-]+)", api_url)
        if not match or api_url == values.get("TOWBAR_APP_BASE_URL"):
            raise ConfigError("installation.apiBaseUrl must be a separate HTTPS origin")
        values["TOWBAR_GATEWAY_API_DOMAIN"] = match[1]
    elif api_url != "http://localhost:4020":
        raise ConfigError("local installation.apiBaseUrl must be http://localhost:4020")
    values = {"COMPOSE_PROFILES": mode, **values}
    return values


def read_yaml(path, remove_legacy_proxy=False):
    if path.is_symlink():
        raise ConfigError("YAML configuration must be a regular file")
    details = path.stat()
    if not stat.S_ISREG(details.st_mode):
        raise ConfigError("YAML configuration must be a regular file")
    if os.geteuid() == 0 and (
        details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise ConfigError("YAML configuration must be owned by root with mode 600")
    try:
        config = yaml.load(path.read_text(), Loader=UniqueLoader)
    except yaml.YAMLError as error:
        line = getattr(getattr(error, "problem_mark", None), "line", None)
        suffix = f" near line {line + 1}" if line is not None else ""
        raise ConfigError(f"invalid YAML{suffix}") from None
    gateway_removed = False
    if isinstance(config, dict):
        installation = config.get("installation")
        if isinstance(installation, dict) and "gatewayDomain" in installation:
            if installation.pop("gatewayDomain") != gateway_domain(installation):
                raise ConfigError("legacy installation.gatewayDomain must match installation.appUrl")
            gateway_removed = True
    if remove_legacy_proxy and isinstance(config, dict):
        changed = gateway_removed
        security = config.get("security")
        if isinstance(security, dict) and "trustedProxyHops" in security:
            del security["trustedProxyHops"]
            changed = True
        installation = config.get("installation")
        if isinstance(installation, dict) and "apiBaseUrl" not in installation:
            installation["apiBaseUrl"] = default_api_base_url(installation.get("appUrl", "http://localhost:4021"))
            changed = True
        if isinstance(installation, dict):
            integrations = config.get("integrations")
            gitlab = integrations.get("gitlab", {}) if isinstance(integrations, dict) else {}
            old_redirect = f"{installation.get('appUrl', 'http://localhost:4021')}/v1/core/gitlab/oauth/callback"
            if isinstance(gitlab, dict) and gitlab.get("oauthRedirectUri") == old_redirect:
                gitlab["oauthRedirectUri"] = f"{installation['apiBaseUrl']}/v1/core/gitlab/oauth/callback"
                changed = True
        if changed:
            to_env(config)
            atomic_write(path, yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
    to_env(config)
    return config


def atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initialize(yaml_path):
    if yaml_path.exists() or yaml_path.is_symlink():
        raise ConfigError("runtime configuration already exists")
    config = {
        "version": 1,
        "installation": {
            "mode": "local",
            "bindAddress": "127.0.0.1",
            "port": 4021,
            "apiPort": 4020,
            "temporalUiPort": 8233,
            "networkName": "towbar-platform",
            "appUrl": "http://localhost:4021",
            "apiBaseUrl": "http://localhost:4020",
        },
        "database": {
            "postgresPassword": secrets.token_hex(32),
            "runtimePassword": secrets.token_hex(32),
        },
        "security": {
            "credentialsKey": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
            "internalHmacSecret": secrets.token_hex(32),
        },
    }
    to_env(config)
    atomic_write(yaml_path, yaml.safe_dump(config, sort_keys=False, allow_unicode=True))


def migrate(env_path, yaml_path, preserve_legacy):
    if yaml_path.exists():
        read_yaml(yaml_path, remove_legacy_proxy=True)
        return
    if env_path.is_symlink():
        raise ConfigError("legacy environment configuration must be a regular file")
    details = env_path.stat()
    if not stat.S_ISREG(details.st_mode):
        raise ConfigError("legacy environment configuration must be a regular file")
    if os.geteuid() == 0 and (
        details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise ConfigError("legacy environment configuration must be owned by root with mode 600")
    values = parse_env(env_path, remove_legacy_proxy=True)
    config = from_env(values)
    rendered = to_env(config)
    for key, value in values.items():
        if key in ("COMPOSE_PROFILES", "TOWBAR_GATEWAY_DOMAIN", "TOWBAR_GATEWAY_API_DOMAIN"):
            continue
        if (
            key == "TOWBAR_GITLAB_OAUTH_REDIRECT_URI"
            and value == f"{values.get('TOWBAR_APP_BASE_URL', 'http://localhost:4021')}/v1/core/gitlab/oauth/callback"
        ):
            continue
        kind = FIELDS[key][1]
        if parse_value(key, value, kind) != parse_value(key, rendered[key], kind):
            raise ConfigError(f"conversion mismatch for {key}")
    if preserve_legacy:
        legacy_path = env_path.with_name(f"{env_path.name}.legacy")
        if legacy_path.exists():
            if legacy_path.read_bytes() != env_path.read_bytes():
                raise ConfigError("existing legacy configuration copy differs from the current environment file")
        else:
            descriptor = os.open(legacy_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output, env_path.open("rb") as source:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
    atomic_write(yaml_path, yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
    read_yaml(yaml_path)


def render(yaml_path, env_path):
    values = to_env(read_yaml(yaml_path))
    lines = []
    for key, value in values.items():
        if re.fullmatch(r"[A-Za-z0-9_./:@%+=-]*", value):
            lines.append(f"{key}={value}\n")
        else:
            escaped = value.replace("'", "\\'")
            lines.append(f"{key}='{escaped}'\n")
    atomic_write(env_path, "".join(lines))


def compare(yaml_path, env_path):
    expected = to_env(read_yaml(yaml_path))
    actual = parse_env(env_path)
    if set(actual) != set(expected):
        raise ConfigError("derived Compose configuration is out of date")
    for key, value in expected.items():
        if key in ("COMPOSE_PROFILES", "TOWBAR_GATEWAY_DOMAIN", "TOWBAR_GATEWAY_API_DOMAIN"):
            if actual[key] != value:
                raise ConfigError("derived Compose configuration is out of date")
            continue
        kind = FIELDS[key][1]
        if parse_value(key, actual[key], kind) != parse_value(key, value, kind):
            raise ConfigError("derived Compose configuration is out of date")


def set_installation(yaml_path, mode, app_url, api_base_url):
    config = read_yaml(yaml_path)
    installation = config.setdefault("installation", {})
    installation.update(
        {
            "mode": mode,
            "appUrl": app_url,
            "apiBaseUrl": api_base_url,
            "bindAddress": "127.0.0.1",
        }
    )
    config.setdefault("integrations", {}).setdefault("gitlab", {})[
        "oauthRedirectUri"
    ] = f"{api_base_url}/v1/core/gitlab/oauth/callback"
    to_env(config)
    atomic_write(yaml_path, yaml.safe_dump(config, sort_keys=False, allow_unicode=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("init", "migrate", "render", "validate", "compare", "set-installation")
    )
    parser.add_argument("--yaml", type=Path, required=True)
    parser.add_argument("--env", type=Path)
    parser.add_argument("--preserve-legacy", action="store_true")
    parser.add_argument("--mode", choices=("local", "public"))
    parser.add_argument("--app-url")
    parser.add_argument("--api-base-url")
    args = parser.parse_args()
    if args.command in ("migrate", "render", "compare") and args.env is None:
        parser.error("--env is required")
    if args.command == "set-installation" and (
        args.mode is None
        or args.app_url is None
        or args.api_base_url is None
    ):
        parser.error("set-installation needs --mode, --app-url, and --api-base-url")
    try:
        if args.command == "init":
            initialize(args.yaml)
        elif args.command == "migrate":
            migrate(args.env, args.yaml, args.preserve_legacy)
        elif args.command == "render":
            render(args.yaml, args.env)
        elif args.command == "compare":
            compare(args.yaml, args.env)
        elif args.command == "set-installation":
            set_installation(args.yaml, args.mode, args.app_url, args.api_base_url)
        else:
            read_yaml(args.yaml)
    except (ConfigError, OSError) as error:
        sys.exit(f"Towbar: {error}")


if __name__ == "__main__":
    main()
