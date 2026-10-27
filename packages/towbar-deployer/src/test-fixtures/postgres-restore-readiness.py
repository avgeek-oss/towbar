#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["RESTORE_READINESS_TEST_DIRECTORY"])
command = Path(sys.argv[0]).name
args = sys.argv[1:]
phase = (root / "phase").read_text()


def event(value):
    with (root / "events").open("a") as events:
        events.write(value + "\n")


def authenticated_tcp():
    expected = {"-h": "127.0.0.1", "-U": "restore_owner", "-d": "restore_db"}
    for flag, value in expected.items():
        if flag not in args or args[args.index(flag) + 1] != value:
            sys.exit("Expected the configured database over loopback TCP")
    if not os.environ.get("PGPASSWORD") or os.environ["PGPASSWORD"] != os.environ["POSTGRES_PASSWORD"]:
        sys.exit("Password authentication required")


if command == "docker":
    if args[:1] == ["run"]:
        (root / "container-env.json").write_text(json.dumps({
            name: os.environ[name] for name in ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"]
        }))
        print("candidate")
    elif args[:1] == ["exec"] and args[2:4] == ["sh", "-c"]:
        env = os.environ | json.loads((root / "container-env.json").read_text())
        os.execvpe("sh", args[2:], env)
    elif args[:1] in [["rm"], ["cp"]] or args[:3] == ["exec", "candidate", "rm"]:
        pass
    else:
        sys.exit("Unexpected Docker command: " + repr(args))
elif command == "pg_isready":
    # The image's temporary initialization server already accepts socket probes.
    event("socket-ready:" + phase)
elif command == "psql":
    authenticated_tcp()
    event("sql-probe:" + phase)
    if phase != "ready":
        sys.exit("TCP is unavailable until initialization finishes")
    print("1")
elif command == "pg_restore":
    event("restore:" + phase)
    if phase != "ready":
        sys.exit("FATAL: the database system is shutting down")
    authenticated_tcp()
elif command == "sleep":
    event("initialization-finished")
    (root / "phase").write_text("ready")
else:
    sys.exit("Unexpected fixture command: " + command)
