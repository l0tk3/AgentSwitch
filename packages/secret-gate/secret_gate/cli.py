"""`secret-gate` command line: keygen | keys | pubkey | enc | check | refs | proxy | mcp | browser | install-ca | service | bootstrap | rpc | system.

With the gate service installed (gate-service-v0 §4), a login user's CLI is its client: `main` hands the parsed
command to service_cli.route, which answers from keys.json / gate.sock or refuses what only the service may do.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import __version__
from .bootstrap import add_bootstrap_parser
from .constants import CA_CERT_FILE, DEFAULT_PROXY_PORT, KIND_SECRET, MITMPROXY_CA_PATH, USE_HTTP, VALID_KINDS, VALID_USES
from .credential_repair import credential_call, read_credential_stdin
from .crypto import b64url_encode, generate_keypair
from .enc_cli import run_enc
from .errors import GateError
from .keyring import create_keypair, retire_keypair, set_current
from .keystore import gate_home, load_private_key, load_public_key, parse_public_key, save_keypair
from .publish import key_rows
from .refs_cli import add_refs_parser
from .resolver import Resolver
from .rpc_methods import LOG_NAMES, MAX_LOG_LINES, tail
from .rpc_server import add_rpc_parser
from .service import ERR_LOG, add_service_parser
from .service_cli import print_keys, route
from .service_paths import client_socket
from .system_cli import add_system_parser


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
        create_keypair(home, args.name)
        if args.use:
            set_current(home, args.name)
    elif args.keys_cmd == "use":
        set_current(home, args.name)
    elif args.keys_cmd == "retire":
        retire_keypair(home, args.name)
    print_keys(key_rows(home), args.json)
    return 0


def _cmd_pubkey(_: argparse.Namespace) -> int:
    """The *current* keypair's public key (an old home's top-level key.pub is its "default" keypair)."""
    print(b64url_encode(load_public_key(gate_home())))
    return 0


def _cmd_enc(args: argparse.Namespace) -> int:
    return run_enc(args, parse_public_key(args.pubkey) if args.pubkey else load_public_key(gate_home()))


def _cmd_check(args: argparse.Namespace) -> int:
    resolver = Resolver(load_private_key(gate_home()))
    info = resolver.describe(args.token)
    for key in ("label", "kind", "hosts", "uses"):
        print(f"{key}: {info[key]}")
    return 0


def _cmd_credential(args: argparse.Namespace) -> int:
    data = read_credential_stdin(args.cmd)
    home = gate_home()
    print(json.dumps(credential_call(Resolver.from_home(home), lambda: load_public_key(home), args.cmd, data)))
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
    os.execv(mitmdump, mitmdump_argv(mitmdump, entry, args.port, confdir=args.confdir))
    return 0  # pragma: no cover


# HTTP/2 stays off: mitmproxy's h2 stack rejects sloppy-but-common upstream headers
# (e.g. `Server: nginx ` with a trailing space) as a protocol error, which surfaces as a
# 502 the model cannot do anything about. HTTP/1.1 parsing tolerates them, and nothing
# here needs h2. Header validation itself is left on (it guards against request smuggling).
PROXY_OPTIONS: tuple[str, ...] = ("http2=false",)


def mitmdump_argv(mitmdump: str, entry: Path, port: int, *, confdir: str | Path | None = None) -> list[str]:
    """The exact mitmdump command line the proxy runs; kept pure so it can be tested.

    `confdir`: where mitmproxy keeps its CA (default ~/.mitmproxy); the gate service passes <root>/gate/mitmproxy."""
    argv = [mitmdump, "-q", "-s", str(entry), "-p", str(port), "--listen-host", "127.0.0.1"]
    for opt in (*PROXY_OPTIONS, *((f"confdir={confdir}",) if confdir else ())):
        argv += ["--set", opt]
    return argv


def print_log(text: str, as_json: bool) -> None:
    print(json.dumps({"text": text}, ensure_ascii=False) if as_json else text)


def _cmd_logs(args: argparse.Namespace) -> int:
    """Without the service: `<home>/logs/<name>.log`, or the LaunchAgent's `proxy.err.log` (service.py)."""
    logs = gate_home() / "logs"
    path = logs / f"{args.name}.log"
    if not path.exists() and args.name == "proxy":
        path = logs / ERR_LOG
    print_log(tail(path, args.lines), args.json or args.json_parent)
    return 0


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


def _add_keys_parser(sub: argparse._SubParsersAction) -> None:
    ks = sub.add_parser("keys", help="list / create / switch / retire named keypairs")
    ks.add_argument("--json", action="store_true", help="machine-readable output")
    kss = ks.add_subparsers(dest="keys_cmd")
    kss.add_parser("list", help="list keypairs (default)")
    kn = kss.add_parser("new", help="create a named keypair")
    kn.add_argument("name")
    kn.add_argument("--use", action="store_true", help="also make it current")
    ku = kss.add_parser("use", help="make a keypair current (not a legacy one)")
    ku.add_argument("name")
    kr = kss.add_parser("retire", help="delete a legacy (decrypt-only) keypair: its tokens stop working")
    kr.add_argument("name")
    ks.set_defaults(fn=_cmd_keys, keys_cmd="list")


def _add_enc_parser(sub: argparse._SubParsersAction) -> None:
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


def log_lines(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        value = 0
    if not 1 <= value <= MAX_LOG_LINES:
        raise argparse.ArgumentTypeError(f"--lines must be 1-{MAX_LOG_LINES}")
    return value


def _add_logs_parser(sub: argparse._SubParsersAction) -> None:
    lg = sub.add_parser("logs", help="the gate's own logs (with the gate service: logs.tail on gate.sock)")
    lg.add_argument("--json", dest="json_parent", action="store_true", help='print {"text": ...}')
    lgs = lg.add_subparsers(dest="logs_cmd", required=True)
    t = lgs.add_parser("tail", help="the last lines of the proxy or rpc log")
    t.add_argument("--name", required=True, choices=LOG_NAMES)
    t.add_argument("--lines", type=log_lines, default=200, help=f"1-{MAX_LOG_LINES} (default 200)")
    t.add_argument("--json", action="store_true", help='print {"text": ...}')
    lg.set_defaults(fn=_cmd_logs, json_parent=False)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="secret-gate", description=__doc__)
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    k = sub.add_parser("keygen", help="generate the gate keypair")
    k.add_argument("--force", action="store_true", help="overwrite an existing (legacy, unnamed) key")
    k.add_argument("--name", help="create a named keypair under <home>/keys/<name> instead")
    k.set_defaults(fn=_cmd_keygen)
    _add_keys_parser(sub)
    sub.add_parser("pubkey", help="print the current public key").set_defaults(fn=_cmd_pubkey)
    _add_enc_parser(sub)

    c = sub.add_parser("check", help="show a token's policy (never its value)")
    c.add_argument("token")
    c.set_defaults(fn=_cmd_check)

    sub.add_parser("credential-info", help="daemon: read token JSON on stdin, return policy metadata").set_defaults(fn=_cmd_credential)
    sub.add_parser("credential-reissue", help="daemon: re-sign an authorized TOTP seed import request from stdin").set_defaults(fn=_cmd_credential)
    add_refs_parser(sub)

    pr = sub.add_parser("proxy", help="run the substituting HTTPS proxy")
    pr.add_argument("-p", "--port", type=int, default=DEFAULT_PROXY_PORT)
    pr.add_argument("--confdir", help="mitmproxy directory for the CA (default ~/.mitmproxy)")
    pr.set_defaults(fn=_cmd_proxy)

    sub.add_parser("mcp", help="run the MCP stdio server").set_defaults(fn=_cmd_mcp)
    b = sub.add_parser("browser", help="run a gated MCP server in front of a browser MCP (Playwright)")
    b.add_argument("command", nargs=argparse.REMAINDER, help="-- <downstream MCP command...>")
    b.set_defaults(fn=_cmd_browser)
    sub.add_parser("install-ca", help="copy mitmproxy CA and trust it").set_defaults(fn=_cmd_install_ca)
    add_service_parser(sub)
    add_bootstrap_parser(sub)
    _add_logs_parser(sub)
    add_rpc_parser(sub)
    add_system_parser(sub)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "enc" and not args.use:
        args.use = [USE_HTTP]
    try:
        sock = client_socket() if args.cmd != "system" else None
        fn = route(args, sock) if sock is not None else args.fn
        return fn(args)
    except GateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
