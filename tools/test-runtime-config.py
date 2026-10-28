#!/usr/bin/env python3

import base64
import importlib.util
import json
import os
import pathlib
import re
import stat
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "runtime_config", ROOT / "infra" / "runtime_config.py"
)
config_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(config_tool)


LEGACY_ENV = """COMPOSE_PROFILES=local
TOWBAR_INSTALL_MODE=local
TOWBAR_PORT=4021
TOWBAR_APP_BASE_URL=http://localhost:4021
"""


class RuntimeConfigTests(unittest.TestCase):
    def test_optional_assistant_settings_render_provider_configuration(self):
        values = config_tool.to_env({"version": 1, "assistant": {
            "apiKey": "local-provider-fixture", "model": "fixture-model",
            "baseUrl": "http://127.0.0.1:9000", "profile": "compatible",
            "maxTokens": 512, "headers": {"x-fixture": "true"},
        }})
        self.assertEqual(values["AGENT_API_KEY"], "local-provider-fixture")
        self.assertEqual(values["AGENT_MAX_TOKENS"], "512")
        self.assertEqual(json.loads(values["AGENT_HEADERS"]), {"x-fixture": "true"})
        self.assertNotIn("AGENT_API_KEY", config_tool.to_env({"version": 1}))

    def test_documented_runtime_yaml_examples(self):
        checked = 0
        for path in (ROOT / "docs" / "docs").rglob("*"):
            if path.suffix not in (".md", ".mdx"):
                continue
            examples = re.findall(
                r'```yaml title="/etc/towbar/config.yml"[^\n]*\n(.*?)\n```',
                path.read_text(),
                re.DOTALL,
            )
            for snippet in examples:
                with self.subTest(path=path.relative_to(ROOT)):
                    config = config_tool.yaml.load(
                        snippet, Loader=config_tool.UniqueLoader
                    )
                    config_tool.to_env({"version": 1, **config})
                checked += 1
        self.assertGreaterEqual(checked, 10)

    def test_initialization_creates_private_yaml_with_independent_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.yml"
            config_tool.initialize(path)
            config = config_tool.read_yaml(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(config["installation"]["appUrl"], "http://localhost:4021")
            self.assertEqual(config["installation"]["apiBaseUrl"], "http://localhost:4020")
            values = [
                config["database"]["postgresPassword"],
                config["database"]["runtimePassword"],
                config["security"]["internalHmacSecret"],
            ]
            for value in values:
                self.assertRegex(value, r"^[0-9a-f]{64}$")
            self.assertEqual(len(set(values)), 3)
            self.assertEqual(len(base64.b64decode(config["security"]["credentialsKey"], validate=True)), 32)
            self.assertEqual(list(path.parent.iterdir()), [path])
            original = path.read_bytes()
            with self.assertRaisesRegex(config_tool.ConfigError, "already exists"):
                config_tool.initialize(path)
            self.assertEqual(path.read_bytes(), original)

    def test_legacy_env_migrates_without_changing_effective_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = root / "towbar.env"
            yml = root / "config.yml"
            env.write_text(LEGACY_ENV)
            original = config_tool.parse_env(env)
            config_tool.migrate(env, yml, True)
            config_tool.migrate(env, yml, True)
            config_tool.render(yml, env)
            config_tool.compare(yml, env)
            self.assertEqual(
                config_tool.from_env(original),
                config_tool.from_env(config_tool.parse_env(env)),
            )
            self.assertEqual(
                (root / "towbar.env.legacy").read_text(),
                LEGACY_ENV,
            )
            self.assertEqual(stat.S_IMODE(yml.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
            yml.write_text(yml.read_text().replace("port: 4021", "port: 4022"))
            with self.assertRaisesRegex(config_tool.ConfigError, "out of date"):
                config_tool.compare(yml, env)

    def test_all_optional_fields_and_nested_json_round_trip(self):
        values = {"COMPOSE_PROFILES": "local"}
        for key, (_, kind) in config_tool.FIELDS.items():
            if kind == "boolean":
                values[key] = "true"
            elif kind == "integer":
                values[key] = "12"
            elif kind == "json-object":
                values[key] = json.dumps({"example": ["one", "two"]})
            else:
                values[key] = "some-value"
        values["TOWBAR_INSTALL_MODE"] = "local"
        values["TOWBAR_APP_BASE_URL"] = "http://localhost:4021"
        values["TOWBAR_API_BASE_URL"] = "http://localhost:4020"
        values["TOWBAR_NOTIFICATION_CONFIG_JSON"] = json.dumps(
            {"providers": {}, "routes": []}
        )
        values["TOWBAR_LOGS_CONFIG_JSON"] = json.dumps({
            "retentionDays": 7,
            "clickhouse": {"endpoint": "https://logs.example.com:8443", "database": "towbar_logs", "username": "towbar", "password": "test-password"},
        })
        converted = config_tool.from_env(values)
        self.assertEqual(
            converted["notifications"]["routes"], []
        )
        self.assertEqual(
            config_tool.from_env(config_tool.to_env(converted)), converted
        )

    def test_secret_characters_survive_rendering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            yml = root / "config.yml"
            env = root / "towbar.env"
            secret = "can't use $OTHER # this value"
            config = {
                "version": 1,
                "installation": {"mode": "local"},
                "security": {"internalHmacSecret": secret},
                "notifications": {
                    "enabled": True,
                    "providers": {
                        "webhook": [
                            {
                                "id": "ops",
                                "headers": {"Authorization": "Bearer $OTHER"},
                            }
                        ]
                    },
                },
            }
            yml.write_text(config_tool.yaml.safe_dump(config))
            config_tool.render(yml, env)
            rendered = config_tool.parse_env(env)
            self.assertEqual(rendered["TOWBAR_INTERNAL_HMAC_SECRET"], secret)
            self.assertEqual(
                json.loads(rendered["TOWBAR_NOTIFICATION_CONFIG_JSON"]),
                {key: value for key, value in config["notifications"].items() if key != "enabled"},
            )

    def test_invalid_and_unknown_settings_fail_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = root / "towbar.env"
            yml = root / "config.yml"
            env.write_text("TOWBAR_INSTALL_MODE=local\nCUSTOM_TOKEN=secret\n")
            with self.assertRaisesRegex(config_tool.ConfigError, "CUSTOM_TOKEN"):
                config_tool.migrate(env, yml, False)
            self.assertFalse(yml.exists())
            yml.write_text("version: 1\ninstallation:\n  mode: local\n  typo: secret\n")
            with self.assertRaisesRegex(config_tool.ConfigError, "installation.typo"):
                config_tool.read_yaml(yml)
            yml.write_text("version: 1\ninstallation:\n  mode: local\n  mode: public\n")
            with self.assertRaisesRegex(config_tool.ConfigError, "duplicate"):
                config_tool.read_yaml(yml)

    def test_installation_url_can_change_after_an_interrupted_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            yml = root / "config.yml"
            env = root / "towbar.env"
            config_tool.initialize(yml)
            config_tool.set_installation(
                yml, "public", "https://towbar.example.com", "https://towbar-api.example.com"
            )
            config_tool.render(yml, env)
            values = config_tool.parse_env(env)
            self.assertEqual(values["COMPOSE_PROFILES"], "public")
            self.assertEqual(values["TOWBAR_GATEWAY_DOMAIN"], "towbar.example.com")
            self.assertEqual(values["TOWBAR_GATEWAY_API_DOMAIN"], "towbar-api.example.com")
            self.assertEqual(values["TOWBAR_API_BASE_URL"], "https://towbar-api.example.com")
            self.assertEqual(
                values["TOWBAR_GITLAB_OAUTH_REDIRECT_URI"],
                "https://towbar-api.example.com/v1/core/gitlab/oauth/callback",
            )
            config = config_tool.read_yaml(yml)
            config["installation"]["apiBaseUrl"] = config["installation"]["appUrl"]
            with self.assertRaisesRegex(config_tool.ConfigError, "separate HTTPS origin"):
                config_tool.to_env(config)

    def test_gateway_domain_is_derived_and_cannot_be_overridden(self):
        config = {"version": 1, "installation": {"mode": "public", "appUrl": "https://control.example.com", "apiBaseUrl": "https://api.example.com"}}
        self.assertEqual(config_tool.to_env(config)["TOWBAR_GATEWAY_DOMAIN"], "control.example.com")
        config["installation"]["gatewayDomain"] = "other.example.com"
        with self.assertRaisesRegex(config_tool.ConfigError, "unknown YAML setting"):
            config_tool.to_env(config)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.yml"
            config_tool.atomic_write(path, config_tool.yaml.safe_dump(config))
            with self.assertRaisesRegex(config_tool.ConfigError, "must match"):
                config_tool.read_yaml(path)

    def test_migration_removes_obsolete_proxy_trust_from_existing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = root / "towbar.env"
            yml = root / "config.yml"
            env.write_text("TOWBAR_INSTALL_MODE=local\nTOWBAR_TRUSTED_PROXY_HOPS=1\n")
            with self.assertRaisesRegex(config_tool.ConfigError, "TOWBAR_TRUSTED_PROXY_HOPS"):
                config_tool.parse_env(env)
            config_tool.migrate(env, yml, True)
            self.assertNotIn("trustedProxyHops", yml.read_text())
            self.assertIn(
                "TOWBAR_TRUSTED_PROXY_HOPS=1",
                (root / "towbar.env.legacy").read_text(),
            )
            yml.write_text(yml.read_text() + "security:\n  trustedProxyHops: 1\n")
            with self.assertRaisesRegex(config_tool.ConfigError, "security.trustedProxyHops"):
                config_tool.read_yaml(yml)
            config_tool.migrate(env, yml, True)
            self.assertNotIn("trustedProxyHops", yml.read_text())
            config_tool.render(yml, env)
            self.assertNotIn("TOWBAR_TRUSTED_PROXY_HOPS", env.read_text())

    def test_existing_public_yaml_migrates_api_origin_and_gitlab_redirect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            yml = root / "config.yml"
            env = root / "towbar.env"
            yml.write_text(
                "version: 1\ninstallation:\n  mode: public\n"
                "  appUrl: https://towbar.example.com\n"
                "  gatewayDomain: towbar.example.com\n"
                "integrations:\n  gitlab:\n"
                "    oauthRedirectUri: https://towbar.example.com/v1/core/gitlab/oauth/callback\n"
            )
            config_tool.migrate(env, yml, False)
            config = config_tool.read_yaml(yml)
            self.assertEqual(config["installation"]["apiBaseUrl"], "https://towbar-api.example.com")
            self.assertEqual(
                config["integrations"]["gitlab"]["oauthRedirectUri"],
                "https://towbar-api.example.com/v1/core/gitlab/oauth/callback",
            )
            self.assertNotIn("gatewayDomain", yml.read_text())
            self.assertEqual(config_tool.to_env(config)["TOWBAR_GATEWAY_DOMAIN"], "towbar.example.com")
            config_tool.render(yml, env)
            config_tool.compare(yml, env)
            legacy = root / "legacy.env"
            migrated = root / "migrated.yml"
            legacy.write_text(
                "COMPOSE_PROFILES=public\nTOWBAR_INSTALL_MODE=public\n"
                "TOWBAR_APP_BASE_URL=https://towbar.example.com\n"
                "TOWBAR_GATEWAY_DOMAIN=towbar.example.com\n"
                "TOWBAR_GITLAB_OAUTH_REDIRECT_URI=https://towbar.example.com/v1/core/gitlab/oauth/callback\n"
            )
            config_tool.migrate(legacy, migrated, False)
            self.assertEqual(
                config_tool.read_yaml(migrated)["integrations"]["gitlab"]["oauthRedirectUri"],
                "https://towbar-api.example.com/v1/core/gitlab/oauth/callback",
            )


if __name__ == "__main__":
    unittest.main()
