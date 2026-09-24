"""BOUNDARY.md (gate-next-v0 §4) may only cite tests that exist; renaming one must update the checklist."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CITATION = re.compile(r"`(tests/[\w/]+\.py)::(\w+)`")


def _defined(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    return {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def test_every_cited_test_exists():
    text = (ROOT / "BOUNDARY.md").read_text()
    citations = CITATION.findall(text)
    assert len(citations) >= 40
    missing = [f"{file}::{name}" for file, name in citations
               if not (ROOT / file).exists() or name not in _defined(ROOT / file)]
    assert missing == []


def test_every_table_row_names_at_least_one_test():
    rows = [line for line in (ROOT / "BOUNDARY.md").read_text().splitlines()
            if line.startswith("| ") and not line.startswith("| 入口") and not line.startswith("|---")]
    assert rows and all(CITATION.search(row) for row in rows)
