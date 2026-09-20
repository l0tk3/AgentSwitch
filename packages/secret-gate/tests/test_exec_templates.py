import json

import pytest

from secret_gate.errors import ExecTemplateError, ValidationError
from secret_gate.exec_templates import ExecTemplate, get_template, load_templates


def _write(home, data):
    home.mkdir(exist_ok=True)
    (home / "exec_templates.json").write_text(json.dumps(data))


def test_load_and_render(tmp_path):
    _write(tmp_path, {"mysql": {"argv": ["mysql", "-u", "{ARG0}", "-p{SECRET}"], "max_args": 1}})
    tpls = load_templates(tmp_path)
    argv = get_template(tpls, "mysql").render("pw", ("app_ro",))
    assert argv == ("mysql", "-u", "app_ro", "-ppw")


def test_missing_file_is_empty(tmp_path):
    assert load_templates(tmp_path) == {}
    with pytest.raises(ExecTemplateError, match="not whitelisted"):
        get_template({}, "anything")


@pytest.mark.parametrize(
    "data",
    [
        {"bad name!": {"argv": ["x", "{SECRET}"]}},
        {"t": {"argv": []}},
        {"t": {"argv": ["x", 1]}},
        {"t": {"argv": ["no-secret-marker"]}},
        {"t": {"argv": ["{SECRET}"], "max_args": -1}},
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
    tpl = ExecTemplate("t", ("cmd", "{ARG0}", "{ARG1}", "{SECRET}"), max_args=2)
    with pytest.raises(ValidationError, match="at most"):
        tpl.render("s", ("a", "b", "c"))
    with pytest.raises(ValidationError, match="unsafe"):
        tpl.render("s", ("a; rm -rf /", "b"))
    with pytest.raises(ValidationError, match="only 1 given"):
        tpl.render("s", ("a",))
