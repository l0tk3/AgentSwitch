"""The probe templates are mirrored by AgentSwitch's agent bridge (packages/daemon/src/browser/probes.ts).

The bridge runs `browser_run_code_unsafe` only when the code is one of these templates with its JSON literal, and
`browser_evaluate` only as the URL probe (browser-v0 §6): anything else could run code in the daemon. Changing a
template here without changing the daemon's copy makes every gate check through the shared browser fail closed, so the
generated code is pinned. When this test fails on purpose, update the daemon's `probes.ts` (its test runs this module's
code generation against the copy) and then the digests below.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from secret_gate import browser_gate
from secret_gate.browser_policy import HREF_PROBE_FUNCTION
from secret_gate.browser_probe import (
    MaskPlan,
    field_state_code,
    form_target_code,
    frame_chain_code,
    masked_screenshot_code,
)

PINNED = {
    "field_state": "118537d942862b63e1585348c481ce0c33f5d2f104468dd0d7229ebb8d901969",
    "frame_chain": "6168949d5784cead923f9c1780b93db0de3c0b87b78e8ac45a1fbb9e36a575a7",
    "form_target": "b827e232d8d384cbe26370c9712f055bbedb2bcaccafd3cbcbd80b09d44f58f8",
    "masked_screenshot": "2e6be3372fde78e01dd7c9ef27be91821af25cbd2b84c22b4e89a1c32f417e76",
    "href": "e430ed879248eb7d2452bb2a04b85b58c2b2fe6981ff7d66b55645bdd3780afd",
}


def _digest(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def test_probe_templates_match_the_agent_bridges_copy():
    plan = MaskPlan(refs=("e1",), selectors=("input[type=password]",), path="/g/secret-gate-mask-0123456789abcdef.png")
    generated = {
        "field_state": field_state_code("e12"),
        "frame_chain": frame_chain_code("e12"),
        "form_target": form_target_code("e12"),
        "masked_screenshot": masked_screenshot_code(plan),
        "href": HREF_PROBE_FUNCTION,
    }
    changed = sorted(name for name, code in generated.items() if _digest(code) != PINNED[name])
    assert changed == [], f"update packages/daemon/src/browser/probes.ts for {changed}, then the digests here"


def test_the_mask_file_is_named_as_the_bridge_expects():
    # The bridge takes a masked screenshot only into `secret-gate-mask-<16 hex>.png` (probes.ts `MASK_FILE`).
    text = Path(browser_gate.__file__).read_text(encoding="utf-8")
    assert re.search(r'f"secret-gate-mask-\{secrets\.token_hex\(8\)\}\.png"', text)
