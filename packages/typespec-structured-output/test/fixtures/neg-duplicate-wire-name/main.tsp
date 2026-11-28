import "typespec-structured-output";
using StructuredOutput;

// Two properties with the same JSON name: rejected by the TypeSpec compiler itself (the
// emitter also checks wire names, for names it derives).
@structuredOutput
model M {
  @encodedName("application/json", "x") a: string;
  x: string;
}
