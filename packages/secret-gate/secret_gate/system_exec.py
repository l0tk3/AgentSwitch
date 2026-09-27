"""Carry out a system plan (system_plan.py) step by step.

Stops at the first failing step and reports what was done, what failed and what was not run; nothing is rolled
back (gate-service-v0 §5.7). Privileged commands go through `SystemDeps.runner`; with `simulate` (the CLI's
`--root <prefix>`) they are only listed, and the service check reads the gate home instead of a live socket.
"""

from __future__ import annotations

import os
import shlex
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import GateError, ValidationError
from .keyring import create_keypair, current_name, list_keypairs, set_current
from .migrate import cleanup_user_home, delete_old_ca_keys, migrate_files, migrate_keys, remove_user_file, unique_name
from .publish import key_rows, publish_ca, publish_keys
from .service import CommandResult, Runner, atomic_write, is_not_loaded
from .service_paths import SystemLayout
from .system_ops import (
    NOT_LOADED_OK,
    CleanupUserHome,
    CreateCurrentKey,
    DeleteOldCA,
    GenerateCA,
    MakeDir,
    MigrateFiles,
    MigrateKeys,
    Op,
    Plan,
    Publish,
    RemovePath,
    RemoveUserFile,
    Run,
    StageRuntime,
    SwapRuntime,
    WaitForService,
    WriteFile,
)
from .system_plan import runtime_version

RUNTIME_ITEMS = ("python", "secret-gate")
CA_BASENAME = "mitmproxy"
CA_KEY_SIZE = 2048
RETRY_DELAY_SECONDS = 0.5


class StepError(GateError):
    """One operation of a step failed; the message says which and why."""


@dataclass(frozen=True)
class SystemDeps:
    runner: Runner
    status: Callable[[Path], Any]           # gate.sock -> the `status` result; GateError when it does not answer
    sleep: Callable[[float], None] = time.sleep
    simulate: bool = False                  # --root: list privileged commands instead of running them
    wait_tries: int = 30
    wait_delay: float = 1.0


@dataclass(frozen=True)
class Outcome:
    ok: bool
    lines: tuple[str, ...]


def execute(plan: Plan, deps: SystemDeps, *, on_failure: str = "") -> Outcome:
    lines = [plan.title]
    for index, step in enumerate(plan.steps):
        try:
            notes = [note for op in step.ops for note in run_op(op, deps)]
        except (GateError, OSError) as exc:
            reason = str(exc) if isinstance(exc, GateError) else f"{exc.strerror or exc}（{getattr(exc, 'filename', '')}）"
            lines.append(f"[失败] {index + 1}. {step.title}：{reason}")
            lines.extend(f"[未执行] {n}. {s.title}" for n, s in enumerate(plan.steps[index + 1:], start=index + 2))
            if on_failure:
                lines.append(on_failure)
            return Outcome(False, tuple(lines))
        lines.append(f"[完成] {index + 1}. {step.title}")
        lines.extend(f"       {note}" for note in notes)
    return Outcome(True, tuple(lines))


def run_op(op: Op, deps: SystemDeps) -> list[str]:
    handler = _HANDLERS[type(op)]
    return handler(op, deps) or []


# -- privileged commands -------------------------------------------------------------------------

def _run(op: Run, deps: SystemDeps) -> list[str]:
    if deps.simulate:
        return [f"{op.describe()}（--root：未执行）"]
    result = CommandResult(1)
    for attempt in range(max(1, op.retries)):
        result = deps.runner(op.argv)
        if result.returncode == 0 and (op.expect is None or op.expect in f"{result.stdout}\n{result.stderr}"):
            return [op.describe()]
        if op.tolerate == NOT_LOADED_OK and is_not_loaded(result):
            return [f"{op.describe()}（未加载，跳过）"]
        if attempt + 1 < op.retries:
            deps.sleep(RETRY_DELAY_SECONDS)
    reason = (result.stderr or result.stdout).strip().splitlines()[:1] or ["无输出"]
    if result.returncode == 0 and op.expect is not None:
        reason = [f"输出中不含 {op.expect!r}"]
    raise StepError(f"{shlex.join(op.argv)} 失败（{result.returncode}）：{reason[0][:300]}")


# -- files ---------------------------------------------------------------------------------------

def _make_dir(op: MakeDir, _deps: SystemDeps) -> None:
    op.path.mkdir(mode=op.mode, parents=True, exist_ok=True)
    op.path.chmod(op.mode)


def _write_file(op: WriteFile, _deps: SystemDeps) -> None:
    atomic_write(op.path, op.data, op.mode)


def remove_path(path: Path) -> bool:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return True
    if path.is_dir():
        shutil.rmtree(path)
        return True
    return False


def _remove(op: RemovePath, _deps: SystemDeps) -> list[str]:
    return [f"已删除 {op.path}"] if remove_path(op.path) else []


def check_tree(root: Path) -> None:
    """Directories 0755, files 0755/0644, and no symlink that points outside `root`."""
    top = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o755)
        for name in (*dirnames, *filenames):
            path = os.path.join(dirpath, name)
            info = os.lstat(path)
            if os.path.islink(path):
                target = os.path.realpath(path)
                if os.path.commonpath([top, target]) != top:
                    raise ValidationError(f"运行时中的符号链接指向副本之外：{path}")
            elif not os.path.isdir(path):
                os.chmod(path, 0o755 if info.st_mode & 0o111 else 0o644)


def stage_runtime(source: Path, layout: SystemLayout) -> list[str]:
    """Copy the App bundle's runtime to `<root>/runtime.new`; the services only ever run that copy (§2)."""
    for item in RUNTIME_ITEMS:
        if not (source / item).is_dir():
            raise ValidationError(f"运行时缺少 {item}/：{source}")
    version = runtime_version((source / "VERSIONS").read_text(encoding="utf-8"))
    staging = layout.runtime_staging
    remove_path(staging)
    staging.mkdir(mode=0o755)
    for item in RUNTIME_ITEMS:
        shutil.copytree(source / item, staging / item, symlinks=True)
    shutil.copyfile(source / "VERSIONS", staging / "VERSIONS")
    if not os.access(staging / "python" / "bin" / "secret-gate", os.X_OK):
        raise ValidationError(f"运行时缺少 python/bin/secret-gate：{source}")
    (staging / "bin").mkdir(mode=0o755)
    target = shlex.quote(str(layout.runtime / "python" / "bin" / "secret-gate"))
    (staging / "bin" / "secret-gate").write_text(
        "#!/bin/sh\n# AgentSwitch gate service (docs/gate-service-v0.md §2): the root-owned copy of the runtime.\n"
        f"exec {target} \"$@\"\n")
    (staging / "bin" / "secret-gate").chmod(0o755)
    check_tree(staging)
    return [f"运行时 {version} → {staging}"]


def _stage(op: StageRuntime, _deps: SystemDeps) -> list[str]:
    return stage_runtime(op.source, op.layout)


def _swap(op: SwapRuntime, _deps: SystemDeps) -> list[str]:
    layout = op.layout
    if not layout.runtime_staging.is_dir():
        raise ValidationError(f"未找到 {layout.runtime_staging}")
    remove_path(layout.runtime_backup)
    if os.path.lexists(layout.runtime):
        os.rename(layout.runtime, layout.runtime_backup)
    os.rename(layout.runtime_staging, layout.runtime)
    return [f"{layout.runtime} 已更新"]


# -- keys, CA, public files ----------------------------------------------------------------------

def _migrate_keys(op: MigrateKeys, _deps: SystemDeps) -> list[str]:
    return list(migrate_keys(op.source, op.owner_uid, op.gate))


def _migrate_files(op: MigrateFiles, _deps: SystemDeps) -> list[str]:
    return list(migrate_files(op.source, op.owner_uid, op.gate))


def _create_key(op: CreateCurrentKey, _deps: SystemDeps) -> list[str]:
    existing = current_name(op.gate)
    if existing is not None:
        return [f"已有当前密钥 {existing}"]
    name = unique_name(op.name, {k.name for k in list_keypairs(op.gate)})
    create_keypair(op.gate, name)
    set_current(op.gate, name)
    return [f"当前密钥：{name}"]


def generate_ca(confdir: Path) -> bool:
    """mitmproxy's own CA generation, into the service's 0700 directory; False when a CA is already there."""
    from mitmproxy.certs import CertStore

    if (confdir / f"{CA_BASENAME}-ca.pem").exists():
        return False
    confdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = os.umask(0o077)
    try:
        CertStore.create_store(confdir, CA_BASENAME, CA_KEY_SIZE)
    finally:
        os.umask(old)
    for entry in confdir.iterdir():
        entry.chmod(0o600)
    return True


def _generate_ca(op: GenerateCA, _deps: SystemDeps) -> list[str]:
    return ["已生成新 CA" if generate_ca(op.confdir) else "已有 CA，保留"]


def _publish(op: Publish, _deps: SystemDeps) -> list[str]:
    rows = publish_keys(op.layout.gate, op.layout.public)
    if not publish_ca(op.layout.mitmproxy, op.layout.public):
        raise ValidationError(f"{op.layout.mitmproxy} 中无 CA 证书")
    return [f"keys.json：{len(rows)} 个密钥；ca.pem 已发布"]


def _wait(op: WaitForService, deps: SystemDeps) -> list[str]:
    expected = {r.name for r in key_rows(op.layout.gate)}
    last = "无响应"
    for attempt in range(deps.wait_tries):
        try:
            status = deps.status(op.layout.socket)
            rows = status["keys"]
            names = {row["name"] for row in rows}
            if not status["proxyRunning"]:
                last = "代理未运行（端口可能被其他进程占用，例如 Mac 应用自行启动的网关进程）"
            elif names != expected:
                last = f"服务列出的密钥与文件不一致：{sorted(names)}"
            elif not any(row["current"] for row in rows):
                last = "服务无当前密钥"
            else:
                return [f"服务已就绪：版本 {status.get('version')}，代理端口 {status.get('proxyPort')}，密钥 {len(names)} 个"]
        except GateError as exc:
            last = str(exc)
        except (KeyError, TypeError):
            last = "status 响应格式无效"
        if attempt + 1 < deps.wait_tries:
            deps.sleep(deps.wait_delay)
    raise StepError(f"服务未就绪：{last}")


def _cleanup(op: CleanupUserHome, _deps: SystemDeps) -> list[str]:
    return list(cleanup_user_home(op.source, op.owner_uid, op.gate, op.moved_text))


def _delete_old_ca(op: DeleteOldCA, _deps: SystemDeps) -> list[str]:
    return list(delete_old_ca_keys(op.mitmproxy_dir, op.owner_uid))


def _remove_user_file(op: RemoveUserFile, _deps: SystemDeps) -> list[str]:
    return [f"已删除 {op.path}"] if remove_user_file(op.path, op.owner_uid) else []


_HANDLERS: dict[type, Callable[[Any, SystemDeps], list[str] | None]] = {
    Run: _run, MakeDir: _make_dir, WriteFile: _write_file, StageRuntime: _stage, SwapRuntime: _swap,
    RemovePath: _remove, MigrateKeys: _migrate_keys, CreateCurrentKey: _create_key, MigrateFiles: _migrate_files,
    GenerateCA: _generate_ca, Publish: _publish, WaitForService: _wait, CleanupUserHome: _cleanup,
    DeleteOldCA: _delete_old_ca, RemoveUserFile: _remove_user_file,
}


def local_status(gate: Path) -> Callable[[Path], Any]:
    """`--root` simulation of the service's `status`: what the service would report from these files."""
    def status(_socket: Path) -> dict[str, Any]:
        return {"version": "simulated", "proxyPort": None, "proxyRunning": True,
                "keys": [r.to_json() for r in key_rows(gate)]}
    return status
