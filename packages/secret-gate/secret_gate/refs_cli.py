"""`secret-gate refs register|release`: the dispatcher's side of task-scoped references (gate-next-v0 §1).

Trusted caller only (the AgentSwitch daemon). The scope travels on stdin, never in argv, where any
process of the same user could read it. Output holds references and policy metadata; never a value.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .errors import GateError, RefError, ValidationError
from .keystore import gate_home
from .refs import RefRegistry, check_scope
from .resolver import Resolver
from .tokens import is_token

MAX_REQUEST_CHARS = 1 << 20
MAX_TOKENS = 256


def read_request(keys: set[str]) -> dict[str, Any]:
    raw = sys.stdin.read(MAX_REQUEST_CHARS + 1)
    if len(raw) > MAX_REQUEST_CHARS:
        raise ValidationError("refs request too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValidationError("refs request must be a JSON object") from None
    if not isinstance(data, dict) or set(data) != keys:
        raise ValidationError(f"refs request needs exactly {sorted(keys)}")
    check_scope(data["scope"])
    return data


def check_tokens(tokens: Any) -> list[Any]:
    if not isinstance(tokens, list) or len(tokens) > MAX_TOKENS:
        raise ValidationError(f"tokens must be a list of at most {MAX_TOKENS}")
    return tokens


def register_tokens(resolver: Resolver, tokens: list[Any]) -> dict[str, list[dict[str, Any]]]:
    """One item per token, in order: its reference and policy metadata, or an error item. Never a value."""
    out: list[dict[str, Any]] = []
    for token in check_tokens(tokens):
        try:
            if not isinstance(token, str) or not is_token(token):
                raise ValidationError("not a complete enc:v1: token")
            info = resolver.describe(token)
            out.append({"ref": resolver.register(token), **{k: info[k] for k in ("label", "kind", "hosts", "uses")}})
        except RefError:
            raise  # the scope itself is unusable: the whole request fails
        except GateError:
            out.append({"error": "not a token of this gate (malformed, tampered, or made for another gate)"})
    return {"refs": out}


def print_register(result: dict[str, list[dict[str, Any]]]) -> int:
    print(json.dumps(result))
    return 0 if all("ref" in item for item in result["refs"]) else 1


def _cmd_register(_: argparse.Namespace) -> int:
    data = read_request({"scope", "tokens"})
    check_tokens(data["tokens"])
    resolver = Resolver.from_home(gate_home(), scope=data["scope"])
    return print_register(register_tokens(resolver, data["tokens"]))


def _cmd_release(_: argparse.Namespace) -> int:
    data = read_request({"scope"})
    print(json.dumps({"released": RefRegistry.from_home(gate_home()).release(data["scope"])}))
    return 0


def add_refs_parser(sub: argparse._SubParsersAction) -> None:
    r = sub.add_parser("refs", help="dispatcher: register / release task-scoped enc:ref: references (JSON on stdin)")
    rs = r.add_subparsers(dest="refs_cmd", required=True)
    rs.add_parser("register", help='stdin {"scope", "tokens": [...]} -> {"refs": [...]}').set_defaults(fn=_cmd_register)
    rs.add_parser("release", help='stdin {"scope"} -> {"released": n}').set_defaults(fn=_cmd_release)
