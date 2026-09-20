"""Minimal live test of Codex over `codex app-server` (JSON-RPC 2.0 on stdio).

Why this exists: `codex exec` auto-cancels every MCP tool call (openai/codex#24135). Over
app-server the approval arrives as a server->client request that the client can answer, which
is exactly how AgentSwitch's Codex executor will run. This script is that executor's skeleton.

Run: .venv/bin/python scripts/codex_appserver_e2e.py
     SG_E2E_ONLY=S3 ... | CODEX_BIN=... | SG_E2E_MODEL=gpt-6-astra ...
Defaults to the codex bundled with ChatGPT.app (0.155) when present, else `codex` on PATH.

Scenarios:
  S0 rateLimits  account/rateLimits/read answers (the "额度面板" data source), no model call.
  S3 mcp         secret_describe over MCP: the approval request is answered programmatically.
  S4 otp         secret_otp over MCP, code checked against the gate's own TOTP.
Every server->client request is logged with its method so the approval protocol is documented
by the run itself.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from secret_gate.otp import totp  # noqa: E402
import codex_e2e as base  # noqa: E402  (reuses temp CODEX_HOME, tokens, constants)

BUNDLED = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
CODEX = os.environ.get("CODEX_BIN") or (str(BUNDLED) if BUNDLED.exists() else "codex")
MODEL = os.environ.get("SG_E2E_MODEL", "")
ONLY = {x.strip() for x in os.environ.get("SG_E2E_ONLY", "").split(",") if x.strip()}
SCRATCH = Path(os.environ.get("TMPDIR", "/tmp")) / "secret-gate-cx-appserver-e2e"
TURN_TIMEOUT_S = 240

# server->client requests we know how to answer; anything else is logged and answered "accept"-shaped
APPROVAL_ANSWERS = {
    "item/commandExecution/requestApproval": {"decision": "accept"},
    "item/fileChange/requestApproval": {"decision": "accept"},
    "item/permissions/requestApproval": {"decision": "accept"},
    "execCommandApproval": {"decision": "approved"},
    "applyPatchApproval": {"decision": "approved"},
    "mcpServer/elicitation/request": {"action": "accept", "content": {}},
}


@dataclass
class Transcript:
    items: list[dict] = field(default_factory=list)
    server_requests: list[dict] = field(default_factory=list)
    notifications: list[str] = field(default_factory=list)
    turn_completed: dict | None = None

    @property
    def text(self) -> str:
        return "\n".join(it.get("text", "") for it in self.items if it.get("type") == "agentMessage")

    @property
    def mcp_calls(self) -> list[dict]:
        return [it for it in self.items if it.get("type") == "mcpToolCall"]

    def leaks(self, *secrets: str) -> bool:
        blob = json.dumps(self.items) + json.dumps(self.server_requests)
        return any(s in blob for s in secrets)


class AppServer:
    """Tiny JSON-RPC client over the app-server's stdio. One thread reads lines into a queue."""

    def __init__(self, env: dict, cwd: Path) -> None:
        self.proc = subprocess.Popen([CODEX, "app-server"], cwd=cwd, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.inbox: queue.Queue[dict] = queue.Queue()
        self._next_id = 0
        self.log: list[dict] = []
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                self.inbox.put(json.loads(line))
            except json.JSONDecodeError:
                self.inbox.put({"raw": line.rstrip()})

    def _send(self, msg: dict) -> None:
        assert self.proc.stdin is not None
        self.log.append(msg)
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method: str, params: dict | None = None, *, timeout: float = 60,
                transcript: Transcript | None = None) -> dict:
        self._next_id += 1
        rid = self._next_id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._pump(transcript, deadline)
            if msg is None:
                continue
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg["result"]
        raise TimeoutError(f"no response to {method}")

    def wait_turn(self, thread_id: str, transcript: Transcript, timeout: float) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self._pump(transcript, deadline)
            done = transcript.turn_completed
            if done and done.get("threadId") == thread_id:
                return done
        raise TimeoutError("turn never completed")

    def _pump(self, transcript: Transcript | None, deadline: float) -> dict | None:
        """Read one message; route notifications and answer server requests. Returns responses only."""
        try:
            msg = self.inbox.get(timeout=max(0.1, min(1.0, deadline - time.time())))
        except queue.Empty:
            return None
        self.log.append(msg)
        method = msg.get("method")
        if method and "id" in msg:  # server -> client request
            self._answer(msg, transcript)
            return None
        if method:  # notification
            if transcript is not None:
                transcript.notifications.append(method)
                if method == "item/completed":
                    transcript.items.append(msg["params"]["item"])
                elif method == "turn/completed":
                    transcript.turn_completed = msg["params"]
            return None
        return msg

    def _answer(self, req: dict, transcript: Transcript | None) -> None:
        method = req["method"]
        answer = APPROVAL_ANSWERS.get(method, {"decision": "accept"})
        if transcript is not None:
            transcript.server_requests.append({"method": method, "params": req.get("params"), "answered": answer})
        print(f"    ↳ server request {method} → {answer}")
        self._send({"jsonrpc": "2.0", "id": req["id"], "result": answer})

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_turn(srv: AppServer, workdir: Path, prompt: str) -> Transcript:
    tr = Transcript()
    thread = srv.request("thread/start", {
        "cwd": str(workdir), "sandbox": "workspace-write", "approvalPolicy": "on-request",
        "ephemeral": True, **({"model": MODEL} if MODEL else {}),
    }, transcript=tr)
    thread_id = thread["thread"]["id"]
    srv.request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": prompt}]}, transcript=tr)
    srv.wait_turn(thread_id, tr, TURN_TIMEOUT_S)
    return tr


def report(name: str, ok: bool, detail: str) -> bool:
    print(f"[{name}] {'PASS' if ok else 'FAIL'} — {detail}")
    return ok


def s0_rate_limits(srv: AppServer, _: Path, __: dict) -> bool:
    try:
        res = srv.request("account/rateLimits/read", {})
    except Exception as exc:  # noqa: BLE001
        return report("S0 rateLimits", False, f"{exc}")
    keys = sorted(res.keys()) if isinstance(res, dict) else type(res).__name__
    return report("S0 rateLimits", isinstance(res, dict) and bool(res), f"keys={keys}; sample={json.dumps(res)[:200]}")


def s3_mcp_describe(srv: AppServer, workdir: Path, tokens: dict) -> bool:
    tok = tokens["local"]
    tr = run_turn(srv, workdir, f"Use the secret_describe tool on this token and report its label and allowed hosts: {tok}")
    calls = tr.mcp_calls
    ok = bool(calls) and all(c.get("status") == "completed" for c in calls) and "portal/pass" in tr.text \
        and base.ECHO_HOST in tr.text and not tr.leaks(base.FAKE_PASS)
    return report("S3 mcp describe", ok,
                  f"mcp calls={[(c.get('tool'), c.get('status')) for c in calls]}; approvals answered={[r['method'] for r in tr.server_requests]}; model said: {tr.text[:160]!r}")


def s4_mcp_otp(srv: AppServer, workdir: Path, tokens: dict) -> bool:
    tok = tokens["otp"]
    tr = run_turn(srv, workdir, f"Use the secret_otp tool to get the current one-time code for this token and reply with just the 6 digits: {tok}")
    now = int(time.time())
    valid = {totp(base.FAKE_TOTP_SECRET, at=now - d) for d in (0, 30, 60)}
    digits = "".join(ch for ch in tr.text if ch.isdigit())[-6:]
    ok = digits in valid and bool(tr.mcp_calls) and not tr.leaks(base.FAKE_TOTP_SECRET)
    return report("S4 mcp otp", ok,
                  f"code={digits!r} valid_now={digits in valid}; mcp calls={[(c.get('tool'), c.get('status')) for c in tr.mcp_calls]}; model said: {tr.text[:120]!r}")


SCENARIOS = {"S0": s0_rate_limits, "S3": s3_mcp_describe, "S4": s4_mcp_otp}


def main() -> int:
    if shutil.which(CODEX) is None and not Path(CODEX).exists():
        print(f"codex binary not found: {CODEX}")
        return 1
    print(f"codex: {CODEX}")
    shutil.rmtree(SCRATCH, ignore_errors=True)
    gate_home, workdir, codex_home = SCRATCH / "home", SCRATCH / "work", SCRATCH / "codex-home"
    workdir.mkdir(parents=True)
    gate_env = {**os.environ, "SECRET_GATE_HOME": str(gate_home)}
    agent_env = {**os.environ, "CODEX_HOME": str(codex_home)}
    base.gate(gate_env, "keygen")
    base.write_codex_home(codex_home, gate_home)
    shutil.copyfile(ROOT / "AGENTS.md", workdir / "AGENTS.md")
    tokens = base.make_tokens(gate_env)

    results: list[bool] = []
    srv = AppServer(agent_env, workdir)
    try:
        init = srv.request("initialize", {"clientInfo": {"name": "agentswitch-e2e", "version": "0.0.1"}})
        srv.notify("initialized")
        print("initialized:", json.dumps(init)[:160])
        for name, fn in SCENARIOS.items():
            if ONLY and name not in ONLY:
                continue
            try:
                results.append(fn(srv, workdir, tokens))
            except Exception as exc:  # noqa: BLE001
                results.append(report(name, False, f"exception: {exc}"))
    finally:
        srv.close()
        stderr_tail = srv.proc.stderr.read()[-3000:] if srv.proc.stderr else ""
        (SCRATCH / "log.json").write_text(json.dumps({"log": srv.log, "stderr": stderr_tail}, indent=1, ensure_ascii=False))
        print(f"\nraw protocol log: {SCRATCH / 'log.json'}")
        shutil.rmtree(gate_home, ignore_errors=True)
        shutil.rmtree(codex_home, ignore_errors=True)  # removes the auth.json copy

    print("\nCODEX APP-SERVER E2E", "PASS" if all(results) else "FAIL", f"({sum(results)}/{len(results)})")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
