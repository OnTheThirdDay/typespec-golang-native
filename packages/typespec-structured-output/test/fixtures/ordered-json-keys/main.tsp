import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M {
  head: string;
  @encodedName("application/json", "1") one: string;
  @encodedName("application/json", "__proto__") proto: string;
  @encodedName("application/json", "0") zero: integer;
}
