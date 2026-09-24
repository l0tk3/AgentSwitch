"""Entry point for `mitmdump -s secret_gate/mitm_entry.py`. Not unit-tested (wiring only).

Absolute imports on purpose: mitmproxy loads this file as a standalone script. SIGHUP reloads
upstream-insecure.txt without dropping connections (reload.py); the resolver opens the enc:ref:
registry per request, so references registered after start-up resolve without a reload.
"""

from secret_gate.keystore import gate_home
from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.reload import InsecureHostsReloader, initial_patterns
from secret_gate.resolver import Resolver
from secret_gate.upstream_tls import UpstreamTlsAddon

_upstream_tls = UpstreamTlsAddon(initial_patterns(gate_home()))
addons = [_upstream_tls, InsecureHostsReloader(_upstream_tls, gate_home()), SecretGateAddon(Resolver.from_home(gate_home()))]
