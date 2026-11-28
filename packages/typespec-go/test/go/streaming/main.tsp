import "@typespec/http";
import "@typespec/http/streams";
import "@typespec/sse";
import "@typespec/events";
import "@typespec/streams";
import "typespec-go";
using Http;
using Http.Streams;
using SSE;
using Events;

@service
namespace Streaming;

model Tick {
  @minValue(1) n: int32;
}

model Item {
  @minLength(1) name: string;
  count?: int32 = 1;
}

@events
union TickEvents {
  @Events.contentType("application/json")
  tick: Tick,

  @Events.contentType("text/plain")
  @terminalEvent
  "[DONE]",
}

@route("/ticks")
op ticks(): SSEStream<TickEvents>;

@route("/items")
@post
op upload(stream: JsonlStream<Item>): {
  @statusCode _: 200;
  @body body: {
    names: string[];
    error?: string;
  };
};

@route("/export")
op export(): JsonlStream<Item>;
