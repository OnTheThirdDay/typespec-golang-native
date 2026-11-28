"""Reference JSON text of Python's json.dumps for typespec-go's float-format: python-repr.

json.dumps writes a float with float.__repr__ (shortest round-trip digits, decimal notation for
decimal exponents -4 <= e < 16, exponent notation with a sign and at least two digits otherwise).

Usage (from this directory):  uv run --frozen python -I python_repr.py
Writes packages/typespec-go/test/go/python-repr/testdata/reference.json.
"""

from __future__ import annotations

import json
import random
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "packages" / "typespec-go" / "test" / "go" / "python-repr" / "testdata" / "reference.json"

FLOAT64 = [
    # zero, sign, integral values, rounding
    0.0, -0.0, 1.0, -1.0, 2.5, -0.5, 100.0, 12345.678, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 2 / 3, 100 / 3, 1.1, 2.675, 1e23, 9007199254740993.0,
    # decimal / exponent thresholds (decimal exponent -4 and 16)
    1e-4, 0.00012345, 9.999999999999999e-05, 1e-5, 1.5e-5, 1e-6, 1.5e-7, 1e15, 999999999999999.9, 9999999999999998.0, 1e16,
    1.0000000000000002e16, 1.5e16, 123456789012345678.0, 1e21, 1e22, 1e100, 1e300, 1.5e-100, -1e-5, -1e16,
    # subnormal and extreme finite values
    5e-324, 1e-323, 2.2250738585072009e-308, 2.2250738585072014e-308, 1e-310, 4.9406564584124654e-324,
    1.7976931348623157e308, -1.7976931348623157e308, 8.98846567431158e307,
]

# float32 values, written as the shortest decimal that round-trips the float32 value.
FLOAT32 = ["0", "-0", "1", "0.1", "0.3", "1.5", "0.0001", "0.00001", "16777216", "1e+15", "1e+16", "3.4028235e+38", "-3.4028235e+38",
           "1.1754944e-38", "1e-45", "-2.5e-07", "1.0000001", "123456.79"]


def shortest32(bits: int) -> str:
    """Shortest decimal that round-trips the float32 with these bits."""
    (f,) = struct.unpack("<f", struct.pack("<I", bits))
    for p in range(1, 10):
        s = f"{f:.{p}g}"
        if struct.unpack("<f", struct.pack("<f", float(s)))[0] == f:
            return s
    raise AssertionError(bits)


def finite64(r: random.Random) -> float:
    while True:
        (f,) = struct.unpack("<d", struct.pack("<Q", r.getrandbits(64)))
        if f == f and abs(f) != float("inf"):
            return f


def finite32(r: random.Random) -> str:
    while True:
        bits = r.getrandbits(32)
        if (bits >> 23) & 0xFF != 0xFF:
            return shortest32(bits)


def main() -> None:
    r = random.Random(20261127)
    # Random bit patterns cover every exponent; random decimals of a few digits cover rounding.
    random64 = [finite64(r) for _ in range(1500)] + [round(r.uniform(-1e6, 1e6), r.randrange(0, 8)) for _ in range(500)]
    random64 += [r.randrange(1, 10**r.randrange(1, 17)) * 10.0 ** r.randrange(-12, 25) for _ in range(500)]
    random32 = [finite32(r) for _ in range(1000)]
    out = {
        "python": sys.version.split()[0],
        "float64": [[f.hex(), json.dumps(f)] for f in FLOAT64 + random64],
        "float32": [[s, json.dumps(float(s))] for s in FLOAT32 + random32],
        # Floats inside a container (json.dumps of a list, compact separators).
        "list": [[[f.hex() for f in FLOAT64[:12]], json.dumps(FLOAT64[:12], separators=(",", ":"))]],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # One entry per line.
    parts = []
    for k, v in out.items():
        if isinstance(v, list):
            parts.append(json.dumps(k) + ": [\n" + ",\n".join(json.dumps(x, separators=(",", ":")) for x in v) + "\n]")
        else:
            parts.append(json.dumps(k) + ": " + json.dumps(v))
    OUT.write_text("{\n" + ",\n".join(parts) + "\n}\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
