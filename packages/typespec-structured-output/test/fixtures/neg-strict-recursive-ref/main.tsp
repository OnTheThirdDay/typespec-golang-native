import "typespec-structured-output";
using StructuredOutput;
@structuredOutput model Self { /** Inline metadata on a recursive reference. */ child: Self; }
