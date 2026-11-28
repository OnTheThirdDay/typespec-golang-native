import "typespec-structured-output";
using StructuredOutput;

@discriminator("kind")
model Pet { @pattern("^[a-z]+$") kind: string; }
model Cat extends Pet { kind: "cat"; }
@structuredOutput
model M { pet: Pet; }
