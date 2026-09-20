"""Entry point for `mitmdump -s secret_gate/mitm_entry.py`. Not unit-tested (wiring only).

Absolute imports on purpose: mitmproxy loads this file as a standalone script.
"""

from secret_gate.keystore import gate_home
from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.resolver import Resolver

addons = [SecretGateAddon(Resolver.from_home(gate_home()))]
