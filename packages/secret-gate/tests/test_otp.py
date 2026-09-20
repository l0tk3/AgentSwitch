import pytest

from secret_gate.errors import ValidationError
from secret_gate.otp import totp
from tests.fixtures.fake_secrets import TOTP_SECRET_B32

# RFC 6238 Appendix B (SHA1, 8 digits) truncated to 6 digits for our default.
RFC_VECTORS = {59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"}


@pytest.mark.parametrize("at,code", RFC_VECTORS.items())
def test_rfc6238_vectors(at, code):
    assert totp(TOTP_SECRET_B32, at=at) == code


def test_same_window_same_code():
    assert totp(TOTP_SECRET_B32, at=990) == totp(TOTP_SECRET_B32, at=1019)  # same 30s window
    assert totp(TOTP_SECRET_B32, at=59) != totp(TOTP_SECRET_B32, at=1111111109)  # RFC vectors differ


def test_bad_inputs():
    with pytest.raises(ValidationError):
        totp("!!notbase32!!", at=0)
    with pytest.raises(ValidationError):
        totp(TOTP_SECRET_B32, at=0, step=0)


def test_now_runs():
    assert len(totp(TOTP_SECRET_B32)) == 6
