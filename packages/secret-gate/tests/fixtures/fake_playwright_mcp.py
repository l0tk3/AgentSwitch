"""A stand-in for Playwright MCP used by the integration test. No browser involved.

Mimics 0.0.82's result format: `### Result` / `### Ran Playwright code` sections, the typed value
echoed JS-escaped in the code section, `- [Snapshot](../x.yml)` link lines, and an unredacted
page-*.yml written to the cwd (which the gate must have pointed at its private dir).
State: current URL and typed values; snapshots echo typed values like the real a11y tree.
Fills are appended to $FAKE_PW_LOG so the test can check what reached the "browser".
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from mcp import types
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("fake-playwright")
_state: dict = {"url": "about:blank", "typed": {}, "tabs": ["about:blank"]}
_log = Path(os.environ["FAKE_PW_LOG"]) if os.environ.get("FAKE_PW_LOG") else None


def _record(event: dict) -> None:
    if _log is not None:
        with _log.open("a") as fh:
            fh.write(json.dumps({**event, "cwd": os.getcwd()}) + "\n")


def _js_quote(text: str) -> str:
    return "'" + json.dumps(text)[1:-1].replace("'", "\\'") + "'"


def _dump_page() -> str:
    """Playwright persists every snapshot unredacted; return the link line it prints."""
    name = f"page-{time.time_ns()}.yml"
    Path(name).write_text(_snapshot_body())
    return f"- [Snapshot](../browser-out/{name})"


def _snapshot_body() -> str:
    lines = [f"- Page URL: {_state['url']}", "- Page Snapshot:"]
    for target, value in _state["typed"].items():
        lines.append(f'  - textbox "{target}" [ref={target}]: {value}')
    return "\n".join(lines)


@mcp.tool()
def browser_navigate(url: str) -> str:
    if url.startswith("https://blocked."):
        raise RuntimeError(f"page.goto: net::ERR_FAILED at {url}")
    _state["url"] = url
    _state["typed"] = {}
    return f"### Ran Playwright code\nawait page.goto({_js_quote(url)});\n\n### Page\n- Page URL: {url}\n{_dump_page()}"


@mcp.tool()
def browser_evaluate(function: str, element: str | None = None, target: str | None = None, filename: str | None = None) -> str:
    if function == "() => location.href":
        return f"### Result\n{json.dumps(_state['url'])}\n\n### Ran Playwright code\nawait page.evaluate('() => location.href');"
    return '### Result\n"evaluated"'


@mcp.tool()
def browser_type(target: str, text: str, element: str | None = None, submit: bool | None = None, slowly: bool | None = None) -> str:
    _state["typed"][target] = text
    _record({"tool": "browser_type", "target": target, "text": text, "submit": bool(submit)})
    return f"### Ran Playwright code\nawait page.getByRole('textbox').fill({_js_quote(text)});\n{_dump_page()}"


@mcp.tool()
def browser_fill_form(fields: list[dict]) -> str:
    for f in fields:
        _state["typed"][f["target"]] = f["value"]
        _record({"tool": "browser_fill_form", "target": f["target"], "text": f["value"]})
    code = "\n".join(f"await page.fill({_js_quote(f['target'])}, {_js_quote(f['value'])});" for f in fields)
    return f"### Ran Playwright code\n{code}\n{_dump_page()}"


@mcp.tool()
def browser_snapshot(filename: str | None = None) -> str:
    return f"{_snapshot_body()}\n{_dump_page()}"


@mcp.tool()
def browser_take_screenshot(filename: str | None = None) -> list[types.ImageContent]:
    return [types.ImageContent(type="image", data="iVBORw0KGgo=", mimeType="image/png")]


@mcp.tool()
def browser_run_code_unsafe(code: str) -> str:
    return "should never be reachable"


@mcp.tool()
def browser_click(target: str, element: str | None = None) -> str:
    return f"clicked {target}"


@mcp.tool()
def browser_press_key(key: str) -> str:
    return f"pressed {key}"


@mcp.tool()
def browser_file_upload(paths: list[str]) -> str:
    return f"uploaded {paths}"


@mcp.tool()
def browser_find(text: str | None = None, regex: str | None = None) -> str:
    hay = _snapshot_body()
    return "found" if (text and text in hay) else "not found"


@mcp.tool()
def browser_tabs(action: str, index: int | None = None, url: str | None = None) -> str:
    if action == "new":
        _state["tabs"].append(url or "about:blank")
        _state["url"] = url or "about:blank"
        _state["typed"] = {}
    elif action == "select" and index is not None:
        _state["url"] = _state["tabs"][index]
    return "\n".join(f"- {i}: {u}" for i, u in enumerate(_state["tabs"]))


if __name__ == "__main__":
    mcp.run(transport="stdio")
