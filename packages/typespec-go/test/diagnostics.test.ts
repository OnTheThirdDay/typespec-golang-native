/**
 * Negative compilation tests: unsupported semantics produce diagnostics at the offending
 * declaration and no output is written (fail closed). Plus determinism and stale-output checks.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateGoPackage } from "../src/testing/index.js";

const H = `import "@typespec/http";\nimport "typespec-go";\nusing Http;\n`;

const INT64_CASES = [
  { name: "int64-default", diag: "invalid-default", message: /9223372036854775808 is outside the int64 range/, code: `${H}model M { a?: integer = 9223372036854775808; }` },
  { name: "int64-array-default", diag: "invalid-default", message: /99999999999999999999 is outside/, code: `${H}model M { a?: integer[] = #[1, 99999999999999999999]; }` },
  { name: "int64-object-default", diag: "invalid-default", message: /-9223372036854775809 is outside/, code: `${H}model M { a?: { n: integer } = #{ n: -9223372036854775809 }; }` },
  { name: "int64-derived-scalar-default", diag: "invalid-default", code: `${H}scalar Big extends integer; model M { a?: Big | null = 1e19; }` },
  { name: "int64-minimum", diag: "unsupported-type", message: /admit no int64 value/, code: `${H}model M { @minValue(9223372036854775808) a: integer; }` },
  { name: "int64-exclusive-minimum", diag: "unsupported-type", message: /admit no int64 value/, code: `${H}model M { @minValueExclusive(9223372036854775807) a?: integer; }` },
  { name: "int64-scalar-maximum", diag: "unsupported-type", message: /admit no int64 value/, code: `${H}@maxValue(-9223372036854775809) scalar S extends integer; model M { s: S; }` },
];

const cases: { name: string; code: string; diag: string; message?: RegExp; options?: Record<string, unknown> }[] = [
  { name: "re2-lookahead", diag: "unsupported-pattern", message: /lookaround/, code: `${H}model M { @pattern("^(?=a)") a: string; }` },
  { name: "re2-backreference", diag: "unsupported-pattern", message: /backreferences/, code: `${H}model M { @pattern("(a)\\\\1") a: string; }` },
  { name: "pattern-identity-escape", diag: "unsupported-pattern", message: /identity escape/, code: `${H}model M { @pattern("\\\\a") a: string; }` },
  { name: "pattern-lone-surrogate", diag: "unsupported-pattern", message: /lone surrogates/, code: `${H}model M { @pattern("\\\\uD83D") a: string; }` },
  { name: "re2-nested-repeat", diag: "unsupported-pattern", message: /repetition limit/, code: `${H}model M { @pattern("(a{40}){40}") a: string; }` },
  { name: "re2-repetition-limit", diag: "unsupported-pattern", code: `${H}model M { @pattern("a{1001}") value: string; }` },
  { name: "invalid-module-segment", diag: "invalid-option", code: `${H}model M {}`, options: { module: "example.com/../api" } },
  { name: "invalid-runtime-import", diag: "invalid-option", code: `${H}model M {}`, options: { runtime: "import", "runtime-module": "bad path" } },
  { name: "keyword-package", diag: "invalid-option", code: `${H}model M {}`, options: {"package-name":"type"} },
  // TypeSpec 1.18 interns numeric literals by binary64 value: the second literal would silently become the first.
  { name: "conflated-numeric-literal", diag: "conflated-numeric-literal", message: /9007199254740997 is represented as 9007199254740995/, code: `${H}model M { a?: int64 = 9007199254740995; b?: int64 = 9007199254740997; }` },
  { name: "conflated-decimal-literal", diag: "conflated-numeric-literal", code: `${H}model M { @minValue(0.1) a: decimal; b?: decimal = 0.10000000000000000001; }` },
  { name: "infinite-type", diag: "infinite-type", code: `${H}model A { b: B; } model B { a: A; }` },
  { name: "unknown-decorator", diag: "unsupported-decorator", message: /uniqueItems/, code: `import "@typespec/json-schema";\n${H}model M { @TypeSpec.JsonSchema.uniqueItems tags: string[]; }` },
  { name: "bytes-encoding", diag: "unsupported-encoding", code: `${H}model M { @encode("base32") b: bytes; }` },
  { name: "datetime-encoding-type", diag: "unsupported-encoding", code: `${H}model M { @encode(DateTimeKnownEncoding.unixTimestamp, int8) t: utcDateTime; }` },
  { name: "nullable-query", diag: "unsupported-http", message: /null/, code: `${H}@service namespace S; op f(@query q: string | null): void;` },
  { name: "query-encoding-with-explode", diag: "unsupported-http", message: /explode/, code: `${H}@service namespace S; op f(@query(#{explode: true}) @encode(ArrayEncoding.pipeDelimited) q: string[]): void;` },
  { name: "record-header", diag: "unsupported-http", message: /record/, code: `${H}@service namespace S; op f(@header h: Record<string>): void;` },
  { name: "xml-union", diag: "unsupported-http", message: /XML/, code: `import "@typespec/xml";\n${H}@service namespace S; model X { u: string | int32; } op f(@header contentType: "application/xml", @body b: X): void;` },
  { name: "unsupported-media", diag: "unsupported-http", message: /application\/yaml/, code: `${H}@service namespace S; model X { a: string; } op f(@header contentType: "application/yaml", @body b: X): void;` },
  { name: "form-nested-model", diag: "unsupported-http", message: /form field/, code: `${H}@service namespace S; model Y { a: string; } model X { y: Y; } op f(@header contentType: "application/x-www-form-urlencoded", @body b: X): void;` },
  { name: "shared-route-identical", diag: "unsupported-http", message: /identical/, code: `${H}@service namespace S; @route("/x") @sharedRoute op a(): void; @route("/x") @sharedRoute op b(): void;` },
  { name: "fragment-expansion", diag: "unsupported-http", message: /fragment/, code: `${H}@service namespace S; @route("/x{#f}") op a(f: string): void;` },
  { name: "invalid-module", diag: "invalid-option", code: `${H}model M {}`, options: { module: "not a path!" } },
  { name: "invalid-api-version", diag: "invalid-option", message: /api-version/, code: `import "@typespec/versioning";\n${H}using Versioning;\n@service @versioned(V) namespace S; enum V { v1 } op f(): void;`, options: { "api-version": "v9" } },
  { name: "xml-record-of-arrays", diag: "unsupported-http", message: /records in XML/, code: `import "@typespec/xml";
${H}@service namespace S; model Y { a: string; } model X { m: Record<Y[]>; } op f(@header contentType: "application/xml", @body b: X): void;` },
  { name: "model-header", diag: "unsupported-http", message: /model-typed header/, code: `${H}@service namespace S; model Y { a: string; } op f(@header h: Y): void;` },
  { name: "model-cookie", diag: "unsupported-http", message: /model-typed cookie/, code: `${H}@service namespace S; model Y { a: string; } op f(@cookie c: Y): void;` },
  { name: "model-path-nested", diag: "unsupported-http", message: /path object.*has no text representation/, code: `${H}@service namespace S; model Y { a: string[]; } @route("/x/{p}") op f(@path p: Y): void;` },
  { name: "model-path-ambiguous", diag: "unsupported-http", message: /does not uniquely delimit fields/, code: `${H}@service namespace S; model Y { a: string; } @route("/x/{+p}") op f(@path p: Y): void;` },
  { name: "record-cookie", diag: "unsupported-http", message: /record-typed cookie/, code: `${H}@service namespace S; op f(@cookie c: Record<string>): void;` },
  { name: "uri-several-variables-optional", diag: "unsupported-http", message: /cannot uniquely separate/, code: `${H}@service namespace S; @route("/x/{a,b}") op f(@path a: string, @path b?: string): void;` },
  { name: "multipart-part-header", diag: "unsupported-http", message: /custom MIME headers/, code: `${H}@service namespace S; op f(@header contentType: "multipart/form-data", @multipartBody body: { a: HttpPart<{ @header("x-custom") h: string; @body body: string }> }): void;` },
  { name: "uri-prefix-modifier", diag: "unsupported-http", message: /prefix modifier/, code: `${H}@service namespace S; @route("/x/{a:3}") op f(@path a: string): void;` },
  { name: "xml-nullable", diag: "unsupported-http", message: /nullable properties have no XML/, code: `import "@typespec/xml";\n${H}@service namespace S; model X { a: string | null; } op f(@header contentType: "application/xml", @body b: X): void;` },
  { name: "xml-nested-collection", diag: "unsupported-http", message: /nested collections/, code: `import "@typespec/xml";\n${H}@service namespace S; model X { a: string[][]; } op f(@header contentType: "application/xml", @body b: X): void;` },
  // `response-unset-nullable` as a list: every name must select an optional nullable property.
  { name: "response-null-unknown-name", diag: "invalid-option", message: /names 'S\.Missing'/, code: `${H}@service namespace S; model M { a?: string | null; } op f(): M;`, options: { "response-unset-nullable": ["S.Missing"] } },
  { name: "response-null-not-nullable", diag: "invalid-option", message: /names 'S\.M\.a'/, code: `${H}@service namespace S; model M { a?: string; b: string | null; } op f(): M;`, options: { "response-unset-nullable": ["S.M.a", "S.M.b"] } },
  // Only properties written by a response can be selected: not request-only models, not models
  // nested only in requests, not properties that the response visibility excludes.
  { name: "response-null-request-only-model", diag: "invalid-option", message: /names 'S\.Req'.*reachable only from requests/, code: `${H}@service namespace S; model Req { a?: string | null; } model Res { r: string; } op f(@body b: Req): Res;`, options: { "response-unset-nullable": ["S.Req"] } },
  { name: "response-null-request-only-nested", diag: "invalid-option", message: /names 'S\.Inner\.x'/, code: `${H}@service namespace S; model Inner { x?: string | null; } model Req { inner: Inner; } model Res { inner?: string | null; } op f(@body b: Req): Res;`, options: { "response-unset-nullable": ["S.Inner.x", "S.Res"] } },
  { name: "response-null-create-only-property", diag: "invalid-option", message: /names 'S\.W\.secret'/, code: `${H}@service namespace S; model W { @visibility(Lifecycle.Create) secret?: string | null; note?: string | null; name: string; } op f(@body w: W): W;`, options: { "response-unset-nullable": ["S.W.secret", "S.W.note"] } },
  // ordered-records: records without an ordered representation are rejected, never reordered.
  { name: "ordered-query-record", diag: "unsupported-http", message: /no ordered representation/, options: { "ordered-records": true }, code: `${H}@service namespace S; op f(@query q: Record<string>): void;` },
  { name: "ordered-form-additional", diag: "unsupported-http", message: /no ordered representation/, options: { "ordered-records": true }, code: `${H}@service namespace S; model F { a: string; ...Record<string>; } op f(@header contentType: "application/x-www-form-urlencoded", @body b: F): void;` },
  { name: "ordered-xml-union-record", diag: "unsupported-http", message: /records in XML require scalar or model values/, options: { "ordered-records": true }, code: `import "@typespec/xml";
${H}@service namespace S; model X { m: Record<string | int32>; } op f(@header contentType: "application/xml", @body b: X): void;` },
  // `integer-type: int64`: values and bounds outside int64 are rejected, never rounded or wrapped.
  ...INT64_CASES.map((c) => ({ ...c, options: { "integer-type": "int64" } })),
  ...(() => {
    const SSE = `import "@typespec/http/streams";\nimport "@typespec/sse";\nimport "@typespec/events";\nimport "@typespec/streams";\n${H}using SSE; using Events;\n@service namespace S;\nmodel A { n: int32; } model B { s: string; }\n`;
    return [
      { name: "sse-text-non-string", diag: "unsupported-http", message: /text events require a declared text codec/, code: `${SSE}@events union Ev { @Events.contentType("text/plain") a: A, b: B }\nop f(): SSEStream<Ev>;` },
      { name: "sse-envelope-response-null", diag: "invalid-option", message: /no optional nullable property written/, options: { "response-unset-nullable": ["S.Env.extra"] }, code: `${SSE}model Env { @data payload: A; extra?: string | null; }\n@events union Ev { e: Env, b: B }\nop f(): SSEStream<Ev>;` },
      { name: "sse-data-extra-required", diag: "unsupported-http", message: /other required properties/, code: `${SSE}model Env { @data payload: A; extra: string; }\n@events union Ev { e: Env, b: B }\nop f(): SSEStream<Ev>;` },
    ];
  })(),
];

describe("Go emitter diagnostics (fail closed)", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const r = await generateGoPackage(c.code, `diag-${c.name}`, c.options as any);
      const ours = r.diagnostics.filter((d) => d.code.startsWith("typespec-go/") || d.severity === "error");
      const match = ours.find((d) => d.code === `typespec-go/${c.diag}` && (!c.message || c.message.test(d.message)));
      expect(match, ours.map((d) => `${d.code}: ${d.message}`).join("\n")).toBeDefined();
      expect(match!.target, "diagnostics must point at a declaration").toBeDefined();
      expect(r.files.filter((f) => f.endsWith(".go")), "no output may be written").toEqual([]);
    });
  }
});

describe("integer-type: int64 diagnostics are specific to the bounded representation", () => {
  for (const c of INT64_CASES) {
    it(`${c.name} compiles with arbitrary-precision integers`, async () => {
      const r = await generateGoPackage(c.code, `diag-ok-${c.name}`);
      expect(r.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    });
  }
});

describe("Structured Output decorators", () => {
  it("do not change Go generation (@schemaName, @defaultFactory)", async () => {
    const r = await generateGoPackage(`import "typespec-structured-output";
using StructuredOutput;
@schemaName("Renamed") model M { @defaultFactory tags?: string[] = #["a"]; }`, "so-decorators");
    expect(r.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const models = readFileSync(join(r.dir, "models.go"), "utf8");
    expect(models).toMatch(/^type M struct/m);
    expect(models).toContain('tsgo.MustDecode(tsgo.ArrayCodec(tsgo.StringCodec), `["a"]`)');
  });
});

describe("generation properties", () => {
  const code = readFileSync(join(import.meta.dirname, "go", "server", "main.tsp"), "utf8");
  it("is deterministic", async () => {
    const a = await generateGoPackage(code, "det-a");
    const b = await generateGoPackage(code, "det-b");
    const read = (dir: string) => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".go")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    expect(read(a.dir)).toEqual(read(b.dir));
  });
  it("removes stale outputs when a later compilation fails", async () => {
    const ok = await generateGoPackage(`${H}model M { a: string; }`, "stale");
    expect(existsSync(join(ok.dir, "models.go"))).toBe(true);
    // same output directory, now with an unsupported construct
    const { compile, NodeHost } = await import("@typespec/compiler");
    const { writeFileSync } = await import("node:fs");
    const root = join(ok.dir, "..", "..");
    writeFileSync(join(root, "main.tsp"), `${H}model M { @pattern("(?=x)") a: string; }`);
    const p = await compile(NodeHost, join(root, "main.tsp"), { outputDir: join(root, "out"), emit: ["typespec-go"], options: { "typespec-go": { module: "example.com/gen" } } });
    expect(p.diagnostics.some((d) => d.code === "typespec-go/unsupported-pattern")).toBe(true);
    expect(existsSync(join(ok.dir, "models.go"))).toBe(false);
    expect(existsSync(join(ok.dir, "tsgo", "codec.go"))).toBe(false);
  });
});
