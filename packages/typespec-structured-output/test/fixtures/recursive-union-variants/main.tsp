import "typespec-structured-output";
using StructuredOutput;

// A JSON-like value: recursive through both lists and dictionaries.
union Json { s: string, n: float64, b: boolean, list: Json[], obj: Record<Json>, nil: null }

// Mutual recursion between two named unions.
union A { s: string, b: B[] }
union B { flag: boolean, a: A[] }

// A cycle through a named model is an ordinary (inlined) union.
model Node { label: string; next: Chain | null; }
union Chain { node: Node, text: string }

@structuredOutput
model Doc {
  /** The payload. */
  value: Json;
  pair: A;
  chain: Chain;
  list: Json[];
  maybe: B | null;
}
