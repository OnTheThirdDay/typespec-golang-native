import "typespec-structured-output";
using StructuredOutput;

@pattern("^[A-Z]{3}$")
scalar CurrencyCode extends string;

@structuredOutput
model Order {
  @minLength(1) @maxLength(40) title: string;
  currency: CurrencyCode;
  @minValue(0) @maxValueExclusive(100) discount: float64;
  @minItems(1) @maxItems(5) lines: string[];
  @format("email") contact: string;
}
