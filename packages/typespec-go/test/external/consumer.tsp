// A separately generated service that imports Shop.Common from the shared Go package.
import "@typespec/http";
import "./common.tsp";
using Http;
using Shop.Common;

@service
namespace Orders;

model Order {
  id: Id;
  total: Money;
  status?: Status | null;
  shape: Shape;
  pets: Pet[];
  widget?: Widget;
  page?: Page<Widget>;
  history?: Page<Order>;
  closed?: Closed;
  twins?: Twins;
  labels?: Labels;
}

@route("/orders") @post op create(@body order: Order): Order;
@route("/widgets") @post op createWidget(@body widget: Widget): Widget;
@route("/widgets") @get op listWidgets(@query status?: Status, @header("x-currency") currency?: Currency): Page<Widget>;
@route("/audited") @post op audit(@body audited: Audited): Audited;

model Shipment { packages: Shop.Common.Deliveries; }
