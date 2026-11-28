import "typespec-structured-output";
using StructuredOutput;

// A fractional literal beyond binary64 precision has no Python float equivalent.
@structuredOutput
model M {
  a: 0.10000000000000000001;
}
