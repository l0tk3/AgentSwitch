#!/usr/bin/env python3
"""Export every design demo page as one self-contained HTML file, for a phone or for someone without the repo.

    python3 docs/design/export.py                 # → ~/Desktop/WorkSpace/Scratch/agentswitch-design/
    python3 docs/design/export.py <out-dir>

Each page gets `pixel.js` inlined, a script that scales wide mock windows to a narrow screen, and — when Google Chrome
is installed — the page as already drawn (headless Chrome's `--dump-dom`), so a viewer that runs no scripts (the
iPhone's file preview) still shows it; in a browser the scripts run again and the controls work. The index
(`index.html`) comes along with links to the exported files. Nothing is fetched from the network.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FOLDERS = ("implemented", "concepts")
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
DEFAULT_OUT = Path.home() / "Desktop" / "WorkSpace" / "Scratch" / "agentswitch-design"

# Wide mock windows are drawn whole at a narrow width (zoom) instead of scrolling sideways: any element wider than
# 600 px and wider than its container, outermost first.
FIT = """<script>
(function () {
  function fit() {
    for (const el of document.querySelectorAll("[data-fitted]")) { el.style.zoom = ""; delete el.dataset.fitted; }
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("[data-fitted]") || el.tagName === "IFRAME" || el.closest(".thumb")) continue;   // the index scales its own thumbnails
      const p = el.parentElement, w = el.offsetWidth;
      if (!p || w <= 600) continue;
      const avail = p.clientWidth - 2;
      if (w > avail + 4) { el.style.zoom = (avail / w).toFixed(3); el.dataset.fitted = "1"; }
    }
  }
  addEventListener("resize", fit);
  addEventListener("load", fit);
})();
</script>
"""


def standalone(page: Path) -> str:
    text = page.read_text()
    pixel = page.parent / "pixel.js"
    tag = '<script src="pixel.js"></script>'
    if tag in text:
        text = text.replace(tag, "<script>\n" + pixel.read_text() + "\n</script>")
    return text.replace("</body>", FIT + "</body>") if "</body>" in text else text + FIT


def drawn(html: str) -> str:
    """The page after its scripts ran, when Chrome is there; else as written."""
    if not CHROME.exists():
        return html
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "page.html"
        src.write_text(html)
        run = subprocess.run([str(CHROME), "--headless=new", "--disable-gpu", "--virtual-time-budget=1500",
                              "--window-size=1320,1000", "--dump-dom", src.as_uri()],
                             capture_output=True, text=True, timeout=60)
    dom = run.stdout.strip()
    if run.returncode != 0 or not dom.startswith("<html"):
        return html
    return "<!doctype html>\n" + dom


def main() -> int:
    copies = {(HERE / folder / "pixel.js").read_text() for folder in FOLDERS}
    if len(copies) != 1:
        print("implemented/pixel.js and concepts/pixel.js differ: change both the same way", file=sys.stderr)
        return 1
    out = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_OUT
    if out.exists():
        shutil.rmtree(out)
    pages = [p for folder in FOLDERS for p in sorted((HERE / folder).glob("*.html"))]
    for page in pages:
        target = out / page.parent.name / page.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(drawn(standalone(page)))
        print(f"  {target}")
    # The index links the exported pages by the same relative paths; the showcase stays in the repo.
    index = (HERE / "index.html").read_text()
    index = re.sub(r"\+ `<section><div class=\"sh\"><h2>// Showcase</h2>.*?</section>`;", ";", index, flags=re.S)
    (out / "index.html").write_text(drawn(index.replace("</body>", FIT + "</body>")))
    print(f"index: {out / 'index.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
