import "@typespec/http";
import "@typespec/xml";
using Http;
@service namespace Wire;

model Filter { kind: "abc"; n: int32; forbidden?: never; ...Record<never>; }
model Attributes { base: string; ...Record<string>; }
model Entry { @Xml.attribute id: string; values: string[]; ...Record<never>; }
model Tree { entry: Entry; ...Record<never>; }
model Parts { a: HttpPart<string>; ...Record<never>; }

@route("/filter") @get op filter(@query q: Filter): int32;
@route("/attrs") @get op attrs(@query(#{explode: true}) q: Attributes): Attributes;
@route("/form") @post op form(@header contentType: "application/x-www-form-urlencoded", @body data: Attributes):
  { @header contentType: "application/x-www-form-urlencoded"; @body result: Attributes; };
@route("/xml") @post op tree(@header contentType: "application/xml", @body data: Tree): Tree;
@route("/parts") @post op parts(@header contentType: "multipart/form-data", @multipartBody data: Parts):
  { @header contentType: "multipart/form-data"; @multipartBody result: Parts; };

@route("/number") @post op number(@header contentType: "text/plain", @body n: int32): int32;

@error model Fault { message: string; }
@route("/reply") @get op reply(@query mode: string): {
  @statusCode _: 200; @header etag: string; @header("x-comment") comment: string;
} | { @statusCode _: 404; } | Fault;

@route("/list") @get op list(@query fields: string[], @query attrs: Record<string>): { fields: string[]; attrs: Record<string>; };

@route("/empty") @post op empty(@body obj: Record<never>): void;
@route("/optional-text") @post op optionalText(@body value?: string): string;

model PathFields {
  @encodedName("application/json", "n-items") @minValue(0) n: int32;
  label?: string;
  ...Record<never>;
}
@route("/object/{fields}") @get op simpleObject(@path fields: PathFields): PathFields;
@route("/matrix{;fields*}") @get op matrixObject(@path fields: PathFields): PathFields;

model Directory { entries: Record<Entry>; }
@route("/directory") @post op directory(@header contentType: "application/xml", @body data: Directory):
  { @header contentType: "application/xml"; @body result: Directory; };
