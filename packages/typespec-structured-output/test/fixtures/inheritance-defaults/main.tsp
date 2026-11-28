import "typespec-structured-output";
using StructuredOutput;

model Base { id: string; }

@structuredOutput
model Derived extends Base {
  score?: int32 = 5;
  mode?: "fast" | "slow" = "fast";
}
