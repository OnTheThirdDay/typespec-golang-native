// `response-unset-nullable: null`: server responses write unset optional nullable properties as
// null at every depth; request decoding, MarshalJSON and the Go values are unchanged.
import "@typespec/http";
import "@typespec/http/streams";
import "@typespec/sse";
import "@typespec/events";
import "@typespec/streams";
using Http;
using Http.Streams;
using SSE;
using Events;

@service
namespace N;

model Inner { x?: int32 | null; y?: int32; }
model Other { z: string; }

@discriminator("kind") model Pet { kind: string; name?: string | null; }
model Dog extends Pet { kind: "dog"; bark?: boolean | null; }

model Item {
  a?: string | null;
  b?: string;
  c: string | null;
  nested?: Inner;
  list?: Inner[];
  map?: Record<Inner>;
  either?: Inner | Other;
  pair?: [Inner, int32];
  pet?: Pet;
  plain?: Other;
}

@events
union InnerEvents {
  @Events.contentType("application/json") inner: Inner,
}

@route("/item") @get op read(): Item;
@route("/item") @post op echo(@body item: Item): Item;
@route("/inners") op export(): JsonlStream<Inner>;
@route("/events") op events(): SSEStream<InnerEvents>;
