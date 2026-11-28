// Feature combination: ordered records, Pydantic floats, minimal escaping, validation hooks,
// response nulls and a per-namespace layout in one package.
import "@typespec/http";
using Http;

@service
namespace C;

model Reading { value: float64; @maxLength(8) unit: string; note?: string | null; }

model Report {
  readings: Record<Reading>;
  totals?: Record<float32>;
  tags?: Record<string>;
}

@route("/report") @post op submit(@body report: Report): Report;
