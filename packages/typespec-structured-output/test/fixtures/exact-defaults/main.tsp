import "typespec-structured-output";
using StructuredOutput;
enum Choice { @encodedName("application/json","ok") yes, huge: 9007199254740993 }
model Inner { @encodedName("application/json","wire") n: integer; }
@structuredOutput model Exact {
  id: 9007199254740993;
  choice: Choice;
  instance?: Inner = #{ n: 18446744073709551615 };
  values?: integer[] = #[9007199254740997];
}
