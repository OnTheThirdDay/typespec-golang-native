import "typespec-structured-output";
using StructuredOutput;

enum Kind { a, b }
model Item { id: string; }
model Pair<K, V> { key: K; value: V; }
@structuredOutput
model Bag {
  p1: Pair<string, Item>;
  p2: Pair<Kind, integer>;
  p3: Pair<boolean, float64>;
}
