/**
 * Cross-emitter consistency: one TypeSpec program, compiled with both emitters under matching
 * optional-property policies, must describe the same value domain. Representative JSON instances derived
 * from the emitted Structured Outputs schema (what a model can return) must decode, validate and
 * re-encode unchanged with the generated Go types; and without the matching Go policy the
 * explicit-null instances must be rejected (never silently reinterpreted).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateGoPackage, runGo } from "../../packages/typespec-go/dist/src/testing/index.js";
import { emitStructuredOutput } from "../../packages/typespec-structured-output/dist/src/testing/index.js";

import { compile, NodeHost } from "@typespec/compiler";
import { getOpenAPI3 } from "@typespec/openapi3";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseJson, stringifyJson } from "../../packages/typespec-structured-output/dist/src/json.js";

type Schema = Record<string, any>;

/**
 * Deterministic instances: variant `k` picks branch k of every anyOf / enum (modulo its size);
 * `k = -1` picks the null branch wherever there is one.
 */
function instance(schema: Schema, defs: Schema, k: number, depth = 0): unknown {
  if (schema.$ref) return instance(defs[schema.$ref.replace("#/$defs/", "")], defs, k, depth + 1);
  if (schema.anyOf) {
    // Below the first level, prefer non-recursive / null branches to keep instances finite.
    const branches = schema.anyOf as Schema[];
    const nullBranch = branches.find((b) => b.type === "null");
    if (k < 0 && nullBranch) return null;
    return instance(branches[(Math.max(k, 0) + depth) % branches.length], defs, k, depth + 1);
  }
  if ("const" in schema) return schema.const;
  if (schema.enum) return schema.enum[Math.max(k, 0) % schema.enum.length];
  switch (schema.type) {
    case "null":
      return null;
    case "boolean":
      return Math.max(k, 0) % 2 === 0;
    case "string":
      return "x".repeat(Math.max(1, schema.minLength ?? 0));
    case "integer": {
      // Bounds beyond 2^53 arrive as bigint (exact parsing); compare exactly.
      let v = BigInt(Math.max(k, 0) + 1);
      if (schema.minimum !== undefined && v < BigInt(schema.minimum)) v = BigInt(schema.minimum);
      if (schema.maximum !== undefined && v > BigInt(schema.maximum)) v = BigInt(schema.maximum);
      return v;
    }
    case "number":
      return 0.5 + Math.max(k, 0);
    case "array":
      return Array.from({ length: Math.max(1, schema.minItems ?? 0) + (Math.max(k, 0) % 2) }, (_, i) => instance(schema.items, defs, k < 0 ? k : k + i, depth + 1));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries<Schema>(schema.properties ?? {})) out[name] = instance(prop, defs, k, depth + 1);
      return out;
    }
  }
  throw new Error(`no instance for ${JSON.stringify(schema)}`);
}

const GO_TEST = `package gen

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"example.com/gen/tsgo"
)

func TestSchemaInstances(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.json")
	if len(files) == 0 {
		t.Fatal("no instances")
	}
	for _, f := range files {
		data, _ := os.ReadFile(f)
		var v Facts
		if err := json.Unmarshal(data, &v); err != nil {
			t.Errorf("%s: decode: %v", f, err)
			continue
		}
		if err := v.Validate(); err != nil {
			t.Errorf("%s: validate: %v", f, err)
			continue
		}
		out, err := json.Marshal(v)
		if err != nil || !tsgo.EquivalentJSON(out, data) {
			t.Errorf("%s: re-encoded differently: %s => %s (%v)", f, data, out, err)
		}
	}
}
`;

describe("cross-emitter consistency", () => {
  const code = readFileSync(join(import.meta.dirname, "main.tsp"), "utf8");

  it("sampled Structured Outputs instances are valid Go values (optional-properties: nullable in both)", async () => {
    const so = await emitStructuredOutput(code, { "optional-properties": "nullable" }, "cross-emitter");
    expect(so.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const schema = so.files["Facts.json"] as Schema;
    expect(schema).toBeDefined();
    const instances = [-1, 0, 1, 2, 3].map((k) => instance(schema, schema.$defs ?? {}, k));
    // The instances cover explicit nulls for the optional properties (the LLM must send them).
    expect(instances.some((i: any) => i.confidence === null && i.primary === null)).toBe(true);

    const go = await generateGoPackage(code, "cross-emitter", { "optional-properties": "nullable" });
    expect(go.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    mkdirSync(join(go.dir, "testdata"), { recursive: true });
    instances.forEach((v, i) => writeFileSync(join(go.dir, "testdata", `instance${i}.json`), stringifyJson(v as any)));
    writeFileSync(join(go.dir, "instances_test.go"), GO_TEST);
    const r = runGo(go.dir, ["test", "-count=1", "./..."]);
    expect(r.ok, r.output).toBe(true);

    // Without the matching policy, optional properties (age?, confidence?) cannot be null in Go:
    // the instance is rejected at the first explicit null, never silently reinterpreted.
    const strict = await generateGoPackage(code, "cross-emitter-source");
    mkdirSync(join(strict.dir, "testdata"), { recursive: true });
    const withNull = instances.find((i: any) => i.confidence === null)!;
    writeFileSync(join(strict.dir, "testdata", "null.json"), stringifyJson(withNull as any));
    writeFileSync(join(strict.dir, "instances_test.go"), GO_TEST);
    const rejected = runGo(strict.dir, ["test", "-count=1", "./..."]);
    expect(rejected.ok).toBe(false);
    expect(rejected.output).toMatch(/null\.json: decode: .*got null/);
  });
});


describe("independent wire contracts", () => {
  it("checks versioned read projections, recursive values and encodings with a JSON Schema validator and Go", async () => {
    const code = readFileSync(join(import.meta.dirname, "versioned.tsp"), "utf8");
    const opts = { "api-version": "v1", "optional-properties": "nullable" } as const;
    const so = await emitStructuredOutput(code, { ...opts, visibility: "Read", "mixed-enums": "typed-union", "scalar-encodings": "wire" }, "independent-read");
    expect(so.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
    const schema = so.files["View.json"] as Schema;
    const validate = new Ajv2020().compile(schema);
    const base = { "2": { kind: "point", value: { x: 0 } }, label: "ab", mode: 0, public: false, bytesValue: "-_8", flag: "false", score: 0, maybe: null };
    const good = [base, { ...base, "2": { kind: "tree", value: { data: [["hi", []], "xy"] } }, label: "abcde", mode: "ok", score: 0.125, maybe: 0, bytesValue: "" }];
    const bad = [
      { ...base, label: "a" }, { ...base, label: "abcdef" }, { ...base, mode: 1 },
      { ...base, maybe: 128 }, { ...base, flag: false }, { ...base, bytesValue: "-_9" },
      { ...base, "2": { kind: "tree", value: { data: [["x"]] } } },
      { ...base, "2": { kind: "other", value: {} } }, { ...base, later: "" }, { ...base, secret: "" },
    ];
    for (const v of good) expect(validate(v), JSON.stringify(validate.errors)).toBe(true);
    for (const v of bad) expect(validate(v), JSON.stringify(v)).toBe(false);
    const { maybe: _omitted, ...absent } = base;
    expect(validate(absent)).toBe(false);
    const go = await generateGoPackage(code, "cross-independent", { ...opts, "unknown-properties": "reject" });
    expect(go.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
    writeFileSync(join(go.dir, "cases.json"), JSON.stringify({ good, bad, absent }));
    writeFileSync(join(go.dir, "independent_test.go"), `package gen
import ("encoding/json"; "os"; "reflect"; "testing")
func TestContract(t *testing.T) {
  b, err := os.ReadFile("cases.json"); if err != nil { t.Fatal(err) }
  var cases struct { Good, Bad []json.RawMessage; Absent json.RawMessage }
  if err = json.Unmarshal(b, &cases); err != nil { t.Fatal(err) }
  for _, raw := range append(cases.Good, cases.Absent) {
    var v ViewRead
    if err := json.Unmarshal(raw, &v); err != nil { t.Fatalf("%s: %v", raw, err) }
    if err := v.Validate(); err != nil { t.Fatal(err) }
    out, err := json.Marshal(v); if err != nil { t.Fatal(err) }
    var x, y any
    if err := json.Unmarshal(raw, &x); err != nil { t.Fatal(err) }
    if err := json.Unmarshal(out, &y); err != nil || !reflect.DeepEqual(x,y) { t.Fatalf("%s became %s", raw,out) }
  }
  for _, raw := range cases.Bad {
    var v ViewRead
    if json.Unmarshal(raw, &v) == nil && v.Validate() == nil { t.Errorf("accepted %s", raw) }
  }
}
`);
    const r = runGo(go.dir, ["test", "-count=1", "."]);
    expect(r.ok, r.output).toBe(true);
  });

  it("preserves exact enum tokens, defaults and typed additional properties in the Pydantic profile", async () => {
    const code = readFileSync(join(import.meta.dirname, "precision.tsp"), "utf8");
    const result = await emitStructuredOutput(code, { "target-profile": "none", "schema-mode": "pydantic" }, "cross-precision");
    expect(result.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
    const s = result.files["Precision.json"] as Schema;
    expect(s.$defs.State.enum).toEqual([9007199254740993n, 0]);
    expect(s.$defs.Counters.properties.value.default).toBe(18446744073709551615n);
    expect(s.$defs.Counters.additionalProperties).toEqual({ type: "integer" });
    const rejected = await emitStructuredOutput(code, { "default-values": "omit" }, "cross-closed");
    expect(Object.keys(rejected.files)).toEqual([]);
    expect(rejected.diagnostics.some(d => d.message.includes("additionalProperties"))).toBe(true);
    const go = await generateGoPackage(code, "cross-precision");
    expect(go.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
    writeFileSync(join(go.dir, "precision_test.go"), `package gen
import ("encoding/json"; "os"; "testing")
func TestPrecision(t *testing.T) {
  var v Precision
  if err := json.Unmarshal([]byte("{\\"state\\":9007199254740993,\\"counts\\":{\\"extra\\":123456789012345678901234567890}}"), &v); err != nil { t.Fatal(err) }
  v.ApplyDefaults()
  if err := v.Validate(); err != nil { t.Fatal(err) }
  b, err := json.Marshal(v); if err != nil { t.Fatal(err) }
  if err := os.WriteFile("roundtrip.json", b, 0600); err != nil { t.Fatal(err) }
  if err := json.Unmarshal([]byte("{\\"state\\":9007199254740992,\\"counts\\":{}}"), &v); err == nil { t.Fatal("accepted neighboring integer") }
}
`);
    const r = runGo(go.dir, ["test", "-count=1", "."]);
    expect(r.ok, r.output).toBe(true);
    expect(parseJson(readFileSync(join(go.dir, "roundtrip.json"), "utf8"))).toEqual({ state: 9007199254740993n, counts: { value: 18446744073709551615n, extra: 123456789012345678901234567890n } });
  });
});

describe("closed models (...Record<never>)", () => {
  // One declaration, three readers: the official OpenAPI 3 emitter, the Structured Output emitter
  // (Pydantic extra="forbid") and the Go emitter (rejects undeclared properties under the default
  // unknown-properties: ignore) must agree, model by model, on which objects are closed.
  const valid: Record<string, unknown> = {
    Closed: { name: "a" },
    Base: { id: "b" },
    DerivedFromClosed: { id: "d" },
    Open: { name: "o" },
    ClosedFromOpen: { name: "n", extra: 1 },
    SpreadOfClosed: { name: "s", more: "m" },
    Tree: { label: "t", kids: [] },
    Empty: {},
    Reopened: { id: "r" },
    OpenExtras: { a: "x" },
    ClosedExtras: { a: "x", b: "y" },
  };
  valid.Root = {
    closed: valid.Closed, derived: valid.DerivedFromClosed, closedFromOpen: valid.ClosedFromOpen, spread: valid.SpreadOfClosed,
    gen: { value: "v" }, tree: valid.Tree, empty: valid.Empty, open: valid.Open, reopened: valid.Reopened,
    openExtras: valid.OpenExtras, closedExtras: valid.ClosedExtras, base: valid.Base,
  };
  const expectedClosed = ["Base", "Closed", "ClosedExtras", "ClosedFromOpen", "DerivedFromClosed", "Empty", "Root", "SpreadOfClosed", "Tree"];

  it("agree with the official OpenAPI 3 emitter, Pydantic extra=forbid and the Go decoder", async () => {
    const path = join(import.meta.dirname, "closed.tsp");
    const code = readFileSync(path, "utf8");

    // Official @typespec/openapi3: own additionalProperties {not: {}}, or inherited through allOf.
    const program = await compile(NodeHost, path, { noEmit: true });
    expect(program.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const [record] = (await getOpenAPI3(program)) as any[];
    const schemas = record.document.components.schemas;
    const officialClosed = (name: string): boolean => {
      const s = schemas[name];
      if ("additionalProperties" in s) return JSON.stringify(s.additionalProperties) === "{\"not\":{}}";
      const base = s.allOf?.[0]?.$ref;
      return base ? officialClosed(base.split("/").at(-1)) : false;
    };
    const names = Object.keys(valid).sort();
    expect(names.filter(officialClosed)).toEqual(expectedClosed);

    // Structured Output, Pydantic mode: extra="forbid" is additionalProperties: false.
    const so = await emitStructuredOutput(code, { "target-profile": "none", "schema-mode": "pydantic" }, "cross-closed-models");
    expect(so.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const root = so.files["Root.json"] as any;
    const soSchema = (name: string) => (name === "Root" ? root : root.$defs[name]);
    expect(names.filter((n) => soSchema(n).additionalProperties === false)).toEqual(expectedClosed);
    // In strict mode every object is closed; closed models keep Pydantic's key position.
    const strict = await emitStructuredOutput(code, { "target-profile": "none", "schema-mode": "strict" }, "cross-closed-models-strict");
    const strictRoot = strict.files["Root.json"] as any;
    for (const n of expectedClosed) expect(Object.keys(n === "Root" ? strictRoot : strictRoot.$defs[n])[n === "Root" ? 1 : 0], n).toBe("additionalProperties");
    expect(Object.keys(strictRoot.$defs.Open).at(-1)).toBe("additionalProperties");

    // Go: each model decodes its valid value; with an undeclared (string) property it is
    // rejected exactly when closed. Generated with the default unknown-properties: ignore.
    const go = await generateGoPackage(code, "cross-closed-models");
    expect(go.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const cases = names.map((name) => ({
      name,
      valid: JSON.stringify(valid[name]),
      extra: JSON.stringify({ ...(valid[name] as object), zz: "undeclared" }),
      closed: expectedClosed.includes(name),
    }));
    writeFileSync(join(go.dir, "closure.json"), JSON.stringify(cases));
    writeFileSync(join(go.dir, "closure_test.go"), `package gen

import (
	"encoding/json"
	"os"
	"testing"
)

func decode[T any](data []byte) error { var v T; return json.Unmarshal(data, &v) }

var decoders = map[string]func([]byte) error{
${names.map((n) => `	"${n}": decode[${n}],`).join("\n")}
}

func TestClosure(t *testing.T) {
	data, err := os.ReadFile("closure.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Valid, Extra string
		Closed             bool
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if err := decoders[c.Name]([]byte(c.Valid)); err != nil {
			t.Errorf("%s rejected its valid value: %v", c.Name, err)
		}
		if err := decoders[c.Name]([]byte(c.Extra)); (err != nil) != c.Closed {
			t.Errorf("%s (closed %v) with an undeclared property: %v", c.Name, c.Closed, err)
		}
	}
}
`);
    const r = runGo(go.dir, ["test", "-count=1", "."]);
    expect(r.ok, r.output).toBe(true);
  });
});

it("keeps numeric aliases, closed recursive objects and generic identities across file layouts", async () => {
  const src = readFileSync(join(import.meta.dirname, "../../packages/typespec-structured-output/test/fixtures/closed-generic-aliases/main.tsp"), "utf8");
  const so = await emitStructuredOutput(src, { "file-layout": "per-namespace" }, "cross-layout");
  expect(so.diagnostics.map(d => d.message)).toEqual([]);
  const schema = so.files["catalog/Index.json"] as Schema;
  expect(Object.keys(schema.$defs.Group.properties)).toEqual(["10", "2", "descendants"]);
  const validate = new Ajv2020().compile(schema);
  const leaf = { "10": { value: "" }, "2": null, descendants: [] };
  const good = { group: { ...leaf, "2": { value: false }, descendants: [leaf] }, annotation: null };
  const invalid = [
    { ...good, group: { ...leaf, extra: 0 } }, { ...good, group: { ...leaf, "10": { value: "", extra: 0 } } },
    { ...good, group: { ...leaf, descendants: [leaf, leaf, leaf] } }, { ...good, group: { ...leaf, "2": { value: 0 } } },
  ];
  expect(validate(good)).toBe(true);
  for (const value of invalid) expect(validate(value)).toBe(false);
  const go = await generateGoPackage(src, "cross-layout", { "file-layout": "per-namespace" });
  expect(go.diagnostics.map(d => d.message)).toEqual([]);
  writeFileSync(join(go.dir, "values.json"), JSON.stringify([good, ...invalid]));
  writeFileSync(join(go.dir, "layout_test.go"), `package gen
import ("encoding/json"; "os"; "testing")
func TestSchemaValues(t *testing.T) {
  data, err := os.ReadFile("values.json"); if err != nil { t.Fatal(err) }
  var values []json.RawMessage
  if err := json.Unmarshal(data, &values); err != nil { t.Fatal(err) }
  for i, raw := range values {
    var x Index
    err := json.Unmarshal(raw, &x)
    if err == nil { err = x.Validate() }
    if (i == 0) != (err == nil) { t.Fatalf("%s: %v", raw, err) }
    if i == 0 {
      b, err := json.Marshal(x); if err != nil { t.Fatal(err) }
      if err := os.WriteFile("result.json", b, 0600); err != nil { t.Fatal(err) }
    }
  }
}
`);
  const result = runGo(go.dir, ["test", "-count=1", "."]);
  expect(result.ok, result.output).toBe(true);
  expect(JSON.parse(readFileSync(join(go.dir, "result.json"), "utf8"))).toEqual(good);
});

it("accepts only empty objects for Record<never> in fields, arrays and generic instances", async () => {
  const code = readFileSync(join(import.meta.dirname, "../../packages/typespec-structured-output/test/fixtures/empty-record/main.tsp"), "utf8");
  const so = await emitStructuredOutput(code, {}, "cross-empty-record");
  expect(so.diagnostics.map(d => d.message)).toEqual([]);
  const schema = so.files["M.json"] as Schema;
  const validate = new Ajv2020().compile(schema);
  const values = [
    { nothing: {}, items: [{}], boxed: { value: {} } },
    { nothing: { x: 0 }, items: [], boxed: { value: {} } },
    { nothing: {}, items: [null], boxed: { value: {} } },
    { nothing: {}, items: [], boxed: { value: { x: false } } },
  ];
  expect(values.map(v => validate(v))).toEqual([true, false, false, false]);
  const go = await generateGoPackage(code, "cross-empty-record");
  expect(go.diagnostics.map(d => d.message)).toEqual([]);
  writeFileSync(join(go.dir, "values.json"), JSON.stringify(values));
  writeFileSync(join(go.dir, "record_test.go"), `package gen
import ("encoding/json"; "os"; "testing")
func TestEmptyRecords(t *testing.T) {
  b, err := os.ReadFile("values.json"); if err != nil { t.Fatal(err) }
  var raws []json.RawMessage
  if err := json.Unmarshal(b, &raws); err != nil { t.Fatal(err) }
  for i, raw := range raws {
    var m M
    err := json.Unmarshal(raw, &m)
    if (err == nil) != (i == 0) { t.Fatalf("%s: %v", raw, err) }
    if i == 0 {
      b, err := json.Marshal(m)
      if err != nil || string(b) != string(raw) { t.Fatalf("%s %v", b, err) }
    }
  }
}
`);
  const test = runGo(go.dir, ["test", "-count=1", "."]);
  expect(test.ok, test.output).toBe(true);
});

it("exercises the documented binary32 rounding and overflow boundary of a Pydantic number", async () => {
  const src = 'import "typespec-structured-output"; using StructuredOutput; @structuredOutput model Reading { x: float32; }';
  const so = await emitStructuredOutput(src, {}, "cross-float32");
  expect(so.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  const validate = new Ajv2020().compile(so.files["Reading.json"] as Schema);
  for (const x of [16777216, 16777217, 1e39]) expect(validate({x})).toBe(true);
  const go = await generateGoPackage(src, "cross-float32");
  expect(go.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  writeFileSync(join(go.dir, "float_test.go"), `package gen
import ("encoding/json"; "testing")
func TestBinary32Boundary(t *testing.T) {
  for _, tc := range []struct{ raw string; fits bool }{
    {"16777216", true}, {"16777217", true}, {"1e39", false},
  } {
    input := []byte("{\\\"x\\\":" + tc.raw + "}")
    var v Reading
    err := json.Unmarshal(input, &v)
    if (err == nil) != tc.fits { t.Fatalf("%s: %v", input, err) }
    if !tc.fits { continue }
    if err := v.Validate(); err != nil { t.Fatal(err) }
    b, err := json.Marshal(v); if err != nil { t.Fatal(err) }
    var output struct{ X float64 }
    if err := json.Unmarshal(b, &output); err != nil || output.X != 16777216 { t.Fatalf("%s: %s %v", input, b, err) }
  }
}
`);
  const test = runGo(go.dir, ["test", "-count=1", "."]);
  expect(test.ok, test.output).toBe(true);
});

it("keeps nested null alternatives and removes uninhabited alternatives from spread indexers", async () => {
  const src = `import "typespec-structured-output"; using StructuredOutput;
    model Base { id: string; ...Record<never>; } model Spread { ...Base; ...Record<string>; }
    alias Maybe = (string | null) | never;
    @structuredOutput model Mixed { value: Maybe | int32; extras: Spread; }`;
  const schema = await emitStructuredOutput(src, {"target-profile": "none", "schema-mode": "pydantic"}, "cross-never");
  expect(schema.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  const validate = new Ajv2020().compile(schema.files["Mixed.json"] as Schema);
  const values = [null, "word", 0, false, 1.5].map(value => ({value, extras: {id: "x", other: "y"}}));
  const invalidExtra = {value: null, extras: {id: "x", other: 0}};
  expect([...values, invalidExtra].map(v => validate(v))).toEqual([true, true, true, false, false, false]);
  const go = await generateGoPackage(src, "cross-never");
  expect(go.diagnostics.filter(d => d.severity === "error").map(d => d.message)).toEqual([]);
  writeFileSync(join(go.dir, "values.json"), JSON.stringify([...values, invalidExtra]));
  writeFileSync(join(go.dir, "bottom_test.go"), `package gen
import ("encoding/json"; "os"; "testing"; "reflect")
func TestInhabitedAlternatives(t *testing.T) {
  b, err := os.ReadFile("values.json"); if err != nil { t.Fatal(err) }
  var values []json.RawMessage
  if err := json.Unmarshal(b, &values); err != nil { t.Fatal(err) }
  for i, raw := range values {
    var v Mixed
    err := json.Unmarshal(raw, &v)
    if err == nil { err = v.Validate() }
    if (err == nil) != (i < 3) { t.Fatalf("%s: %v", raw, err) }
    if err == nil {
      encoded, err := json.Marshal(v); if err != nil { t.Fatal(err) }
      var want, got any
      if json.Unmarshal(raw, &want) != nil || json.Unmarshal(encoded, &got) != nil || !reflect.DeepEqual(want, got) { t.Fatalf("%s => %s", raw, encoded) }
    }
  }
}
`);
  const run = runGo(go.dir, ["test", "-count=1", "."]);
  expect(run.ok, run.output).toBe(true);
});

it("preserves recursion, bounds and generic identity for named collections", async () => {
  const src = readFileSync(join(import.meta.dirname, "../../packages/typespec-structured-output/test/fixtures/recursive-collections/main.tsp"), "utf8");
  const so = await emitStructuredOutput(src, { "target-profile": "none" }, "cross-recursive-collections");
  expect(so.diagnostics.map(d => d.message)).toEqual([]);
  const validate = new Ajv2020().compile(so.files["Forest.json"] as Schema);
  const base = { roots: [[[]]], short: [[]], named: { z: { y: {} }, a: {} }, packet: { value: [[]] } };
  const cases = [
    { value: base, valid: true },
    { value: { ...base, short: [[[], [], []]] }, valid: true },
    { value: { ...base, short: [[], []] }, valid: false },
    { value: { ...base, roots: [[[], [], [], []]] }, valid: false },
    { value: { ...base, packet: { value: [1] } }, valid: false },
    { value: { ...base, named: { key: { bad: [] } } }, valid: false },
  ];
  for (const { value, valid } of cases) expect(validate(value)).toBe(valid);
  const openai = await emitStructuredOutput(src, {}, "cross-recursive-profile");
  expect(openai.diagnostics.map(d => d.code)).toContain("typespec-structured-output/target-incompatible");
  expect(openai.files).toEqual({});
  const go = await generateGoPackage(src, "cross-recursive-collections", { "ordered-records": true });
  expect(go.diagnostics.map(d => d.message)).toEqual([]);
  writeFileSync(join(go.dir, "cases.json"), JSON.stringify(cases));
  writeFileSync(join(go.dir, "recursive_test.go"), `package gen
import ("encoding/json"; "os"; "testing")
func TestRecursiveCollections(t *testing.T) {
  data, err := os.ReadFile("cases.json"); if err != nil { t.Fatal(err) }
  var cases []struct { Value json.RawMessage; Valid bool }
  if err := json.Unmarshal(data, &cases); err != nil { t.Fatal(err) }
  for _, c := range cases {
    var forest Forest
    err := json.Unmarshal(c.Value, &forest)
    if err == nil { err = forest.Validate() }
    if (err == nil) != c.Valid { t.Fatalf("%s: %v", c.Value, err) }
    if c.Valid {
      out, err := json.Marshal(forest)
      if err != nil || string(out) != string(c.Value) { t.Fatalf("%s => %s: %v", c.Value, out, err) }
    }
  }
}
`);
  const run = runGo(go.dir, ["test", "-count=1", "."]);
  expect(run.ok, run.output).toBe(true);
});
