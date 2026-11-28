import "typespec-structured-output";
using StructuredOutput;

// An anonymous object has no Python class name for generic naming.
model Box<T> { v: T; }
@structuredOutput
model M { b: Box<{ x: string }>; }
