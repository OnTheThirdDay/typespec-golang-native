// Serialization policies float-format: pydantic and string-escaping: minimal, checked against
// pydantic-core's model_dump_json (reference.json from tools/pydantic-reference/serialization.py).
model F { x: float64; }
model F32 { x: float32; }
model S { s: string; }
model R { m: Record<string>; }
