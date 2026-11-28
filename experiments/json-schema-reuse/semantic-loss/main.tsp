import "@typespec/json-schema";
namespace A { model Foo { x: string; } }
namespace B { model Foo { y: int32; } }
model Root {
  @encodedName("application/json", "full-name") fullName: string;
  a: A.Foo;
  b: B.Foo;
  blob: bytes;
  amount: decimal;
  big: int64;
}
