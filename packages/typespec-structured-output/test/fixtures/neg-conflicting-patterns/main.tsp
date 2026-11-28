import "typespec-structured-output";
using StructuredOutput;

@pattern("^a")
scalar A extends string;
@structuredOutput
model M { @pattern("b$") v: A; }
