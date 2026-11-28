import "typespec-structured-output";
using StructuredOutput;

enum Level { info, warn }
@structuredOutput
model Settings {
  level?: Level = Level.warn;
  retries?: int32 = 3;
  label?: string | null = "x";
  note?: string | null;
  tags?: string[] = #["a", "b"];
}
