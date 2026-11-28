import "@typespec/http";
import "typespec-go";
using Http;

namespace Demo;

/** Colors. */
enum Color { red, green: "grn" }
enum Priority { low: 1, high: 10 }

@pattern("^[a-z]+$")
@maxLength(20)
scalar Slug extends string;

model Base { id: string; }

/** A widget. */
model Widget extends Base {
  /** Display name. */
  @minLength(1) name: string;
  color?: Color = Color.red;
  tags: string[];
  meta?: Record<int32>;
  slug: Slug;
  nick: string | null;
  aka?: string | null;
  @minValue(0) @maxValue(100) score: int32;
  ratio?: float64 = 0.5;
  created: utcDateTime;
  @encode(DateTimeKnownEncoding.rfc7231) seen?: utcDateTime;
  @encode("seconds", int32) ttl?: duration;
  day: plainDate;
  data?: bytes;
  child?: Widget;
  kind: "widget";
  mode: "fast" | "slow";
  open: "a" | "b" | string;
  value: string | int32 | Base;
  pair?: [string, int32];
  big?: integer;
  amount?: decimal;
  anything?: unknown;
  prio?: Priority;
}

model Cat { kind: "cat"; lives: int8; }
model Dog { kind: "dog"; good: boolean; }
@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Pet { cat: Cat, dog: Dog }
@discriminated
union Wrapped { cat: Cat, dog: Dog }

@discriminator("kind")
model Fish { kind: string; age: int32; }
model Shark extends Fish { kind: "shark"; teeth: int32; }
model Salmon extends Fish { kind: "salmon"; }

model Known { kind: "known"; x: int32; }
model Other { kind: string; extra?: string; }
@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Tagged { known: Known, Other }

model Zoo {
  tagged?: Tagged[]; pets: Pet[]; wrapped?: Wrapped; fish: Fish[]; }

model Page<T> { items: T[]; next?: url; }
model Catalog { widgets: Page<Widget>; }
