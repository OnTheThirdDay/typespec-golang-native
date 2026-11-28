// Request errors as data, collected errors and application-defined validation hooks.
import "@typespec/http";
using Http;

@service
namespace E;

@pattern("^[A-Z]+$") scalar Code extends string;

model Line { @minLength(2) sku: string; @minValue(1) qty: int32; }

model Order {
  id: string;
  lines: Line[];
  code?: Code;
  meta?: Record<int32>;
  shape?: { a: string } | { b: int32 };
  kind?: "x" | "y";
}

@route("/orders") @post op create(@query limit?: int32, @body order: Order): Order;
