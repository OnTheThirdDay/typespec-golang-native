import "typespec-structured-output";
using StructuredOutput;
enum Choice { red: "red", one: 1, blue: "blue" }
@structuredOutput model Selected { choice: Choice; literal: "red" | 1 | "blue"; }
