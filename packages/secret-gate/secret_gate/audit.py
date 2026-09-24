"""Append-only decision log of the browser gate (gate-next-v0 "可审计").

One JSON line per decision: what was allowed or refused, where, and why, with labels, hosts and
references only. Never values, never ciphertext, never the scope itself (a short hash links the
lines of one execution). The file lives in the gate home, which agents cannot read.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

AUDIT_FILE = "logs/browser-audit.jsonl"


class Audit:
    def __init__(self, path: Path | None, scope: str | None = None, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._scope = hashlib.sha256(scope.encode()).hexdigest()[:12] if scope else None
        self._clock = clock

    @classmethod
    def at_home(cls, home: Path, scope: str | None) -> Audit:
        return cls(Path(home) / AUDIT_FILE, scope)

    def record(self, event: str, **fields: Any) -> None:
        """Best effort: an unwritable log is reported on stderr, it never blocks the tool call."""
        if self._path is None:
            return
        line = json.dumps({"ts": round(self._clock(), 3), "scope": self._scope, "event": event, **fields},
                          ensure_ascii=False, sort_keys=True)
        try:
            self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError as exc:
            print(f"secret-gate: audit log not written: {exc.strerror}", file=sys.stderr)
