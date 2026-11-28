import "@typespec/versioning";
import "typespec-structured-output";
using StructuredOutput;
using Versioning;

@versioned(Versions)
namespace Svc;
enum Versions { v1, v2 }

@structuredOutput
model M {
  a: string;
  @added(Versions.v2) b: string;
}
