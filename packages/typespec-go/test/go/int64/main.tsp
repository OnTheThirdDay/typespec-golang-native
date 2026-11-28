// `integer-type: int64`: TypeSpec integer is a native Go int64 everywhere it appears.
import "@typespec/http";
using Http;

@service
namespace I;

@minValue(0) scalar Count extends integer;
@encode(string) scalar BigID extends integer;

model Totals {
  plain: integer;
  @maxValue(1e30) @minValue(-5) bounded?: integer;
  limited?: integer = 9223372036854775807;
  count?: Count = 3;
  id?: BigID;
  @encode(string) text?: integer;
  list?: integer[] = #[1, -9223372036854775808];
  map?: Record<integer>;
  nullable?: integer | null;
  either?: integer | string;
  level?: 1 | 2 | integer;
  nested?: { n: integer } = #{ n: 2 };
}

@route("/totals/{id}") @post op put(@path id: integer, @query page?: Count, @header("x-limit") limit?: integer, @body totals: Totals): { @header("x-total") total: integer; @body body: Totals };
