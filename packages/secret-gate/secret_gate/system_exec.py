"""Carry out a system plan (system_plan.py) step by step.

Stops at the first failing step and reports what was done, what failed and what was not run; nothing is rolled
back (gate-service-v0 §5.7). Privileged commands go through `SystemDeps.runner`; with `simulate` (the CLI's
`--root <prefix>`) they are only listed, and the service check reads the gate home instead of a live socket.

Windows (gate-simple-v0 §5): `SetAcl` operations are carried out with pywin32 (fsacl.set_acl) and, like commands, only
listed under `--root`; the runtime is copied by `stage_runtime_windows` (no directory descriptors there); renaming or
removing the runtime is retried for a few seconds, since Windows keeps the files of a process that is still exiting.
"""

from __future__ import annotations

import errno
import os
import shlex
import shutil
import stat
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import fsacl
from .errors import GateError, ValidationError
from .keyring import create_keypair, has_keypair
from .publish import key_rows, publish_ca, publish_keys
from .service import CommandResult, Runner, atomic_write, is_not_loaded
from .service_paths import SystemLayout
from .system_ops import (
    NOT_LOADED_OK,
    SYSTEMD_NOT_LOADED_OK,
    WINDOWS_EXISTS_OK,
    WINDOWS_NO_SERVICE_OK,
    WINDOWS_NOT_RUNNING_OK,
    CreateKey,
    EnsureFile,
    GenerateCA,
    MakeDir,
    Op,
    Plan,
    Publish,
    RemovePath,
    Run,
    SetAcl,
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

_SYSTEMD_NOT_LOADED_CODES = frozenset({1, 5})    # systemctl: generic failure / "unit not loaded" (LSB 5)
_SYSTEMD_NOT_LOADED_TEXT = ("not loaded", "does not exist", "not found", "no such file")


def systemd_not_loaded(result: CommandResult) -> bool:
    """systemctl's answer for a unit that is not there (stop, disable --now, kill on a fresh or removed unit)."""
    text = f"{result.stdout}\n{result.stderr}".lower()
    return result.returncode in _SYSTEMD_NOT_LOADED_CODES and any(t in text for t in _SYSTEMD_NOT_LOADED_TEXT)


def windows_exists(result: CommandResult) -> bool:
    """sc.exe create on a service that is registered already (ERROR_SERVICE_EXISTS)."""
    return result.returncode == 1073 or "1073" in f"{result.stdout}\n{result.stderr}"


def windows_not_running(result: CommandResult) -> bool:
    """net.exe stop on a service that is not started (NET HELPMSG 3521) or not installed (2185)."""
    text = f"{result.stdout}\n{result.stderr}"
    return result.returncode == 2 and ("3521" in text or "2185" in text)


def windows_no_service(result: CommandResult) -> bool:
    """sc.exe delete on a service that is not registered (ERROR_SERVICE_DOES_NOT_EXIST)."""
    return result.returncode == 1060 or "1060" in f"{result.stdout}\n{result.stderr}"


_NOT_LOADED: dict[str, Callable[[CommandResult], bool]] = {
    NOT_LOADED_OK: is_not_loaded, SYSTEMD_NOT_LOADED_OK: systemd_not_loaded, WINDOWS_EXISTS_OK: windows_exists,
    WINDOWS_NOT_RUNNING_OK: windows_not_running, WINDOWS_NO_SERVICE_OK: windows_no_service,
}

def _run(op: Run, deps: SystemDeps) -> list[str]:
    if deps.simulate:
        return [f"{op.describe()}（--root：未执行）"]
    result = CommandResult(1)
    for attempt in range(max(1, op.retries)):
        result = deps.runner(op.argv)
        if result.returncode == 0 and (op.expect is None or op.expect in f"{result.stdout}\n{result.stderr}"):
            return [op.describe()]
        if op.tolerate is not None and _NOT_LOADED[op.tolerate](result):
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
    if op.path.is_symlink() or fsacl.is_link(op.path):   # chmod as root follows a link (Windows: also a junction)
        raise ValidationError(f"{op.path} 是符号链接，未处理")
    op.path.chmod(op.mode)


def _set_acl(op: SetAcl, deps: SystemDeps) -> list[str]:
    if deps.simulate:
        return [f"{op.describe()}（--root：未执行）"]
    if fsacl.is_link(op.path):
        raise ValidationError(f"{op.path} 是符号链接或联接点，未处理")
    fsacl.set_acl(op.path, op.grants, op.owner, reset_children=op.tree)
    return [op.describe()]


def _write_file(op: WriteFile, _deps: SystemDeps) -> None:
    atomic_write(op.path, op.data, op.mode)


def _ensure_file(op: EnsureFile, _deps: SystemDeps) -> None:
    """Create an empty file, never through a link and never truncating one that is there (the chown -R of the gate
    home that follows gives it to the service account)."""
    try:
        fd = os.open(op.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, op.mode)
    except FileExistsError:
        if op.path.is_symlink() or not op.path.is_file():
            raise ValidationError(f"{op.path} 不是普通文件，未处理") from None
        return
    if hasattr(os, "fchmod"):
        os.fchmod(fd, op.mode)
    os.close(fd)


def _windows_retry(action: Callable[[], Any], tries: int = 20, delay: float = 0.5) -> Any:
    """Windows keeps a file open while the process that ran it exits: retry a rename or removal for a while."""
    for attempt in range(tries if os.name == "nt" else 1):
        try:
            return action()
        except PermissionError:
            if os.name != "nt" or attempt + 1 == tries:
                raise
            time.sleep(delay)
    return None


def remove_path(path: Path) -> bool:
    if path.is_symlink() or path.is_file() or fsacl.is_link(path):
        path.unlink() if not path.is_dir() or path.is_symlink() else os.rmdir(path)   # a junction: the link only
        return True
    if path.is_dir():
        _windows_retry(lambda: shutil.rmtree(path))
        return True
    return False


def _remove(op: RemovePath, _deps: SystemDeps) -> list[str]:
    return [f"已删除 {op.path}"] if remove_path(op.path) else []


# getattr: Windows has none of these (and no directory descriptors); stage_runtime_windows copies there.
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW
# O_NONBLOCK: a FIFO planted in the bundle cannot hang the open; fstat then refuses anything but a regular file.
_FILE_FLAGS = os.O_RDONLY | _NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
_NEW_FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW
VERSIONS_FILE = "VERSIONS"
MAX_VERSIONS_BYTES = 64 << 10
_COPY_CHUNK = 1 << 20


def check_tree(root: Path) -> None:
    """Verify a staged copy, changing nothing: directories 0755, regular files 0755/0644, every symlink relative and
    resolving inside `root`, no other file type. Modes are set when the copy creates each entry (`copy_runtime_dir`),
    so this never chmods anything, and nothing here follows a link."""
    top = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        if stat.S_IMODE(os.lstat(dirpath).st_mode) != 0o755:
            raise ValidationError(f"运行时副本中目录权限不对：{dirpath}")
        for name in (*dirnames, *filenames):
            path = os.path.join(dirpath, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                resolved = os.path.realpath(path)
                if os.path.isabs(target) or os.path.commonpath([top, resolved]) != top:
                    raise ValidationError(f"运行时中的符号链接指向副本之外：{path}")
            elif stat.S_ISREG(info.st_mode):
                if stat.S_IMODE(info.st_mode) not in (0o644, 0o755):
                    raise ValidationError(f"运行时副本中文件权限不对：{path}")
            elif not stat.S_ISDIR(info.st_mode):
                raise ValidationError(f"运行时副本中有不支持的文件类型：{path}")


def _entry_error(shown: Path, why: str) -> ValidationError:
    return ValidationError(f"运行时中的 {shown} {why}，未复制（App 包可能被改动过）")


def read_regular_file(dir_fd: int, name: str, owner: int, shown: Path, limit: int) -> tuple[bytes, int]:
    """(content, mode) of a regular file in a directory of the App bundle, opened without following a link; it must
    belong to `owner`, the bundle's owner, so a hard link to someone else's file (a root-only file, the gate's keys)
    is never read as root."""
    try:
        fd = os.open(name, _FILE_FLAGS, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise _entry_error(shown, "是符号链接") from None
        raise ValidationError(f"无法读取运行时中的 {shown}：{exc.strerror or exc}") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise _entry_error(shown, "不是普通文件")
        if info.st_uid != owner:
            raise _entry_error(shown, "不属于 App 包的属主")
        if info.st_size > limit:
            raise _entry_error(shown, "过大")
        chunks = []
        while chunk := os.read(fd, _COPY_CHUNK):
            chunks.append(chunk)
        return b"".join(chunks), info.st_mode
    finally:
        os.close(fd)


def _copy_file(src_dir: int, name: str, target: Path, owner: int, shown: Path) -> None:
    try:
        fd = os.open(name, _FILE_FLAGS, dir_fd=src_dir)
    except OSError as exc:
        raise ValidationError(f"无法读取运行时中的 {shown}：{exc.strerror or exc}") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise _entry_error(shown, "不是普通文件")
        if info.st_uid != owner:
            raise _entry_error(shown, "不属于 App 包的属主")
        mode = 0o755 if info.st_mode & 0o111 else 0o644
        out = os.open(target, _NEW_FILE_FLAGS, mode)
        try:
            while chunk := os.read(fd, _COPY_CHUNK):
                os.write(out, chunk)
            os.fchmod(out, mode)
        finally:
            os.close(out)
    finally:
        os.close(fd)


def copy_runtime_dir(src_fd: int, target: Path, owner: int, shown: Path) -> None:
    """Copy one directory of the App bundle into the root-owned staging area, never following a link: every entry
    is looked at with lstat and opened relative to its parent's descriptor with O_NOFOLLOW, so swapping an entry
    for a symlink at any moment makes the open fail instead of reading elsewhere. Symlinks are recreated as they
    are (check_tree then refuses any that leaves the copy); FIFOs, devices and sockets are refused; every entry
    must belong to the bundle's owner. Directories are made 0755, files 0755/0644 when created."""
    os.mkdir(target, 0o700)
    for name in sorted(os.listdir(src_fd)):
        path, label = target / name, shown / name
        info = os.stat(name, dir_fd=src_fd, follow_symlinks=False)
        if info.st_uid != owner:
            raise _entry_error(label, "不属于 App 包的属主")
        if stat.S_ISLNK(info.st_mode):
            os.symlink(os.readlink(name, dir_fd=src_fd), path)
        elif stat.S_ISDIR(info.st_mode):
            try:
                sub = os.open(name, _DIR_FLAGS, dir_fd=src_fd)
            except OSError as exc:
                raise _entry_error(label, f"无法打开（{exc.strerror or exc}）") from None
            try:
                copy_runtime_dir(sub, path, owner, label)
            finally:
                os.close(sub)
        elif stat.S_ISREG(info.st_mode):
            _copy_file(src_fd, name, path, owner, label)
        else:
            raise _entry_error(label, "不是普通文件、目录或符号链接")
    os.chmod(target, 0o755)


def open_runtime_source(source: Path) -> tuple[int, int]:
    """(descriptor, owner uid) of the App bundle's runtime directory."""
    try:
        fd = os.open(source, _DIR_FLAGS)
    except OSError as exc:
        raise ValidationError(f"无法打开运行时目录 {source}：{exc.strerror or exc}") from None
    return fd, os.fstat(fd).st_uid


def read_runtime_versions(source: Path) -> str:
    """The VERSIONS file of an App bundle's runtime, read as stage_runtime reads it (a regular file, no link)."""
    if os.name == "nt":
        return _versions_text(_read_checked(Path(source) / VERSIONS_FILE, Path(VERSIONS_FILE), MAX_VERSIONS_BYTES))
    fd, owner = open_runtime_source(source)
    try:
        data, _mode = read_regular_file(fd, VERSIONS_FILE, owner, Path(VERSIONS_FILE), MAX_VERSIONS_BYTES)
    finally:
        os.close(fd)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValidationError("运行时的 VERSIONS 文件不是 UTF-8 文本") from None


def stage_runtime(source: Path, layout: SystemLayout) -> list[str]:
    """Copy the App bundle's runtime to `<root>/runtime.new`; the services only ever run that copy (§2).

    The bundle sits where the login user can write, and this runs as root: nothing in it is followed (a
    `runtime/secret-gate` swapped for a symlink to the gate home would otherwise make root copy the gate's keys
    into a world-readable tree), see copy_runtime_dir."""
    fd, owner = open_runtime_source(source)
    try:
        for item in RUNTIME_ITEMS:
            try:
                info = os.stat(item, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                raise ValidationError(f"运行时缺少 {item}/：{source}") from None
            if not stat.S_ISDIR(info.st_mode):
                raise _entry_error(Path(item), "不是目录（符号链接不跟随）")
        versions, _mode = read_regular_file(fd, VERSIONS_FILE, owner, Path(VERSIONS_FILE), MAX_VERSIONS_BYTES)
        try:
            version = runtime_version(versions.decode("utf-8"))
        except UnicodeDecodeError:
            raise ValidationError("运行时的 VERSIONS 文件不是 UTF-8 文本") from None
        staging = layout.runtime_staging
        remove_path(staging)
        staging.mkdir(mode=0o755)
        staging.chmod(0o755)
        for item in RUNTIME_ITEMS:
            try:
                sub = os.open(item, _DIR_FLAGS, dir_fd=fd)
            except OSError as exc:
                raise _entry_error(Path(item), f"无法打开（{exc.strerror or exc}）") from None
            try:
                copy_runtime_dir(sub, staging / item, owner, Path(item))
            finally:
                os.close(sub)
    finally:
        os.close(fd)
    out = os.open(staging / VERSIONS_FILE, _NEW_FILE_FLAGS, 0o644)
    try:
        os.write(out, versions)
        os.fchmod(out, 0o644)
    finally:
        os.close(out)
    if not os.access(staging / "python" / "bin" / "secret-gate", os.X_OK):
        raise ValidationError(f"运行时缺少 python/bin/secret-gate：{source}")
    (staging / "bin").mkdir(mode=0o755)
    (staging / "bin").chmod(0o755)
    target = shlex.quote(str(layout.runtime / "python" / "bin" / "secret-gate"))
    wrapper = os.open(staging / "bin" / "secret-gate", _NEW_FILE_FLAGS, 0o755)
    try:
        os.write(wrapper, (
            "#!/bin/sh\n# AgentSwitch gate service (docs/gate-service-v0.md §2): the root-owned copy of the runtime.\n"
            f"exec {target} \"$@\"\n").encode())
        os.fchmod(wrapper, 0o755)
    finally:
        os.close(wrapper)
    check_tree(staging)
    return [f"运行时 {version} → {staging}"]


# -- the runtime on Windows ----------------------------------------------------------------------
# No directory descriptors and no O_NOFOLLOW: every entry is looked at with lstat (a symlink, junction or any other
# reparse point is refused, never followed), then opened, and the open file must be the very file that was looked at
# (same volume and file index) with one link only, so neither a swap between the look and the open nor a hard link to
# a file elsewhere is read as the administrator. A user cannot make a hard link to the gate's keys (that needs write
# access to them), but the check costs nothing. Owners are not compared: on Windows the runtime's files belong to
# whoever unpacked them, which says nothing.

WINDOWS_RUNTIME_PYTHON = Path("python") / "python.exe"


def _versions_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValidationError("运行时的 VERSIONS 文件不是 UTF-8 文本") from None


def _open_checked(path: Path, shown: Path) -> tuple[int, os.stat_result]:
    try:
        before = os.lstat(path)
    except OSError as exc:
        raise ValidationError(f"无法读取运行时中的 {shown}：{exc.strerror or exc}") from None
    if fsacl.is_link(path) or stat.S_ISLNK(before.st_mode):
        raise _entry_error(shown, "是符号链接或联接点")
    if not stat.S_ISREG(before.st_mode):
        raise _entry_error(shown, "不是普通文件")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | _NOFOLLOW)
    info = os.fstat(fd)
    if (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise _entry_error(shown, "在复制时被换掉")
    if info.st_nlink != 1:
        os.close(fd)
        raise _entry_error(shown, "有多个硬链接")
    return fd, info


def _read_checked(path: Path, shown: Path, limit: int) -> bytes:
    fd, info = _open_checked(path, shown)
    try:
        if info.st_size > limit:
            raise _entry_error(shown, "过大")
        chunks = []
        while chunk := os.read(fd, _COPY_CHUNK):
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def copy_tree_windows(source: Path, target: Path, shown: Path) -> None:
    os.mkdir(target)
    for entry in sorted(os.listdir(source)):
        path, label = source / entry, shown / entry
        if fsacl.is_link(path):
            raise _entry_error(label, "是符号链接或联接点")
        info = os.lstat(path)
        if stat.S_ISDIR(info.st_mode):
            copy_tree_windows(path, target / entry, label)
        elif stat.S_ISREG(info.st_mode):
            fd, _info = _open_checked(path, label)
            try:
                out = os.open(target / entry, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
                try:
                    while chunk := os.read(fd, _COPY_CHUNK):
                        os.write(out, chunk)
                finally:
                    os.close(out)
            finally:
                os.close(fd)
        else:
            raise _entry_error(label, "不是普通文件、目录或符号链接")


def stage_runtime_windows(source: Path, layout: SystemLayout) -> list[str]:
    """Copy the runtime's `python\\` (a complete Python with secret-gate installed in it), `secret-gate\\` when there
    is one and `VERSIONS` to `<pf>\\gate-runtime.new`; the service runs only that copy, which inherits the
    administrators-only ACL of `<pf>` (platform/windows.py)."""
    source = Path(source)
    if fsacl.is_link(source) or not source.is_dir():
        raise ValidationError(f"无法打开运行时目录 {source}：不是目录（符号链接不跟随）")
    versions = _read_checked(source / VERSIONS_FILE, Path(VERSIONS_FILE), MAX_VERSIONS_BYTES)
    version = runtime_version(_versions_text(versions))
    staging = layout.runtime_staging
    remove_path(staging)
    staging.mkdir()
    for item in RUNTIME_ITEMS:
        path = source / item
        if item != "python" and not os.path.lexists(path):
            continue
        if fsacl.is_link(path) or not path.is_dir():
            raise ValidationError(f"运行时缺少 {item}\\（符号链接不跟随）：{source}")
        copy_tree_windows(path, staging / item, Path(item))
    (staging / VERSIONS_FILE).write_bytes(versions)
    if not (staging / WINDOWS_RUNTIME_PYTHON).is_file():
        raise ValidationError(f"运行时缺少 python\\python.exe：{source}")
    return [f"运行时 {version} → {staging}"]


def _stage(op: StageRuntime, _deps: SystemDeps) -> list[str]:
    if op.layout.platform.key == "windows":
        return stage_runtime_windows(op.source, op.layout)
    return stage_runtime(op.source, op.layout)


def _swap(op: SwapRuntime, _deps: SystemDeps) -> list[str]:
    layout = op.layout
    if not layout.runtime_staging.is_dir():
        raise ValidationError(f"未找到 {layout.runtime_staging}")
    remove_path(layout.runtime_backup)
    if os.path.lexists(layout.runtime):
        _windows_retry(lambda: os.rename(layout.runtime, layout.runtime_backup))
    os.rename(layout.runtime_staging, layout.runtime)
    return [f"{layout.runtime} 已更新"]


# -- keys, CA, public files ----------------------------------------------------------------------

def _create_key(op: CreateKey, _deps: SystemDeps) -> list[str]:
    for name in ("key.priv", "key.pub"):  # root writes here: never through a link planted in the service's home
        if (op.gate / name).is_symlink():
            raise ValidationError(f"{op.gate / name} 是符号链接，未处理")
    if has_keypair(op.gate) and not op.replace:
        return ["已有密钥，保留"]
    info = create_keypair(op.gate, replace=op.replace)
    note = "（旧密文全部失效，需要重新封装）" if op.replace else ""
    return [f"公钥 {info.public}{note}"]


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
        if entry.is_symlink():
            raise ValidationError(f"{entry} 是符号链接，未处理")
        entry.chmod(0o600)
    return True


def _generate_ca(op: GenerateCA, _deps: SystemDeps) -> list[str]:
    return ["已生成新 CA" if generate_ca(op.confdir) else "已有 CA，保留"]


def _publish(op: Publish, _deps: SystemDeps) -> list[str]:
    if not publish_keys(op.layout.gate, op.layout.public):
        raise ValidationError(f"{op.layout.gate} 中无密钥")
    if not publish_ca(op.layout.mitmproxy, op.layout.public):
        raise ValidationError(f"{op.layout.mitmproxy} 中无 CA 证书")
    return ["keys.json、ca.pem 已发布"]


def _wait(op: WaitForService, deps: SystemDeps) -> list[str]:
    expected = [r.public_key for r in key_rows(op.layout.gate)]
    last = "无响应"
    for attempt in range(deps.wait_tries):
        try:
            status = deps.status(op.layout.socket)
            rows = status["keys"]
            listed = [row["publicKey"] for row in rows]
            if not status["proxyRunning"]:
                last = "代理未运行（端口可能被其他进程占用，例如 Mac 应用或 Linux 看护进程自行启动的网关进程）"
            elif not expected or listed != expected:
                last = "服务列出的密钥与文件不一致"
            elif not all(row["current"] for row in rows):
                last = "服务无当前密钥"
            else:
                return [f"服务已就绪：版本 {status.get('version')}，代理端口 {status.get('proxyPort')}"]
        except GateError as exc:
            last = str(exc)
        except (KeyError, TypeError):
            last = "status 响应格式无效"
        if attempt + 1 < deps.wait_tries:
            deps.sleep(deps.wait_delay)
    raise StepError(f"服务未就绪：{last}")


_HANDLERS: dict[type, Callable[[Any, SystemDeps], list[str] | None]] = {
    Run: _run, MakeDir: _make_dir, SetAcl: _set_acl, WriteFile: _write_file, EnsureFile: _ensure_file, StageRuntime: _stage, SwapRuntime: _swap,
    RemovePath: _remove, CreateKey: _create_key, GenerateCA: _generate_ca, Publish: _publish, WaitForService: _wait,
}


def local_status(gate: Path) -> Callable[[Path], Any]:
    """`--root` simulation of the service's `status`: what the service would report from these files."""
    def status(_socket: Path) -> dict[str, Any]:
        return {"version": "simulated", "proxyPort": None, "proxyRunning": True,
                "keys": [r.to_json() for r in key_rows(gate)]}
    return status
