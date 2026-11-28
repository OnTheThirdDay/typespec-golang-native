import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { emitStructuredOutput } from "../src/testing/index.js";
import { nestingDepth, validateProfile } from "../src/profile.js";
import { toStrictJsonSchema } from "../src/strict.js";
import type { JsonObject } from "../src/json.js";

const H = `import "typespec-structured-output";\nusing StructuredOutput;\n`;

describe("emitter behaviour", () => {
  it("is deterministic", async () => {
    const code = `${H}
      model B { x: string; } model A { b: B; c: C; } model C { a: A | null; }
      @structuredOutput model Root { a: A; c: C; n: B[]; }`;
    const one = await emitStructuredOutput(code, {}, "det-1");
    const two = await emitStructuredOutput(code, {}, "det-2");
    expect(JSON.stringify(one.files)).toEqual(JSON.stringify(two.files));
  });

  it("removes previous outputs when a later compilation fails", async () => {
    const dir = join(import.meta.dirname, ".tmp", "stale");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const run = async (code: string) => {
      writeFileSync(join(dir, "main.tsp"), code);
      return compile(NodeHost, join(dir, "main.tsp"), { outputDir: join(dir, "out"), emit: ["typespec-structured-output"] });
    };
    const out = join(dir, "out", "typespec-structured-output");
    await run(`${H}@structuredOutput model Ok { a: string; }`);
    expect(readdirSync(out).sort()).toEqual([".structured-output-manifest.json", "Ok.json"]);
    const p = await run(`${H}@structuredOutput model Ok { a?: string; }`);
    expect(p.diagnostics.some((d) => d.code.endsWith("optional-property"))).toBe(true);
    expect(existsSync(join(out, "Ok.json"))).toBe(false);
  });

  it("writes Responses API and Chat Completions wrappers", async () => {
    const code = `${H}@structuredOutput model Answer { text: string; }`;
    const tf = await emitStructuredOutput(code, { "output-format": "text-format" }, "wrap-1");
    expect(Object.keys(tf.files["Answer.json"] as JsonObject)).toEqual(["type", "strict", "name", "schema"]);
    const rf = await emitStructuredOutput(code, { "output-format": "response-format" }, "wrap-2");
    expect((rf.files["Answer.json"] as any).json_schema.name).toBe("Answer");
    expect((rf.files["Answer.json"] as any).json_schema.strict).toBe(true);
  });

  it("emit-all-models emits every concrete model", async () => {
    const r = await emitStructuredOutput(`${H}model A { x: string; } model B { a: A; } model T<X> { v: X; }`, { "emit-all-models": true }, "all");
    expect(Object.keys(r.files).sort()).toEqual(["A.json", "B.json"]);
  });

  it("emit-all-models includes models with indexers and skips only map types", async () => {
    const r = await emitStructuredOutput(
      `${H}model Closed { a: string; ...Record<never>; } model Extras { a: string; ...Record<string>; } model Empty { ...Record<never>; } model Counts is Record<int32>;`,
      { "emit-all-models": true, "target-profile": "none" },
      "all-indexers",
    );
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(Object.keys(r.files).sort()).toEqual(["Closed.json", "Empty.json", "Extras.json"]);
    expect(Object.keys(r.files["Empty.json"] as JsonObject)).toEqual(["additionalProperties", "properties", "title", "type", "required"]);
  });

  it("keeps closed-model key order in strict mode and leaves ordinary models unchanged", async () => {
    const code = `${H}@structuredOutput model C { a: string; ...Record<never>; } @structuredOutput model O { a: string; }`;
    for (const mode of ["strict", "pydantic"] as const) {
      const r = await emitStructuredOutput(code, { "schema-mode": mode, "target-profile": mode === "strict" ? "openai" : "none" }, `closed-order-${mode}`);
      expect(Object.keys(r.files["C.json"] as JsonObject)).toEqual(["additionalProperties", "properties", "required", "title", "type"]);
      expect(Object.keys(r.files["O.json"] as JsonObject)).toEqual(mode === "strict" ? ["properties", "required", "title", "type", "additionalProperties"] : ["properties", "required", "title", "type"]);
    }
  });

  it("keeps item bounds for the openai profile and rejects (never drops) them for fine-tuned models", async () => {
    // Positions: a property, a nullable property, a nested model in $defs.
    const code = (k: string) => `${H}model Inner { @${k}(2) deep: string[]; }
      @structuredOutput model M { @${k}(2) xs: string[]; @${k}(2) maybe: string[] | null; inner: Inner; }`;
    for (const k of ["minItems", "maxItems"]) {
      const ok = await emitStructuredOutput(code(k), {}, `items-openai-${k}`);
      expect(ok.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const text = JSON.stringify(ok.files["M.json"]);
      expect(text.split(`"${k}":2`).length - 1, text).toBe(3);

      const ft = await emitStructuredOutput(code(k), { "target-profile": "openai-fine-tuned" }, `items-ft-${k}`);
      const reasons = ft.diagnostics.filter((d) => d.code.endsWith("target-incompatible")).map((d) => d.message);
      expect(reasons.filter((m) => m.includes(`keyword '${k}' is not supported for fine-tuned models`)).length, reasons.join("\n")).toBe(3);
      expect(Object.keys(ft.files)).toEqual([]);
    }
  });

  it("omits defaults when default-values is omit", async () => {
    const r = await emitStructuredOutput(`${H}@structuredOutput model S { n?: int32 = 4; }`, { "default-values": "omit" }, "omit");
    expect(JSON.stringify(r.files["S.json"])).not.toContain("default");
  });

  it("keeps integer-like and prototype field names in their declared wire order", async () => {
    const code = readFileSync(join(import.meta.dirname, "fixtures/ordered-json-keys/main.tsp"), "utf8");
    const r = await emitStructuredOutput(code, {}, "wire-order");
    expect(r.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const wire = readFileSync(join(import.meta.dirname, ".tmp/wire-order/out/typespec-structured-output/M.json"), "utf8");
    const keys = ["head", "1", "__proto__", "0"];
    const positions = keys.map(k => wire.indexOf(JSON.stringify(k) + ":"));
    expect(positions.every(i => i >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a,b) => a-b));
    expect(JSON.parse(wire).required).toEqual(keys);
  });

  it("rejects root names that are not portable file names, case-insensitively unique", async () => {
    const reserved = await emitStructuredOutput(`${H}@structuredOutput("con") model R { x: string; }`, {}, "root-reserved");
    expect(reserved.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/invalid-root");
    expect(reserved.files).toEqual({});
    // "A.json" and "a.json" are the same file on case-insensitive file systems.
    const clash = await emitStructuredOutput(`${H}@structuredOutput("Shape") model A { x: string; } @structuredOutput("shape") model B { y: string; }`, {}, "root-case");
    expect(clash.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/duplicate-root-name");
  });

  it("never allows default-values emit to bypass either OpenAI profile", async () => {
    for (const profile of ["openai","openai-fine-tuned"] as const) {
      const r = await emitStructuredOutput(`${H}@structuredOutput model R { x?: string = "hi"; }`, {"target-profile":profile,"default-values":"emit"}, profile);
      expect(r.diagnostics.some(d => d.code.endsWith("default-value"))).toBe(true);
      expect(r.files).toEqual({});
    }
  });

  it("locates profile diagnostics at the offending TypeSpec declaration", async () => {
    const r = await emitStructuredOutput(`${H}@structuredOutput model S {\n  ok: string;\n  bad: Record<string>;\n}`, {}, "loc");
    const d = r.diagnostics.find((x) => x.code.endsWith("target-incompatible"))!;
    expect(d).toBeDefined();
    const target = d.target as any;
    expect(target.kind === "ModelProperty" ? target.name : target.kind).toBe("bad");
  });
});

describe("OpenAI profile validator", () => {
  it("validates constraint values and typed literal membership", () => {
    const invalid: JsonObject[] = [{type: "string", minLength: -1}, {type: "array", items: {type: "string"}, maxItems: 0.5},
      {type: "number", multipleOf: 0}, {type: "integer", minimum: "0"}, {type: "string", pattern: "["},
      {type: "integer", enum: [1, true]}, {type: "boolean", const: 1}, {type: []},
      {type: ["integer", "string"], enum: [1, "one"]}, {type: ["integer", "string"], const: 1}, {type: ["string", "null"], enum: ["C", 1]}];
    for (const prop of invalid) {
      const root = { type: "object", additionalProperties: false, required: ["x"], properties: {x: prop} };
      expect(validateProfile(root, "Root", "openai").length, JSON.stringify(prop)).toBeGreaterThan(0);
    }
  });
  const ok = (): JsonObject => ({
    type: "object",
    properties: { a: { type: "string" }, b: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    required: ["a", "b"],
    additionalProperties: false,
  });
  it("accepts the nullable enum type used in the OpenAI guide", () => {
    const root = {type: "object", additionalProperties: false, properties: {
      unit: {type: ["string", "null"], enum: ["F", "C"]},
      choice: {type: ["null", "integer"], enum: [0, null]},
    }, required: ["unit", "choice"]};
    for (const profile of ["openai", "openai-fine-tuned"] as const) expect(validateProfile(root, "Weather", profile)).toEqual([]);
  });
  it("counts an anyOf branch alongside object properties at the same level", () => {
    const object = (properties: JsonObject): JsonObject => ({type: "object", properties, required: Object.keys(properties), additionalProperties: false});
    let deep = object({});
    for (let i = 0; i < 9; i++) deep = object({child: deep});
    const root = object({value: {...object({}), anyOf: [deep]}});
    expect(nestingDepth(root, {})).toBe(11);
    expect(validateProfile(root, "Root", "openai").some(v => v.reason.includes("nesting depth"))).toBe(true);
  });
  it("accepts a valid schema", () => expect(validateProfile(ok(), "x", "openai")).toEqual([]));
  it("requires additionalProperties false", () => {
    const s = ok();
    delete s.additionalProperties;
    expect(validateProfile(s, "x", "openai").map((v) => v.reason)).toContain("objects must set 'additionalProperties: false'");
  });
  it("requires all properties", () => {
    const s = ok();
    s.required = ["a"];
    expect(validateProfile(s, "x", "openai")[0].reason).toMatch(/every property must be required/);
  });
  it("rejects root anyOf and non-object root", () => {
    const v = validateProfile({ anyOf: [ok(), ok()] } as JsonObject, "x", "openai").map((x) => x.reason);
    expect(v).toContain("the root schema must be an object");
    expect(v).toContain("the root schema must not use anyOf");
  });
  it("rejects allOf/oneOf/not", () => {
    for (const k of ["allOf", "oneOf", "not"]) {
      const s = ok();
      (s.properties as any).a = { type: "string", [k]: [] };
      expect(validateProfile(s, "x", "openai").some((v) => v.reason.includes(`'${k}'`))).toBe(true);
    }
  });
  it("rejects $ref with siblings and dangling refs", () => {
    const s = ok();
    (s.properties as any).a = { $ref: "#/$defs/Missing", description: "d" };
    const r = validateProfile(s, "x", "openai").map((v) => v.reason);
    expect(r.some((x) => x.includes("sibling"))).toBe(true);
    expect(r.some((x) => x.includes("resolve"))).toBe(true);
  });
  it("does not resolve types or references through Object.prototype", () => {
    for (const bad of [{ type: "constructor" }, { $ref: "#/$defs/toString" }, { $ref: "#/$defs/__proto__" }]) {
      const s = ok();
      (s.properties as any).a = bad;
      expect(validateProfile(s, "x", "openai").length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("counts string budgets in code points and requires a unique required list", () => {
    const s = ok();
    (s.properties as any).a = { type: "string", enum: ["😀".repeat(3)] };
    expect(validateProfile(s, "x", "openai")).toEqual([]);
    (s as any).required = [...(s as any).required, (s as any).required[0]];
    expect(validateProfile(s, "x", "openai").map((v) => v.reason).join()).toMatch(/unique/);
  });

  it("follows recursion without counting it as nesting", () => {
    const s: JsonObject = {
      $defs: { N: { type: "object", properties: { c: { type: "array", items: { $ref: "#/$defs/N" } } }, required: ["c"], additionalProperties: false } },
      type: "object",
      properties: { n: { $ref: "#/$defs/N" } },
      required: ["n"],
      additionalProperties: false,
    };
    expect(nestingDepth(s, s.$defs as JsonObject)).toBe(2);
    expect(validateProfile(s, "x", "openai")).toEqual([]);
  });
  it("fine-tuned profile rejects constraints", () => {
    const s = ok();
    (s.properties as any).a = { type: "string", maxLength: 3 };
    expect(validateProfile(s, "x", "openai")).toEqual([]);
    expect(validateProfile(s, "x", "openai-fine-tuned")[0].reason).toMatch(/fine-tuned/);
  });
  it("checks the large-enum string budget", () => {
    const s = ok();
    (s.properties as any).a = { type: "string", enum: Array.from({ length: 300 }, (_, i) => `${"v".repeat(60)}${i}`) };
    expect(validateProfile(s, "x", "openai").some((v) => v.reason.includes("15000"))).toBe(true);
  });
});

describe("strict transformation port", () => {
  it("matches the SDK's ref unravelling key order", () => {
    const s: JsonObject = {
      $defs: { Item: { description: "An item.", properties: { name: { title: "Name", type: "string" } }, required: ["name"], title: "Item", type: "object" } },
      properties: { d: { $ref: "#/$defs/Item", description: "the item" } },
      required: ["d"],
      title: "M",
      type: "object",
    };
    const out = toStrictJsonSchema(s);
    expect(Object.keys((out.properties as any).d)).toEqual(["description", "properties", "required", "title", "type", "additionalProperties"]);
    expect(Object.keys(out)).toEqual(["$defs", "properties", "required", "title", "type", "additionalProperties"]);
  });
  it("adds required after additionalProperties when absent", () => {
    const out = toStrictJsonSchema({ properties: { a: { default: null, anyOf: [{ type: "string" }, { type: "null" }] } }, title: "T", type: "object" });
    expect(Object.keys(out)).toEqual(["properties", "title", "type", "additionalProperties", "required"]);
    expect((out.properties as any).a).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  });
  it("flattens single allOf", () => {
    const out = toStrictJsonSchema({ type: "object", properties: { a: { allOf: [{ type: "string" }], title: "A" } } });
    expect((out.properties as any).a).toEqual({ title: "A", type: "string" });
  });
});

describe("committed reference metadata", () => {
  it("pins the Pydantic and OpenAI SDK versions", () => {
    const fixtures = join(import.meta.dirname, "fixtures");
    for (const c of readdirSync(fixtures)) {
      const f = join(fixtures, c, "reference.json");
      if (!existsSync(f)) continue;
      const ref = JSON.parse(readFileSync(f, "utf8")).reference;
      expect(ref).toEqual({ pydantic: "2.14.4", "pydantic-core": "2.50.5", openai: "3.59.0" });
    }
  });
});

describe("@schemaName and @defaultFactory", () => {
  it("rejects schema names that are not Python identifiers", async () => {
    const r = await emitStructuredOutput(`${H}@schemaName("Not-A-Name") @structuredOutput model M { a: string; }`, {}, "schema-name-invalid");
    expect(r.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/invalid-schema-name");
    expect(r.files).toEqual({});
  });

  it("requires a default value for @defaultFactory", async () => {
    const r = await emitStructuredOutput(`${H}@structuredOutput model M { @defaultFactory a?: string[]; }`, { "target-profile": "none" }, "default-factory-missing");
    expect(r.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/default-factory-without-default");
  });

  it("keeps the OpenAI profile's restriction on defaults", async () => {
    // Omitting the keyword must not let a default through a profile that forbids defaults.
    const r = await emitStructuredOutput(`${H}@structuredOutput model M { @defaultFactory a?: string[] = #[]; }`, {}, "default-factory-openai");
    expect(r.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/default-value");
    expect(r.files).toEqual({});
    // Requiredness and the strict transformation are unchanged (an optional field becomes required with null in strict mode only via policy).
    const pyd = await emitStructuredOutput(`${H}@structuredOutput model M { @defaultFactory a?: string[] = #[]; b: string; }`, { "target-profile": "none", "default-values": "emit", "schema-mode": "pydantic" }, "default-factory-required");
    expect((pyd.files["M.json"] as any).required).toEqual(["b"]);
    expect("default" in (pyd.files["M.json"] as any).properties.a).toBe(false);
  });
});

describe("root selection (roots, exclude-roots)", () => {
  // An imported library declares its own @structuredOutput roots; the service references one.
  const lib = `${H}namespace Lib { @structuredOutput model Address { street: string; city: string; } @structuredOutput model Unused { n: int32; } @structuredOutput model Bad { a?: string; } }`;
  const main = `import "./lib.tsp";\n${H}namespace App { @structuredOutput model Invoice { to: Lib.Address; total: float64; } @structuredOutput model Note { text: string; } }`;
  const sources = { "main.tsp": main, "lib.tsp": lib };

  it("writes only the selected roots; the others remain definitions, unchanged", async () => {
    const excluded = await emitStructuredOutput(sources, { "exclude-roots": ["Lib"] }, "roots-exclude");
    expect(excluded.diagnostics.map((d) => d.message)).toEqual([]);
    expect(Object.keys(excluded.files).sort()).toEqual(["Invoice.json", "Note.json"]);
    const invoice = excluded.files["Invoice.json"] as any;
    expect(Object.keys(invoice.$defs)).toEqual(["Address"]);
    expect(invoice.properties.to).toEqual({ $ref: "#/$defs/Address" });
    // Schema fidelity: a root's schema is the same whether the others are written or not.
    const selected = await emitStructuredOutput({ ...sources, "lib.tsp": lib.replace(" @structuredOutput model Bad { a?: string; }", "") }, {}, "roots-all");
    expect(JSON.stringify(selected.files["Invoice.json"])).toBe(JSON.stringify(invoice));
    expect(JSON.stringify(selected.files["Note.json"])).toBe(JSON.stringify(excluded.files["Note.json"]));
    expect(Object.keys(selected.files)).toContain("Address.json");
    // An excluded root is not validated on its own (Bad is invalid for the OpenAI profile).
    const only = await emitStructuredOutput(sources, { roots: ["App.Invoice"] }, "roots-include");
    expect(only.diagnostics.map((d) => d.message)).toEqual([]);
    expect(Object.keys(only.files).sort()).toEqual(["Invoice.json"]);
    expect(JSON.stringify(only.files["Invoice.json"])).toBe(JSON.stringify(invoice));
    const manifest = join(import.meta.dirname, ".tmp", "roots-include", "out", "typespec-structured-output", ".structured-output-manifest.json");
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual({ files: ["Invoice.json"] });
  });

  it("still validates excluded roots where they are referenced", async () => {
    const r = await emitStructuredOutput({ "main.tsp": `import "./lib.tsp";\n${H}namespace App { @structuredOutput model Uses { b: Lib.Bad; } }`, "lib.tsp": lib }, { "exclude-roots": ["Lib"] }, "roots-referenced-invalid");
    expect(r.diagnostics.map((d) => d.code)).toContain("typespec-structured-output/optional-property");
    expect(r.files).toEqual({});
  });

  it("rejects selections that select nothing", async () => {
    for (const [options, reason] of [
      [{ roots: ["App.Invoic"] }, /'roots' entry 'App\.Invoic' selects no root/],
      [{ "exclude-roots": ["Libs"] }, /'exclude-roots' entry 'Libs' selects no root/],
      [{ roots: ["App"], "exclude-roots": ["App"] }, /leaves no root to emit/],
      [{ roots: ["App..x"] }, /is not a TypeSpec namespace or type name/],
    ] as const) {
      const r = await emitStructuredOutput(sources, { ...options, "exclude-roots": [...(options as any)["exclude-roots"] ?? [], "Lib.Bad"] } as any, "roots-bad");
      expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(reason);
      expect(r.files).toEqual({});
    }
  });

  it("selects Unicode identifiers and escaped names containing dots", async () => {
    const source = H + 'namespace Café { @structuredOutput("One") model Über { x: string; } @structuredOutput("Two") model `two.words` { y: string; } }';
    for (const [key, file] of [["Café.Über", "One.json"], ["Café.`two.words`", "Two.json"]]) {
      const r = await emitStructuredOutput(source, { roots: [key] }, "roots-unicode");
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
      expect(Object.keys(r.files)).toEqual([file]);
    }
  });

  it("diagnoses selected roots absent from the requested API version", async () => {
    const src = 'import "@typespec/versioning";' + H + 'using Versioning; @versioned(V) namespace Api { enum V { v1, v2 } @added(V.v2) @structuredOutput model Later { x: string; } @structuredOutput model Older { y: string; } }';
    for (const roots of [["Api.Later"], ["Api.Later", "Api.Older"]]) {
      const r = await emitStructuredOutput(src, { roots, "api-version": "v1" }, "roots-version");
      expect(r.diagnostics.map(d => d.message)).toContainEqual(expect.stringMatching(/Api.Later.*no root in api-version 'v1'/));
      expect(r.files).toEqual({});
    }
    const active = await emitStructuredOutput(src, { roots: ["Api"], "api-version": "v1" }, "roots-version-active");
    expect(Object.keys(active.files)).toEqual(["Older.json"]);
  });

  it("checks every explicitly marked root when automatically collecting models", async () => {
    const r = await emitStructuredOutput(H + "@structuredOutput model Bad is string[]; @structuredOutput model Good { x: string; }", { "emit-all-models": true }, "roots-marked-array");
    expect(r.diagnostics.map(d => d.code)).toContain("typespec-structured-output/invalid-root");
    expect(r.files).toEqual({});
  });

  it("selects among emit-all-models roots", async () => {
    const r = await emitStructuredOutput(`${H}namespace A { model X { a: string; } } namespace B { model Y { x: A.X; } }`, { "emit-all-models": true, "exclude-roots": ["A"] }, "roots-all-models");
    expect(Object.keys(r.files).sort()).toEqual(["Y.json"]);
    expect(Object.keys((r.files["Y.json"] as any).$defs)).toEqual(["X"]);
  });
});
