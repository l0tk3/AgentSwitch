"""`secret-gate system install|update|rotate-key|uninstall|status` (gate-service-v0 §4, §5; gate-simple-v0 §1, §5).

install/update/rotate-key/uninstall run as root (on macOS the Mac app asks for an administrator once, through
osascript; on Linux `sudo`, the command printed by `agentswitch doctor`) and print the steps they did; `--dry-run`
prints the plan and changes nothing; `--root <prefix>` moves every system path under a prefix and only lists the
privileged commands (tests, inspection), and with it `--platform macos|linux` picks the layout to simulate. `status
--json` needs no root and is what the Mac app and the Linux keeper poll.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import DEFAULT_PROXY_PORT
from .errors import GateError, ValidationError
from .platform import MACOS, PLATFORMS, GatePlatform, native
from .rpc_client import RpcClient
from .service import Runner, port_arg, run_command
from .service_paths import ServiceConfig, SystemLayout, read_service_config
from .system_exec import SystemDeps, execute, local_status, read_runtime_versions
from .system_plan import (
    InstallFacts,
    InstallOptions,
    install_plan,
    render,
    rotate_key_plan,
    runtime_version,
    uninstall_plan,
    update_plan,
)

NEED_ROOT = MACOS.need_root
INSTALL_FAILURE = "已执行的步骤不会回滚；已有的密钥保留。修正原因后可重新运行安装。"
ROTATE_FAILURE = "已执行的步骤不会回滚；如新密钥已生成，旧密文已失效。修正原因后可重新运行。"
UPDATE_FAILURE = "已执行的步骤不会回滚；旧运行时如已移走，保留在 runtime.old。修正原因后可重新运行更新。"
UNINSTALL_FAILURE = "已执行的步骤不会回滚；修正原因后可重新运行卸载。"
STATUS_TIMEOUT_SECONDS = 5.0


def gather_install_facts(options: InstallOptions, runner: Runner, *, simulate: bool, now: datetime,
                         platform: GatePlatform = MACOS) -> InstallFacts:
    """Read-only look at the machine: the service account (dscl, getent), the login user's group (Linux), the
    runtime's version. Never the user's home."""
    account = platform.gather_account(runner, simulate=simulate)
    version = runtime_version(read_runtime_versions(options.runtime))
    return InstallFacts(account=account, runtime_version=version, installed_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        owner_gid=platform.owner_gid(options.owner_uid, simulate=simulate))


def _platform(args: argparse.Namespace) -> GatePlatform:
    """This machine's layer; under `--root` the one `--platform` names, macOS when none (what `--root` simulated
    before there was a choice, so its output is the same on every machine)."""
    chosen = getattr(args, "platform", None)
    if chosen and not args.root:
        raise ValidationError("--platform 只能与 --root 一起使用（模拟另一个系统的布局）")
    if args.root:
        return PLATFORMS[chosen or MACOS.key]
    return native()


def _layout(args: argparse.Namespace) -> SystemLayout:
    platform = _platform(args)
    if not args.root:
        return SystemLayout(Path("/"), platform)
    prefix = Path(args.root).expanduser().absolute()
    if prefix == Path("/") or not prefix.is_dir():
        raise ValidationError("--root 应为已存在的测试目录（不可为 /）")
    return SystemLayout(prefix, platform)


def _deps(args: argparse.Namespace, layout: SystemLayout) -> SystemDeps:
    simulate = bool(args.root)
    status = local_status(layout.gate) if simulate else (lambda sock: RpcClient(sock, timeout=STATUS_TIMEOUT_SECONDS).call("status"))
    return SystemDeps(runner=run_command, status=status, simulate=simulate)


def _sudo_uid() -> int | None:
    """The uid `sudo` was run from (`sudo secret-gate system install` on Linux needs no --owner-uid)."""
    text = os.environ.get("SUDO_UID", "")
    return int(text) if text.isdigit() else None


def _check_root(args: argparse.Namespace) -> None:
    if not args.root and not args.dry_run and os.geteuid() != 0:
        raise ValidationError(native().need_root)


def _print(lines: list[str] | tuple[str, ...]) -> None:
    for line in lines:
        print(line)


def _cmd_install(args: argparse.Namespace) -> int:
    _check_root(args)
    layout = _layout(args)
    owner_uid = args.owner_uid if args.owner_uid is not None else _sudo_uid()
    if owner_uid is None:
        raise ValidationError("缺少 --owner-uid（登录用户的 uid）")
    if not 0 < owner_uid < 2**31:
        raise ValidationError("--owner-uid 应为登录用户的 uid（不可为 root）")
    options = InstallOptions(owner_uid=owner_uid, port=args.port, runtime=Path(args.runtime).expanduser().resolve())
    deps = _deps(args, layout)
    facts = gather_install_facts(options, deps.runner, simulate=deps.simulate, now=datetime.now(timezone.utc),
                                 platform=layout.platform)
    plan = install_plan(layout, options, facts)
    if args.dry_run:
        _print(render(plan))
        return 0
    outcome = execute(plan, deps, on_failure=INSTALL_FAILURE)
    _print(outcome.lines)
    return 0 if outcome.ok else 1


def _cmd_update(args: argparse.Namespace) -> int:
    _check_root(args)
    layout = _layout(args)
    config = read_service_config(layout.config)
    runtime = Path(args.runtime).expanduser().resolve()
    version = runtime_version(read_runtime_versions(runtime))
    new = replace(config, runtime_version=version, proxy_port=args.port or config.proxy_port)
    plan = update_plan(layout, runtime, new)
    if args.dry_run:
        _print(render(plan))
        return 0
    outcome = execute(plan, _deps(args, layout), on_failure=UPDATE_FAILURE)
    _print(outcome.lines)
    return 0 if outcome.ok else 1


def _cmd_rotate_key(args: argparse.Namespace) -> int:
    _check_root(args)
    layout = _layout(args)
    config = read_service_config(layout.config)  # only an installed service has a key to replace
    plan = rotate_key_plan(layout, layout.platform.owner_gid(config.owner_uid, simulate=bool(args.root)))
    if args.dry_run:
        _print(render(plan))
        return 0
    outcome = execute(plan, _deps(args, layout), on_failure=ROTATE_FAILURE)
    _print(outcome.lines)
    return 0 if outcome.ok else 1


def _cmd_uninstall(args: argparse.Namespace) -> int:
    _check_root(args)
    layout = _layout(args)
    plan = uninstall_plan(layout, delete_keys=args.delete_keys)
    if args.dry_run:
        _print(render(plan))
        return 0
    outcome = execute(plan, _deps(args, layout), on_failure=UNINSTALL_FAILURE)
    _print(outcome.lines)
    return 0 if outcome.ok else 1


def bundled_runtime_version(runtime: Path | None = None) -> str | None:
    """The runtime this CLI belongs to (`<runtime>/python/bin/python3.x` → `<runtime>/VERSIONS`), if any."""
    base = runtime or Path(sys.executable).parents[2]
    try:
        return runtime_version((base / "VERSIONS").read_text(encoding="utf-8"))
    except (OSError, GateError, IndexError):
        return None


def service_status(layout: SystemLayout, call_status: Any, bundled: str | None) -> dict[str, Any]:
    report: dict[str, Any] = {"installed": False, "running": False, "rpcRunning": False, "proxyRunning": False,
                              "proxyPort": None, "runtimeVersion": None, "ownerUid": None,
                              "publicDir": str(layout.public), "bundledRuntimeVersion": bundled,
                              "updateAvailable": False, "error": None}
    try:
        config: ServiceConfig = read_service_config(layout.config)
    except GateError as exc:
        report["error"] = str(exc)
        return report
    report.update(installed=True, proxyPort=config.proxy_port, runtimeVersion=config.runtime_version,
                  ownerUid=config.owner_uid, updateAvailable=bundled is not None and bundled != config.runtime_version)
    try:
        status = call_status(layout.socket)
        proxy = bool(status.get("proxyRunning")) if isinstance(status, dict) else False
    except GateError as exc:
        report["error"] = str(exc)
        return report
    report.update(rpcRunning=True, proxyRunning=proxy, running=proxy)
    if not proxy:
        report["error"] = f"代理未运行；见 {layout.logs / 'proxy.log'}"
    return report


def _cmd_status(args: argparse.Namespace) -> int:
    layout = _layout(args)
    bundled = bundled_runtime_version(Path(args.runtime) if args.runtime else None)
    report = service_status(layout, lambda sock: RpcClient(sock, timeout=STATUS_TIMEOUT_SECONDS).call("status"), bundled)
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
        return 0
    _print([f"安装：{'已安装' if report['installed'] else '未安装'}",
            f"运行：{'正常' if report['running'] else '异常'}（rpc {'可用' if report['rpcRunning'] else '无响应'}，"
            f"代理 {'运行中' if report['proxyRunning'] else '未运行'}）",
            f"代理端口：{report['proxyPort']}", f"运行时：{report['runtimeVersion']}",
            f"App 内置运行时：{report['bundledRuntimeVersion']}" + ("（有更新）" if report["updateAvailable"] else ""),
            f"公开目录：{report['publicDir']}", *([f"原因：{report['error']}"] if report["error"] else [])])
    return 0 if report["running"] else 1


def _common(p: argparse.ArgumentParser, *, dry_run: bool = True) -> None:
    p.add_argument("--root", metavar="PREFIX", help="move every system path under PREFIX; privileged commands are only listed (tests)")
    p.add_argument("--platform", choices=sorted(PLATFORMS), help="with --root: the system whose layout to simulate "
                                                                 "(default: macos)")
    if dry_run:
        p.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")


def add_system_parser(sub: argparse._SubParsersAction) -> None:
    s = sub.add_parser("system", help="the gate as a system service: install | update | rotate-key | uninstall | status "
                                      "(gate-service-v0, gate-simple-v0)")
    ss = s.add_subparsers(dest="system_cmd", required=True)
    i = ss.add_parser("install", help="root: service account, directories, runtime copy, a new keypair, LaunchDaemons "
                                      "(macOS) or systemd units (Linux)")
    i.add_argument("--owner-uid", type=int, help="the login user allowed on gate.sock (default: $SUDO_UID)")
    i.add_argument("--port", type=port_arg, default=DEFAULT_PROXY_PORT, help=f"proxy port (default {DEFAULT_PROXY_PORT})")
    i.add_argument("--runtime", required=True, help="the App bundle's Contents/Resources/runtime; on Linux the node's "
                                                     "~/.local/share/agentswitch/runtime/current")
    # Accepted and ignored, so an App that still passes them keeps installing: install reads nothing in the user's home.
    i.add_argument("--migrate-from", help=argparse.SUPPRESS)
    i.add_argument("--user-home", help=argparse.SUPPRESS)
    _common(i)
    i.set_defaults(fn=_cmd_install)
    u = ss.add_parser("update", help="root: replace runtime/ and restart both services (data stays)")
    u.add_argument("--runtime", required=True, help="the App bundle's Contents/Resources/runtime")
    u.add_argument("--port", type=port_arg, help="change the proxy port")
    _common(u)
    u.set_defaults(fn=_cmd_update)
    rk = ss.add_parser("rotate-key", help="root: replace the gate's keypair; every existing token stops working "
                                          "and must be sealed again")
    _common(rk)
    rk.set_defaults(fn=_cmd_rotate_key)
    un = ss.add_parser("uninstall", help="root: stop services, remove their definitions and the runtime copy (keys stay)")
    un.add_argument("--delete-keys", action="store_true", help="also delete the gate home: existing tokens can no longer be opened")
    _common(un)
    un.set_defaults(fn=_cmd_uninstall)
    st = ss.add_parser("status", help="installed? running? (no root needed)")
    st.add_argument("--json", action="store_true", help="machine-readable, always exit 0")
    st.add_argument("--runtime", help="runtime to compare with (default: the one this CLI runs from)")
    _common(st, dry_run=False)
    st.set_defaults(fn=_cmd_status)

