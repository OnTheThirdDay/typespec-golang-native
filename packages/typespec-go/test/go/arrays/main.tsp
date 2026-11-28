// Named array models (`model Docs is Doc[]`) are named Go slice types with their own codecs,
// defaults and validation; zero-element tuples (`[]`, e.g. the default scopes of
// TypeSpec.Http.OAuth2Auth) decode and encode as empty arrays.
import "@typespec/http";
using Http;

@service
namespace A;

model Doc { @minLength(1) title: string; tags?: string[] = #["new"]; }

/** Documents of a page. */
@maxItems(3)
model Docs is Doc[];

@minItems(1)
model Tags is string[];

model Page<T> is T[];

model Shelf {
  docs: Docs;
  more?: Docs;
  pages?: Page<Doc>;
  nested?: Docs[];
  @maxItems(1) limited?: Docs;
  tags?: Tags = #["a"];
  empty: [];
  scopes?: OAuth2Auth<[Flow]>;
}

model Flow { type: OAuth2FlowType.clientCredentials; tokenUrl: "https://example.com/token"; scopes: []; }

@useAuth(OAuth2Auth<[Flow]> | NoAuth)
@route("/shelf") @post op put(@query tags?: Tags, @header("x-tags") need: Tags, @body shelf: Shelf): Shelf;

@route("/docs") @post op docs(@body docs: Docs): Docs;

namespace Shadow {
  model Array is TypeSpec.Array<Array>;
  model Record is TypeSpec.Record<Record>;
  model Box<T> { payload: T; }
  model Collections { rows: Box<Array>; index: Box<Record>; }
}
