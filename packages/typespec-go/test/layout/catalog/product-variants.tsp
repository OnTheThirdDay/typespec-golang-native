// Second file of namespace Shop.Catalog.
namespace Shop.Catalog;

model ColorVariant { ...Record<never>; kind: "color"; color: string; }
model SizeVariant { ...Record<never>; kind: "size"; size: "S" | "M" | "L"; }
model Variants { items: (ColorVariant | SizeVariant)[]; }

alias Shipping = { carrier: string } | { pickup: true };
model Offer { shipping: Shipping; edits?: OmitProperties<Product, "id">; variants?: Variants; }
