// ordered-records: records and additional properties keep insertion order.
import "@typespec/http";
import "@typespec/xml";
using Http;

@service
namespace O;

model Inner { n: int32; }
model Defaults { @minValue(0) n?: int32 = 5; }

model Doc {
  plain: Record<int32>;
  nested?: Record<Record<string>>;
  anything?: Record<unknown>;
  models?: Record<Defaults>;
  withDefault?: Record<int32> = #{ z: 1, a: 2, m: 3 };
  either?: Record<string> | string[];
}

model Open { id: string; ...Record<int32>; }

@route("/doc") @post op echo(@body doc: Doc): Doc;
@route("/open") @post op open(@body open: Open): Open;

model Tagged { @Xml.attribute id: string; ...Record<never>; }
model XMLRecords { scalars: Record<string>; models?: Record<Tagged>; }
@route("/xml") @post op xml(@header contentType: "application/xml", @body records: XMLRecords):
  { @header contentType: "application/xml"; @body result: XMLRecords; };
