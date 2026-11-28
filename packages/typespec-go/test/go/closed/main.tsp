import "@typespec/http";
import "typespec-go";
using Http;

/**
 * Closed models: `...Record<never>` is TypeSpec's closed object (the official emitters write
 * `additionalProperties: {not: {}}` / `unevaluatedProperties: {not: {}}`). They reject undeclared
 * properties under the default `unknown-properties: ignore` policy (see closed_test.go).
 */
@service
namespace Closed;

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
  closedExtras: ClosedExtras;
}

// A closed variant that does not declare a property cannot absorb it, so an open variant that
// declares it is selected even though it comes later.
model Wide { name: string; note?: string; }
union Pick { closed: Closed, wide: Wide }
model Picks { pick: Pick; }

model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  color?: string;
  ...Record<never>;
}

model FormBody { name: string; tags?: string[]; hidden?: never; ...Record<never>; }
model OpenForm { name: string; hidden?: never; }

@route("/root") @post op root(@body body: Root): Root;
@route("/picks") @post op picks(@body body: Picks): Picks;
@route("/widgets") @post op create(@body body: Widget): Widget;
@route("/widgets") @patch(#{ implicitOptionality: false }) op update(@header("content-type") contentType: "application/merge-patch+json", @body body: Widget): Widget;
@route("/form") @post op form(@header contentType: "application/x-www-form-urlencoded", @body body: FormBody): void;
@route("/open-form") @post op openForm(@header contentType: "application/x-www-form-urlencoded", @body body: OpenForm): void;
