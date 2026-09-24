import pytest

from secret_gate.constants import KIND_TOTP
from secret_gate.errors import ValidationError
from secret_gate.policy import SecretPayload, host_matches, normalize_host


def test_create_and_roundtrip():
    p = SecretPayload.create(value="v", hosts=["A.Example.com."], uses=["http"], label="x/y")
    assert p.hosts == ("a.example.com",)
    assert SecretPayload.from_json(p.to_json()) == p


@pytest.mark.parametrize("bad", ["", "http://a.com", "a.com/path", "a com", "-"])
def test_bad_hosts(bad):
    with pytest.raises(ValidationError):
        normalize_host(bad)


@pytest.mark.parametrize(
    "pattern,host,expected",
    [
        ("a.com", "a.com", True),
        ("a.com", "b.a.com", False),
        ("*.a.com", "b.a.com", True),
        ("*.a.com", "c.b.a.com", True),
        ("*.a.com", "a.com", False),
        ("*.a.com", "xa.com", False),
    ],
)
def test_host_matches(pattern, host, expected):
    assert host_matches(pattern, host) is expected


def test_invalid_inputs():
    with pytest.raises(ValidationError):
        SecretPayload.create(value="", hosts=[], uses=["http"], label="l")
    with pytest.raises(ValidationError):
        SecretPayload.create(value="v", hosts=[], uses=[], label="l")
    with pytest.raises(ValidationError):
        SecretPayload.create(value="v", hosts=[], uses=["teleport"], label="l")
    with pytest.raises(ValidationError):
        SecretPayload.create(value="v", hosts=[], uses=["http"], label="bad label!")
    with pytest.raises(ValidationError):
        SecretPayload.create(value="v", hosts=[], uses=["http"], label="l", kind="rsa")
    with pytest.raises(ValidationError):
        SecretPayload.create(value="not base32 !!", hosts=[], uses=["otp"], label="l", kind=KIND_TOTP)


def test_from_json_errors():
    for raw in ["not json", "[1,2]", '{"v":"x"}', '{"v":1,"use":["http"],"label":"l"}']:
        with pytest.raises(ValidationError):
            SecretPayload.from_json(raw)


def test_describe_hides_value():
    p = SecretPayload.create(value="TopSecret", hosts=["a.com"], uses=["http"], label="l")
    assert "TopSecret" not in str(p.describe())
    assert p.describe()["hosts"] == ["a.com"]


def test_allows():
    p = SecretPayload.create(value="v", hosts=["*.a.com"], uses=["http"], label="l")
    assert p.allows_host("X.a.com") and not p.allows_host("a.com")
    assert p.allows_use("http") and not p.allows_use("exec")


@pytest.mark.parametrize("label", ["portal/pass\n", "portal/pass\r", "ok\n"])
def test_label_with_trailing_newline_is_rejected(label):
    from secret_gate.errors import ValidationError
    from secret_gate.policy import SecretPayload

    with pytest.raises(ValidationError):
        SecretPayload.create(value="v", hosts=["a.example.com"], uses=["http"], label=label)


@pytest.mark.parametrize("host", ["a.example.com:٨٠", "a.example.com:²", "a.example.com:８０"])
def test_hosts_reject_non_ascii_ports(host):  # surrounding whitespace is trimmed on purpose (CLI input)
    from secret_gate.errors import ValidationError
    from secret_gate.policy import normalize_host

    with pytest.raises(ValidationError):
        normalize_host(host)
