"""`secret-gate enc`: encrypt a value (or a JSON batch) to a public key. Values never touch argv in batch mode."""

from __future__ import annotations

import argparse
import getpass
import json
import sys

from .constants import KIND_SECRET, USE_HTTP
from .errors import GateError
from .policy import SecretPayload
from .tokens import make_token


def run_enc(args: argparse.Namespace, public: bytes) -> int:
    """`secret-gate enc` with the public key already chosen (gate home, --pubkey, or the service's keys.json)."""
    if args.batch:
        return _enc_batch(public)
    value = args.value if args.value is not None else _read_value(args.stdin)
    payload = SecretPayload.create(
        value=value, hosts=tuple(args.host), uses=set(args.use), label=args.label, kind=args.kind,
        seed_import_hosts=args.seed_import_host,
    )
    print(make_token(public, payload))
    return 0


def _enc_batch(public: bytes) -> int:
    """stdin: JSON array of {label, hosts?, kind?, uses?, value}; stdout: JSON array of results.

    Values never touch argv. A bad entry yields {"label", "error"} without aborting the others.
    """
    try:
        entries = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        print("error: batch input must be a JSON array", file=sys.stderr)
        return 2
    if not isinstance(entries, list):
        print("error: batch input must be a JSON array", file=sys.stderr)
        return 2
    results = []
    for entry in entries:
        label = entry.get("label") if isinstance(entry, dict) else None
        try:
            if not isinstance(entry, dict):
                raise GateError("entry must be an object")
            payload = SecretPayload.create(
                value=entry.get("value", ""),
                hosts=tuple(entry.get("hosts") or ()),
                uses=set(entry.get("uses") or [USE_HTTP]),
                label=label or "",
                kind=entry.get("kind", KIND_SECRET),
                seed_import_hosts=entry.get("seed_import_hosts", []),
            )
            results.append({"label": label, "token": make_token(public, payload)})
        except GateError as exc:
            results.append({"label": label, "error": str(exc)})
    print(json.dumps(results))
    return 0 if all("token" in r for r in results) else 1


def _read_value(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.read().rstrip("\n")
    return getpass.getpass("secret value (not echoed): ")
