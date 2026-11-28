import "typespec-structured-output";
using StructuredOutput;

model Inner { v: string; }
@structuredOutput
model Partial {
  a?: string;
  b?: Inner;
  @maxLength(3) c?: string;
}
