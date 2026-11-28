// `invisible-properties: ignore` with `unknown-properties: reject`: properties excluded by the
// request visibility are accepted and discarded; undeclared properties are still rejected.
import "@typespec/http";
using Http;

@service
namespace V;

model Owner { @visibility(Lifecycle.Read) ownerId: string; name: string; ...Record<never>; }

model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  @visibility(Lifecycle.Create) secret?: string;
  owner?: Owner;
  @visibility(Lifecycle.Read) @encodedName("application/json", "created_at") createdAt?: utcDateTime;
  ...Record<never>;
}

model Form { @visibility(Lifecycle.Read) id: string; name: string; ...Record<never>; }

@route("/widgets") @post op create(@body widget: Widget): Widget;
@route("/widgets/{id}") @patch op update(@path id: string, @header("content-type") contentType: "application/merge-patch+json", @body patch: Widget): Widget;
@route("/forms") @post op submit(@header("content-type") contentType: "application/x-www-form-urlencoded", @body form: Form): void;
