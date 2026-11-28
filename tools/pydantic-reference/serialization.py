"""Reference JSON text of pydantic-core's model_dump_json for typespec-go's serialization policies
(float-format: pydantic, string-escaping: minimal).

Usage (from this directory):  uv run --frozen python -I serialization.py
Writes packages/typespec-go/test/go/pydantic-json/testdata/reference.json.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

OUT = Path(__file__).resolve().parents[2] / "packages" / "typespec-go" / "test" / "go" / "pydantic-json" / "testdata" / "reference.json"

FLOAT64 = [0.0, -0.0, 1.0, -1.0, 2.5, -0.5, 100.0, 12345.678, 0.1, 1 / 3, 1e-4, 9.5e-5, 1e-5, 1e-6, 1.5e-7, 1e15, 9999999999999998.0,
           1e16, 1.5e16, 123456789012345678.0, 1e21, 1e100, 1e300, 1.5e-100, 2.2250738585072014e-308, 5e-324, 1.7976931348623157e308,
           9007199254740993.0, -1.7976931348623157e308]
# float32 values, written as the shortest decimal that round-trips the float32 value.
FLOAT32 = ["0", "-0", "1", "0.1", "0.3", "1.5", "16777216", "1e+16", "3.4028235e+38", "1.1754944e-38", "1e-45", "-2.5e-07", "0.00001"]
STRINGS = ["", "plain", "<>&", "é", "日本", "  ", "\x00\x01\x1f\x7f", '"' + chr(92) + '/', "\t\n\r\b\f", "\U0001f600", "a\u0085b"]
KEYS = ["<k>&", " ", "é", "q\"uote", "tab\t"]


class F(BaseModel):
    x: float


class S(BaseModel):
    s: str


class R(BaseModel):
    m: dict[str, str]


def main() -> None:
    out = {
        "float64": [[f.hex(), F(x=f).model_dump_json()] for f in FLOAT64],
        "float32": [[s, F(x=float(s)).model_dump_json()] for s in FLOAT32],
        "strings": [[s, S(s=s).model_dump_json()] for s in STRINGS],
        "keys": [[k, R(m={k: k}).model_dump_json()] for k in KEYS],
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
