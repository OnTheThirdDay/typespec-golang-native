// Collected errors (ServerOptions.CollectErrors): every failure of an identified union variant,
// machine-readable decoding problems, validation of the parts that decoded, application checks
// on the values that decoded completely, and parameters collected with the body.
import "@typespec/http";
using Http;

@service
namespace K;

model Cat { kind: "cat"; @minLength(2) name: string; age: int8; }
model Dog { kind: "dog"; barks: boolean; }
union Pet { cat: Cat, dog: Dog }

model Leaf { @minLength(3) code: string; }
model Branch { kind: "branch"; inner: Leaf | int32; @minValue(0) weight: int32; }
model Tip { kind: "tip"; }

enum Color { red, green }

@discriminated(#{ envelope: "none", discriminatorPropertyName: "type" })
union Shape { circle: Circle, square: Square }
model Circle { type: "circle"; @minValue(1) radius: int32; @maxLength(3) label: string; }
model Square { type: "square"; side: int32; }

@discriminated(#{ envelope: "object", discriminatorPropertyName: "kind", envelopePropertyName: "data" })
union Event { created: Created, deleted: Deleted }
model Created { @minLength(2) id: string; at: int32; }
model Deleted { id: string; }

model Item { @minLength(2) sku: string; @minValue(1) qty: int32; }

// Overlapping variants: the first that decodes and satisfies the declared constraints is selected
// (application checks never select a variant).
union Flex { a: FlexA, b: FlexB }
model FlexA { n: int32; }
model FlexB { n: int32; extra?: string; }

model Order {
  @minLength(3) id: string;
  @maxItems(2) items: Item[];
  pet?: Pet;
  tree?: Branch | Tip;
  color?: Color;
  small?: uint8;
  shape?: Shape;
  event?: Event;
  pair?: [Item, int32];
  fixed?: "v1";
  note?: string;
  flex?: Flex;
}

@route("/orders") @post op create(@query @minValue(1) limit?: int32, @header("x-tag") @minLength(2) tag?: string, @query color?: Color, @body order: Order): Order;

// Failures while the operation is selected are reported alone, without collection.
@route("/select?mode=a") @get op selectA(@query @minValue(1) limit?: int32, @header("x-tag") @minLength(2) tag?: string): void;
@route("/select?mode=b") @get op selectB(@query @minValue(1) limit?: int32): void;
@sharedRoute @route("/upload") @post op uploadJson(@header contentType: "application/json", @query @minValue(1) limit?: int32, @body item: Item): void;
@sharedRoute @route("/upload") @post op uploadText(@header contentType: "text/plain", @query @minValue(1) limit?: int32, @body text: string): void;

enum Wide { low: 9007199254740993, high: 18446744073709551615 }
model WideInput { value: Wide; }
