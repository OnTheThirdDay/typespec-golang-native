"""Regenerates the Pydantic + OpenAI SDK reference fixtures for typespec-structured-output.

Usage (from this directory):  uv run python -I generate.py [case-name ...]

For every fixture directory containing a `model.py`, the module is executed in an isolated
namespace whose `__name__` is `__main__` (Pydantic uses the module name in definition-collision
handling). The module must define `ROOTS`, a list of BaseModel classes. For each root this writes:

  pydantic : BaseModel.model_json_schema()                  (validation mode)
  strict   : openai.lib._pydantic.to_strict_json_schema()   (what the SDK sends)
  name     : the `json_schema.name` the SDK derives (type_to_response_format_param)

Output: `<case>/reference.json`. Python is only needed to refresh these committed fixtures.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import openai
import pydantic
import pydantic_core
from openai.lib._parsing._completions import type_to_response_format_param
from openai.lib._pydantic import to_strict_json_schema

FIXTURES = Path(__file__).resolve().parents[2] / "packages" / "typespec-structured-output" / "test" / "fixtures"


def run_case(case_dir: Path) -> dict:
    source = (case_dir / "model.py").read_text(encoding="utf-8")
    module = types.ModuleType("__main__")
    module.__dict__["__name__"] = "__main__"
    # Make the module importable while executing so forward references resolve.
    saved = sys.modules.get("__main__")
    sys.modules["__main__"] = module
    try:
        exec(compile(source, str(case_dir / "model.py"), "exec"), module.__dict__)
        roots = module.__dict__["ROOTS"]
        out: dict[str, dict] = {}
        for root in roots:
            fmt = type_to_response_format_param(root)
            name = fmt["json_schema"]["name"]
            out[name] = {
                "pydantic": root.model_json_schema(),
                "strict": to_strict_json_schema(root),
                "name": name,
            }
        return out
    finally:
        if saved is not None:
            sys.modules["__main__"] = saved


def main(argv: list[str]) -> int:
    selected = set(argv)
    count = 0
    for case_dir in sorted(p for p in FIXTURES.iterdir() if p.is_dir()):
        if selected and case_dir.name not in selected:
            continue
        if not (case_dir / "model.py").exists():
            continue
        result = {
            "reference": {
                "pydantic": pydantic.VERSION,
                "pydantic-core": pydantic_core.__version__,
                "openai": openai.__version__,
            },
            "roots": run_case(case_dir),
        }
        text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
        (case_dir / "reference.json").write_text(text, encoding="utf-8", newline="\n")
        count += 1
    print(f"wrote {count} reference fixture(s) to {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
