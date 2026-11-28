import "typespec-structured-output";
using StructuredOutput;

// @defaultFactory: Pydantic `Field(default_factory=...)` writes no schema default; the field
// stays optional.
model Point { x: int32; }

@structuredOutput
model Settings {
  @defaultFactory tags?: string[] = #[];
  @defaultFactory origin?: Point = #{ x: 0 };
  retries?: int32 = 3;
  @defaultFactory label?: string | null = null;
}
