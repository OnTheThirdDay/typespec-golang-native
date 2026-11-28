import "typespec-structured-output";
using StructuredOutput;

model Box<T> { v: T; }
@structuredOutput
model M { b: Box<int32>; tags: Box<string[]>; }
