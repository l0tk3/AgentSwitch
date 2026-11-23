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
from .constants import (
    CA_CERT_FILE,
    DEFAULT_PROXY_PORT,
    KIND_SECRET,
    MITMPROXY_CA_PATH,
    PRIVATE_KEY_FILE,
    PUBLIC_KEY_FILE,
    USE_HTTP,
    VALID_KINDS,
    VALID_USES,
)
from .crypto import b64url_encode
from .enc_cli import run_enc
from .errors import GateError
from .fill_cli import add_fill_parser
from .keyring import create_keypair, has_keypair
from .keystore import gate_home, load_private_key, load_public_key, parse_public_key
from .publish import key_rows
from .refs_cli import add_refs_parser
from .resolver import Resolver
from .rpc_methods import LOG_NAMES, MAX_LOG_LINES, redacted_log, tail
from .rpc_server import add_rpc_parser
from .service import ERR_LOG, add_service_parser
from .service_cli import print_keys, route
from .service_paths import client_socket
from .system_cli import add_system_parser


REPLACED_WARNING = "the old keypair is gone: every token sealed to it no longer opens; seal those values again"


def _cmd_keygen(args: argparse.Namespace) -> int:
    """The gate's one keypair, without the gate service (with it, `system install` makes it, `system rotate-key`
    replaces it). Refuses when there is one unless --force, which replaces it."""
    home = gate_home()
    replaced = has_keypair(home)
    info = create_keypair(home, replace=args.force)
    print(f"private key: {info.path / PRIVATE_KEY_FILE} (0600, keep it away from agents)")
    print(f"public key:  {info.path / PUBLIC_KEY_FILE}")
    print(f"public key value: {info.public}")
    if replaced:
        print(f"warning: {REPLACED_WARNING}", file=sys.stderr)
    return 0


def _cmd_keys(args: argparse.Namespace) -> int:
    print_keys(key_rows(gate_home()), args.json)
    return 0


def _cmd_pubkey(_: argparse.Namespace) -> int:
    """The gate's public key."""
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


def _find_mitmdump() -> str | None:
    """Prefer the mitmdump of *this* interpreter so the addon can import secret_gate."""
    sibling = Path(sys.executable).with_name("mitmdump")
    if sibling.exists():
        return str(sibling)
    return shutil.which("mitmdump")


def _cmd_proxy(args: argparse.Namespace) -> int:
    load_private_key(gate_home())  # fail early with a clear message
    entry = Path(__file__).with_name("mitm_entry.py")
    if sys.platform == "win32":
        # No exec on Windows (os.execv starts a new process and ends this one, so whoever supervises this process,
        # the Windows service host, would see it exit at once): run mitmdump in this process instead.
        from mitmproxy.tools.main import mitmdump as run_mitmdump

        run_mitmdump(mitmdump_argv("mitmdump", entry, args.port, confdir=args.confdir)[1:])
        return 0
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
    print_log(redacted_log(tail(path, args.lines), gate_home()), args.json or args.json_parent)
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
    ks = sub.add_parser("keys", help="show the gate's keypair (one row, or none)")
    ks.add_argument("--json", action="store_true", help="machine-readable output")
    kss = ks.add_subparsers(dest="keys_cmd")
    kss.add_parser("list", help="show the keypair (default)")
    ks.set_defaults(fn=_cmd_keys, keys_cmd="list")


def _add_enc_parser(sub: argparse._SubParsersAction) -> None:
    e = sub.add_parser("enc", help="encrypt a secret into a token")
    e.add_argument("--label", help="e.g. site-a/pass (required unless --batch)")
    e.add_argument("--host", action="append", default=[], help="allowed host, repeatable; *.x.com ok; add :port to bind one port (host:8001)")
    e.add_argument("--use", action="append", default=[], choices=sorted(VALID_USES))
    e.add_argument("--kind", default=KIND_SECRET, choices=sorted(VALID_KINDS))
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

    k = sub.add_parser("keygen", help="generate the gate keypair (without the gate service)")
    k.add_argument("--force", action="store_true", help="replace an existing keypair: every token sealed to the old one "
                                                        "stops working")
    k.set_defaults(fn=_cmd_keygen)
    _add_keys_parser(sub)
    sub.add_parser("pubkey", help="print the current public key").set_defaults(fn=_cmd_pubkey)
    _add_enc_parser(sub)

    c = sub.add_parser("check", help="show a token's policy (never its value)")
    c.add_argument("token")
    c.set_defaults(fn=_cmd_check)

    add_refs_parser(sub)

    pr = sub.add_parser("proxy", help="run the substituting HTTPS proxy")
    pr.add_argument("-p", "--port", type=int, default=DEFAULT_PROXY_PORT)
    pr.add_argument("--confdir", help="mitmproxy directory for the CA (default ~/.mitmproxy)")
    pr.set_defaults(fn=_cmd_proxy)

    sub.add_parser("mcp", help="run the MCP stdio server").set_defaults(fn=_cmd_mcp)
    b = sub.add_parser("browser", help="run a gated MCP server in front of a browser MCP (Playwright)")
    b.add_argument("command", nargs=argparse.REMAINDER, help="-- <downstream MCP command...>")
    b.set_defaults(fn=_cmd_browser)
    add_fill_parser(sub)
    sub.add_parser("install-ca", help="copy mitmproxy CA and trust it").set_defaults(fn=_cmd_install_ca)
    add_service_parser(sub)
    add_bootstrap_parser(sub)
    _add_logs_parser(sub)
    add_rpc_parser(sub)
    add_system_parser(sub)
    return p


def utf8_output(streams: tuple = ()) -> None:
    """Windows writes a pipe or file in the ANSI code page, where every Chinese message would fail to encode: the
    CLI's output is UTF-8 there as everywhere else (a console keeps its own Unicode path)."""
    for stream in streams or (sys.stdout, sys.stderr):
        if not stream.isatty() and (stream.encoding or "").lower().replace("-", "") != "utf8":
            stream.reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    if sys.platform == "win32":
        utf8_output()
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
