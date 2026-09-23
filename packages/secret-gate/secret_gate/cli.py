"""`secret-gate` command line: keygen | keys | pubkey | enc | check | proxy | mcp | install-ca."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import __version__
from .constants import (
    CA_CERT_FILE,
    DEFAULT_PROXY_PORT,
    KIND_SECRET,
    MITMPROXY_CA_PATH,
    PUBLIC_KEY_FILE,
    USE_HTTP,
    VALID_KINDS,
    VALID_USES,
)
from .crypto import generate_keypair
from .credential_repair import checked_token, credential_info, reissue_totp_seed
from .errors import GateError, ValidationError
from .keyring import create_keypair, list_keypairs, set_current
from .keystore import gate_home, load_private_key, load_public_key, parse_public_key, save_keypair
from .policy import SecretPayload
from .resolver import Resolver
from .tokens import make_token


def _cmd_keygen(args: argparse.Namespace) -> int:
    home = gate_home()
    if args.name:
        info = create_keypair(home, args.name)
        print(f"keypair {info.name!r} created under {info.path} ({'current' if info.current else 'not current'})")
        print(f"public key value: {info.public}")
        return 0
    priv, pub = save_keypair(home, generate_keypair(), overwrite=args.force)
    print(f"private key: {priv} (0600, keep it away from agents)")
    print(f"public key:  {pub}")
    print(f"public key value: {pub.read_text().strip()}")
    return 0


def _cmd_keys(args: argparse.Namespace) -> int:
    home = gate_home()
    if args.keys_cmd == "new":
        info = create_keypair(home, args.name)
        if args.use:
            set_current(home, args.name)
            info = next(k for k in list_keypairs(home) if k.name == args.name)
    elif args.keys_cmd == "use":
        set_current(home, args.name)
    rows = [{"name": k.name, "public": k.public, "current": k.current} for k in list_keypairs(home)]
    if args.json:
        print(json.dumps(rows))
    else:
        for r in rows:
            print(f"{'*' if r['current'] else ' '} {r['name']:20} {r['public']}")
    return 0


def _cmd_pubkey(_: argparse.Namespace) -> int:
    print((gate_home() / PUBLIC_KEY_FILE).read_text().strip())
    return 0


def _cmd_enc(args: argparse.Namespace) -> int:
    public = parse_public_key(args.pubkey) if args.pubkey else load_public_key(gate_home())
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


def _cmd_check(args: argparse.Namespace) -> int:
    resolver = Resolver(load_private_key(gate_home()))
    info = resolver.describe(args.token)
    for key in ("label", "kind", "hosts", "uses"):
        print(f"{key}: {info[key]}")
    return 0


def _cmd_credential(args: argparse.Namespace) -> int:
    """Trusted daemon commands: ciphertext on stdin, policy/ciphertext on stdout, never a secret value."""
    raw = sys.stdin.read(196609)
    if len(raw) > 196608:
        raise ValidationError("credential request too large")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValidationError("credential request must be a JSON object") from None
    keys = {"token"} if args.cmd == "credential-info" else {"token", "host", "purpose"}
    if not isinstance(data, dict) or set(data) != keys:
        raise ValidationError("credential request has unexpected fields")
    token = checked_token(data["token"])
    home = gate_home()
    resolver = Resolver.from_home(home)
    result = credential_info(resolver, token) if args.cmd == "credential-info" else reissue_totp_seed(
        resolver, load_public_key(home), token, data["host"], data["purpose"])
    print(json.dumps(result))
    return 0


def _find_mitmdump() -> str | None:
    """Prefer the mitmdump of *this* interpreter so the addon can import secret_gate."""
    sibling = Path(sys.executable).with_name("mitmdump")
    if sibling.exists():
        return str(sibling)
    return shutil.which("mitmdump")


def _cmd_proxy(args: argparse.Namespace) -> int:
    load_private_key(gate_home())  # fail early with a clear message
    entry = Path(__file__).with_name("mitm_entry.py")
    mitmdump = _find_mitmdump()
    if not mitmdump:
        print("mitmdump not found; pip install mitmproxy", file=sys.stderr)
        return 1
    os.execv(mitmdump, mitmdump_argv(mitmdump, entry, args.port))
    return 0  # pragma: no cover


# HTTP/2 stays off: mitmproxy's h2 stack rejects sloppy-but-common upstream headers
# (e.g. `Server: nginx ` with a trailing space) as a protocol error, which surfaces as a
# 502 the model cannot do anything about. HTTP/1.1 parsing tolerates them, and nothing
# here needs h2. Header validation itself is left on (it guards against request smuggling).
PROXY_OPTIONS: tuple[str, ...] = ("http2=false",)


def mitmdump_argv(mitmdump: str, entry: Path, port: int) -> list[str]:
    """The exact mitmdump command line the proxy runs; kept pure so it can be tested."""
    argv = [mitmdump, "-q", "-s", str(entry), "-p", str(port), "--listen-host", "127.0.0.1"]
    for opt in PROXY_OPTIONS:
        argv += ["--set", opt]
    return argv


def _cmd_mcp(_: argparse.Namespace) -> int:
    from .mcp_server import main as mcp_main

    mcp_main()
    return 0


def _cmd_browser(args: argparse.Namespace) -> int:
    from .browser_mcp import main as browser_main

    browser_main(args.command)
    return 0


def _cmd_install_ca(_: argparse.Namespace) -> int:
    if not MITMPROXY_CA_PATH.exists():
        print(f"{MITMPROXY_CA_PATH} not found; run `secret-gate proxy` once to generate it", file=sys.stderr)
        return 1
    target = gate_home() / CA_CERT_FILE
    shutil.copyfile(MITMPROXY_CA_PATH, target)
    print(f"copied CA to {target}")
    if sys.platform == "darwin":
        cmd = ["security", "add-trusted-cert", "-r", "trustRoot", "-k",
               str(Path.home() / "Library/Keychains/login.keychain-db"), str(target)]
        print("trusting in login keychain: " + " ".join(cmd))
        subprocess.run(cmd, check=False)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="secret-gate", description=__doc__)
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    k = sub.add_parser("keygen", help="generate the gate keypair")
    k.add_argument("--force", action="store_true", help="overwrite an existing (legacy, unnamed) key")
    k.add_argument("--name", help="create a named keypair under <home>/keys/<name> instead")
    k.set_defaults(fn=_cmd_keygen)

    ks = sub.add_parser("keys", help="list / create / switch named keypairs")
    ks.add_argument("--json", action="store_true", help="machine-readable output")
    kss = ks.add_subparsers(dest="keys_cmd")
    kss.add_parser("list", help="list keypairs (default)")
    kn = kss.add_parser("new", help="create a named keypair")
    kn.add_argument("name")
    kn.add_argument("--use", action="store_true", help="also make it current")
    ku = kss.add_parser("use", help="make a keypair current")
    ku.add_argument("name")
    ks.set_defaults(fn=_cmd_keys, keys_cmd="list")

    sub.add_parser("pubkey", help="print the public key").set_defaults(fn=_cmd_pubkey)

    e = sub.add_parser("enc", help="encrypt a secret into a token")
    e.add_argument("--label", help="e.g. site-a/pass (required unless --batch)")
    e.add_argument("--host", action="append", default=[], help="allowed host, repeatable; *.x.com ok; add :port to bind one port (host:8001)")
    e.add_argument("--use", action="append", default=[], choices=sorted(VALID_USES))
    e.add_argument("--kind", default=KIND_SECRET, choices=sorted(VALID_KINDS))
    e.add_argument("--seed-import-host", action="append", default=[], help="explicitly authorize TOTP seed import to an existing exact host[:port]")
    e.add_argument("--pubkey", help="public key text (default: read from gate home)")
    e.add_argument("--value", help="secret value (prefer prompt or --stdin: avoids shell history)")
    e.add_argument("--stdin", action="store_true", help="read value from stdin")
    e.add_argument("--batch", action="store_true", help="read a JSON array of entries from stdin, print JSON results")
    e.set_defaults(fn=_cmd_enc)

    c = sub.add_parser("check", help="show a token's policy (never its value)")
    c.add_argument("token")
    c.set_defaults(fn=_cmd_check)

    sub.add_parser("credential-info", help="daemon: read token JSON on stdin, return policy metadata").set_defaults(fn=_cmd_credential)
    sub.add_parser("credential-reissue", help="daemon: re-sign an authorized TOTP seed import request from stdin").set_defaults(fn=_cmd_credential)

    pr = sub.add_parser("proxy", help="run the substituting HTTPS proxy")
    pr.add_argument("-p", "--port", type=int, default=DEFAULT_PROXY_PORT)
    pr.set_defaults(fn=_cmd_proxy)

    sub.add_parser("mcp", help="run the MCP stdio server").set_defaults(fn=_cmd_mcp)
    b = sub.add_parser("browser", help="run a gated MCP server in front of a browser MCP (Playwright)")
    b.add_argument("command", nargs=argparse.REMAINDER, help="-- <downstream MCP command...>")
    b.set_defaults(fn=_cmd_browser)
    sub.add_parser("install-ca", help="copy mitmproxy CA and trust it").set_defaults(fn=_cmd_install_ca)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "enc" and not args.use:
        args.use = [USE_HTTP]
    if args.cmd == "enc" and args.batch and not args.label:
        pass  # label comes from each entry
    try:
        return args.fn(args)
    except GateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
