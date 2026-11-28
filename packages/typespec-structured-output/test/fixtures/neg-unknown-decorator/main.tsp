import "@typespec/json-schema";
import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @TypeSpec.JsonSchema.uniqueItems tags: string[]; }
