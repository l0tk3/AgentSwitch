"""Exception hierarchy. Every failure the gate raises derives from GateError."""


class GateError(Exception):
    """Base class for all secret-gate errors."""


class TokenError(GateError):
    """Token is malformed, tampered with, or not encrypted for this gate."""


class PolicyViolation(GateError):
    """Token is valid but the requested host/use is not allowed by its policy."""


class KeyStoreError(GateError):
    """Key material is missing, unreadable, or has unsafe permissions."""


class ExecTemplateError(GateError):
    """Exec template is missing, malformed, or not whitelisted."""


class ValidationError(GateError):
    """Caller-supplied input failed validation."""
