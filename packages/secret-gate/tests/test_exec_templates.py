import json
from pathlib import Path

import pytest

from secret_gate.errors import ExecTemplateError, ValidationError
from secret_gate.exec_templates import (
    ExecTemplate,
    child_env,
    get_template,
    load_templates,
)

EXAMPLE = Path(__file__).resolve().parents[1] / "config" / "exec_templates.example.json"


def _write(home, data):
    home.mkdir(exist_ok=True)
    (home / "exec_templates.json").write_text(json.dumps(data))


def test_load_and_render(tmp_path):
    _write(tmp_path, {"mysql": {"argv": ["mysql", "-u", "{ARG0}"], "env": {"MYSQL_PWD": "{SECRET}"}, "max_args": 1},
                      "tool": {"argv": ["tool", "login", "--password-stdin"], "stdin": "{SECRET}\n"}})
    tpls = load_templates(tmp_path)
    rendered = get_template(tpls, "mysql").render("pw", ("app_ro",), base_env={"PATH": "/usr/bin", "HOME": "/x"})
    assert rendered.argv == ("mysql", "-u", "app_ro")
    assert rendered.env == {"PATH": "/usr/bin", "MYSQL_PWD": "pw"} and rendered.stdin is None
    rendered = get_template(tpls, "tool").render("pw", (), base_env={})
    assert rendered.argv == ("tool", "login", "--password-stdin") and rendered.stdin == "pw\n"
    assert rendered.env == {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def test_the_example_loads_and_keeps_the_value_off_the_command_line(tmp_path):
    (tmp_path / "exec_templates.json").write_text(EXAMPLE.read_text())
    tpls = load_templates(tmp_path)
    assert set(tpls) == {"mysql", "psql"}
    assert dict(tpls["psql"].env) == {"PGPASSWORD": "{SECRET}"} and dict(tpls["mysql"].env) == {"MYSQL_PWD": "{SECRET}"}
    rendered = tpls["psql"].render("s3cret", ("db.example", "app", "select"), base_env={})
    assert "s3cret" not in " ".join(rendered.argv) and rendered.env["PGPASSWORD"] == "s3cret"


def test_secret_in_argv_is_refused_with_a_reason(tmp_path):
    _write(tmp_path, {"mysql": {"argv": ["mysql", "-u", "{ARG0}", "-p{SECRET}"], "max_args": 1}})
    with pytest.raises(ExecTemplateError, match="argv 中使用了 \\{SECRET\\}.*env.*stdin"):
        load_templates(tmp_path)
    with pytest.raises(ExecTemplateError, match="argv"):
        ExecTemplate("t", ("env", "PGPASSWORD={SECRET}", "psql"), max_args=0)


def test_missing_file_is_empty(tmp_path):
    assert load_templates(tmp_path) == {}
    with pytest.raises(ExecTemplateError, match="不在白名单中"):
        get_template({}, "anything")


@pytest.mark.parametrize(
    "data",
    [
        {"bad name!": {"argv": ["x"], "stdin": "{SECRET}"}},
        {"t": {"argv": [], "stdin": "{SECRET}"}},
        {"t": {"argv": ["x", 1], "stdin": "{SECRET}"}},
        {"t": {"argv": ["no-secret-marker"]}},
        {"t": {"argv": ["x"], "env": {"V": "literal"}}},
        {"t": {"argv": ["x"], "stdin": "{SECRET}", "max_args": -1}},
        {"t": {"argv": ["x"], "stdin": "{SECRET}", "max_args": True}},
        {"t": {"argv": ["x"], "env": {"BAD-NAME": "{SECRET}"}}},
        {"t": {"argv": ["x"], "env": {"V": 1}, "stdin": "{SECRET}"}},
        {"t": {"argv": ["x"], "env": {"V": "{SECRET}{ARG0}"}, "max_args": 1}},
        {"t": {"argv": ["x"], "stdin": "{ARG0}{SECRET}", "max_args": 1}},
        {"t": {"argv": ["x"], "env": ["V"], "stdin": "{SECRET}"}},
        {"t": {"argv": ["x"], "stdin": "{SECRET}", "shell": True}},
        {"t": "not a dict"},
    ],
)
def test_bad_templates(tmp_path, data):
    _write(tmp_path, data)
    with pytest.raises(ExecTemplateError):
        load_templates(tmp_path)


def test_invalid_json_and_shape(tmp_path):
    tmp_path.joinpath("exec_templates.json").write_text("{nope")
    with pytest.raises(ExecTemplateError):
        load_templates(tmp_path)
    tmp_path.joinpath("exec_templates.json").write_text("[]")
    with pytest.raises(ExecTemplateError):
        load_templates(tmp_path)


def test_render_arg_validation():
    tpl = ExecTemplate("t", ("cmd", "{ARG0}", "{ARG1}"), max_args=2, stdin="{SECRET}")
    with pytest.raises(ValidationError, match="最多接受 2 个参数"):
        tpl.render("s", ("a", "b", "c"))
    with pytest.raises(ValidationError, match="不允许"):
        tpl.render("s", ("a; rm -rf /", "b"))
    with pytest.raises(ValidationError, match="只给了 1 个参数"):
        tpl.render("s", ("a",))


@pytest.mark.parametrize("arg", ["-h", "--host=evil.example", "-oProxyCommand=x", "-"])
def test_args_that_look_like_options_are_refused(arg):
    tpl = ExecTemplate("t", ("cmd", "{ARG0}"), max_args=1, stdin="{SECRET}")
    with pytest.raises(ValidationError, match="不能以 - 开头"):
        tpl.render("s", (arg,))
    assert tpl.render("s", ("a-b",), base_env={}).argv == ("cmd", "a-b")       # a dash inside is fine


def test_child_env_is_minimal():
    base = {"PATH": "/usr/bin", "LANG": "C", "HOME": "/Users/me", "SECRET_GATE_HOME": "/g", "SECRET_GATE_SCOPE": "s",
            "HTTPS_PROXY": "http://127.0.0.1:8080", "AWS_SECRET_ACCESS_KEY": "x", "LC_ALL": ""}
    assert child_env(base) == {"PATH": "/usr/bin", "LANG": "C"}
    assert child_env({}) == {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
