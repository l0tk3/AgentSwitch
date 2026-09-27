"""A directory of the login user, as root touches it during `secret-gate system install` (gate-service-v0 §5).

Root must never follow a path the login user controls: a symlink planted at `~/.secret-gate/keys` or
`~/.secret-gate/MOVED.txt` would otherwise make root read, delete or overwrite files elsewhere. Every access
here is relative to a directory file descriptor opened with O_NOFOLLOW, every directory must belong to the
expected owner, and only regular files are read.
"""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path

from .errors import ValidationError

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
MAX_READ_BYTES = 64 << 20


class UserDir:
    def __init__(self, fd: int, path: Path, owner_uid: int) -> None:
        self._fd = fd
        self.path = Path(path)
        self.owner_uid = owner_uid

    @classmethod
    def open(cls, path: Path, owner_uid: int) -> UserDir | None:
        """None when there is no such directory; refuses a symlink or a directory of someone else."""
        try:
            fd = os.open(path, _DIR_FLAGS)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ValidationError(f"无法打开 {path}：{exc.strerror or exc}") from None
        return cls._checked(fd, Path(path), owner_uid)

    @classmethod
    def _checked(cls, fd: int, path: Path, owner_uid: int) -> UserDir:
        if os.fstat(fd).st_uid != owner_uid:
            os.close(fd)
            raise ValidationError(f"{path} 不属于 uid {owner_uid}，未处理")
        return cls(fd, path, owner_uid)

    def __enter__(self) -> UserDir:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._fd >= 0:
            os.close(self._fd)
            self._fd = -1

    def sub(self, name: str) -> UserDir | None:
        """A subdirectory; None when it is missing, a symlink or not a directory."""
        try:
            fd = os.open(name, _DIR_FLAGS, dir_fd=self._fd)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ELOOP, errno.ENOTDIR):
                return None
            raise ValidationError(f"无法打开 {self.path / name}：{exc.strerror or exc}") from None
        return self._checked(fd, self.path / name, self.owner_uid)

    def names(self) -> list[str]:
        return sorted(os.listdir(self._fd))

    def kind(self, name: str) -> str | None:
        """'file', 'dir', 'link', 'other', or None when missing (never follows a symlink)."""
        try:
            mode = os.stat(name, dir_fd=self._fd, follow_symlinks=False).st_mode
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(mode):
            return "link"
        if stat.S_ISREG(mode):
            return "file"
        return "dir" if stat.S_ISDIR(mode) else "other"

    def read(self, name: str, limit: int = MAX_READ_BYTES) -> bytes | None:
        """A regular file's bytes; None when missing, a symlink, not a regular file, not the owner's, or a
        hard link (a link to a file root can read but the owner cannot is never taken for the owner's file)."""
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self._fd)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ELOOP):
                return None
            raise ValidationError(f"无法读取 {self.path / name}：{exc.strerror or exc}") from None
        with os.fdopen(fd, "rb") as fh:
            info = os.fstat(fh.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.owner_uid or info.st_nlink != 1:
                return None
            data = fh.read(limit + 1)
        if len(data) > limit:
            raise ValidationError(f"{self.path / name} 过大，未处理")
        return data

    def unlink(self, name: str) -> bool:
        """Remove a file or symlink entry (unlink never follows it)."""
        try:
            os.unlink(name, dir_fd=self._fd)
        except FileNotFoundError:
            return False
        return True

    def rmdir(self, name: str) -> bool:
        """Remove an empty subdirectory; False when it is missing, not empty, or not a directory (a symlink)."""
        try:
            os.rmdir(name, dir_fd=self._fd)
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
                return False
            raise
        return True

    def write_new(self, name: str, data: bytes, mode: int = 0o644) -> None:
        """Replace `name` with a new regular file owned by the directory's owner."""
        self.unlink(name)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=self._fd)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            if os.geteuid() == 0:
                os.fchown(fh.fileno(), self.owner_uid, -1)
