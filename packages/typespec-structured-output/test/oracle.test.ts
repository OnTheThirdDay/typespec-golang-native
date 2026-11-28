/**
 * Differential test against the official @typespec/json-schema emitter, used as an oracle for
 * leaf-level semantics (scalar type/format, constraint keywords and values, defaults). The
 * Pydantic representation intentionally differs in structure (titles, $defs, inlining), so only
 * per-property leaf keywords are compared. Every deliberate divergence is listed explicitly.
 */
import { compile, NodeHost } from "@typespec/compiler";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitStructuredOutput } from "../src/testing/index.js";
import type { JsonObject } from "../src/json.js";

const MODEL = `
@pattern("^[a-z]+$") scalar Slug extends string;
@minValue(1) @maxValue(9) scalar Digit extends int32;
model Leaf {
  s: string;
  b: boolean;
  i: integer;
  f64: float64;
  f32: float32;
  i8: int8;
  i16: int16;
  i32: int32;
  u8: uint8;
  u16: uint16;
  u32: uint32;
  dt: utcDateTime;
  odt: offsetDateTime;
  d: plainDate;
  t: plainTime;
  dur: duration;
  @minLength(2) @maxLength(5) sl: string;
  @pattern("^x") pat: string;
  @format("uuid") id: string;
  @minValue(-1.5) @maxValueExclusive(10) num: float64;
  @minValueExclusive(0) @maxValue(5) num2: float64;
  @minItems(1) @maxItems(3) arr: string[];
  slug: Slug;
  digit: Digit;
  lit: "a";
  nlit: 42;
  blit: true;
  dflt?: int32 = 7;
  sdflt?: string = "hi";
}
`;

/** Keywords whose meaning is shared by both emitters. */
const LEAF = ["type", "format", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "const", "default", "items"];

function leaf(s: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of LEAF.sort()) if (k in s) out[k] = s[k];
  return out;
}

async function officialSchemas(): Promise<{ props: Record<string, JsonObject>; defs: Record<string, JsonObject> }> {
  const dir = join(import.meta.dirname, ".tmp", "oracle-official");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tsp"), `import "@typespec/json-schema";\n${MODEL}`);
  const program = await compile(NodeHost, join(dir, "main.tsp"), {
    outputDir: join(dir, "out"),
    emit: ["@typespec/json-schema"],
    options: { "@typespec/json-schema": { emitAllModels: true, bundleId: "b.json", "file-type": "json", "int64-strategy": "number" } },
  });
  expect(program.diagnostics).toEqual([]);
  const bundle = JSON.parse(readFileSync(join(dir, "out/@typespec/json-schema/b.json"), "utf8"));
  return { props: bundle.$defs.Leaf.properties, defs: bundle.$defs };
}

describe("@typespec/json-schema leaf parity", () => {
  it("agrees on scalar, constraint, literal and default keywords", async () => {
    const official = await officialSchemas();
    const ours = await emitStructuredOutput(
      `import "typespec-structured-output";\nusing StructuredOutput;\n${MODEL.replace("model Leaf", "@structuredOutput model Leaf")}`,
      { "target-profile": "none", "schema-mode": "pydantic" },
      "oracle-ours",
    );
    expect(ours.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const props = (ours.files["Leaf.json"] as JsonObject).properties as Record<string, JsonObject>;

    // Deliberate, documented divergences (Pydantic compatibility profile):
    const expectedDivergence: Record<string, (o: JsonObject, p: JsonObject) => void> = {
      // Official emitter keeps a $ref to the scalar declaration; Pydantic inlines Annotated aliases.
      slug: (o) => expect(o.$ref).toBe("Slug.json"),
      digit: (o) => expect(o.$ref).toBe("Digit.json"),
      // Number literals: official emits `type: number`; Pydantic `Literal[42]` is `integer`.
      nlit: (o, p) => {
        expect(o).toEqual({ type: "number", const: 42 });
        expect(leaf(p)).toEqual({ const: 42, type: "integer" });
      },
      // Property-level constraints on a sized integer are intersected with the type's range.
      // (Not exercised by `dflt`, which has no extra constraints.)
    };
    for (const [name, o] of Object.entries(official.props)) {
      const p = props[name];
      expect(p, name).toBeDefined();
      if (expectedDivergence[name]) {
        expectedDivergence[name](o, p);
        continue;
      }
      expect(leaf(p), name).toEqual(leaf(o));
    }
    // The inlined custom scalars must agree with the official scalar declarations.
    expect(leaf(props.slug)).toEqual(leaf(official.defs.Slug));
    expect(leaf(props.digit)).toEqual(leaf(official.defs.Digit));
  });
});
