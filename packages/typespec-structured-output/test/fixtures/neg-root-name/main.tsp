import "typespec-structured-output";
using StructuredOutput;

@structuredOutput("not a valid name!")
model M { a: string; }
