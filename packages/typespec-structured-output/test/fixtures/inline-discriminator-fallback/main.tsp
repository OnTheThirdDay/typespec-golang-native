import "typespec-structured-output";
using StructuredOutput;

model A { kind: "a"; x: string; }
model Other { kind: string; }
@discriminated(#{ envelope: "none" })
union U { a: A, Other }
@structuredOutput
model M { u: U; }
