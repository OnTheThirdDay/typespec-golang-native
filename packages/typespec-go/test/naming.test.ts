/**
 * Generated names derived from TypeSpec types: union variants, template instances and anonymous
 * declarations. Genuine maps (`Record<T>`) are distinguished from named models with an indexer
 * (closed models included), and canonical names do not depend on which visibility variant of a
 * model is reached first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateGoPackage, runGo } from "../src/testing/index.js";

const H = `import "@typespec/http";\nusing Http;\n`;

async function models(code: string, name: string): Promise<{ text: string; types: string[]; dir: string }> {
  const r = await generateGoPackage(code, `naming-${name}`);
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const vet = runGo(r.dir, ["vet", "./..."]);
  expect(vet.ok, vet.output).toBe(true);
  const text = readFileSync(join(r.dir, "models.go"), "utf8");
  return { text, types: [...text.matchAll(/^type (\w+)/gm)].map((m) => m[1]).sort(), dir: r.dir };
}

const accessors = (text: string, union: string) => [...text.matchAll(new RegExp(`^func \\(x ${union}\\) As(\\w+)\\(\\)`, "gm"))].map((m) => m[1]);

describe("union variant names", () => {
  it("names closed-model variants after the models (consumer reproduction)", async () => {
    const { text } = await models(`model A { ...Record<never>; kind: "a"; }\nmodel B { ...Record<never>; kind: "b"; }\nmodel R { items: (A | B)[]; }`, "closed");
    expect(accessors(text, "RItemsItem")).toEqual(["A", "B"]);
    expect(text).not.toMatch(/NeverMap/);
  });

  it("distinguishes genuine maps from named models with indexers", async () => {
    const { text } = await models(
      `model Open { a: string; ...Record<string>; }\nmodel Bag is Record<int32>;\nmodel Derived extends Open { b: string; }\n` +
        `model R { u: Open | Bag | Derived | Record<string> | Record<int32>[] | string[]; }`,
      "maps",
    );
    expect(accessors(text, "RU")).toEqual(["Open", "Bag", "Derived", "StringMap", "Int32MapArray", "StringArray"]);
  });

  it("names template instances after their arguments", async () => {
    const { types } = await models(
      `model Closed { ...Record<never>; c: string; }\nmodel Bag is Record<int32>;\nmodel Item { id: string; n: int32; }\nmodel Box<T> { value: T; meta: { at: utcDateTime }; }\n` +
        `model R { a: Box<Closed>; b: Box<Bag>; c: Box<Record<int32>>; d: OmitProperties<Item, "id">; }`,
      "templates",
    );
    // `meta` is an anonymous model inside each instance: named after the instance, not "X<arg>".
    expect(types).toEqual(["Bag", "BoxBag", "BoxBagMeta", "BoxClosed", "BoxClosedMeta", "BoxInt32Map", "BoxInt32MapMeta", "Closed", "Item", "OmitPropertiesItemID", "R"]);
  });
});

describe("anonymous declarations and visibility", () => {
  const model = `model P { @visibility(Lifecycle.Read) id: string; shape: { a: string; @visibility(Lifecycle.Read) r: string }; k: "x" | "y"; t?: [int32, int32]; u?: { a: string } | { b: string; @visibility(Lifecycle.Read) r: string }; }`;

  it("keeps canonical names whether or not a visibility variant is generated", async () => {
    const canonical = ["P", "PK", "PShape", "PT", "PU", "PUKind", "PUObject", "PUObject1"];
    const readOnly = await models(`${H}@service namespace S;\n${model}\n@get op read(): P;`, "vis-read");
    expect(readOnly.types).toEqual(canonical);
    const withCreate = await models(`${H}@service namespace S;\n${model}\n@post op create(@body p: P): P;\n@get op read(): P;`, "vis-create");
    // Only declarations that differ under Create visibility get a variant (the tuple does not).
    expect(withCreate.types).toEqual([...canonical, "PCreate", "PShapeCreate", "PUCreate", "PUCreateKind", "PUObject1Create"].sort());
    expect(withCreate.text).toMatch(/^\tK PK$/m);
    expect(withCreate.text).toMatch(/^\tT \*PT$/m);
  });

  it("applies request visibility through unions of closed models", async () => {
    const { text, dir } = await models(
      `${H}@service namespace S;\nmodel A { ...Record<never>; kind: "a"; @visibility(Lifecycle.Read) id: string; }\nmodel B { ...Record<never>; kind: "b"; }\n` +
        `model R { items: (A | B)[]; }\n@post op create(@body r: R): R;`,
      "vis-closed-union",
    );
    expect(accessors(text, "RItemsItemCreate")).toEqual(["A", "B"]);
    expect(text).toMatch(/^func \(x RItemsItemCreate\) AsA\(\) \(ACreate, bool\)/m);
    // ACreate is closed and has no `id`: a read-only property is rejected in a create request.
    const go = `package gen\nimport ("encoding/json"; "testing")\nfunc TestCreate(t *testing.T) {\n  var r RCreate\n  if err := json.Unmarshal([]byte(\`{"items":[{"kind":"a"}]}\`), &r); err != nil { t.Fatal(err) }\n  if err := json.Unmarshal([]byte(\`{"items":[{"kind":"a","id":"x"}]}\`), &r); err == nil { t.Fatal("read-only id accepted") }\n  var full R\n  if err := json.Unmarshal([]byte(\`{"items":[{"kind":"a","id":"x"}]}\`), &full); err != nil { t.Fatal(err) }\n}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "naming_test.go"), go);
    const test = runGo(dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });
});
