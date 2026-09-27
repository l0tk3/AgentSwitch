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
class MigrateKeys:
    source: Path
    owner_uid: int
    gate: Path

    def describe(self) -> str:
        return f"copy every keypair of {self.source} → {self.gate}/keys/legacy/<name>/ (decrypt only), verify each"


@dataclass(frozen=True)
class CreateCurrentKey:
    gate: Path
    name: str

    def describe(self) -> str:
        return f"new keypair {self.name} in {self.gate}/keys/, made current (skipped if a current keypair exists)"


@dataclass(frozen=True)
class MigrateFiles:
    source: Path
    owner_uid: int
    gate: Path

    def describe(self) -> str:
        return f"copy refs.sqlite3, exec_templates.json, upstream-insecure.txt, screenshot-mask.json, logs → {self.gate}"


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
        return f"wait for `status` on {self.layout.socket}: proxy running, the migrated keys listed"


@dataclass(frozen=True)
class CleanupUserHome:
    source: Path
    owner_uid: int
    gate: Path
    moved_text: str

    def describe(self) -> str:
        return f"delete migrated originals in {self.source} (only with an identical copy in the service), write MOVED.txt"


@dataclass(frozen=True)
class DeleteOldCA:
    mitmproxy_dir: Path
    owner_uid: int

    def describe(self) -> str:
        return f"delete the old CA private key in {self.mitmproxy_dir} (mitmproxy-ca.pem, mitmproxy-ca.p12)"


@dataclass(frozen=True)
class RemoveUserFile:
    path: Path
    owner_uid: int

    def describe(self) -> str:
        return f"rm {_q(self.path)}"


Op = (Run | MakeDir | WriteFile | StageRuntime | SwapRuntime | RemovePath | MigrateKeys | CreateCurrentKey
      | MigrateFiles | GenerateCA | Publish | WaitForService | CleanupUserHome | DeleteOldCA | RemoveUserFile)


@dataclass(frozen=True)
class Step:
    title: str
    ops: tuple[Op, ...]


@dataclass(frozen=True)
class Plan:
    title: str
    steps: tuple[Step, ...]
