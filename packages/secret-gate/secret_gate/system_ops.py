"""The operations a `secret-gate system` plan is made of (system_plan.py builds plans, system_exec.py runs them).

Each operation is frozen data with a one-line `describe()` for `--dry-run` and the step report. `Run` is the only
one that executes a program; every privileged tool is named by its absolute path.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path

from .service_paths import SystemLayout

NOT_LOADED_OK = "not-loaded-ok"
# Absolute paths: root never resolves a privileged tool through PATH.
DSCL = "/usr/bin/dscl"
DSEDITGROUP = "/usr/sbin/dseditgroup"
SYSADMINCTL = "/usr/sbin/sysadminctl"
CHOWN = "/usr/sbin/chown"
CHMOD = "/bin/chmod"
LAUNCHCTL = "/bin/launchctl"



# -- operations ----------------------------------------------------------------------------------

def _q(path: Path) -> str:
    return shlex.quote(str(path))


@dataclass(frozen=True)
class Run:
    argv: tuple[str, ...]
    tolerate: str | None = None       # NOT_LOADED_OK: launchctl's "no such service" counts as done
    expect: str | None = None         # the output must contain this (sysadminctl exits 0 on some failures)
    retries: int = 1

    def describe(self) -> str:
        return "$ " + shlex.join(self.argv)


@dataclass(frozen=True)
class MakeDir:
    path: Path
    mode: int

    def describe(self) -> str:
        return f"mkdir -m {self.mode:o} {_q(self.path)}"


@dataclass(frozen=True)
class WriteFile:
    path: Path
    data: bytes
    mode: int

    def describe(self) -> str:
        return f"write {_q(self.path)} (mode {self.mode:o})"


@dataclass(frozen=True)
class StageRuntime:
    source: Path
    layout: SystemLayout

    def describe(self) -> str:
        return (f"copy {self.source}/{{python,secret-gate,VERSIONS}} → {self.layout.runtime_staging}, "
                f"write bin/secret-gate, check that no symlink leaves the copy")


@dataclass(frozen=True)
class SwapRuntime:
    layout: SystemLayout

    def describe(self) -> str:
        layout = self.layout
        return f"mv {_q(layout.runtime)} {_q(layout.runtime_backup)}; mv {_q(layout.runtime_staging)} {_q(layout.runtime)}"


@dataclass(frozen=True)
class RemovePath:
    path: Path

    def describe(self) -> str:
        return f"rm -rf {_q(self.path)}"


@dataclass(frozen=True)
class CreateKey:
    gate: Path
    replace: bool = False               # rotate-key: the old keypair goes, every token sealed to it stops opening

    def describe(self) -> str:
        if self.replace:
            return f"replace the keypair in {self.gate} (key.priv, key.pub) with a new one"
        return f"new keypair in {self.gate} (key.priv, key.pub; skipped if one exists)"


@dataclass(frozen=True)
class GenerateCA:
    confdir: Path

    def describe(self) -> str:
        return f"new mitmproxy CA in {self.confdir} (skipped if one exists)"


@dataclass(frozen=True)
class Publish:
    layout: SystemLayout

    def describe(self) -> str:
        return f"write {self.layout.public}/keys.json and ca.pem (0644)"


@dataclass(frozen=True)
class WaitForService:
    layout: SystemLayout

    def describe(self) -> str:
        return f"wait for `status` on {self.layout.socket}: proxy running, the key in {self.layout.gate} listed"


Op = Run | MakeDir | WriteFile | StageRuntime | SwapRuntime | RemovePath | CreateKey | GenerateCA | Publish | WaitForService


@dataclass(frozen=True)
class Step:
    title: str
    ops: tuple[Op, ...]


@dataclass(frozen=True)
class Plan:
    title: str
    steps: tuple[Step, ...]
