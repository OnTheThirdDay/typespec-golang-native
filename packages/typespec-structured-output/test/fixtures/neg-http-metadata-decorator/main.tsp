import "@typespec/http";
import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @TypeSpec.Http.header etag: string; }
