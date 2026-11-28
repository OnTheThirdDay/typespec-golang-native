import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model Profile {
  @encodedName("application/json", "firstName") first_name: string;
  @encodedName("application/json", "last-name") lastName: string;
  `display name`: string;
}
