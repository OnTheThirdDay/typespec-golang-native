/**
 * Independently compiled specifications sharing Go packages (options `export-contract` and
 * `external`): a shared package generated from Shop.Common, and consumer packages that import its
 * types instead of generating them. The Go tests check type identity and runtime behaviour across
 * the package boundary; mismatched or unsupported mappings must be diagnosed, never generated.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generateGoPackage, gofmtList, type GoGenResult } from "../src/testing/index.js";

const dir = join(import.meta.dirname, "external");
const common = readFileSync(join(dir, "common.tsp"), "utf8");
const consumer = readFileSync(join(dir, "consumer.tsp"), "utf8");
const SHARED_RUNTIME = { runtime: "import", "runtime-module": "example.com/shared/tsgo" } as const;

let shared: GoGenResult;

/** Use portable module paths so the same generated workspace also runs under WSL. */
function writeWork(work: string, ...dirs: string[]): void {
  const modules = dirs.map(p => relative(dirname(work), p).replaceAll("\\", "/"));
  writeFileSync(work, `go 1.24\n\nuse (\n\t${modules.join("\n\t")}\n)\n`);
}

function goInWorkspace(work: string, cwd: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("go", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, GOWORK: work, GOFLAGS: "" } }) };
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Generates a consumer of the shared package (same Shop.Common sources unless replaced). */
async function generateConsumer(name: string, options: Record<string, unknown> = {}, sources: Record<string, string> = {}) {
  return generateGoPackage({ "main.tsp": consumer, "common.tsp": common, ...sources }, `ext-${name}`, {
    module: "example.com/consumer",
    ...SHARED_RUNTIME,
    external: { "Shop.Common": shared.dir },
    ...options,
  } as any);
}

beforeAll(async () => {
  shared = await generateGoPackage({ "main.tsp": 'import "./common.tsp";\n', "common.tsp": common }, "ext-shared", { module: "example.com/shared", "export-contract": true });
  expect(shared.diagnostics.map((d) => d.message)).toEqual([]);
});

describe("shared Go packages", () => {
  it("writes a contract of the shared package's declarations", () => {
    const contract = JSON.parse(readFileSync(join(shared.dir, "typespec-go-contract.json"), "utf8"));
    expect(contract).toMatchObject({ version: 4, importPath: "example.com/shared", package: "shared", runtime: "example.com/shared/tsgo" });
    expect(contract.options).toEqual({ "unknown-properties": "ignore", "optional-properties": "source", "integer-type": "arbitrary-precision", "invisible-properties": "unknown", "response-unset-nullable": "omit", "float-format": "shortest", "string-escaping": "default", "ordered-records": "false" });
    expect(contract.decls["Shop.Common.Money"]).toEqual({ name: "Money", fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(contract.decls["Shop.Common.Pet@Union"].name).toBe("PetUnion");
    expect(contract.decls["Shop.Common.Page<Shop.Common.Widget>"].name).toBe("PageWidget");
    // Anonymous types are keyed by where they are written, not by content: Twins declares three
    // structurally identical members, each with its own identity and Go type.
    const twins = Object.keys(contract.decls).filter((k) => k.startsWith("~Shop.Common.Twins/"));
    expect(twins.map((k) => contract.decls[k].name).sort()).toEqual(["TwinsDeep", "TwinsDeepInner", "TwinsLeft", "TwinsRight"]);
    expect(new Set(twins.map((k) => contract.decls[k].fingerprint)).size).toBe(2); // left, right and deep.inner have equal content
    expect(Object.values(contract.decls).some((e: any) => e.ambiguous)).toBe(false);
    // Enums and scalars of a shared package expose their text form to other packages.
    expect(readFileSync(join(shared.dir, "models.go"), "utf8")).toMatch(/^func \(x \*Status\) UnmarshalText\(b \[\]byte\) error \{/m);
  });

  it("generates a consumer that uses the shared types (identity and behaviour)", async () => {
    const r = await generateConsumer("consumer");
    expect(r.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const models = readFileSync(join(r.dir, "models.go"), "utf8");
    // Shared declarations are imported, not regenerated; derived ones are generated here.
    expect([...models.matchAll(/^type (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["AuditedCreate", "AuditedStampedCreate", "Order", "OrderCreate", "PageOrder", "PageOrderCreate", "PageWidgetCreate", "Shipment", "WidgetCreate"]);
    expect(models).toContain('externalRef0 "example.com/shared"');
    expect(models).not.toMatch(/regexp/); // patterns of shared scalars live in the shared package
    expect(gofmtList(r.dir)).toBe("");
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, shared.dir, r.dir);
    cpSync(join(dir, "consumer_test.go"), join(r.dir, "consumer_test.go"));
    const vet = goInWorkspace(work, r.dir, ["vet", "./..."]);
    expect(vet.ok, vet.output).toBe(true);
    const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });

  it("preserves dependencies of a single mapped model across two package boundaries", async () => {
    const main = "import \"./common.tsp\"; namespace Middle; model Invoice { money: Shop.Common.Money; }";
    const middle = await generateConsumer("middle", {
      module: "example.com/middle", external: { "Shop.Common.Money": shared.dir }, "export-contract": true,
    }, { "main.tsp": main });
    expect(middle.diagnostics.map(d => d.message)).toEqual([]);
    const r = await generateConsumer("transitive", { external: { "Middle.Invoice": middle.dir } }, {
      "main.tsp": 'import "./middle.tsp"; model View { invoice: Middle.Invoice; price: Shop.Common.Money; currency: Shop.Common.Currency; }',
      "middle.tsp": main,
    });
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, shared.dir, middle.dir, r.dir);
    writeFileSync(join(r.dir, "identity_test.go"), `package consumer
import (
  "testing"
  "example.com/shared"
)
func TestIdentity(t *testing.T) {
  var v View
  var _ shared.Currency = v.Currency
  v.Price = v.Invoice.Money
  v.Currency = v.Price.Currency
  if err := shared.Currency("lower").Validate(); err == nil { t.Fatal("missing inherited pattern") }
}
`);
    const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });

  it("rejects drift in a nested declaration reached only through a type mapping", async () => {
    const r = await generateConsumer("nested-drift", { external: { "Shop.Common.Widget": shared.dir } }, {
      "common.tsp": common.replace("^[A-Z]{3}$", "^[A-Z]{4}$"),
    });
    expect(r.diagnostics.map(d => d.message).join("\n")).toMatch(/Shop\.Common\.Currency.*differs/);
    expect(r.files).toEqual([]);
  });

  it.each([null, { decls: null }, { options: [] }, { decls: { "Shop.Common.Money": { name: "not a Go identifier", fingerprint: "a".repeat(32) } } }])(
    "diagnoses a malformed external contract before generation (%#)", async (bad) => {
      const contract = JSON.parse(readFileSync(join(shared.dir, "typespec-go-contract.json"), "utf8"));
      const file = join(shared.dir, "..", "..", "invalid-contract.json");
      writeFileSync(file, JSON.stringify(bad === null ? null : { ...contract, ...bad }));
      const r = await generateConsumer("malformed-contract", { external: { "Shop.Common.Money": file } });
      expect(r.diagnostics.map(d => d.code)).toContain("typespec-go/invalid-option");
      expect(r.files).toEqual([]);
    },
  );

  it("binds XML for an imported model whose owner has no XML service", async () => {
    const r = await generateConsumer("xml", { external: { "Shop.Common.Money": shared.dir } }, {
      "main.tsp": `import "@typespec/http"; import "@typespec/xml"; import "./common.tsp";
        using Http; @service namespace Pay;
        @route("/xml") @post op transfer(@header contentType: "application/xml", @body price: Shop.Common.Money):
          { @header contentType: "application/xml"; @body price: Shop.Common.Money; };`,
    });
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, shared.dir, r.dir);
    cpSync(join(dir, "xml_test.go"), join(r.dir, "xml_test.go"));
    const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });

  it("allows a consumer to select its own nullable response fields with an unchanged shared model", async () => {
    const source = consumer + '\nmodel Snapshot { cost: Money; @encode(string) counter: LongRunningTransactionSequenceNumber; note?: string | null; }\n@route("/snapshot") @get op snapshot(): Snapshot;';
    const r = await generateConsumer("local-response-policy", { "response-unset-nullable": ["Orders.Snapshot.note"] }, { "main.tsp": source });
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, shared.dir, r.dir);
    writeFileSync(join(r.dir, "policy_test.go"), `package consumer
import ("testing"; "net/http/httptest"; "example.com/shared")
func TestLocalSelection(t *testing.T) {
  w := httptest.NewRecorder()
  err := (Snapshot200JSONResponse{Body: Snapshot{Cost: shared.Money{Currency: "AUD"}, Counter: shared.LongRunningTransactionSequenceNumber(9007199254740993)}}).VisitSnapshotResponse(w)
  if err != nil || w.Body.String() != \"{\\\"cost\\\":{\\\"amount\\\":0,\\\"currency\\\":\\\"AUD\\\"},\\\"counter\\\":\\\"9007199254740993\\\",\\\"note\\\":null}\" { t.Fatalf("%s %v", w.Body, err) }
}
`);
    const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });

  it("accepts dotted names as a list or as nested objects (the forms tspconfig.yaml allows)", async () => {
    const flat = await generateConsumer("form-flat");
    const nested = await generateConsumer("form-nested", { external: { Shop: { Common: shared.dir } } });
    const list = await generateConsumer("form-list", { external: [{ name: "Shop.Common", path: shared.dir }] });
    for (const r of [flat, nested, list]) expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const models = (r: GoGenResult) => readFileSync(join(r.dir, "models.go"), "utf8");
    expect(models(nested)).toBe(models(flat));
    expect(models(list)).toBe(models(flat));
    for (const [name, external, message] of [
      ["dup", [{ name: "Shop.Common", path: shared.dir }, { name: "Shop.Common", path: shared.dir }], /maps 'Shop.Common' more than once/],
      ["dup-forms", { Shop: { Common: shared.dir }, "Shop.Common": shared.dir }, /maps 'Shop.Common' more than once/],
      ["entry", [{ name: "Shop.Common", contract: shared.dir }], /must be \{ name, path \}/],
      ["leaf", { Shop: { Common: 3 } }, /the path must be a non-empty string/],
    ] as const) {
      const r = await generateConsumer(`form-bad-${name}`, { external });
      expect(r.diagnostics.map(d => d.message).join("\n")).toMatch(message);
      expect(r.files.filter(f => f.endsWith(".go"))).toEqual([]);
    }
  });

  it("maps a dotted namespace from tspconfig.yaml", async () => {
    const { compile, NodeHost, resolveCompilerOptions } = await import("@typespec/compiler");
    const root = join(import.meta.dirname, ".tmp", "ext-tspconfig");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "main.tsp"), consumer);
    writeFileSync(join(root, "common.tsp"), common);
    const shared_ = relative(root, shared.dir).replaceAll("\\", "/");
    writeFileSync(join(root, "tspconfig.yaml"), `emit: [typespec-go]\noptions:\n  typespec-go:\n    module: example.com/consumer\n    runtime: import\n    runtime-module: example.com/shared/tsgo\n    external:\n      Shop:\n        Common: ${shared_}\n`);
    const [options, diags] = await resolveCompilerOptions(NodeHost, { entrypoint: join(root, "main.tsp"), cwd: root });
    expect(diags).toEqual([]);
    const program = await compile(NodeHost, join(root, "main.tsp"), { ...options, outputDir: join(root, "out") });
    expect(program.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
    expect(readFileSync(join(root, "out", "typespec-go", "models.go"), "utf8")).toContain('externalRef0 "example.com/shared"');
  });

  it("shares ordered records between packages", async () => {
    const lib = 'namespace Data { model Bag { items: Record<int32>; ...Record<string>; } }';
    const sharedOrdered = await generateGoPackage({ "main.tsp": lib }, "ext-ordered-shared", { module: "example.com/shared", "export-contract": true, "ordered-records": true });
    expect(sharedOrdered.diagnostics.map(d => d.message)).toEqual([]);
    const code = `import "@typespec/http"; using Http; ${lib} @service namespace Api { model Box { bag: Data.Bag; extra?: Record<string>; } @post op put(@body box: Box): Box; }`;
    const opts = { module: "example.com/consumer", ...SHARED_RUNTIME, external: { Data: sharedOrdered.dir } };
    const mismatch = await generateGoPackage(code, "ext-ordered-mismatch", opts);
    expect(mismatch.diagnostics.map(d => d.message).join("\n")).toMatch(/option 'ordered-records' is 'false' here but 'true'/);
    const r = await generateGoPackage(code, "ext-ordered-consumer", { ...opts, "ordered-records": true });
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, sharedOrdered.dir, r.dir);
    writeFileSync(join(r.dir, "ordered_test.go"), `package consumer
import ("encoding/json"; "testing"; shared "example.com/shared")
func TestOrderedAcrossPackages(t *testing.T) {
  var b Box
  in := \`{"bag":{"items":{"z":1,"a":2},"y":"1","b":"2"},"extra":{"q":"1","p":"2"}}\`
  if err := json.Unmarshal([]byte(in), &b); err != nil { t.Fatal(err) }
  var _ shared.Bag = b.Bag
  out, err := json.Marshal(b)
  if err != nil || string(out) != in { t.Fatalf("%s %v", out, err) }
}
`);
    const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
  });

  it("lets an exporting service select types that only its consumers' responses write", async () => {
    const code = 'import "@typespec/http"; using Http; @service namespace Data { model Row { tag?: string | null; } model Other { n: int32; } @get op other(): Other; }';
    const exported = await generateGoPackage(code, "ext-export-service", { module: "example.com/shared", "export-contract": true, "response-unset-nullable": ["Data.Row.tag"] });
    expect(exported.diagnostics.map(d => d.message)).toEqual([]);
    const local = await generateGoPackage(code, "ext-local-service", { module: "example.com/local", "response-unset-nullable": ["Data.Row.tag"] });
    expect(local.diagnostics.map(d => d.message).join("\n")).toMatch(/names 'Data\.Row\.tag'/);
  });

  it("inherits the response nulls of shared declarations from their contract", async () => {
    const src = { "main.tsp": 'namespace Data; model Row { tag?: string | null; other?: string | null; } model Holder { row?: Row; }' };
    const selected = await generateGoPackage(src, "ext-selected-export", {
      module: "example.com/shared", "export-contract": true, "response-unset-nullable": ["Data.Row.tag"],
    });
    expect(selected.diagnostics.map(d => d.message)).toEqual([]);
    const contract = JSON.parse(readFileSync(join(selected.dir, "typespec-go-contract.json"), "utf8"));
    expect(contract.decls["Data.Row"].responseNulls).toEqual(["tag"]);
    expect(contract.decls["Data.Holder"].responseNulls).toBeUndefined();
    const code = 'import "@typespec/http"; using Http; namespace Data { model Row { tag?: string | null; other?: string | null; } model Holder { row?: Row; } }'
      + ' @service namespace Api { model Page { rows: Data.Row[]; holder: Data.Holder; next?: string | null; } @get op rows(): Data.Row; @get @route("/page") op page(): Page; }';
    const opts = { module: "example.com/caller", ...SHARED_RUNTIME, external: { "Data.Row": selected.dir, "Data.Holder": selected.dir } };
    // The consumer does not repeat the shared selection: the shared types keep it, local types
    // containing them write it, and the consumer's own properties keep its own policy.
    const inherited = await generateGoPackage(code, "ext-selected-inherited", opts);
    expect(inherited.diagnostics.map(d => d.message)).toEqual([]);
    const repeated = await generateGoPackage(code, "ext-selected-repeated", { ...opts, "response-unset-nullable": ["Data.Row.tag"] });
    expect(repeated.diagnostics.map(d => d.message)).toEqual([]);
    for (const r of [inherited, repeated]) {
      const work = join(r.dir, "..", "..", "go.work");
      writeWork(work, selected.dir, r.dir);
      writeFileSync(join(r.dir, "shared_policy_test.go"), `package caller
import ("testing"; "net/http/httptest"; "example.com/shared")
func TestSharedSelection(t *testing.T) {
  w := httptest.NewRecorder()
  err := (Rows200JSONResponse{}).VisitRowsResponse(w)
  if err != nil || w.Body.String() != "{\\"tag\\":null}" { t.Fatalf("%s %v", w.Body, err) }
  w = httptest.NewRecorder()
  err = (Page200JSONResponse{Body: Page{Rows: []shared.Row{{}}, Holder: shared.Holder{Row: &shared.Row{}}}}).VisitPageResponse(w)
  if err != nil || w.Body.String() != "{\\"rows\\":[{\\"tag\\":null}],\\"holder\\":{\\"row\\":{\\"tag\\":null}}}" { t.Fatalf("%s %v", w.Body, err) }
}
`);
      const test = goInWorkspace(work, r.dir, ["test", "-count=1", "."]);
      expect(test.ok, test.output).toBe(true);
    }
    // Genuine conflicts: the consumer writes as null what the shared type omits.
    const conflict = await generateGoPackage(code, "ext-selected-conflict", { ...opts, "response-unset-nullable": ["Data.Row.other"] });
    expect(conflict.diagnostics.map(d => d.message).join("\n")).toMatch(/writes 'Data\.Row\.other' as null when unset, but example\.com\/shared\.Row \(external 'Data\.Row'\) omits it/);
    expect(conflict.diagnostics.filter(d => d.code === "typespec-go/external-package")).toHaveLength(1);
    expect(conflict.files).toEqual([]);
    const all = await generateGoPackage(code, "ext-selected-conflict-all", { ...opts, "response-unset-nullable": "null" });
    expect(all.diagnostics.map(d => d.message).join("\n")).toMatch(/'Data\.Row\.other' as null when unset/);
    expect(all.files).toEqual([]);
  });

  it("maps single types", async () => {
    const r = await generateConsumer("type-mapping", { external: { "Shop.Common.Money": shared.dir, "Shop.Common.Status": shared.dir } });
    expect(r.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const models = readFileSync(join(r.dir, "models.go"), "utf8");
    expect(models).toMatch(/^\tTotal externalRef0\.Money$/m);
    expect(models).toMatch(/^type Widget struct/m); // not mapped: generated here
    expect(models).not.toMatch(/^type (Money|Status) /m);
    const work = join(r.dir, "..", "..", "go.work");
    writeWork(work, shared.dir, r.dir);
    const vet = goInWorkspace(work, r.dir, ["vet", "./..."]);
    expect(vet.ok, vet.output).toBe(true);
  });
});

describe("mapping diagnostics", () => {
  const cases: { name: string; options?: Record<string, unknown>; sources?: () => Record<string, string>; code: string; message: RegExp }[] = [
    { name: "vendored-runtime", options: { runtime: "vendor", "runtime-module": undefined }, code: "external-package", message: /uses the runtime example\.com\/shared\/tsgo; set 'runtime: import'/ },
    { name: "option-mismatch", options: { "unknown-properties": "reject" }, code: "external-package", message: /option 'unknown-properties' is 'reject' here but 'ignore'/ },
    { name: "derived-model", sources: () => ({ "main.tsp": consumer + '\nmodel Cat extends Shop.Common.Pet { kind: "cat"; }\n' }), code: "external-package", message: /'Shop\.Common\.Pet' differs from example\.com\/shared\.PetUnion/ },
    { name: "augment-decorator", sources: () => ({ "main.tsp": consumer + '\n@@doc(Shop.Common.Money, "Changed.");\n' }), code: "external-package", message: /'Shop\.Common\.Money' differs/ },
    { name: "changed-source", sources: () => ({ "common.tsp": common.replace("model Money { amount: decimal;", "model Money { amount: decimal; cents?: int32;") }), code: "external-package", message: /'Shop\.Common\.Money' differs/ },
    { name: "stale-contract", sources: () => ({ "common.tsp": common + "\nmodel Extra { x: string; }\n" }), code: "external-package", message: /'Shop\.Common\.Extra' is mapped to example\.com\/shared \(external 'Shop\.Common'\), which does not declare it/ },
    { name: "missing-contract", options: { external: { "Shop.Common": "does/not/exist" } }, code: "invalid-option", message: /cannot read the contract .*export-contract: true/ },
    { name: "self-mapping", options: { module: "example.com/shared" }, code: "invalid-option", message: /the contract is the package being generated/ },
    { name: "bad-key", options: { external: { "not a name": "x" } }, code: "invalid-option", message: /'external' keys are TypeSpec namespace or type names/ },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const r = await generateConsumer(`diag-${c.name}`, c.options, c.sources?.());
      const match = r.diagnostics.find((d) => d.code === `typespec-go/${c.code}` && c.message.test(d.message));
      expect(match, r.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBeDefined();
      expect(r.files.filter((f) => f.endsWith(".go")), "no output may be written").toEqual([]);
    });
  }

  it("different runtime version", async () => {
    const contract = JSON.parse(readFileSync(join(shared.dir, "typespec-go-contract.json"), "utf8"));
    const other = join(shared.dir, "..", "..", "other-runtime");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "typespec-go-contract.json"), JSON.stringify({ ...contract, runtimeHash: "0".repeat(32) }));
    const r = await generateConsumer("diag-runtime-version", { external: { "Shop.Common": other } });
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(/generated by a typespec-go version with a different runtime/);
    expect(r.files.filter((f) => f.endsWith(".go"))).toEqual([]);
  });
});
