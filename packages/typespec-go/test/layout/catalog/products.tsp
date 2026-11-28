import "@typespec/http";
using Http;

namespace Shop.Catalog;

model Product {
  @visibility(Lifecycle.Read) id: string;
  slug: Common.Slug;
  price: Common.Money;
  status: Common.Status;
  tags?: string[];
  dimensions?: [float64, float64];
  attributes?: Record<string>;
  kind: "physical" | "digital";
  @pattern("^[a-z]+$") label?: string;
}

model ProductPage is Common.Page<Product>;

@discriminator("type") model Media { type: string; url: url; }
model Image extends Media { type: "image"; width: int32; }
model Video extends Media { type: "video"; seconds: int32; }

@route("/media") op getMedia(): Media;
