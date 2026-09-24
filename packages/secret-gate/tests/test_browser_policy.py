import pytest

from secret_gate.browser_policy import (
    DENIED_TOOLS,
    GateState,
    check_call_allowed,
    extract_href,
    has_tokens,
    page_host,
    resolve_for_page,
    rewrite_fill_args,
    scrub_result_text,
    secret_fill_to_type,
    strip_file_output,
)
from secret_gate.errors import PolicyViolation, ValidationError
from secret_gate.resolver import Resolution
from tests.fixtures import fake_secrets as fs

EMPTY = GateState()
FILLED = GateState().with_fill("https://a.example.com/", (Resolution(token="t", label="l", value="Hunter2-Fake"),))


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://a.example.com/login?x=1", "a.example.com:443"),
        ("http://10.0.0.5:8400/", "10.0.0.5:8400"),
        ("http://core.internal.example:8400/app#/x", "core.internal.example:8400"),
        ("http://allowed.example.com@evil.example/", "evil.example:80"),  # userinfo is not the host
    ],
)
def test_page_host_is_port_aware(url, expected):
    assert page_host(url) == expected


@pytest.mark.parametrize("url", ["about:blank", "file:///tmp/x.html", "chrome://settings", "", "http://h:abc/"])
def test_page_host_rejects_non_http_or_bad_port(url):
    with pytest.raises(PolicyViolation):
        page_host(url)


def test_extract_href_reads_only_the_result_section():
    text = '### Result\n"http://core.internal.example:8400/login"\n\n### Ran Playwright code\nawait page.evaluate(...)'
    assert extract_href(text) == "http://core.internal.example:8400/login"
    assert extract_href('### Result\n"about:blank"\n') == "about:blank"
    for bad in (
        "### Result\nundefined",
        "- Page URL: https://x.example.com/a\n",  # no Result section: fail closed
        '### Error\n"https://attacker.example/"\n### Result\n42',  # not a string
        '### Error\nDialog: "https://attacker.example/"\n',  # attacker text outside Result
    ):
        with pytest.raises(PolicyViolation):
            extract_href(bad)


def test_strip_file_output_removes_only_filename():
    schema = {"type": "object", "properties": {"filename": {"type": "string"}, "depth": {"type": "integer"}}, "required": ["filename"]}
    out = strip_file_output(schema)
    assert "filename" not in out["properties"] and "depth" in out["properties"]
    assert out["required"] == []
    assert schema["properties"]["filename"]  # input untouched
    plain = {"type": "object", "properties": {"url": {}}}
    assert strip_file_output(plain) is plain


def test_static_refusals():
    for name in DENIED_TOOLS:
        with pytest.raises(PolicyViolation):
            check_call_allowed(name, {}, EMPTY)
    with pytest.raises(PolicyViolation):
        check_call_allowed("browser_snapshot", {"filename": "out.txt"}, EMPTY)
    with pytest.raises(PolicyViolation):
        check_call_allowed("browser_file_upload", {"paths": ["page-1.yml"]}, EMPTY)
    with pytest.raises(PolicyViolation):
        check_call_allowed("browser_drop", {"target": "e1", "paths": ["x"]}, EMPTY)
    check_call_allowed("browser_snapshot", {"filename": ""}, EMPTY)
    check_call_allowed("browser_click", {"target": "e1"}, EMPTY)


@pytest.mark.parametrize(
    "url", ["data:text/html,<script>1</script>", "javascript:alert(1)", "file:///etc/hosts", "blob:https://x/1", "about:srcdoc"]
)
def test_non_http_urls_refused_even_before_any_fill(url):
    for name in ("browser_navigate", "browser_tabs"):
        with pytest.raises(PolicyViolation):
            check_call_allowed(name, {"url": url, "action": "new"}, EMPTY)


def test_http_urls_and_blank_allowed():
    check_call_allowed("browser_navigate", {"url": "https://a.example.com/"}, FILLED)
    check_call_allowed("browser_navigate", {"url": "about:blank"}, FILLED)
    check_call_allowed("browser_tabs", {"action": "list"}, FILLED)


@pytest.mark.parametrize("key", ["Meta+c", "Control+C", "ctrl+x", "ControlOrMeta+c", "Control+Insert"])
def test_copy_chords_refused_once_filled(key):
    check_call_allowed("browser_press_key", {"key": key}, EMPTY)  # nothing to protect yet
    with pytest.raises(PolicyViolation):
        check_call_allowed("browser_press_key", {"key": key}, FILLED)


@pytest.mark.parametrize("key", ["Enter", "Meta+a", "Meta+v", "Tab", "c"])
def test_other_keys_allowed(key):
    check_call_allowed("browser_press_key", {"key": key}, FILLED)


def test_substring_oracles_refused_once_filled():
    check_call_allowed("browser_find", {"text": "Hunt"}, EMPTY)
    for args in ({"text": "Hunt"}, {"textGone": "Fake"}, {"target": "text=Hunter2"}, {"regex": "H.*"},
                 {"text": "Welcome Hunter2-Fake!"}):
        with pytest.raises(PolicyViolation):
            check_call_allowed("browser_find", args, FILLED)
    check_call_allowed("browser_find", {"text": "Welcome"}, FILLED)
    check_call_allowed("browser_click", {"target": "e12"}, FILLED)  # refs never share 4 chars with the value
    check_call_allowed("browser_wait_for", {"text": "Hun"}, FILLED)  # below the n-gram size


def test_secret_fill_to_type(portal_pass):
    out = secret_fill_to_type({"target": "e5", "token": f" {portal_pass}\n", "submit": True})
    assert out == {"target": "e5", "text": portal_pass, "element": "secret field", "submit": True}
    assert secret_fill_to_type({"target": "e5", "token": portal_pass, "element": "pw"})["element"] == "pw"
    assert secret_fill_to_type({"target": "e5", "token": portal_pass, "element": 7})["element"] == "secret field"
    for bad in ({"token": portal_pass}, {"target": "e5", "token": "Hunter2"}, {"target": "e5", "token": f"{portal_pass} more"}):
        with pytest.raises(ValidationError):
            secret_fill_to_type(bad)


def test_has_tokens(portal_pass):
    assert has_tokens("browser_type", {"text": portal_pass})
    assert has_tokens("browser_fill_form", {"fields": [{"value": portal_pass}]})
    assert not has_tokens("browser_type", {"text": "hello"})
    assert not has_tokens("browser_click", {"target": portal_pass})  # not a fill tool
    with pytest.raises(PolicyViolation):
        has_tokens("browser_type", {"text": "x", "element": portal_pass})


def _sub(text):
    res = Resolution(token="enc:v1:AAAAAAAAAAAAAAAAAAAA", label="l", value="PLAIN")
    return text.replace(res.token, res.value), ((res,) if res.token in text else ())


def test_rewrite_fill_args_type_and_form():
    tok = "enc:v1:AAAAAAAAAAAAAAAAAAAA"
    args, res = rewrite_fill_args("browser_type", {"target": "e1", "text": f"x{tok}"}, _sub)
    assert args["text"] == "xPLAIN" and len(res) == 1
    form = {"fields": [{"target": "a", "value": tok}, {"target": "b", "value": "keep"}, {"target": "c", "value": 3}]}
    args, res = rewrite_fill_args("browser_fill_form", form, _sub)
    assert [f["value"] for f in args["fields"]] == ["PLAIN", "keep", 3]
    assert len(res) == 1
    assert form["fields"][0]["value"] == tok  # input untouched
    assert rewrite_fill_args("browser_type", {"target": "e1"}, _sub) == ({"target": "e1"}, ())
    assert rewrite_fill_args("browser_fill_form", {"fields": "nope"}, _sub)[1] == ()
    assert rewrite_fill_args("browser_click", {"text": tok}, _sub)[1] == ()


def test_resolve_for_page_enforces_host(resolver, portal_pass, bank_pass):
    ok = resolve_for_page(resolver, "https://login.portal-a.example.com/")
    text, res = ok(portal_pass)
    assert text == fs.PORTAL.password and res[0].label == fs.PORTAL.label
    with pytest.raises(PolicyViolation):
        ok(bank_pass)


def test_scrub_drops_code_echo_for_fills_and_output_links():
    text = "### Ran Playwright code\nawait page.fill('it\\'s');\n- [Snapshot](../browser-out/page-1.yml)\n### Page\n- Page URL: https://a/\n"
    out = scrub_result_text("browser_type", text)
    assert "it\\'s" not in out and "page-1.yml" not in out
    assert out.startswith("### Page") and "Page URL" in out
    nav = "### Ran Playwright code\nawait page.goto('https://a/');\n- [Snapshot](/abs/page-2.yml)\n"
    assert scrub_result_text("browser_navigate", nav) == "### Ran Playwright code\nawait page.goto('https://a/');\n"
    assert scrub_result_text("browser_snapshot", "- [Link](https://a.example.com/x)\n") == "- [Link](https://a.example.com/x)\n"


def test_gate_state_is_immutable_and_accumulates():
    r1 = Resolution(token="t1", label="a", value="v1")
    r2 = Resolution(token="t2", label="b", value="v1")  # same value, different token
    s0 = GateState()
    s1 = s0.with_fill("http://x/", (r1,))
    s2 = s1.with_fill("http://y/", (r2,))
    assert s0.filled == () and s0.tainted_urls == frozenset()
    assert s1.tainted_urls == {"http://x/"} and s1.filled == (r1,)
    assert s2.filled == (r1,) and s2.tainted_urls == {"http://x/", "http://y/"}


def test_references_are_fillable_and_refused_outside_the_typed_text():
    from secret_gate.refs import new_ref

    ref = new_ref()
    assert secret_fill_to_type({"target": "e1", "token": ref})["text"] == ref
    assert has_tokens("browser_type", {"target": "e1", "text": f"x{ref}"})
    assert has_tokens("browser_fill_form", {"fields": [{"target": "e1", "value": ref}]})
    with pytest.raises(PolicyViolation, match="only appear in the typed text"):
        has_tokens("browser_type", {"target": ref, "text": "x"})


def test_gate_state_tracks_sealed_values_and_fill_history():
    from secret_gate.browser_policy import FILL_ATTEMPTED, FILL_DONE, GateState
    from secret_gate.resolver import Resolution

    sealed = Resolution(token="enc:ref:AAAAAAAAAAAAAAAA", label="page/email-1", value="alice@example.com")
    state = GateState().with_sealed("https://a.example.com/", (sealed,))
    assert state.protected == (sealed,) and state.tainted_urls == {"https://a.example.com/"}
    assert state.with_sealed("https://a.example.com/", (sealed,)).sealed == (sealed,)  # no duplicates
    state = state.with_fill_status("https://b.example.com/", ("e1", "e2"), FILL_ATTEMPTED)
    state = state.with_fill_status("https://b.example.com/", ("e1",), FILL_DONE)
    assert state.fill_history("https://b.example.com/", "e1") == (True, True)
    assert state.fill_history("https://b.example.com/", "e2") == (True, False)
    assert state.fill_history("https://a.example.com/", "e1") == (False, False)
    assert state.filled_targets("https://b.example.com/") == ("e2", "e1")


def test_oracle_checks_cover_drag_form_targets_case_and_text_selectors():
    from secret_gate.browser_policy import GateState

    state = GateState(filled=(Resolution(token="enc:v1:x", label="t", value="Zq9-Vx7-Pw4k"),))
    for name, args, needle in (
        ("browser_drag", {"startTarget": "e1", "endTarget": "zq9-v"}, "matches part"),
        ("browser_fill_form", {"fields": [{"target": "input[value^=VX7-]", "value": "x"}]}, "matches part"),
        ("browser_click", {"target": "text=Welcome back"}, "text or path selectors"),
        ("browser_click", {"target": "button:has(span)"}, "text or path selectors"),
        ("browser_click", {"target": "internal:role=button"}, "text or path selectors"),
        ("browser_network_requests", {"filter": "/api/.*"}, "filter search"),
    ):
        with pytest.raises(PolicyViolation, match=needle):
            check_call_allowed(name, args, state)
    check_call_allowed("browser_click", {"target": "f1e7"}, state)
    check_call_allowed("browser_click", {"target": "#submit"}, state)
    check_call_allowed("browser_click", {"target": "text=Welcome back"}, GateState())  # nothing protected yet


def test_page_host_errors_never_echo_the_url():
    with pytest.raises(PolicyViolation) as exc:
        page_host("data:text/html,alice@example.com")
    assert "alice" not in str(exc.value) and "data:" in str(exc.value)
    with pytest.raises(PolicyViolation) as exc:
        page_host("https://a.example.com:99999/?pw=Hunter2")
    assert "Hunter2" not in str(exc.value)
