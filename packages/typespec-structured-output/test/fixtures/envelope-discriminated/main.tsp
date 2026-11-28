import "typespec-structured-output";
using StructuredOutput;

model A { x: string; }
model B { y: string; }
@discriminated
union U { a: A, b: B }
@structuredOutput
model M { u: U; }
