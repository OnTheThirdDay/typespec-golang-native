import "typespec-structured-output";
using StructuredOutput;

/** Primary colors. */
enum Color { red, green: "grn", blue }

@structuredOutput
model Paint {
  color: Color;
  finish: "matte" | "gloss";
  kind: "paint";
  shade?: Color | null;
  level: 1 | 2 | 3;
}
