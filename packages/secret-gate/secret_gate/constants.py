"""Project-wide constants. No logic lives here."""

import re
from pathlib import Path

TOKEN_PREFIX = "enc:v1:"
# base64url alphabet, optional padding
TOKEN_PATTERN = re.compile(r"enc:v1:[A-Za-z0-9_-]{16,}={0,2}")
# The same token after application/x-www-form-urlencoded encoding (curl --data-urlencode, browsers)
ENCODED_TOKEN_PATTERN = re.compile(r"enc%3[Aa]v1%3[Aa][A-Za-z0-9_-]{16,}(?:%3[Dd]){0,2}")

# Task-scoped short reference to a token (gate-next-v0 §1): a pointer, never a value or a policy.
REF_PREFIX = "enc:ref:"
REF_ID_CHARS = 16
REF_PATTERN = re.compile(rf"enc:ref:[A-Za-z0-9_-]{{{REF_ID_CHARS}}}(?![A-Za-z0-9_-])")
ENCODED_REF_PATTERN = re.compile(rf"enc%3[Aa]ref%3[Aa][A-Za-z0-9_-]{{{REF_ID_CHARS}}}(?![A-Za-z0-9_-])")
# Execution scope: an unguessable capability the dispatcher creates per execution.
SCOPE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{22,64}$")
SCOPE_ENV_VAR = "SECRET_GATE_SCOPE"
SCOPE_PROXY_USER = "scope"  # proxy URL http://scope:<scope>@127.0.0.1:8080
REFS_FILE = "refs.sqlite3"
REF_MAX_AGE_SECONDS = 2 * 24 * 3600  # an execution that never released its scope
RELEASED_SCOPE_RETENTION_SECONDS = 30 * 24 * 3600  # remembered so a released scope cannot reopen

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
# Browser fill only (secret_fill / browser_type / browser_fill_form): the proxy and secret_http refuse it.
# A browser fill also accepts `http` tokens; page values sealed under a transfer grant carry `fill` alone.
USE_FILL = "fill"
VALID_USES = frozenset({USE_HTTP, USE_OTP, USE_EXEC, USE_FILL})

KIND_SECRET = "secret"
KIND_TOTP = "totp"
VALID_KINDS = frozenset({KIND_SECRET, KIND_TOTP})

# Patterns are used with fullmatch(): `$` alone would also accept a trailing newline.
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
