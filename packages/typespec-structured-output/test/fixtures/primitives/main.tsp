import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model Primitives {
  text: string;
  flag: boolean;
  count: integer;
  ratio: float64;
  created: utcDateTime;
  day: plainDate;
  at: plainTime;
  span: duration;
}
