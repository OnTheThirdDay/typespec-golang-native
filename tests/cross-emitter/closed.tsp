import "@typespec/http";
import "typespec-go";
import "typespec-structured-output";
using Http;
using StructuredOutput;

/** Closed models (`...Record<never>`) declared once and read by three emitters. */
@service
namespace ClosedModels;

model Closed { name: string; ...Record<never>; }
model Base { id: string; ...Record<never>; }
model DerivedFromClosed extends Base {}
model Open { name: string; }
model ClosedFromOpen extends Open { extra: int32; ...Record<never>; }
model SpreadOfClosed { ...Closed; more: string; }
model Gen<T> { value: T; ...Record<never>; }
model Tree { label: string; kids: Tree[]; ...Record<never>; }
model Empty { ...Record<never>; }
model Reopened extends Base { ...Record<string>; }
model OpenExtras { a: string; ...Record<string>; }
model ClosedExtras extends OpenExtras { b: string; ...Record<never>; }

@structuredOutput
model Root {
  closed: Closed;
  derived: DerivedFromClosed;
  closedFromOpen: ClosedFromOpen;
  spread: SpreadOfClosed;
  gen: Gen<string>;
  tree: Tree;
  empty: Empty;
  open: Open;
  reopened: Reopened;
  openExtras: OpenExtras;
  closedExtras: ClosedExtras;
  base: Base;
  ...Record<never>;
}

@route("/root") @post op root(@body body: Root): Root;
