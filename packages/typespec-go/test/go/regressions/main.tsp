import "@typespec/http";
import "typespec-go";
using Http;

/** Regression cases (see regressions_test.go). */
@service
namespace Regressions;

// Finding 4: overlapping union variants that differ only in a nested property.
model Inner { x: string; }
model InnerWide { x: string; y: int32; }
model Narrow { o: Inner; }
model Wide { o: InnerWide; }
union Overlap { narrow: Narrow, wide: Wide }

// Union variant with defaults: decoding, ApplyDefaults and re-encoding must compose.
model WithDefault { label: string; size?: int32 = 7; }
model Other { count: int32; }
union Defaulted { withDefault: WithDefault, other: Other }

model Holder {
  overlap: Overlap;
  defaulted: Defaulted;
}

// Finding 3: defaults beyond binary64 integer precision.
model Big {
  i64?: int64 = 9007199254740993;
  u64?: uint64 = 18446744073709551615;
  neg?: int64 = -9223372036854775808;
  amount?: decimal = 0.10000000000000000000000000001;
  list?: int64[] = #[9007199254740999];
  @encode(string) asText?: int64 = 9007199254740995;
}

@route("/echo") @post op echo(@body body: Holder): Holder;
@route("/big") @get op big(@query @minValue(9007199254740993) q?: int64 = 9007199254740993): { @body body: Big; @header("x-q") q: int64; };

// Patterns follow ECMAScript Unicode-mode semantics (JSON Schema 2020-12): code points.
model Patterns {
  @pattern("^.$") one?: string;
  @pattern("^[\\b]$") backspace?: string;
  @pattern("^\\p{Lu}+$") upper?: string;
  @pattern("^\\uD83D\\uDE00$") pair?: string;
  @pattern("^[😀-😂]$") range?: string;
}

// Enums mixing string and numeric members are closed sum types of their literal values.
enum Mixed { yes: "ok", n: 1 }
model Choice { m: Mixed; }
@route("/choice") @post op choice(@body body: Choice): Choice;

// Content negotiation by q-value between operations sharing a route.
@route("/negotiate") @get @sharedRoute op negotiateJson(@header accept: "application/json"): { @header contentType: "application/json"; @body body: Choice };
@route("/negotiate") @get @sharedRoute op negotiateText(@header accept: "text/plain"): { @header contentType: "text/plain"; @body body: string };

// Numbers outside the binary range, including nonzero numbers that would round to 0, are rejected.
model Floats { f: float64; g: float32; }

model ScriptFields {
  @pattern("^\\p{Script_Extensions=Greek}+$") greek: string;
  @pattern("^[\\S\\p{White_Space}]+$") any: string;
  @pattern("^\\P{ASCII}+$") foreign: string;
}
enum Empty {}

enum Mode { on, off }
model ModeOn { n: int32; }
model OverlapKind { n: int32; }
model NewOverlapWide { n: int32; }
model Spelling { tag: "ab-c" | "ab_c"; }

enum Fraction { first: 0.3, second: 0.2 }
model Precise { fraction: Fraction; point: 0.3; }

// Float literals in literal unions, in a mixed sum type and in a query parameter are compared
// with the wire token exactly, before binary rounding.
model MoreLiterals { pair: 0.5 | 1.5; mixed: 0.7 | string; }
@route("/literal") @get op literalQuery(@query q: 0.25): void;
