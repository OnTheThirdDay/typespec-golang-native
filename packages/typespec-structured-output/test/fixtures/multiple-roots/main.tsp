import "typespec-structured-output";
using StructuredOutput;

model Shared { x: string; }
@structuredOutput model First { s: Shared; }
@structuredOutput model Second { s: Shared; n: integer; }
