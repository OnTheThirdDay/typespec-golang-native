import "typespec-structured-output";
using StructuredOutput;

model Extra { name: string; ...Record<int32>; }
@structuredOutput
model Loose {
  counts: Record<integer>;
  pair: [string, integer];
  extra: Extra;
  anything: unknown;
  link: url;
}
