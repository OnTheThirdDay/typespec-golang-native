import "typespec-structured-output";
using StructuredOutput;

model Empty {}
/**
 * Multi-line
 * documentation.
 */
@summary("Custom Title")
@structuredOutput("custom_name")
model Titled {
  empty: Empty;
  snake_case_name: string;
  camelCaseName: string;
  x1y2: string;
  @encodedName("application/json", "_private") private_: string;
}
