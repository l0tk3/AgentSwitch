"""The `secret-gate` CLI as a client of the gate service (gate-service-v0 §4).

When the gate service is installed (`gate-service.json`, service_paths.client_socket; its socket need not be up), `main`
asks `route` for the service-mode version of the parsed command. Outputs and exit codes stay exactly what the
daemon and the Mac app parse today; only where the answer comes from changes:

* `keys [--json]`, `pubkey`, `enc`: the public key in `keys.json`;
* `refs register|release`, `logs tail`: calls on `gate.sock`;
* `fill-value`: `browser.resolve` on `gate.sock`, once per frame host;
* `mcp`, `browser`: unchanged here; they pick their remote backend themselves (mcp_backend, browser_mcp);
* `keygen`, `check`, `proxy`, `service`, `install-ca`, `rpc`: refused, the service owns them (its key is made by
  `system install` and replaced by `system rotate-key`, both as root).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from functools import partial
from pathlib import Path
from typing import Any

from .enc_cli import run_enc
from .errors import ValidationError
from .fill_cli import fill_value_remote
from .keystore import parse_public_key
from .publish import KeyRow, current_public_key, read_rows
from .refs_cli import check_tokens, print_register, read_request
from .rpc_client import RpcClient
from .service_paths import SERVICE_REFUSAL

REFUSED_COMMANDS = frozenset({"keygen", "check", "proxy", "service", "install-ca", "rpc"})
Command = Callable[[argparse.Namespace], int]


def print_keys(rows: Sequence[KeyRow], as_json: bool) -> None:
    """The one output format of `secret-gate keys`, with or without the service."""
    if as_json:
        print(json.dumps([r.cli_json() for r in rows]))
        return
    for r in rows:
        print(f"{'*' if r.current else ' '} {r.name:20} {r.public_key}")


def _refuse(_: argparse.Namespace) -> int:
    print(f"error: {SERVICE_REFUSAL}", file=sys.stderr)
    return 2


def _keys(args: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    print_keys(read_rows(public), args.json)
    return 0


def _pubkey(_: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    rows = read_rows(public)
    current_public_key(rows)  # the service's "no current key" message when there is none
    print(next(r.public_key for r in rows if r.current))
    return 0


def _enc(args: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    key = parse_public_key(args.pubkey) if args.pubkey else current_public_key(read_rows(public))
    return run_enc(args, key)


def _refs(args: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    if args.refs_cmd == "register":
        data = read_request({"scope", "tokens"})
        check_tokens(data["tokens"])
        return print_register(_register_result(client.call("refs.register", data)))
    data = read_request({"scope"})
    print(json.dumps(client.call("refs.release", data)))
    return 0


def _register_result(result: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(result, dict) or not isinstance(result.get("refs"), list):
        raise ValidationError("凭据网关服务返回了无效的响应")
    return result


def _logs(args: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    from .cli import print_log  # local import: cli imports this module

    result = client.call("logs.tail", {"name": args.name, "lines": args.lines})
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise ValidationError("凭据网关服务返回了无效的响应")
    print_log(result["text"], args.json or args.json_parent)
    return 0


def _bootstrap(args: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    from .bootstrap import run_bootstrap  # local import: bootstrap pulls in the harness snippets

    return run_bootstrap(args, service_public=public)


_ROUTES: dict[str, Callable[..., int]] = {
    "keys": _keys, "pubkey": _pubkey, "enc": _enc, "refs": _refs, "bootstrap": _bootstrap, "logs": _logs,
    "fill-value": fill_value_remote,
}


def route(args: argparse.Namespace, sock: Path) -> Command:
    """The service-mode implementation of a parsed command (the command itself when it needs no change)."""
    if args.cmd in REFUSED_COMMANDS:
        return _refuse
    handler = _ROUTES.get(args.cmd)
    if handler is None:
        return args.fn
    return partial(handler, client=RpcClient(sock), public=sock.parent)
