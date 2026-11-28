import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model Person {
  name: string;
  nickname: string | null;
  age?: int32 | null;
  tags: string[];
  partner?: Person | null;
}
