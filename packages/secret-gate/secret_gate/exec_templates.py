"""Whitelisted command templates for `secret_exec`.

Format of exec_templates.json:
    {"psql":  {"argv": ["/usr/bin/psql", "-h", "db.internal", "-U", "{ARG0}", "-c", "{ARG1}"],
               "env": {"PGPASSWORD": "{SECRET}"}, "max_args": 2},
     "vault": {"argv": ["/usr/local/bin/tool", "login", "--password-stdin"], "stdin": "{SECRET}\\n"}}

`{SECRET}` is the resolved value. It may only appear in `env` values and in `stdin`, never in `argv`: a command
line is visible to every user of the machine (`ps`), the gate service's included. `{ARGn}` are caller-supplied args,
allowed only in `argv`. The child gets a minimal environment (see `child_env`), never the gate's own.
Only listed templates may run; the model can never supply a raw command line, and an arg may not start with `-`
(it would be read as an option).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .constants import EXEC_TEMPLATES_FILE, TEMPLATE_NAME_PATTERN
from .errors import ExecTemplateError, ValidationError

_ARG_PATTERN = re.compile(r"\{ARG(\d+)\}")
_SECRET_MARK = "{SECRET}"
_SAFE_ARG = re.compile(r"^[A-Za-z0-9._@:/=+,][A-Za-z0-9._@:/=+,-]{0,255}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_SPEC_KEYS = frozenset({"argv", "env", "stdin", "max_args"})
# What the child inherits from the gate's environment; everything else (the gate's home, scope, proxy settings,
# keys of other tools) stays out. Under the service PATH holds only root-owned directories (gate-service-v0 §2).
INHERITED_ENV = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ")
DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


@dataclass(frozen=True)
class Rendered:
    argv: tuple[str, ...]
    env: dict[str, str]
    stdin: str | None


@dataclass(frozen=True)
class ExecTemplate:
    name: str
    argv: tuple[str, ...]
    max_args: int
    env: tuple[tuple[str, str], ...] = ()
    stdin: str | None = None

    def __post_init__(self) -> None:
        if isinstance(self.env, Mapping):
            object.__setattr__(self, "env", tuple(self.env.items()))
        _check(self.name, tuple(self.argv), dict(self.env), self.stdin)

    def render(self, secret: str, args: tuple[str, ...], base_env: Mapping[str, str] | None = None) -> Rendered:
        if len(args) > self.max_args:
            raise ValidationError(f"模板 {self.name!r} 最多接受 {self.max_args} 个参数")
        for arg in args:
            if not isinstance(arg, str) or not _SAFE_ARG.match(arg):
                raise ValidationError(f"参数 {arg!r} 不允许：只能含字母、数字和 ._@:/=+,-，且不能以 - 开头")

        def fill(part: str) -> str:
            def sub(m: re.Match) -> str:
                idx = int(m.group(1))
                if idx >= len(args):
                    raise ValidationError(f"模板需要 ARG{idx}，只给了 {len(args)} 个参数")
                return args[idx]

            return _ARG_PATTERN.sub(sub, part)

        env = child_env(base_env)
        env.update({name: value.replace(_SECRET_MARK, secret) for name, value in self.env})
        stdin = self.stdin.replace(_SECRET_MARK, secret) if self.stdin is not None else None
        return Rendered(argv=tuple(fill(p) for p in self.argv), env=env, stdin=stdin)


def child_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """The few variables a template command inherits; PATH always set."""
    source = os.environ if base is None else base
    env = {name: source[name] for name in INHERITED_ENV if source.get(name)}
    env.setdefault("PATH", DEFAULT_PATH)
    return env


def _check(name: str, argv: tuple[str, ...], env: dict[str, str], stdin: str | None) -> None:
    if not TEMPLATE_NAME_PATTERN.fullmatch(name):
        raise ExecTemplateError(f"模板名 {name!r} 无效")
    if not argv or not all(isinstance(p, str) and p for p in argv):
        raise ExecTemplateError(f"模板 {name!r} 的 argv 应为非空字符串列表")
    if any(_SECRET_MARK in p for p in argv):
        raise ExecTemplateError(f"模板 {name!r} 在 argv 中使用了 {{SECRET}}：命令行对本机所有用户可见，"
                                f"请改用 env（如 PGPASSWORD、MYSQL_PWD）或 stdin 传值")
    for key, value in env.items():
        if not isinstance(key, str) or not _ENV_NAME.fullmatch(key):
            raise ExecTemplateError(f"模板 {name!r} 的环境变量名 {key!r} 无效")
        if not isinstance(value, str) or _ARG_PATTERN.search(value):
            raise ExecTemplateError(f"模板 {name!r} 的环境变量 {key} 应为字符串，且不能含 {{ARGn}}")
    if stdin is not None and (not isinstance(stdin, str) or _ARG_PATTERN.search(stdin)):
        raise ExecTemplateError(f"模板 {name!r} 的 stdin 应为字符串，且不能含 {{ARGn}}")
    if not any(_SECRET_MARK in v for v in (*env.values(), stdin or "")):
        raise ExecTemplateError(f"模板 {name!r} 没有在 env 或 stdin 中使用 {{SECRET}}")


def _parse_one(name: str, spec: object) -> ExecTemplate:
    if not isinstance(spec, dict) or not isinstance(spec.get("argv"), list):
        raise ExecTemplateError(f"模板 {name!r} 需要 argv 列表")
    unknown = set(spec) - _SPEC_KEYS
    if unknown:
        raise ExecTemplateError(f"模板 {name!r} 有未知字段：{', '.join(sorted(map(str, unknown)))}")
    env = spec.get("env", {})
    if not isinstance(env, dict):
        raise ExecTemplateError(f"模板 {name!r} 的 env 应为对象")
    max_args = spec.get("max_args", 0)
    if not isinstance(max_args, int) or isinstance(max_args, bool) or max_args < 0:
        raise ExecTemplateError(f"模板 {name!r} 的 max_args 应为非负整数")
    return ExecTemplate(name=name, argv=tuple(spec["argv"]), max_args=max_args,
                        env=tuple(env.items()), stdin=spec.get("stdin"))


def load_templates(home: Path) -> dict[str, ExecTemplate]:
    path = home / EXEC_TEMPLATES_FILE
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ExecTemplateError(f"{path} 不是有效的 JSON") from exc
    if not isinstance(data, dict):
        raise ExecTemplateError(f"{path} 应为 JSON 对象")
    return {name: _parse_one(name, spec) for name, spec in data.items()}


def get_template(templates: dict[str, ExecTemplate], name: str) -> ExecTemplate:
    if name not in templates:
        raise ExecTemplateError(f"模板 {name!r} 不在白名单中（已有：{sorted(templates)}）")
    return templates[name]
