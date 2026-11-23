"""The gate service's per-system layer (gate-simple-v0 §5): base.GatePlatform and one module per system.

`native()` is this machine's; macOS is also what every system without a layer of its own gets (the behaviour before
the layer existed). Windows plugs in here as a third module (gate-simple-v0 §7 step 4).
"""

from __future__ import annotations

import sys

from .base import GatePlatform
from .linux import LINUX
from .macos import MACOS

PLATFORMS: dict[str, GatePlatform] = {MACOS.key: MACOS, LINUX.key: LINUX}


def native(sys_platform: str = sys.platform) -> GatePlatform:
    return LINUX if sys_platform.startswith("linux") else MACOS


def by_key(key: str) -> GatePlatform:
    return PLATFORMS[key]


__all__ = ["LINUX", "MACOS", "PLATFORMS", "GatePlatform", "by_key", "native"]
