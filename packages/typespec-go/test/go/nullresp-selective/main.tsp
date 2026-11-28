// `response-unset-nullable` as a list: only the named properties (and the own properties of the
// named models) are written as null when unset in responses. Models that are not named keep
// omitting unset properties, also when nested in a named model or reused by requests.
import "@typespec/http";
using Http;

@service
namespace S;

/** Reused by requests and responses; not named: never written as null. */
model Inner { x?: int32 | null; }
model Other { z?: string | null; }
model Page<T> { items: T[]; next?: string | null; }
model Base { b?: string | null; c?: string | null; }
model Derived extends Base { d?: string | null; }

model Item {
  a?: string | null;
  b?: string | null;
  inner?: Inner;
  list?: Inner[];
  other?: Other;
  derived?: Derived;
}

/** Shared by a request and a response: selected, the response writes null; requests unchanged. */
model Shared { s?: string | null; }

@route("/item") @get op read(): Item;
@route("/shared") @post op shared(@body body: Shared): Shared;
@route("/inner") @post op echo(@body inner: Inner): Inner;
@route("/page") @get op page(): Page<Inner>;
