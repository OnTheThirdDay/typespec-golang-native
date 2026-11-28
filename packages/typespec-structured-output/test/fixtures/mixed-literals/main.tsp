import "typespec-structured-output";
using StructuredOutput;

/** An enum whose members mix string and integer values. */
enum Choice { yes: "ok", n: 1 }

@structuredOutput
model M {
  choice: Choice;
  lit: "a" | 1;
  withNull: "b" | 2 | null;
}
