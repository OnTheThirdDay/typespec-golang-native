import "typespec-structured-output";
using StructuredOutput;
model Box<T> { value: T; }
@structuredOutput model Labels { first: Box<"it's here">; second: Box<"tab\t\"quote\"">; }
