#!/usr/bin/env python3
"""Isolated fictional-data prototype; NOT a production gate endpoint.

Run with the package's existing .venv Python. No key files, network listeners,
model calls or daemon imports are used. Every process generates an ephemeral
keypair in memory, using the actual secret_gate sealed-box/policy/resolver code.

--server is a private JSONL pipe for the trusted demo browser driver. Requests
have an integer id and action. Successful replies use {id, ok: true, ...}; errors
use a fixed code/message and never echo arguments or exception text. Operations:

register(scope, value, label, host, uses=['http']) -> ref, tokenLength, refLength
describe(scope, ref) -> ref, label, kind, hosts, uses
resolve(scope, ref, host, use) -> value (TRUSTED DRIVER ONLY; NEVER model output)
relabel(scope, ref, label) -> metadata (reference identity remains unchanged)
export(scope, ref) -> token, label (ciphertext only, no key persistence)
restore(scope, token, label?) -> ref, tokenLength, refLength
release(scope) -> released (count); closes that scope permanently

The registry stores only ciphertext and metadata. Random reference identity and
scope are separate from the descriptive label. Releasing mappings does not
revoke the original ciphertext. Restore is an explicit trusted-driver action,
not a model-callable capability; it works only in this process/key lifetime.

--self-test prints and optionally writes metadata/check outcomes only. Fixtures
are explicitly fictional. This prototype supports secret-kind values, exact
hosts and http/exec uses; it does not infer PII or make new permission grants.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from secret_gate.constants import LABEL_PATTERN  # noqa: E402
from secret_gate.crypto import generate_keypair  # noqa: E402
from secret_gate.errors import GateError, PolicyViolation, TokenError  # noqa: E402
from secret_gate.policy import SecretPayload, normalize_host  # noqa: E402
from secret_gate.resolver import Resolver  # noqa: E402
from secret_gate.tokens import make_token  # noqa: E402


class DemoError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Entry:
    scope: str
    token: str
    label: str


class DemoGate:
    """In-memory trusted component; only opaque references leave for a model."""

    def __init__(self) -> None:
        keys = generate_keypair()
        self.public_key = keys.public
        self._resolver = Resolver(keys.private)
        self._entries: dict[str, Entry] = {}
        self._released: set[str] = set()

    @staticmethod
    def _string(value: Any, *, maximum: int = 4096) -> str:
        if not isinstance(value, str) or not value or len(value) > maximum:
            raise DemoError("invalid_request", "Invalid demo request.")
        return value

    def _scope(self, value: Any) -> str:
        scope = self._string(value, maximum=128)
        if scope in self._released:
            raise DemoError("scope_released", "The execution scope has been released.")
        return scope

    def _entry(self, scope: Any, ref: Any) -> Entry:
        valid_scope = self._scope(scope)
        entry = self._entries.get(self._string(ref, maximum=128))
        if entry is None:
            raise DemoError("unknown_reference", "The reference is unavailable.")
        if entry.scope != valid_scope:
            raise DemoError("scope_mismatch", "The reference belongs to a different scope.")
        return entry

    def _label(self, value: Any) -> str:
        label = self._string(value, maximum=64)
        if LABEL_PATTERN.fullmatch(label) is None:
            raise DemoError("invalid_request", "Invalid demo request.")
        return label

    def _add(self, scope: str, token: str, label: str) -> dict[str, Any]:
        ref = "enc:ref:" + secrets.token_urlsafe(12)
        while ref in self._entries:
            ref = "enc:ref:" + secrets.token_urlsafe(12)
        self._entries[ref] = Entry(scope=scope, token=token, label=label)
        return {"ref": ref, "tokenLength": len(token), "refLength": len(ref)}

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        scope = self._scope(request.get("scope"))
        if action == "register":
            host = normalize_host(self._string(request.get("host"), maximum=255))
            if "*" in host:
                raise DemoError("invalid_request", "Demo registration requires an exact host.")
            uses = request.get("uses", ["http"])
            if (not isinstance(uses, list) or not uses
                    or any(use not in ("http", "exec") for use in uses)):
                raise DemoError("invalid_request", "Demo registration supports http and exec uses.")
            label = self._label(request.get("label"))
            payload = SecretPayload.create(
                value=self._string(request.get("value")), hosts=[host], uses=uses, label=label,
            )
            return self._add(scope, make_token(self.public_key, payload), label)
        if action == "release":
            refs = [ref for ref, entry in self._entries.items() if entry.scope == scope]
            for ref in refs:
                del self._entries[ref]
            self._released.add(scope)
            return {"released": len(refs)}
        if action == "restore":
            token = self._string(request.get("token"), maximum=16384)
            metadata = self._resolver.describe(token)
            label = self._label(request.get("label", metadata["label"]))
            return self._add(scope, token, label)
        if action not in ("describe", "resolve", "relabel", "export"):
            raise DemoError("unknown_action", "Unknown demo action.")
        ref = request.get("ref")
        entry = self._entry(scope, ref)
        if action == "resolve":
            host = normalize_host(self._string(request.get("host"), maximum=255))
            use = self._string(request.get("use"), maximum=16)
            # The existing resolver is the authority for the sealed host/use policy.
            return {"value": self._resolver.resolve(entry.token, host=host, use=use).value}
        if action == "export":
            return {"token": entry.token, "label": entry.label}
        if action == "relabel":
            entry.label = self._label(request.get("label"))
        metadata = self._resolver.describe(entry.token)
        metadata["label"] = entry.label
        return {"ref": ref, **metadata}

    def handle(self, request: Any) -> dict[str, Any]:
        request_id = request.get("id") if isinstance(request, dict) else None
        if isinstance(request_id, bool) or not isinstance(request_id, int):
            request_id = None
        try:
            if not isinstance(request, dict) or request_id is None:
                raise DemoError("invalid_request", "Requests require an integer id and object body.")
            return {"id": request_id, "ok": True, **self.dispatch(request)}
        except DemoError as exc:
            return {"id": request_id, "ok": False, "code": exc.code, "message": exc.message}
        except PolicyViolation:
            return {"id": request_id, "ok": False, "code": "policy_denied", "message": "The sealed policy denies this operation."}
        except TokenError:
            return {"id": request_id, "ok": False, "code": "invalid_token", "message": "The ciphertext is invalid or belongs to another gate."}
        except (GateError, TypeError, ValueError):
            return {"id": request_id, "ok": False, "code": "invalid_request", "message": "Invalid demo request."}
        except Exception:
            return {"id": request_id, "ok": False, "code": "internal_error", "message": "The isolated demo could not process this request."}


def serve() -> None:
    gate = DemoGate()
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            reply = {"id": None, "ok": False, "code": "invalid_json", "message": "A JSON object is required."}
        else:
            reply = gate.handle(request)
        print(json.dumps(reply, separators=(",", ":")), flush=True)


def self_test() -> dict[str, Any]:
    gate = DemoGate()
    sequence = 0
    checks: list[dict[str, Any]] = []

    def call(action: str, **kwargs: Any) -> dict[str, Any]:
        nonlocal sequence
        sequence += 1
        return gate.handle({"id": sequence, "action": action, **kwargs})

    def check(name: str, passed: bool) -> None:
        checks.append({"name": name, "passed": bool(passed)})

    fixture_a = "FICTIONAL-demo-value-A-only"
    fixture_b = "FICTIONAL-demo-value-B-only"
    host = "destination.example.test:8443"
    a = call("register", scope="fictional-task-a", value=fixture_a, label="acct1/pass", host=host)
    b = call("register", scope="fictional-task-b", value=fixture_b, label="acct1/pass", host=host)
    check("same_label_has_distinct_random_references", a["ok"] and b["ok"] and a["ref"] != b["ref"])
    ra = call("resolve", scope="fictional-task-a", ref=a["ref"], host=host, use="http")
    rb = call("resolve", scope="fictional-task-b", ref=b["ref"], host=host, use="http")
    check("same_label_does_not_mix_values", ra.get("value") == fixture_a and rb.get("value") == fixture_b)
    wrong_scope = call("resolve", scope="fictional-task-b", ref=a["ref"], host=host, use="http")
    check("wrong_scope_is_denied", wrong_scope.get("code") == "scope_mismatch")
    wrong_host = call("resolve", scope="fictional-task-a", ref=a["ref"], host="other.example.test:8443", use="http")
    check("wrong_host_is_denied", wrong_host.get("code") == "policy_denied")
    wrong_port = call("resolve", scope="fictional-task-a", ref=a["ref"], host="destination.example.test:9443", use="http")
    check("wrong_port_is_denied", wrong_port.get("code") == "policy_denied")
    wrong_use = call("resolve", scope="fictional-task-a", ref=a["ref"], host=host, use="exec")
    check("wrong_use_is_denied", wrong_use.get("code") == "policy_denied")
    before = call("export", scope="fictional-task-a", ref=a["ref"])
    corrected = call("relabel", scope="fictional-task-a", ref=a["ref"], label="acct1/totp-seed")
    after = call("export", scope="fictional-task-a", ref=a["ref"])
    check("metadata_correction_preserves_reference_and_ciphertext", corrected.get("ref") == a["ref"] and before.get("token") == after.get("token") and corrected.get("label") == "acct1/totp-seed")
    check("metadata_correction_does_not_change_permission", corrected.get("kind") == "secret" and corrected.get("uses") == ["http"] and corrected.get("hosts") == [host])
    metadata = call("describe", scope="fictional-task-a", ref=a["ref"])
    check("metadata_contains_no_value_or_ciphertext", fixture_a not in json.dumps(metadata) and "value" not in metadata and "token" not in metadata)
    check("random_reference_is_shorter_than_ciphertext", a["refLength"] == 24 and a["refLength"] < a["tokenLength"])
    token = before["token"]
    check("uses_real_authenticated_sealed_box", token.startswith("enc:v1:") and fixture_a not in token)
    foreign = DemoGate().handle({"id": 1, "action": "restore", "scope": "foreign-gate", "token": token})
    check("different_ephemeral_key_cannot_restore", foreign.get("code") == "invalid_token")
    altered_token = token[:20] + ("A" if token[20] != "A" else "B") + token[21:]
    tampered = call("restore", scope="tampered", token=altered_token)
    check("tampered_ciphertext_is_rejected", tampered.get("code") == "invalid_token")
    released = call("release", scope="fictional-task-a")
    stale = call("resolve", scope="fictional-task-a", ref=a["ref"], host=host, use="http")
    check("released_scope_is_unusable", released.get("released") == 1 and stale.get("code") == "scope_released")
    reopening = call("register", scope="fictional-task-a", value=fixture_a, label="acct1/pass", host=host)
    check("released_scope_cannot_be_reopened", reopening.get("code") == "scope_released")
    original_value = gate._resolver.resolve(token, use="http", host=host).value
    check("releasing_reference_does_not_revoke_original_ciphertext", original_value == fixture_a)
    restored = call("restore", scope="fictional-followup", token=token, label=after["label"])
    continued = call("resolve", scope="fictional-followup", ref=restored["ref"], host=host, use="http")
    check("trusted_restore_supports_continuation", restored["ref"] != a["ref"] and continued.get("value") == fixture_a)
    denied_again = call("resolve", scope="fictional-followup", ref=restored["ref"], host="other.example.test", use="http")
    check("restoration_retains_original_policy", denied_again.get("code") == "policy_denied")
    still_b = call("resolve", scope="fictional-task-b", ref=b["ref"], host=host, use="http")
    check("releasing_one_scope_does_not_affect_another", still_b.get("value") == fixture_b)
    malformed = call("register", scope="invalid", value=fixture_a, label=fixture_a + "\n", host=host)
    check("error_output_does_not_echo_arguments", not malformed["ok"] and fixture_a not in json.dumps(malformed))
    return {
        "demo": "fictional-scoped-reference-registry",
        "fictionalDataOnly": True,
        "ephemeralInMemoryKeys": True,
        "productionIntegrated": False,
        "passed": all(item["passed"] for item in checks),
        "checks": checks,
        "measurements": {"referenceCharacters": a["refLength"], "ciphertextCharacters": a["tokenLength"], "checksPassed": sum(item["passed"] for item in checks), "checksTotal": len(checks)},
        "limitations": ["Reference release removes mappings, not ciphertext capability.", "Restore requires the same ephemeral key lifetime and trusted driver.", "No real model, production daemon, persistent keys or network listener."],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--server", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.server:
        serve()
        return 0
    result = self_test()
    rendered = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
