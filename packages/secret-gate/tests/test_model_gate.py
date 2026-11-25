"""The model traffic gateway's pure parts (model_gate.py): the table, hiding, and putting values back in streams."""

import base64
import json

from secret_gate.model_gate import SSE, Logs, Pair, Scope, Swapper, Table, forms, hide, scope_of_auth

P = (Pair("AGSW-REAL-秘密", "h_7kq3m9x2pd"), Pair("Alice", "PERSON_A", restore=False))


def test_table_and_hosts():
    t = Table.parse(json.dumps({"logDir": "/x", "scopes": {"t1": {"hosts": ["api.anthropic.com", "*.openai.com"], "upstream": "http://u:p@127.0.0.1:9",
                                                                    "pairs": [{"value": "v", "ref": "h_1"}, {"value": "", "ref": "h_2"}], "log": True}}}))
    s = t.scopes["t1"]
    assert s.pairs == (Pair("v", "h_1"),) and s.log and str(t.log_dir) == "/x"
    assert s.opens("API.anthropic.com") and s.opens("chatgpt.openai.com") and not s.opens("openai.com") and not s.opens("github.com")


def test_proxy_credentials_name_the_scope():
    auth = "Basic " + base64.b64encode(b"s:term-1").decode()
    assert scope_of_auth(auth) == "term-1"
    assert scope_of_auth("Basic " + base64.b64encode(b"x:term-1").decode()) is None
    assert scope_of_auth(None) is None and scope_of_auth("Basic !!") is None


def test_hide_in_every_form_a_request_may_carry():
    assert set(forms("a\"b")) == {"a\"b", "a\\\"b"}
    body = json.dumps({"m": "key AGSW-REAL-秘密 and Alice"}) + json.dumps({"m": "AGSW-REAL-秘密"}, ensure_ascii=False)
    out = hide(body, P)
    assert "AGSW" not in out and "\\u79d8" not in out and "Alice" not in out
    assert out.count("h_7kq3m9x2pd") == 2 and "PERSON_A" in out


def test_swapper_puts_back_only_what_may_be_restored_and_joins_split_placeholders():
    sw = Swapper(P)
    assert sw.whole("h_7kq3m9x2pd PERSON_A") == "AGSW-REAL-秘密 PERSON_A"
    ev = lambda s: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": s}}
    got = []
    for piece in ["say h_7k", "q3m9", "x2pd now", " h_7"]:
        got += sw.event(ev(piece))
    got += sw.event({"type": "content_block_stop", "index": 0})
    text = "".join(e["delta"]["text"] for e in got if e.get("type") == "content_block_delta")
    assert text == "say AGSW-REAL-秘密 now h_7"
    assert got[-1] == {"type": "content_block_stop", "index": 0}


def test_streams_of_each_kind():
    sw = Swapper(P)
    r = [sw.event({"type": "response.function_call_arguments.delta", "item_id": "i", "output_index": 0, "delta": d}) for d in ['{"cmd":"echo h_7kq', '3m9x2pd"}']]
    r.append(sw.event({"type": "response.function_call_arguments.done", "item_id": "i", "arguments": '{"cmd":"echo h_7kq3m9x2pd"}'}))
    flat = [e for x in r for e in x]
    assert "".join(e["delta"] for e in flat if e["type"].endswith(".delta")) == '{"cmd":"echo AGSW-REAL-秘密"}'
    assert flat[-1]["arguments"] == '{"cmd":"echo AGSW-REAL-秘密"}'
    sw = Swapper(P)
    c = lambda d, fin=None: {"choices": [{"index": 0, "delta": d, "finish_reason": fin}]}
    out = sw.event(c({"tool_calls": [{"index": 0, "function": {"arguments": "h_7kq3m"}}]})) + sw.event(c({}, "tool_calls"))
    args = "".join(tc["function"]["arguments"] for e in out for tc in e["choices"][0]["delta"].get("tool_calls", []))
    assert args == "h_7kq3m"   # never completed: given as it came, before the chunk that finishes


def test_sse_bytes_split_anywhere():
    events = [{"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": p}} for p in ['{"c":"echo h_', "7kq3m9x2", 'pd"}']]
    raw = b"".join(b"event: content_block_delta\r\ndata: " + json.dumps(e).encode() + b"\r\n\r\n" for e in events) + b"data: [DONE]\n\n"
    sse, out = SSE(Swapper(P)), b""
    for i in range(0, len(raw), 5):
        out += sse.feed(raw[i:i + 5])
    out += sse.feed(b"")
    datas = [json.loads(l[6:]) for l in out.decode().split("\n") if l.startswith("data: {")]
    assert "".join(d["delta"]["partial_json"] for d in datas) == '{"c":"echo AGSW-REAL-秘密"}'
    assert b"data: [DONE]" in out and b"event: content_block_delta" in out


def test_logs_are_kept_per_scope_and_day_and_bounded(tmp_path, monkeypatch):
    import secret_gate.model_gate as mg
    monkeypatch.setattr(mg, "MAX_LOG_FILE", 300)
    t = Table({"t1": Scope(log=True)}, tmp_path)
    logs = Logs()
    for i in range(5):
        logs.write(t, "t1", "before", {"dir": "out", "body": "x" * 80})
    files = list((tmp_path / "t1").iterdir())
    assert len(files) == 1 and files[0].name.endswith(".before.jsonl")
    lines = files[0].read_text().splitlines()
    assert "log full" in lines[-1] and files[0].stat().st_size <= 400
    assert oct(files[0].stat().st_mode & 0o777) == "0o600"
