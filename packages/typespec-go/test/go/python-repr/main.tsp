// float-format: python-repr, checked against Python's json.dumps (testdata/reference.json from
// tools/pydantic-reference/python_repr.py).
model F { x: float64; }
model F32 { x: float32; }
model L { xs: float64[]; }
model Nested { r: Record<float64>; t: [float64, float32]; o?: float64 | null; }
