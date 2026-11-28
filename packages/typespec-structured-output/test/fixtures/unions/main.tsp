import "typespec-structured-output";
using StructuredOutput;

model Cat { kind: "cat"; lives: int8; }
model Dog { kind: "dog"; good: boolean; }

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Pet { cat: Cat, dog: Dog }

@structuredOutput
model Household {
  pet: Pet;
  maybe: Cat | Dog | null;
  value: string | float64;
}
