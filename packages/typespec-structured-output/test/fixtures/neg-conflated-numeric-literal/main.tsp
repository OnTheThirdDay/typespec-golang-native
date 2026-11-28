import "typespec-structured-output";
using StructuredOutput;

// Distinct literals that round to the same binary64 value share one exact value in the
// TypeSpec 1.18 semantic model; the second one cannot be emitted faithfully.
@structuredOutput
model M {
  a: 9007199254740995;
  b: 9007199254740997;
}
