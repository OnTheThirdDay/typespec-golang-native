import "typespec-structured-output";
using StructuredOutput;

@discriminator("kind")
model Pet { kind: string; }
model Cat extends Pet { kind: "cat"; }
@structuredOutput
model M { pet: Pet; }
