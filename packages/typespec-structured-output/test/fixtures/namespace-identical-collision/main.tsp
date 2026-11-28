import "typespec-structured-output";
using StructuredOutput;

namespace One { model Tag { name: string; } }
namespace Two { model Tag { name: string; } }
@structuredOutput
model Tagged { a: One.Tag; b: Two.Tag; }
