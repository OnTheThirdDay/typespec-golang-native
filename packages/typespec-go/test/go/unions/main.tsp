// Undiscriminated unions: error reports derived from the variants' declared constants.
import "@typespec/http";
using Http;

@service
namespace U;

model Circle { ...Record<never>; kind: "circle"; radius: float64; @maxValue(100) size?: int32; }
model Square { ...Record<never>; kind: "square"; side: float64; }
model Line { kind: "line"; points: Point[]; }
model Point { x: int32; y: int32; }
model Text { kind: "text"; body: Fragment; }

union Fragment { Plain, Rich }
model Plain { format: "plain"; text: string; }
model Rich { format: "rich"; html: string; }

model Drawing { shapes: (Circle | Square | Line | Text)[]; }

model Big1 { kind: "k1"; v: int32; }
model Big2 { kind: "k2"; v: int32; }
model Big3 { kind: "k3"; v: int32; }
model Big4 { kind: "k4"; v: int32; }
model Big5 { kind: "k5"; v: int32; }
model Big6 { kind: "k6"; v: int32; }
model Big7 { kind: "k7"; v: int32; }
model Big8 { kind: "k8"; v: int32; }
model Big9 { kind: "k9"; v: int32; }
model Big10 { kind: "k10"; v: int32; }
model Big11 { kind: "k11"; v: int32; }
model Big12 { kind: "k12"; v: int32; }
union Many { Big1, Big2, Big3, Big4, Big5, Big6, Big7, Big8, Big9, Big10, Big11, Big12 }

/** No variant declares a constant. */
union NoConst { a: { a: string }, b: { b: int32 }, c: { c: boolean }, d: { d: string[] }, e: { e: float64 } }

/** A numeric constant, under no conventional name. */
union Versioned { v1: { revision: 1; a: string }, v2: { revision: 2; a: int32 } }

/** `type` is an ordinary string in X: only declared constants count as evidence. */
union TypeNamed { x: { type: string; x: int32 }, y: { type: "y"; y: int32 } }

model Inputs { many?: Many; noConst?: NoConst; versioned?: Versioned; typeNamed?: TypeNamed; }

@route("/draw") @post op draw(@body drawing: Drawing): void;
