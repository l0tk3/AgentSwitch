"""Real commands for the secret_exec tests on every system: `sh` on POSIX, `cmd` and Windows PowerShell on Windows.

`echo("got {PW}")` prints that line with the variable expanded; `out(text)` normalises Windows line ends, so a test
compares the same text everywhere.
"""

from __future__ import annotations

import re
import sys

WINDOWS = sys.platform == "win32"
_VAR = re.compile(r"\{([A-Z_][A-Z0-9_]*)\}")


def echo(text: str) -> list[str]:
    """One line, `{NAME}` replaced by the variable's value."""
    if WINDOWS:
        return ["cmd", "/d", "/c", "echo " + _VAR.sub(r"%\1%", text)]
    return ["/bin/sh", "-c", "echo " + _VAR.sub(r'"$\1"', text)]


def powershell(script: str) -> list[str]:
    """Windows PowerShell, by its absolute path (the child's PATH is the gate's fixed one, not the test runner's)."""
    from secret_gate.fsacl import windows_dir

    exe = f"{windows_dir()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    return [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]


def out(text: str) -> str:
    return text.replace("\r\n", "\n")
