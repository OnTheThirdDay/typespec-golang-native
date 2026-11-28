import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { a?: int32 = 1; }
