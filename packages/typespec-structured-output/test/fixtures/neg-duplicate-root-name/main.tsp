import "typespec-structured-output";
using StructuredOutput;

@structuredOutput("Same") model A { a: string; }
@structuredOutput("Same") model B { b: string; }
