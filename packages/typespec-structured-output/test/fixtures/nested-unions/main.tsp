import "typespec-structured-output";
using StructuredOutput;

model A { a: string; }
model B { b: string; }
model C { c: string; }
union AB { a: A, b: B }
@structuredOutput
model Holder {
  flat: AB | C;
  nullable_nested: (A | (B | C)) | null;
  literal_mix: "x" | "y" | A;
  bools: true | false;
  floats: 1.5 | 2.5;
  single: true;
  optional_literal?: "on" | "off" | null;
}
