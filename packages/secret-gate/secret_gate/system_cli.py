"""`secret-gate system install|update|uninstall|status` (gate-service-v0 §4, §5).

install/update/uninstall run as root (the Mac app asks for an administrator once, through osascript) and print
the steps they did; `--dry-run` prints the plan and changes nothing; `--root <prefix>` moves every system path
under a prefix and only lists the privileged commands (tests, inspection). `status --json` needs no root and is
what the Mac app polls.
"""

from __future__ import annotations

import argparse
import json
import os
import pwd
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import DEFAULT_PROXY_PORT
from .errors import GateError, ValidationError
from .rpc_client import RpcClient
from .service import SERVICE_LABEL, Runner, port_arg, run_command
from .service_paths import ServiceConfig, SystemLayout, read_service_config
from .system_exec import SystemDeps, execute, local_status
from .system_ops import DSCL
from .system_plan import (
    InstallFacts,
    InstallOptions,
    choose_account,
    install_plan,
    render,
    runtime_version,
    uninstall_plan,
    update_plan,
)

NEED_ROOT = "需要管理员权限：请在 Mac 应用中操作（会请求一次管理员授权）。"
INSTALL_FAILURE = "已执行的步骤不会回滚。原有密钥仅在最后一步、确认服务可用后删除；修正原因后可重新运行安装。"
UPDATE_FAILURE = "已执行的步骤不会回滚；旧运行时如已移走，保留在 runtime.old。修正原因后可重新运行更新。"
UNINSTALL_FAILURE = "已执行的步骤不会回滚；修正原因后可重新运行卸载。"
STATUS_TIMEOUT_SECONDS = 5.0


def _ids(runner: Runner, path: str, attribute: str) -> dict[str, int]:
    result = runner((DSCL, ".", "-list", path, attribute))
    if result.returncode != 0:
        raise ValidationError(f"dscl . -list {path} {attribute} 失败（{result.returncode}）")
    out: dict[str, int] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("-").isdigit():
            out[parts[0]] = int(parts[-1])
    return out


def gather_install_facts(options: InstallOptions, runner: Runner, *, simulate: bool, now: datetime) -> InstallFacts:
    """Read-only look at the machine: users and groups (dscl), the runtime's version, an old LaunchAgent."""
    users = {} if simulate else _ids(runner, "/Users", "UniqueID")
    groups = {} if simulate else _ids(runner, "/Groups", "PrimaryGroupID")
    try:
        version = runtime_version((options.runtime / "VERSIONS").read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValidationError(f"无法读取运行时的 VERSIONS 文件：{exc.strerror or exc}") from None
    agent = None
    if options.user_home is not None:
        candidate = options.user_home / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"
        agent = candidate if os.path.lexists(candidate) else None
    return InstallFacts(account=choose_account(users, groups), runtime_version=version,
                        installed_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"), old_agent_plist=agent)


def _layout(args: argparse.Namespace) -> SystemLayout:
    if not args.root:
        return SystemLayout()
    prefix = Path(args.root).expanduser().absolute()
    if prefix == Path("/") or not prefix.is_dir():
        raise ValidationError("--root 应为已存在的测试目录（不可为 /）")
    return SystemLayout(prefix)


def _deps(args: argparse.Namespace, layout: SystemLayout) -> SystemDeps:
    simulate = bool(args.root)
    status = local_status(layout.gate) if simulate else (lambda sock: RpcClient(sock, timeout=STATUS_TIMEOUT_SECONDS).call("status"))
    return SystemDeps(runner=run_command, status=status, simulate=simulate)


def _check_root(args: argparse.Namespace) -> None:
    if not args.root and not args.dry_run and os.geteuid() != 0:
        raise ValidationError(NEED_ROOT)


def _print(lines: list[str] | tuple[str, ...]) -> None:
    for line in lines:
        print(line)


def _owner_home(owner_uid: int) -> Path:
    try:
        return Path(pwd.getpwuid(owner_uid).pw_dir)
    except KeyError:
        raise ValidationError(f"uid {owner_uid} 不存在") from None


def owner_path(text: str, owner_home: Path | None) -> Path:
    """`~` and `~/…` mean the *owner's* home: install runs as root, often with HOME unset (`env -i`)."""
    if text == "~" or text.startswith("~/"):
        if owner_home is None:
            raise ValidationError(f"无法确定 {text} 所在的用户目录；请给出绝对路径或 --user-home")
        return owner_home / text[2:]
    path = Path(text)
    if not path.is_absolute():
        raise ValidationError(f"{text} 应为绝对路径")
    return path


def _cmd_install(args: argparse.Namespace) -> int:
    _check_root(args)
    layout = _layout(args)
    if not 0 < args.owner_uid < 2**31:
        raise ValidationError("--owner-uid 应为登录用户的 uid（不可为 root）")
    user_home = Path(args.user_home) if args.user_home else (None if args.root else _owner_home(args.owner_uid))
    options = InstallOptions(owner_uid=args.owner_uid, port=args.port, runtime=Path(args.runtime).expanduser().resolve(),
                             migrate_from=owner_path(args.migrate_from, user_home) if args.migrate_from else None,
                             user_home=user_home)
    deps = _deps(args, layout)
    facts = gather_install_facts(options, deps.runner, simulate=deps.simulate, now=datetime.now(timezone.utc))
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
    try:
        version = runtime_version((runtime / "VERSIONS").read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValidationError(f"无法读取运行时的 VERSIONS 文件：{exc.strerror or exc}") from None
    new = replace(config, runtime_version=version, proxy_port=args.port or config.proxy_port)
    plan = update_plan(layout, runtime, new)
    if args.dry_run:
        _print(render(plan))
        return 0
    outcome = execute(plan, _deps(args, layout), on_failure=UPDATE_FAILURE)
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
    if dry_run:
        p.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")


def add_system_parser(sub: argparse._SubParsersAction) -> None:
    s = sub.add_parser("system", help="the gate as a system service: install | update | uninstall | status (gate-service-v0)")
    ss = s.add_subparsers(dest="system_cmd", required=True)
    i = ss.add_parser("install", help="root: service account, directories, runtime copy, migration, LaunchDaemons")
    i.add_argument("--owner-uid", type=int, required=True, help="the login user allowed on gate.sock")
    i.add_argument("--port", type=port_arg, default=DEFAULT_PROXY_PORT, help=f"proxy port (default {DEFAULT_PROXY_PORT})")
    i.add_argument("--runtime", required=True, help="the App bundle's Contents/Resources/runtime")
    i.add_argument("--migrate-from", help="the owner's old gate home (~/.secret-gate)")
    i.add_argument("--user-home", help="the owner's home for the old ~/.mitmproxy CA key and LaunchAgent (default: from --owner-uid; none with --root)")
    _common(i)
    i.set_defaults(fn=_cmd_install)
    u = ss.add_parser("update", help="root: replace runtime/ and restart both services (data stays)")
    u.add_argument("--runtime", required=True, help="the App bundle's Contents/Resources/runtime")
    u.add_argument("--port", type=port_arg, help="change the proxy port")
    _common(u)
    u.set_defaults(fn=_cmd_update)
    un = ss.add_parser("uninstall", help="root: stop services, remove LaunchDaemons and runtime/ (keys stay)")
    un.add_argument("--delete-keys", action="store_true", help="also delete the gate home: existing tokens can no longer be opened")
    _common(un)
    un.set_defaults(fn=_cmd_uninstall)
    st = ss.add_parser("status", help="installed? running? (no root needed)")
    st.add_argument("--json", action="store_true", help="machine-readable, always exit 0")
    st.add_argument("--runtime", help="runtime to compare with (default: the one this CLI runs from)")
    _common(st, dry_run=False)
    st.set_defaults(fn=_cmd_status)

