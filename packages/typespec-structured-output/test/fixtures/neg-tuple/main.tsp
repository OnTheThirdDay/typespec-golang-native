import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { pair: [string, string]; }
