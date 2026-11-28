import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { name: string; ...Record<string>; }
