import "typespec-structured-output";
using StructuredOutput;

namespace Billing { model Address { line: string; } }
namespace Shipping { model Address { street: string; zip: string; } }
@structuredOutput
model Shipment {
  bill_to: Billing.Address;
  ship_to: Shipping.Address;
}
