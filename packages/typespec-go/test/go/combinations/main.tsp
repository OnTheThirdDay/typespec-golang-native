import "@typespec/http";
import "typespec-go";
using Http;

@service
namespace Combo;

@minValue(-5)
scalar SmallInt extends int8;

@maxLength(5)
scalar Code extends string;

@minLength(2)
scalar ShortCode extends Code;

model Leaf {
  v: int32;
}

model Tree {
  label: ShortCode;
  kids?: Node[];
}

/** Recursive through Tree.kids. */
union Node {
  tree: Tree,
  leaf: Leaf,
  text: string,
}

model Holder {
  nested: (Leaf | (string | int64) | null)[];
  maybe?: Tree | Leaf | null;
  map: Record<Node | null>;
  big: int64;
  ubig: uint64;
  exact: decimal;
  f32: float32;
  @minValueExclusive(-2) @maxValueExclusive(3) small: int8;
  @minValueExclusive(0.1) @maxValue(0.3) ratio: float64;
  si?: SmallInt;
  sc: ShortCode;
  @maxLength(3) narrower: ShortCode;
  withDefault?: Tree = #{ label: "dd" };
  nullableDefault?: string | null = "x";
  kidsDefault?: Leaf[] = #[#{ v: 1 }];
}

model Base {
  @minLength(3) id: string;
}

model Derived extends Base {
  @maxLength(4) id2?: string;
}

@route("/combo") @post op roundTrip(@body body: Holder): Holder;
@route("/slow") op slow(): void;
@route("/derived") @post op derived(@body body: Derived): void;
