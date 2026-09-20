"""Project-wide constants. No logic lives here."""

import re
from pathlib import Path

TOKEN_PREFIX = "enc:v1:"
# base64url alphabet, optional padding
TOKEN_PATTERN = re.compile(r"enc:v1:[A-Za-z0-9_-]{16,}={0,2}")
# The same token after application/x-www-form-urlencoded encoding (curl --data-urlencode, browsers)
ENCODED_TOKEN_PATTERN = re.compile(r"enc%3[Aa]v1%3[Aa][A-Za-z0-9_-]{16,}(?:%3[Dd]){0,2}")

DEFAULT_HOME = Path.home() / ".secret-gate"
HOME_ENV_VAR = "SECRET_GATE_HOME"
PRIVATE_KEY_FILE = "key.priv"
PUBLIC_KEY_FILE = "key.pub"
CA_CERT_FILE = "ca.pem"
EXEC_TEMPLATES_FILE = "exec_templates.json"
MITMPROXY_CA_PATH = Path.home() / ".mitmproxy" / "mitmproxy-ca-cert.pem"

USE_HTTP = "http"
USE_OTP = "otp"
USE_EXEC = "exec"
VALID_USES = frozenset({USE_HTTP, USE_OTP, USE_EXEC})

KIND_SECRET = "secret"
KIND_TOTP = "totp"
VALID_KINDS = frozenset({KIND_SECRET, KIND_TOTP})

LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$")
_LABEL = r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
HOST_PATTERN = re.compile(rf"^(\*\.)?(?:{_LABEL}\.)*{_LABEL}$")
TEMPLATE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")

TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6

REDACTED_FORMAT = "[REDACTED:{label}]"
MIN_REDACT_LENGTH = 4

DEFAULT_PROXY_PORT = 8080
EXEC_TIMEOUT_SECONDS = 60
HTTP_TIMEOUT_SECONDS = 30
MAX_BODY_BYTES = 4 * 1024 * 1024

POLICY_DENIED_STATUS = 403
