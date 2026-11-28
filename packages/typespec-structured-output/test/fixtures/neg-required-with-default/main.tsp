import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { a: string = "x"; }
