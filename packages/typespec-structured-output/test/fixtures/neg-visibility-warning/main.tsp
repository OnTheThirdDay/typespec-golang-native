import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @visibility(Lifecycle.Read) id: string; }
