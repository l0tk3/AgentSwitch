"""Whitelisted command templates for `secret_exec`.

Format of exec_templates.json:
    {"mysql": {"argv": ["mysql", "-h", "{ARG0}", "-u", "{ARG1}", "-p{SECRET}"], "max_args": 2}}

`{SECRET}` is replaced with the resolved value, `{ARGn}` with caller-supplied args.
Only listed templates may run; the model can never supply a raw command line.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .constants import EXEC_TEMPLATES_FILE, TEMPLATE_NAME_PATTERN
from .errors import ExecTemplateError, ValidationError

_ARG_PATTERN = re.compile(r"\{ARG(\d+)\}")
_SECRET_MARK = "{SECRET}"
_SAFE_ARG = re.compile(r"^[A-Za-z0-9._@:/=+,-]{1,256}$")


@dataclass(frozen=True)
class ExecTemplate:
    name: str
    argv: tuple[str, ...]
    max_args: int

    def render(self, secret: str, args: tuple[str, ...]) -> tuple[str, ...]:
        if len(args) > self.max_args:
            raise ValidationError(f"template {self.name!r} accepts at most {self.max_args} args")
        for arg in args:
            if not _SAFE_ARG.match(arg):
                raise ValidationError(f"unsafe argument {arg!r}")

        def fill(part: str) -> str:
            out = part.replace(_SECRET_MARK, secret)

            def sub(m: re.Match) -> str:
                idx = int(m.group(1))
                if idx >= len(args):
                    raise ValidationError(f"template needs ARG{idx} but only {len(args)} given")
                return args[idx]

            return _ARG_PATTERN.sub(sub, out)

        return tuple(fill(p) for p in self.argv)


def _parse_one(name: str, spec: object) -> ExecTemplate:
    if not TEMPLATE_NAME_PATTERN.fullmatch(name):
        raise ExecTemplateError(f"bad template name {name!r}")
    if not isinstance(spec, dict) or not isinstance(spec.get("argv"), list) or not spec["argv"]:
        raise ExecTemplateError(f"template {name!r} needs a non-empty argv list")
    argv = tuple(spec["argv"])
    if not all(isinstance(p, str) for p in argv):
        raise ExecTemplateError(f"template {name!r} argv must be strings")
    if not any(_SECRET_MARK in p for p in argv):
        raise ExecTemplateError(f"template {name!r} never uses {{SECRET}}")
    max_args = spec.get("max_args", 0)
    if not isinstance(max_args, int) or max_args < 0:
        raise ExecTemplateError(f"template {name!r} max_args must be a non-negative int")
    return ExecTemplate(name=name, argv=argv, max_args=max_args)


def load_templates(home: Path) -> dict[str, ExecTemplate]:
    path = home / EXEC_TEMPLATES_FILE
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ExecTemplateError(f"{path} is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ExecTemplateError(f"{path} must be a JSON object")
    return {name: _parse_one(name, spec) for name, spec in data.items()}


def get_template(templates: dict[str, ExecTemplate], name: str) -> ExecTemplate:
    if name not in templates:
        raise ExecTemplateError(f"template {name!r} is not whitelisted (have: {sorted(templates)})")
    return templates[name]
