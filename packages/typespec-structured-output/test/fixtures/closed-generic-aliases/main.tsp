import "typespec-structured-output";
using StructuredOutput;
namespace Catalog;

model Cell<T> { value: T; ...Record<never>; }
model Group {
  @encodedName("application/json", "10") first: Cell<string>;
  @encodedName("application/json", "2") second: Cell<boolean> | null;
  @maxItems(2) descendants: Group[];
  ...Record<never>;
}
@structuredOutput model Index { group: Group; annotation?: string | null; ...Record<never>; }
@structuredOutput model Measurements { cell: Cell<float32>; }
