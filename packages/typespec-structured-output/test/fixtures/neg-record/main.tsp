import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { counts: Record<string>; }
