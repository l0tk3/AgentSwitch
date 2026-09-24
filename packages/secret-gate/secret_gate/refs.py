"""Task-scoped short references `enc:ref:<id>` to ciphertext tokens (gate-next-v0 §1).

A model retypes a 24-character reference reliably where a 270-character enc:v1 token gets
damaged. A reference is only a pointer: the ciphertext it points to still carries the policy, so a
reference goes through exactly the same host/use checks as the token itself.

Registry: `<gate home>/refs.sqlite3` (0600). Rows hold ciphertext and its label keyed by the
sha256 of the execution scope, never plaintext and never the scope itself. A scope is an
unguessable capability the trusted dispatcher (the AgentSwitch daemon) creates per execution and
hands only to that execution's gate processes (SECRET_GATE_SCOPE, the proxy's Proxy-Authorization).
A reference resolves only inside its own scope, and a released scope never reopens. Releasing
drops the mappings; it does not revoke the ciphertext, which stays valid wherever its own policy
allows. Every call opens its own connection: the proxy, the MCP servers and the CLI are separate
processes sharing this file.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from .constants import (
    LABEL_PATTERN,
    REF_ID_CHARS,
    REF_MAX_AGE_SECONDS,
    REF_PREFIX,
    REFS_FILE,
    RELEASED_SCOPE_RETENTION_SECONDS,
    SCOPE_PATTERN,
)
from .errors import RefError, ValidationError
from .tokens import is_ref, is_token

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, created REAL NOT NULL, released REAL)",
    "CREATE TABLE IF NOT EXISTS refs (ref TEXT PRIMARY KEY, scope TEXT NOT NULL, token TEXT NOT NULL,"
    " label TEXT NOT NULL, created REAL NOT NULL, UNIQUE (scope, token))",
)
NO_SCOPE_MESSAGE = (
    "enc:ref: references only work inside the task that received them (secret_fill, the gate MCP tools, "
    "or the task's own proxy settings); this request carries no task scope"
)
RELEASED_MESSAGE = "this reference was released when its execution ended; use the reference in the current task context"


@dataclass(frozen=True)
class RefEntry:
    ref: str
    token: str
    label: str


def check_scope(scope: object) -> str:
    if not isinstance(scope, str) or not SCOPE_PATTERN.fullmatch(scope):
        raise ValidationError("invalid execution scope")
    return scope


def _scope_key(scope: str) -> str:
    return hashlib.sha256(check_scope(scope).encode("ascii")).hexdigest()


def new_ref() -> str:
    body = secrets.token_urlsafe(REF_ID_CHARS)[:REF_ID_CHARS]
    return REF_PREFIX + body


class RefRegistry:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time) -> None:
        self._path = Path(path)
        self._clock = clock

    @classmethod
    def from_home(cls, home: Path, clock: Callable[[], float] = time.time) -> RefRegistry:
        return cls(Path(home) / REFS_FILE, clock=clock)

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        if not self._path.exists():
            self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.close(os.open(self._path, os.O_WRONLY | os.O_CREAT, 0o600))
        self._path.chmod(0o600)
        conn = sqlite3.connect(self._path, timeout=5, isolation_level=None)
        for statement in _SCHEMA:
            conn.execute(statement)
        return conn

    def register(self, scope: str, token: str, label: str) -> str:
        """The reference for `token` in `scope`: the existing one, or a new random one."""
        key = _scope_key(scope)
        if not is_token(token):
            raise ValidationError("only a complete enc:v1: token can be registered")
        if not isinstance(label, str) or not LABEL_PATTERN.fullmatch(label):
            raise ValidationError(f"invalid label: {label!r}")
        now = self._clock()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                self._prune(conn, now)
                released = conn.execute("SELECT released FROM scopes WHERE scope = ?", (key,)).fetchone()
                if released is not None and released[0] is not None:
                    raise RefError("this execution scope was released and cannot register references again")
                conn.execute("INSERT OR IGNORE INTO scopes (scope, created) VALUES (?, ?)", (key, now))
                row = conn.execute("SELECT ref FROM refs WHERE scope = ? AND token = ?", (key, token.strip())).fetchone()
                ref = row[0] if row else self._insert(conn, key, token.strip(), label, now)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return ref

    @staticmethod
    def _insert(conn: sqlite3.Connection, key: str, token: str, label: str, now: float) -> str:
        while True:
            ref = new_ref()
            try:
                conn.execute("INSERT INTO refs (ref, scope, token, label, created) VALUES (?, ?, ?, ?, ?)",
                             (ref, key, token, label, now))
                return ref
            except sqlite3.IntegrityError:
                continue  # 96-bit collision: draw again

    def lookup(self, scope: str | None, ref: str) -> RefEntry:
        """The ciphertext behind `ref`, only for the scope it was registered in."""
        if not is_ref(ref):
            raise ValidationError("malformed enc:ref: reference")
        if scope is None:
            raise RefError(NO_SCOPE_MESSAGE)
        key = _scope_key(scope)
        ref = ref.strip()
        if not self._path.exists():
            raise RefError("unknown enc:ref: reference")
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT scope, token, label, created FROM refs WHERE ref = ?", (ref,)).fetchone()
            released = conn.execute("SELECT released FROM scopes WHERE scope = ?", (key,)).fetchone()
        if released is not None and released[0] is not None:
            raise RefError(RELEASED_MESSAGE)
        if row is None or row[3] < self._clock() - REF_MAX_AGE_SECONDS:
            # Expiry is checked here too, not only when the next registration prunes.
            raise RefError("unknown or expired enc:ref: reference; use the reference in the current task context")
        if row[0] != key:
            raise RefError("this reference belongs to a different task; use the reference in the current task context")
        return RefEntry(ref=ref, token=row[1], label=row[2])

    def release(self, scope: str) -> int:
        """Drop every mapping of `scope` and mark it released, so it can never be reopened."""
        key = _scope_key(scope)
        now = self._clock()
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                count = conn.execute("DELETE FROM refs WHERE scope = ?", (key,)).rowcount
                conn.execute(
                    "INSERT INTO scopes (scope, created, released) VALUES (?, ?, ?) "
                    "ON CONFLICT (scope) DO UPDATE SET released = COALESCE(released, excluded.released)",
                    (key, now, now),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return count

    @staticmethod
    def _prune(conn: sqlite3.Connection, now: float) -> None:
        """Scopes a crashed dispatcher never released expire; released ones are forgotten eventually."""
        stale = now - REF_MAX_AGE_SECONDS
        conn.execute(
            "UPDATE scopes SET released = ? WHERE released IS NULL AND created < ? "
            "AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.scope = scopes.scope AND refs.created >= ?)",
            (now, stale, stale),
        )
        conn.execute("DELETE FROM refs WHERE scope IN (SELECT scope FROM scopes WHERE released IS NOT NULL)")
        conn.execute("DELETE FROM scopes WHERE released IS NOT NULL AND released < ?",
                     (now - RELEASED_SCOPE_RETENTION_SECONDS,))
