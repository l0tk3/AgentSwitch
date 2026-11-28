"""The model traffic gateway's pure parts (model_gate.py): the table, hiding, and putting values back in streams."""

import base64
import json

from secret_gate.model_gate import SSE, Logs, Pair, Scope, Swapper, Table, forms, hash_ref, hide, scope_of_auth

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


def test_cloud_code_streams_are_hidden_and_put_back():
    # Antigravity CLI to daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse (measured
    # 2026-11-26): a request wrapped in `request` with Gemini's `contents[].parts[].text`, and an event wrapped in
    # `response` whose text is in `candidates[].content.parts[].text`.
    p = (Pair("AGSW-REAL-秘密", "h_7kq3m9x2pd"),)
    body = json.dumps({"request": {"contents": [{"role": "user", "parts": [{"text": "say AGSW-REAL-秘密"}]}],
                                   "systemInstruction": {"role": "user", "parts": [{"text": "about AGSW-REAL-秘密"}]}},
                       "model": "gemini-4-hydrogen-high"})
    hidden = hide(body, p)
    assert "AGSW" not in hidden and hidden.count("h_7kq3m9x2pd") == 2

    sw = Swapper(p)
    def ev(text):
        return {"response": {"candidates": [{"index": 0, "content": {"role": "model", "parts": [{"text": text}]}}]}}
    got = []
    for piece in ["say h_7k", "q3m9", "x2pd now"]:
        got += sw.event(ev(piece))
    got += sw.event({"response": {"candidates": [{"index": 0, "finishReason": "STOP"}]}})   # no text: the held piece comes out
    text = "".join(e["response"]["candidates"][0]["content"]["parts"][0]["text"]
                   for e in got if e.get("response", {}).get("candidates") and e["response"]["candidates"][0].get("content"))
    assert text == "say AGSW-REAL-秘密 now"

    # A tool call's arguments come whole beside the text (its `args` is an object, not a delta string): put back too.
    sw = Swapper(p)
    out = sw.event({"response": {"candidates": [{"index": 0, "content": {"parts": [
        {"text": "ok"}, {"functionCall": {"name": "run", "args": {"command": "echo h_7kq3m9x2pd"}}}]}}]}})
    args = out[0]["response"]["candidates"][0]["content"]["parts"][1]["functionCall"]["args"]
    assert args["command"] == "echo AGSW-REAL-秘密"


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


def test_an_event_that_cannot_be_read_goes_on_as_it_came():
    # A stream is never cut for an event the gateway cannot rewrite (user #448).
    sse = SSE(Swapper((Pair("secret-value", "h_abcdefghij", True),)))
    sse._block = lambda block: (_ for _ in ()).throw(KeyError("x")) if b"odd" in block else SSE._block(sse, block)  # type: ignore[method-assign]
    out = sse.feed(b'data: {"odd": 1}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"text":"h_abcdefghij ok"}}\n\n')
    assert out.startswith(b'data: {"odd": 1}\n\n')
    assert b"secret-value ok" in out
    assert sse.failed and "KeyError" in sse.failed
    # Chat Completions pieces of an odd shape are read past.
    assert Swapper.deltas({"choices": [{"delta": "text"}, {"delta": {"tool_calls": ["x", {"function": "y"}]}}]}) == []


# ---- regular expressions (AgentSwitch room #596) --------------------------------------------------------------------

SALT = "01" * 32


def regex_scope(**more):
    line = {"scopes": {"t1": {"hosts": ["api.anthropic.com"], "pairs": [], "patterns": [
        {"pattern": r"sk-[A-Za-z0-9]{20,}", "salt": SALT, "restore": True},
        {"pattern": r"acct-\d{6}", "ref": "ACCOUNT_ID", "restore": True},
        {"pattern": r"(?<id>broken", "salt": SALT},
        {"pattern": r"nothing-to-use"},
    ], **more}}}
    return Table.parse(json.dumps(line)).scopes["t1"]


def test_the_placeholder_is_the_services_own():
    # daemon tests/redactRegex.test.ts fixes the same: this salt and text give this placeholder there too.
    assert hash_ref(bytes.fromhex(SALT), "sk-abcdefghijklmnopqrstuv") == "h_dqmolpdzrc"


def test_patterns_are_read_and_the_unusable_left_out():
    sc = regex_scope()
    assert [p.regex.pattern for p in sc.patterns] == [r"sk-[A-Za-z0-9]{20,}", r"acct-\d{6}"]
    assert sc.patterns[1].restore is False   # every match becomes the user's one placeholder: nothing to put back


def test_each_match_gets_its_own_placeholder_and_comes_back_whole_even_split_in_a_stream():
    sc, learned = regex_scope(), {}
    k1, k2 = "sk-abcdefghijklmnopqrstuv", "sk-ZYXWVUTSRQPONMLKJIHGFE"
    body = json.dumps({"messages": [{"role": "user", "content": f"keys {k1} and {k2}, again {k1}; acct-123456"}]})
    sent = hide(body, (), sc.patterns, learned)
    r1, r2 = hash_ref(bytes.fromhex(SALT), k1), hash_ref(bytes.fromhex(SALT), k2)
    assert k1 not in sent and k2 not in sent and "acct-123456" not in sent
    assert json.loads(sent)["messages"][0]["content"] == f"keys {r1} and {r2}, again {r1}; ACCOUNT_ID"
    assert learned == {r1: k1, r2: k2}
    sw = Swapper((), learned)
    ev = lambda s: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": s}}
    got = []
    for piece in ["use ", r1[:5], r1[5:] + " ok ", "ACCOUNT_ID"]:
        got += sw.event(ev(piece))
    got += sw.event({"type": "content_block_stop", "index": 0})
    assert "".join(e["delta"]["text"] for e in got if e.get("type") == "content_block_delta") == f"use {k1} ok ACCOUNT_ID"


def test_a_match_that_needed_json_escaping_is_put_back_as_it_reads():
    learned = {}
    sc = Table.parse(json.dumps({"scopes": {"t": {"patterns": [{"pattern": r'tok-[a-z"\\]{6,}', "salt": SALT}]}}})).scopes["t"]
    value = 'tok-ab"cd\\ef'
    sent = hide(json.dumps({"q": value}), (), sc.patterns, learned)
    ref = hash_ref(bytes.fromhex(SALT), value)
    assert json.loads(sent) == {"q": ref} and learned == {ref: value}
    assert Swapper((), learned).walk({"a": f"x {ref}"}) == {"a": f"x {value}"}


def test_a_placeholder_already_there_is_not_matched_again():
    learned = {}
    pats = Table.parse(json.dumps({"scopes": {"t": {"patterns": [{"pattern": r"h_[a-z2-7]{10}x?", "salt": SALT}]}}})).scopes["t"].patterns
    once = hide("v h_abcdefghij", (), pats, learned)
    ref = next(iter(learned))
    assert hide(once, (), pats, learned) == once and once == f"v {ref}"


def test_a_stream_put_back_longer_is_not_cut_at_the_length_it_was_announced_with():
    # A relay's SSE with `content-length` (2026-11-27, Antigravity on a relay): the value put back is longer than its
    # placeholder, so the length the relay said no longer holds — it is not passed on, and an HTTP/1 answer is chunked.
    from mitmproxy.test import tflow
    from secret_gate.model_gate import ModelGate

    def answered(version: str):
        gate = ModelGate(Table.parse(json.dumps({"scopes": {"t": {"hosts": ["relay.example"], "pairs": [{"value": "AGSW-REAL-秘密", "ref": "h_7kq3m9x2pd"}]}}})), read_stdin=False)
        f = tflow.tflow(resp=True)
        f.client_conn.agentswitch_scope = "t"
        f.request.host = "relay.example"
        body = ('data: {"candidates":[{"content":{"parts":[{"text":"is h_7kq3m9x2pd"}]},"index":0}]}\n\n').encode()
        f.response.http_version = version
        f.response.headers["content-type"] = "text/event-stream"
        f.response.headers["content-length"] = str(len(body))
        gate.responseheaders(f)
        out = b"".join(f.response.stream(body) + f.response.stream(b""))
        return f, out, body

    f, out, body = answered("HTTP/1.1")
    assert "content-length" not in f.response.headers and f.response.headers["transfer-encoding"] == "chunked"
    assert len(out) > len(body)
    assert json.loads(out.decode().split("data: ", 1)[1])["candidates"][0]["content"]["parts"][0]["text"] == "is AGSW-REAL-秘密"
    f2, _, _ = answered("HTTP/2.0")
    assert "content-length" not in f2.response.headers and "transfer-encoding" not in f2.response.headers


def test_an_address_written_as_an_ip_is_opened_by_where_the_connection_goes(capsys):
    # No server name is sent for `https://<IP>/…` (a relay's): the connection is looked up by its CONNECT's address,
    # opened when that is the profile's own, passed through when not; a server not believed there is refused, said
    # once — never passed on unread (AgentSwitch room #33-#35).
    from types import SimpleNamespace as NS

    from mitmproxy.test import tflow
    from secret_gate.model_gate import ModelGate

    gate = ModelGate(Table.parse(json.dumps({"scopes": {"t": {"hosts": ["api.example", "203.0.113.7", "[2001:db8::5]"]}}})), read_stdin=False)
    client = NS(agentswitch_scope="t")

    def hello(sni, address, who=client):
        d = NS(context=NS(client=who, server=NS(address=address, sni=None)), client_hello=NS(sni=sni), ignore_connection=False)
        gate.tls_clienthello(d)
        return not d.ignore_connection

    assert hello(None, ("203.0.113.7", 443)) and hello(None, ("2001:db8::5", 8443)) and hello("api.example", ("198.51.100.1", 443))
    assert not hello(None, ("198.51.100.1", 443)) and not hello(None, None) and not hello("github.com", ("203.0.113.7", 443))
    assert not hello(None, ("203.0.113.7", 443), NS(agentswitch_scope=None))   # a connection of no terminal's

    # What it carries is read and written there too: the request's host is the address.
    f = tflow.tflow(resp=True)
    f.client_conn.agentswitch_scope = "t"
    f.request.host, f.request.headers["host"] = "203.0.113.7", "203.0.113.7:443"
    assert gate.table.scopes["t"].opens(f.request.pretty_host)

    # A server the gateway does not believe: the connection ends, and why is said.
    failed = NS(context=NS(client=client, server=NS(sni="203.0.113.7", address=("203.0.113.7", 443))),
                conn=NS(error="Certificate verify failed: IP address mismatch"))
    gate.tls_failed_server(failed)
    err = capsys.readouterr().err
    assert "203.0.113.7" in err and "refused" in err and "IP address mismatch" in err
    gate.tls_failed_server(NS(context=NS(client=NS(agentswitch_scope=None), server=failed.context.server), conn=failed.conn))
    assert capsys.readouterr().err == ""


def test_pictures_and_files_go_on_as_they_came_and_the_words_beside_them_are_replaced():
    # A word found by chance inside a picture's base64 broke it — a placeholder's `_` is not base64 — and the provider
    # refused every later turn, the picture going out again each time (2026-11-27, room #52-#68: a Codex session, the
    # user name replaced). Binary data is never touched, either way; the text beside it is replaced as ever.
    from secret_gate.model_gate import ModelGate, is_blob, pattern_of

    word = Pair("Zq7w", "h_aaaaaaaaaa")
    long_b64 = "AAAAZq7wAAAA" * 30                     # valid base64 holding the word, longer than BLOB_MIN
    short_b64 = "AAAAZq7wAAAA"                         # too short to be told by its look: told by where it stands
    url = "data:image/png;base64," + short_b64
    assert is_blob(url) and is_blob(long_b64) and not is_blob(short_b64) and not is_blob("say Zq7w " * 40)
    bodies = {
        "responses": {"input": [{"role": "user", "content": [{"type": "input_text", "text": "see Zq7w"},
                                                             {"type": "input_image", "image_url": url},
                                                             {"type": "input_file", "filename": "a.pdf", "file_data": short_b64}]}]},
        "chat": {"messages": [{"role": "user", "content": [{"type": "text", "text": "see Zq7w"},
                                                           {"type": "image_url", "image_url": {"url": url, "detail": "auto"}},
                                                           {"type": "input_audio", "input_audio": {"data": short_b64, "format": "wav"}}]}]},
        "anthropic": {"messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": short_b64}},
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": short_b64}},
            {"type": "text", "text": "see Zq7w"}]}]},
        "gemini": {"contents": [{"role": "user", "parts": [{"text": "see Zq7w"}, {"inlineData": {"mimeType": "image/png", "data": short_b64}},
                                                           {"inline_data": {"mime_type": "image/png", "data": short_b64}}]}]},
        "a tool's output": {"input": [{"type": "function_call_output", "output": "see Zq7w"},
                                      {"type": "function_call_output", "output": long_b64}], "images": [long_b64]},
    }
    pats = tuple(p for p in (pattern_of({"pattern": r"Zq7\w", "salt": "00"}),) if p)
    for kind, body in bodies.items():
        for pairs, patterns in (((word,), ()), ((), pats)):
            out = hide(json.dumps(body), pairs, patterns, {})
            assert "see Zq7w" not in out, kind                                  # the text: replaced
            assert out.count("Zq7w") == json.dumps(body).count("Zq7w") - 1, kind  # the data: all of it as it was
    # through the addon, as a request
    from mitmproxy.test import tflow
    gate = ModelGate(Table.parse(json.dumps({"scopes": {"t": {"hosts": ["api.example"], "pairs": [{"value": "Zq7w", "ref": "h_aaaaaaaaaa"}]}}})), read_stdin=False)
    f = tflow.tflow()
    f.client_conn.agentswitch_scope = "t"
    f.request.host = "api.example"
    f.request.set_text(json.dumps(bodies["responses"]))
    gate.request(f)
    sent = json.loads(f.request.get_text())["input"][0]["content"]
    assert sent[0]["text"] == "see h_aaaaaaaaaa" and sent[1]["image_url"] == url and sent[2]["file_data"] == short_b64


def test_what_comes_back_puts_words_back_in_the_text_but_never_in_a_picture():
    sw = Swapper((Pair("Zq7w", "QQQQ"),))
    blob = "AAAAQQQQAAAA" * 30
    whole = {"output": [{"type": "image_generation_call", "result": blob}, {"type": "message", "content": [{"type": "output_text", "text": "QQQQ"}]}]}
    back = sw.walk(json.loads(json.dumps(whole)))
    assert back["output"][0]["result"] == blob and back["output"][1]["content"][0]["text"] == "Zq7w"
    # in a stream: a partial picture, a piece of sound, and the text beside them
    ev = sw.event({"type": "response.image_generation_call.partial_image", "partial_image_b64": blob})
    assert ev[-1]["partial_image_b64"] == blob
    ev = sw.event({"type": "response.output_audio.delta", "delta": "AAAAQQQQ"})
    assert ev[-1]["delta"] == "AAAAQQQQ"
    ev = sw.event({"type": "response.output_text.delta", "item_id": "m", "output_index": 0, "content_index": 0, "delta": "QQQQ "})
    assert ev[-1]["delta"] == "Zq7w "
    g = Swapper((Pair("Zq7w", "QQQQ"),)).event({"candidates": [{"index": 0, "content": {"parts": [
        {"text": "QQQQ "}, {"inlineData": {"mimeType": "image/png", "data": "AAAAQQQQAAAA"}}]}}]})
    parts = g[-1]["candidates"][0]["content"]["parts"]
    assert parts[0]["text"] == "Zq7w " and parts[1]["inlineData"]["data"] == "AAAAQQQQAAAA"


def test_a_word_inside_json_that_is_itself_inside_a_string_is_replaced_in_its_escaped_form_too():
    # A tool call's arguments: JSON in a string, written with \u escapes by some clients.
    pairs = (Pair("张三丰", "h_abcdefghij"),)
    inner = json.dumps({"path": "/Users/张三丰/x"})          # ASCII: the name stands as \uXXXX
    assert "张三丰" not in inner
    out = hide(json.dumps({"arguments": inner, "text": "张三丰 here"}), pairs)
    doc = json.loads(out)
    assert json.loads(doc["arguments"])["path"] == "/Users/h_abcdefghij/x"
    assert doc["text"] == "h_abcdefghij here"


def test_a_picture_given_as_an_address_or_a_path_is_text_and_its_words_are_replaced():
    # Only data is passed over: where a picture may also be named by an address to fetch, or a path, that is text.
    word = Pair("Zq7w", "h_aaaaaaaaaa")
    body = {"input": [{"type": "input_image", "image_url": "https://files.example/Zq7w/a.png"},
                      {"type": "image_url", "image_url": {"url": "file:///Users/Zq7w/a.png", "detail": "auto"}},
                      {"type": "input_file", "filename": "Zq7w.pdf", "file_data": "AAAAZq7wAAAA"},
                      {"fileData": {"fileUri": "gs://b/Zq7w/a.png"}}, {"type": "input_text", "text": "/Users/Zq7w/a.png"}]}
    out = json.loads(hide(json.dumps(body), (word,)))["input"]
    assert out[0]["image_url"] == "https://files.example/h_aaaaaaaaaa/a.png"
    assert out[1]["image_url"] == {"url": "file:///Users/h_aaaaaaaaaa/a.png", "detail": "auto"}
    assert out[2] == {"type": "input_file", "filename": "h_aaaaaaaaaa.pdf", "file_data": "AAAAZq7wAAAA"}
    assert out[3]["fileData"]["fileUri"] == "gs://b/h_aaaaaaaaaa/a.png" and out[4]["text"] == "/Users/h_aaaaaaaaaa/a.png"
    back = Swapper((word,)).walk({"image_url": "https://files.example/h_aaaaaaaaaa/a.png", "file_data": "AAAAh_aaaaaaaaaaAAAA"})
    assert back == {"image_url": "https://files.example/Zq7w/a.png", "file_data": "AAAAh_aaaaaaaaaaAAAA"}


def test_what_the_review_found_a_number_a_text_that_begins_like_data_and_a_path_without_a_dot():
    # Review #83.
    from secret_gate.model_gate import is_blob, is_data, pattern_of
    word, phone = Pair("alice", "h_aaaaaaaaaa"), Pair("13800138000", "h_nnnnnnnnnn")
    # A word written as a number goes on as its placeholder, a string; other numbers stay numbers, patterns or not.
    pats = tuple(p for p in (pattern_of({"pattern": r"\d{6}", "salt": "00"}),) if p)
    out = json.loads(hide(json.dumps({"max_tokens": 100000, "input": {"phone": 13800138000, "n": 7}}), (phone, Pair("100", "h_cccccccccc")), pats, {}))
    assert out == {"max_tokens": 100000, "input": {"phone": "h_nnnnnnnnnn", "n": 7}}
    # A text that only begins like a data URL is text.
    said = "data:image/png;base64,iVBOR is how the file begins; written by alice"
    assert not is_blob(said) and not is_data(said)
    assert "alice" not in hide(json.dumps({"text": said, "image_url": said}), (word,))
    assert Swapper((word,)).walk({"text": "data:text/plain;base64,aGk=\nby h_aaaaaaaaaa"})["text"].endswith("by alice")
    # A path is text though every letter of it is base64's: a long one anywhere, a short one where a picture stands.
    long_path = "/Users/alice/Projects" + "/deep/folder/of/work" * 20
    assert len(long_path) >= 256 and not is_blob(long_path) and not is_data("/Users/alice/Desktop/shot")
    out = json.loads(hide(json.dumps({"text": long_path, "image_url": "/Users/alice/Desktop/shot", "x": {"image_url": {"url": "/Users/alice/Pictures/screenshot_2026"}}}), (word,)))
    assert "alice" not in json.dumps(out) and out["image_url"] == "/Users/h_aaaaaaaaaa/Desktop/shot"
    # A JPEG's base64 begins with a slash too, and is data.
    jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD" + "aliceAAAA" * 40
    # ... and a JPEG of text on white has a slash every eleven letters, two together all over it (review #86).
    shot = "/9j/4AAQ" + "alice//AB/Cd/" * 400
    assert shot.count("/") * 16 > len(shot) and is_data(shot) and is_blob(shot)
    assert json.loads(hide(json.dumps({"inlineData": {"mimeType": "image/jpeg", "data": shot}, "images": [shot]}), (word,)))["images"] == [shot]
    assert is_data(jpeg) and is_blob(jpeg) and json.loads(hide(json.dumps({"image_url": jpeg, "t": jpeg}), (word,))) == {"image_url": jpeg, "t": jpeg}


def test_a_long_request_is_not_slow():
    import time
    pairs = tuple(Pair(f"word{i:03d}x", f"h_{i:010d}") for i in range(60))
    body = json.dumps({"input": [{"role": "user", "content": [{"type": "input_text", "text": f"message {i} of many"}]} for i in range(20000)]})
    t0 = time.perf_counter()
    assert hide(body, pairs) == body
    assert time.perf_counter() - t0 < 2.0     # 6.5 s before the forms were worked out once


def test_an_event_that_comes_in_several_reads_does_not_end_the_answer():
    """User #129: an event bigger than one read (a web search's results) made the stream function answer b"", which
    mitmproxy writes into a chunked answer as its end. Nothing to send is no piece at all."""
    from mitmproxy.test import tflow
    from secret_gate.model_gate import ModelGate

    gate = ModelGate(Table.parse(json.dumps({"scopes": {"t": {"hosts": ["relay.example"], "pairs": [{"value": "project-falcon", "ref": "h_7kq3m9x2pd"}]}}})), read_stdin=False)
    f = tflow.tflow(resp=True)
    f.client_conn.agentswitch_scope = "t"
    f.request.host = "relay.example"
    f.response.headers["content-type"] = "text/event-stream"
    gate.responseheaders(f)
    big = "x" * 40_000
    event = ('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","content":[{"encrypted_content":"%s","title":"h_7kq3m9x2pd"}]}}\n\n' % big).encode()
    pieces = [f.response.stream(event[i : i + 1400]) for i in range(0, len(event), 1400)]
    assert all(isinstance(p, list) for p in pieces)
    assert all(b for p in pieces for b in p), "no empty piece: it would be written as the end of a chunked answer"
    assert [p for p in pieces[:-1] if p] == []
    sent = b"".join(b for p in pieces for b in p) + b"".join(f.response.stream(b""))
    assert big.encode() in sent and b"project-falcon" in sent and b"h_7kq3m9x2pd" not in sent

