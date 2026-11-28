import "@typespec/http";
import "@typespec/http/streams";
import "@typespec/sse";
import "@typespec/events";
import "@typespec/streams";
import "typespec-go";
using Http;
using SSE;
using Events;

/** An @events union whose variant is itself a union: event "change" carries an A or a B. */
@service
namespace SseNested;

model A { n: int32; }
model B { s: string; }

model CountEnvelope { @data @Events.contentType("text/plain") value?: int32; }
model Detail { count: CountEnvelope; }
model Fixed { @data code: "sent"; note?: string; }

@events
union Ev {
  count: Detail,
  fixed: Fixed,
  @Events.contentType("application/json")
  single: A,

  @Events.contentType("application/json")
  change: A | B,
}

@route("/events")
op events(): SSEStream<Ev>;
