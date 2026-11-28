import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @maxLength(3) code: string; @minItems(1) xs: string[]; }
