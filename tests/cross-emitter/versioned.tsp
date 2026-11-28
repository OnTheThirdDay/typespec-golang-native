import "@typespec/http";
import "@typespec/versioning";
import "typespec-go";
import "typespec-structured-output";
using Http;
using Versioning;
using StructuredOutput;

@service @versioned(Versions) namespace Contract;
enum Versions { v1, v2 }
@minLength(2) scalar Label extends string;
model Box<T> { data: T; }
union Tree { leaf: Label, children: Tree[] }
model Point { x: int8; }
@discriminated union Answer { point: Point, tree: Box<Tree> }
enum Mode { yes: "ok", zero: 0 }
@structuredOutput model View {
  @encodedName("application/json", "2") answer: Answer;
  mode: Mode;
  @maxLength(5) label: Label;
  @visibility(Lifecycle.Read) public: boolean;
  @visibility(Lifecycle.Create) secret: string;
  @added(Versions.v2) later: string;
  @encode(BytesKnownEncoding.base64url) bytesValue: bytes;
  @encode(string) flag: boolean;
  score: float32;
  maybe?: int8;
}
@route("/view") op read(): View;
