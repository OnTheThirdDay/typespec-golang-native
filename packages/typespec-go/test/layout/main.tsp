// Multi-file specification for the file-layout tests: the same Go package must result from
// every layout (equal public API, equal declarations, equal behaviour).
import "@typespec/http";
import "./global.tsp";
import "./common/scalars.tsp";
import "./common/paging.tsp";
import "./catalog/products.tsp";
import "./catalog/product-variants.tsp";
import "./orders.tsp";
import "./devices.tsp";
import "./x_test.tsp";
import "./build_linux.tsp";
using Http;

/** Shop service. */
@service(#{ title: "Shop" })
namespace Shop;

@route("/products") @post op createProduct(@body product: Catalog.Product): Catalog.Product;
@route("/products") @get op listProducts(@query slug?: Common.Slug): Catalog.ProductPage;
@route("/products/{id}") @patch op updateProduct(@path id: string, @header("content-type") contentType: "application/merge-patch+json", @body patch: Catalog.Product): Catalog.Product;
@route("/offers") @post op createOffer(@body offer: Catalog.Offer): { @statusCode code: 201; @body body: Catalog.Offer } | { @statusCode code: 400; @body body: Common.Problem };
@route("/orders") @post op placeOrder(lines: Orders.Line[], note?: string): Orders.Order;
