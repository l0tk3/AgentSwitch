"""`secret-gate bootstrap <harness>`: check the gate for one harness and print its config snippet.

A checker and generator, not an installer (gate-next-v0 §3). It verifies what the harness will depend on:

* keypair: the gate can decrypt (same check as `secret-gate proxy` makes at start);
* ca: `<home>/ca.pem` is a PEM certificate, not expired, and the same CA the local proxy signs with
  (`~/.mitmproxy/mitmproxy-ca-cert.pem`, when this user has one): a stale copy makes every HTTPS call fail;
* listener: something accepts TCP on 127.0.0.1:<port>;
* gate: that listener is the secret-gate proxy, not another web server or a bare mitmproxy (`proxy_probe.py`;
  loopback only).

It then prints the snippet (stdout) and a report (stderr): the checks, what applying the snippet would
change, and where it goes. It never edits a harness's global config, never touches the keychain, and writes
nothing unless `--write PATH` is given; then only PATH, only after every check passed, never over an existing
file without `--force`, and never onto a known global harness config even with `--force`.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509

from .constants import CA_CERT_FILE, DEFAULT_PROXY_PORT, MITMPROXY_CA_PATH
from .errors import GateError, ValidationError
from .harness_config import CA_ENV_VARS, HARNESSES, GateContext, HarnessConfig, harness_config
from .keystore import gate_home, load_private_key
from .publish import current_public_key, read_rows
from .service_paths import KEYS_JSON
from .proxy_probe import LOOPBACK, ProbeResult, probe_gate, tcp_reachable
from .service import atomic_write, gate_command, port_arg, validate_port

STATUS_OK = "ok"
STATUS_FAIL = "FAIL"
STATUS_SKIP = "skip"
WRITE_MODE = 0o600


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str


@dataclass(frozen=True)
class BootstrapDeps:
    user_home: Path
    mitmproxy_ca: Path
    env: Mapping[str, str]
    tcp: Callable[[int], bool] = tcp_reachable
    probe: Callable[[int], ProbeResult] = probe_gate
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)


def system_deps() -> BootstrapDeps:
    return BootstrapDeps(user_home=Path.home(), mitmproxy_ca=MITMPROXY_CA_PATH, env=dict(os.environ))


# -- checks --------------------------------------------------------------------------------------

def check_keypair(home: Path) -> Check:
    try:
        load_private_key(home)
    except GateError as exc:
        return Check("keypair", STATUS_FAIL, str(exc))
    return Check("keypair", STATUS_OK, f"the current keypair in {home} loads")


def check_keys_json(public: Path) -> Check:
    """Gate service: the published keys.json names a current keypair (the private keys are the service's)."""
    try:
        rows = read_rows(public)
        current_public_key(rows)
    except GateError as exc:
        return Check("keypair", STATUS_FAIL, str(exc))
    return Check("keypair", STATUS_OK, f"the gate service publishes a current keypair in {public / KEYS_JSON}")


def check_ca(home: Path, mitmproxy_ca: Path | None, now: datetime) -> Check:
    """`mitmproxy_ca` None: the proxy's CA is private to the gate service, which publishes `ca.pem` itself."""
    path = home / CA_CERT_FILE
    if not path.is_file():
        return Check("ca", STATUS_FAIL, f"{path} not found: start the proxy once, then copy its CA there "
                                        f"(cp {mitmproxy_ca} {path})")
    try:
        data = path.read_bytes()
        cert = x509.load_pem_x509_certificate(data)
    except OSError as exc:
        return Check("ca", STATUS_FAIL, f"cannot read {path}: {exc.strerror or exc}")
    except ValueError:
        return Check("ca", STATUS_FAIL, f"{path} is not a PEM certificate")
    if cert.not_valid_after_utc <= now:
        return Check("ca", STATUS_FAIL, f"{path} expired on {cert.not_valid_after_utc:%Y-%m-%d}")
    if mitmproxy_ca is None:
        return Check("ca", STATUS_OK, f"{path} is a valid certificate published by the gate service, "
                                      f"valid until {cert.not_valid_after_utc:%Y-%m-%d}")
    if not mitmproxy_ca.is_file():
        return Check("ca", STATUS_OK, f"{path} is a valid certificate (not compared: {mitmproxy_ca} not found; "
                                      "proxy under another user?)")
    try:
        same = mitmproxy_ca.read_bytes() == data
    except OSError as exc:
        return Check("ca", STATUS_FAIL, f"cannot read {mitmproxy_ca}: {exc.strerror or exc}")
    if not same:
        return Check("ca", STATUS_FAIL, f"{path} is not the CA the proxy signs with ({mitmproxy_ca}); "
                                        f"refresh the copy: cp {mitmproxy_ca} {path}")
    return Check("ca", STATUS_OK, f"{path} matches the proxy's CA, valid until {cert.not_valid_after_utc:%Y-%m-%d}")


def check_listener(port: int, tcp: Callable[[int], bool]) -> Check:
    if tcp(port):
        return Check("listener", STATUS_OK, f"{LOOPBACK}:{port} accepts connections")
    return Check("listener", STATUS_FAIL, f"nothing listens on {LOOPBACK}:{port}: `secret-gate service install` "
                                          f"or `secret-gate proxy --port {port}`")


def check_gate(port: int, probe: Callable[[int], ProbeResult], listening: bool) -> Check:
    if not listening:
        return Check("gate", STATUS_SKIP, "no listener to ask")
    result = probe(port)
    return Check("gate", STATUS_OK if result.is_gate else STATUS_FAIL, result.detail)


def run_checks(home: Path, port: int, deps: BootstrapDeps, *, service_public: Path | None = None) -> tuple[Check, ...]:
    listener = check_listener(port, deps.tcp)
    keys = check_keys_json(service_public) if service_public else check_keypair(home)
    ca = check_ca(service_public, None, deps.now()) if service_public else check_ca(home, deps.mitmproxy_ca, deps.now())
    return (keys, ca, listener, check_gate(port, deps.probe, listener.status == STATUS_OK))


def checks_pass(checks: tuple[Check, ...]) -> bool:
    return all(c.status != STATUS_FAIL for c in checks)


# -- --write -------------------------------------------------------------------------------------

def global_config_paths(user_home: Path, env: Mapping[str, str]) -> frozenset[Path]:
    """Config files that belong to a harness as a whole; bootstrap never writes them."""
    xdg = Path(env.get("XDG_CONFIG_HOME") or user_home / ".config").expanduser()
    paths = [
        user_home / ".claude" / "settings.json",
        user_home / ".claude.json",
        user_home / ".codex" / "config.toml",
        *(xdg / "opencode" / name for name in ("opencode.json", "opencode.jsonc", "config.json")),
    ]
    if env.get("CODEX_HOME"):
        paths.append(Path(env["CODEX_HOME"]).expanduser() / "config.toml")
    return frozenset(p.resolve() for p in paths)


def write_snippet(path: Path, text: str, *, force: bool, deps: BootstrapDeps) -> Path:
    target = path.expanduser()
    if target.resolve() in global_config_paths(deps.user_home, deps.env):
        raise ValidationError(f"{target} is a harness's global config; bootstrap never writes it. "
                              "Merge the snippet by hand.")
    if not target.parent.is_dir():
        raise ValidationError(f"directory {target.parent} does not exist")
    if target.is_dir():
        raise ValidationError(f"{target} is a directory")
    data = text.encode()
    if force:
        atomic_write(target, data, WRITE_MODE)
        return target
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, WRITE_MODE)
    except FileExistsError:
        raise ValidationError(f"{target} exists; pass --force to replace it") from None
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return target


# -- report --------------------------------------------------------------------------------------

def report_lines(ctx: GateContext, config: HarnessConfig, checks: tuple[Check, ...]) -> list[str]:
    return [
        f"secret-gate bootstrap {config.harness}: gate home {ctx.home}, proxy {LOOPBACK}:{ctx.port}",
        "checks:",
        *(f"  [{c.status:<4}] {c.name}: {c.detail}" for c in checks),
        "scope:",
        "  - this command installs nothing, never edits a harness's global config and never touches the "
        "keychain; --write PATH writes that one file only",
        f"  - CA trust travels as {', '.join(CA_ENV_VARS)} "
        "in the snippet: only processes given that environment trust the gate's CA (`secret-gate install-ca` "
        "instead trusts it in the login keychain for every app of this user)",
        *(f"  - {line}" for line in config.scope),
        "apply (by hand):",
        *(f"  - {line}" if not line.startswith("  ") else f"  {line}" for line in config.apply),
    ]


def run_bootstrap(args: argparse.Namespace, *, service_public: Path | None = None) -> int:
    """`service_public`: the gate service's public directory when this CLI is its client (gate-service-v0 §4)."""
    if args.force and not args.write:
        raise ValidationError("--force only applies together with --write PATH")
    deps = system_deps()
    ctx = GateContext(home=gate_home().expanduser().absolute(), port=validate_port(args.port),
                      command=gate_command(), user_home=deps.user_home,
                      ca_file=service_public / CA_CERT_FILE if service_public else None)
    config = harness_config(args.harness, ctx)
    checks = run_checks(ctx.home, ctx.port, deps, service_public=service_public)
    passed = checks_pass(checks)
    lines = report_lines(ctx, config, checks)
    code, written = (0 if passed else 1), None
    if args.write and not passed:
        lines.append(f"not written: {args.write} (fix the failed checks first)")
    elif args.write:
        try:
            written = write_snippet(Path(args.write), config.snippet, force=args.force, deps=deps)
            lines.append(f"wrote {written} (mode {WRITE_MODE:o}); nothing else was changed")
        except (ValidationError, OSError) as exc:
            lines.append(f"error: {exc}")
            code = 2
    print("\n".join(lines), file=sys.stderr)
    if written is None:
        sys.stdout.write(config.snippet)
    return code


def add_bootstrap_parser(sub: argparse._SubParsersAction) -> None:
    b = sub.add_parser("bootstrap", help="check the gate for a harness and print its config snippet (installs nothing)")
    b.add_argument("harness", choices=HARNESSES)
    b.add_argument("--port", type=port_arg, default=DEFAULT_PROXY_PORT, help=f"proxy port (default {DEFAULT_PROXY_PORT})")
    b.add_argument("--write", metavar="PATH", help="also write the snippet to PATH, only after all checks pass")
    b.add_argument("--force", action="store_true", help="with --write: replace an existing PATH")
    b.set_defaults(fn=run_bootstrap)
