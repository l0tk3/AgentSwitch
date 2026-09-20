from secret_gate.redact import contains_any, redact
from secret_gate.resolver import Resolution


def test_redact_basic():
    res = [Resolution("t", "site/pass", "Hunter2-Fake")]
    assert redact("welcome Hunter2-Fake!", res) == "welcome [REDACTED:site/pass]!"


def test_redact_longest_first():
    res = [Resolution("t1", "short", "abcd"), Resolution("t2", "long", "abcdefgh")]
    assert redact("x abcdefgh y abcd", res) == "x [REDACTED:long] y [REDACTED:short]"


def test_redact_skips_tiny_values():
    res = [Resolution("t", "pin", "12")]
    assert redact("code 12 here", res) == "code 12 here"


def test_redact_none_and_contains():
    res = [Resolution("t", "l", "secretvalue")]
    assert redact(None, res) is None
    assert contains_any("has secretvalue", res)
    assert not contains_any("clean", res)
    assert not contains_any(None, res)
