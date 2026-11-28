/**
 * The `file-layout` option: every layout yields the same Go package (public API, declarations,
 * server, behaviour); file names are deterministic and portable; stale files are removed when
 * declarations or the layout change; a change to one declaration leaves unrelated files alone.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { fileNames } from "../src/layout.js";
import { generateGoPackage, gofmtList, runGo } from "../src/testing/index.js";

const LAYOUTS = ["single", "per-namespace", "per-source-file"] as const;
type Layout = (typeof LAYOUTS)[number];

const fixtureDir = join(import.meta.dirname, "layout");
const fixture = Object.fromEntries(
  readdirSync(fixtureDir, { recursive: true }).map(String).filter((f) => f.endsWith(".tsp")).map((f) => [f.replaceAll("\\", "/"), readFileSync(join(fixtureDir, f), "utf8")]),
);

/** Generated Go sources of the package (vendored runtime excluded). */
function goSources(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".go")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

/** Top-level declarations of all model files, independent of the file they are written in. */
function declarations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    if (!name.startsWith("models")) continue;
    const body = text.replace(/^[\s\S]*?\npackage \w+\n(?:\nimport \([\s\S]*?\n\)\n)?/, "");
    out.push(...body.split(/\n\n(?=\S)/).map((s) => s.trim()).filter(Boolean));
  }
  return out.sort();
}

function goDoc(dir: string): string {
  const r = runGo(dir, ["doc", "-all", "."]);
  expect(r.ok, r.output).toBe(true);
  return r.output;
}

async function generate(code: string | Record<string, string>, name: string, layout: Layout) {
  const r = await generateGoPackage(code, name, { "file-layout": layout });
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return r;
}

describe("file layouts of a multi-file specification", () => {
  const results = new Map<Layout, { dir: string; files: Record<string, string> }>();

  it.each(LAYOUTS)("%s: compiles, vets and passes the behaviour tests", async (layout) => {
    const r = await generate(fixture, `layout-${layout}`, layout);
    expect(gofmtList(r.dir)).toBe("");
    results.set(layout, { dir: r.dir, files: goSources(r.dir) });
    cpSync(join(fixtureDir, "layout_test.go"), join(r.dir, "layout_test.go"));
    const vet = runGo(r.dir, ["vet", "./..."]);
    expect(vet.ok, vet.output).toBe(true);
    const test = runGo(r.dir, ["test", "-count=1", "."]);
    expect(test.ok, test.output).toBe(true);
    rmSync(join(r.dir, "layout_test.go"));
  });

  it("writes the expected files", () => {
    expect(Object.keys(results.get("single")!.files)).toEqual(["models.go", "server.go"]);
    expect(Object.keys(results.get("per-namespace")!.files)).toEqual([
      "models.go", // global namespace and pattern variables
      "models.shop.builds.go",
      "models.shop.catalog.go", // namespace declared in two files
      "models.shop.common.go",
      "models.shop.con.go",
      "models.shop.foo_bar.go", // Shop.FooBar
      "models.shop.foo_bar_2.go", // Shop.Foo_Bar
      "models.shop.go",
      "models.shop.js.go",
      "models.shop.linux_amd64.go",
      "models.shop.orders.archive.go",
      "models.shop.orders.go",
      "models.shop.tests_test_.go",
      "models.shop.windows_amd64.go",
      "server.go",
    ]);
    expect(Object.keys(results.get("per-source-file")!.files)).toEqual([
      "models.build_linux.go",
      "models.catalog.product_variants.go",
      "models.catalog.products.go",
      "models.common.paging.go",
      "models.common.scalars.go",
      "models.devices.go", // namespace Shop.Con
      "models.global.go",
      "models.go",
      "models.main.go",
      "models.orders.go",
      "models.x_test_.go",
      "server.go",
    ]);
  });

  it("places anonymous, synthetic and generic declarations with their owners", () => {
    const types = (files: Record<string, string>, file: string) => [...files[file].matchAll(/^type (\w+)/gm)].map((m) => m[1]);
    const ns = results.get("per-namespace")!.files;
    // Visibility and merge-patch variants, anonymous members, closed-model unions, aliases and
    // instances of library templates (OmitProperties) are written with the declaring model.
    expect(types(ns, "models.shop.catalog.go")).toEqual(expect.arrayContaining(["Product", "ProductCreate", "ProductUpdateMergePatch", "ProductKind", "ProductDimensions", "VariantsItemsItem", "OfferShipping", "OmitPropertiesProductID", "MediaUnion"]));
    // Template instances and their anonymous members live with their first project-declared
    // argument, else with the template declaration.
    expect(types(ns, "models.shop.common.go")).toEqual(["CurrencyCode", "Money", "MoneyMergePatch", "PageString", "PageStringMeta", "Problem", "ProblemCode", "Slug", "Status"]);
    expect(types(ns, "models.shop.catalog.go")).toEqual(expect.arrayContaining(["ProductPage", "ProductPageMeta"]));
    expect(types(ns, "models.shop.orders.go")).toEqual(["Line", "OrderList", "OrderStatus", "PageOrder", "PageOrderMeta", "ShopOrdersOrder"]);
    // Request bodies synthesized from operation parameters live with the operation.
    expect(types(ns, "models.shop.go")).toEqual(["PlaceOrderRequestBody"]);
    expect(types(ns, "models.go")).toEqual(["GlobalSetting"]);
    expect(ns["models.go"]).toMatch(/^\tpattern[0-9a-f]{8} = tsgo.CompilePattern/m);
    const files = results.get("per-source-file")!.files;
    expect(types(files, "models.catalog.product_variants.go")).toEqual(expect.arrayContaining(["ColorVariant", "SizeVariant", "SizeVariantSize", "Variants", "VariantsItemsItem", "Offer", "OfferShipping", "OfferShippingObject"]));
    expect(types(files, "models.catalog.products.go")).toEqual(expect.arrayContaining(["Product", "ProductCreate", "ProductPage", "ProductPageMeta", "Media", "MediaUnion"]));
  });

  it("generates the same package in every layout", () => {
    const single = results.get("single")!;
    const docs = goDoc(single.dir);
    for (const layout of LAYOUTS) {
      const r = results.get(layout)!;
      expect(r.files["server.go"]).toBe(single.files["server.go"]);
      expect(declarations(r.files)).toEqual(declarations(single.files));
      expect(goDoc(r.dir)).toBe(docs);
    }
  });

  it("is deterministic", async () => {
    for (const layout of ["per-namespace", "per-source-file"] as const) {
      const again = await generate(fixture, `layout-${layout}-again`, layout);
      expect(goSources(again.dir)).toEqual(results.get(layout)!.files);
    }
  });
});

describe("stale outputs", () => {
  it("removes the files of previous layouts and of removed declarations", async () => {
    const root = join(import.meta.dirname, ".tmp", "layout-stale");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const out = join(root, "out", "typespec-go");
    const run = async (sources: Record<string, string>, layout: Layout) => {
      for (const [path, text] of Object.entries(sources)) writeFileSync(join(root, path), text);
      const p = await compile(NodeHost, join(root, "main.tsp"), { outputDir: join(root, "out"), emit: ["typespec-go"], options: { "typespec-go": { module: "example.com/gen", "file-layout": layout } } });
      expect(p.diagnostics.map((d) => d.message)).toEqual([]);
      return readdirSync(out).filter((f) => f.endsWith(".go")).sort();
    };
    const two = { "main.tsp": 'import "./b.tsp";\nnamespace A { model X { x: string; } }\n', "b.tsp": "namespace B { model Y { y: string; } }\n" };
    expect(await run(two, "per-namespace")).toEqual(["models.a.go", "models.b.go"]);
    writeFileSync(join(out, "handwritten.go"), "package gen\n");
    expect(await run(two, "per-source-file")).toEqual(["handwritten.go", "models.b.go", "models.main.go"]);
    expect(await run({ ...two, "main.tsp": 'import "./b.tsp";\n', "b.tsp": "namespace B { model Y { y: string; } }\n" }, "per-source-file")).toEqual(["handwritten.go", "models.b.go"]);
    expect(await run({ ...two, "b.tsp": "" }, "per-namespace")).toEqual(["handwritten.go", "models.a.go"]);
    expect(await run(two, "single")).toEqual(["handwritten.go", "models.go"]);
    // A failing compilation removes every generated file and writes nothing.
    writeFileSync(join(root, "main.tsp"), 'import "./b.tsp";\nnamespace A { model X { @pattern("(?=x)") x: string; } }\n');
    const p = await compile(NodeHost, join(root, "main.tsp"), { outputDir: join(root, "out"), emit: ["typespec-go"], options: { "typespec-go": { module: "example.com/gen", "file-layout": "per-namespace" } } });
    expect(p.diagnostics.some((d) => d.code === "typespec-go/unsupported-pattern")).toBe(true);
    expect(readdirSync(out).filter((f) => f.endsWith(".go"))).toEqual(["handwritten.go"]);
    expect(existsSync(join(out, "tsgo"))).toBe(true); // directory left, files removed
    expect(readdirSync(join(out, "tsgo")).filter((f) => f.endsWith(".go"))).toEqual([]);
  });
});

describe("large multi-file specification", () => {
  const FILES = 24;
  const MODELS = 25;
  /** FILES files over 8 namespaces (three files each), with cross-file references, anonymous
   * members, literal unions, patterns, visibility variants and one operation per file. */
  function spec(edit?: (file: number, model: number) => string | undefined): Record<string, string> {
    const files: Record<string, string> = {};
    const ops: string[] = [];
    for (let f = 0; f < FILES; f++) {
      const ns = `Big.Area${f % 8}`;
      const lines = [`namespace ${ns};`];
      for (let m = 0; m < MODELS; m++) {
        const prev = f === 0 ? "" : `ref?: Big.Area${(f - 1) % 8}.M${f - 1}_${m};`;
        const pattern = m % 10 === 0 ? `@pattern("^[a-z]{${(f % 5) + 1}}$") code: string;` : "";
        lines.push(`model M${f}_${m} { @visibility(Lifecycle.Read) id: string; n: int32; ${prev} status: "on" | "off"; meta?: { at: utcDateTime; tags?: string[] }; ${pattern} ${edit?.(f, m) ?? ""} }`);
      }
      files[`area${f}/models_${f}.tsp`] = lines.join("\n") + "\n";
      ops.push(`@route("/m${f}") @post op create${f}(@body body: Big.Area${f % 8}.M${f}_0): Big.Area${f % 8}.M${f}_0;`);
    }
    files["main.tsp"] = ['import "@typespec/http";', ...Object.keys(files).map((p) => `import "./${p}";`), "using Http;", "@service namespace Big;", ...ops].join("\n") + "\n";
    return files;
  }

  it("generates equivalent packages and confines changes to the affected file", async () => {
    const base = spec();
    const runs = new Map<Layout, { dir: string; files: Record<string, string> }>();
    for (const layout of LAYOUTS) {
      const r = await generate(base, `layout-big-${layout}`, layout);
      expect(gofmtList(r.dir)).toBe("");
      const vet = runGo(r.dir, ["vet", "."]);
      expect(vet.ok, vet.output).toBe(true);
      runs.set(layout, { dir: r.dir, files: goSources(r.dir) });
    }
    const single = runs.get("single")!;
    expect(single.files["models.go"].split("\n").length).toBeGreaterThan(40_000);
    expect(Object.keys(runs.get("per-namespace")!.files).length).toBe(8 + 2); // + shared, server
    expect(Object.keys(runs.get("per-source-file")!.files).length).toBe(FILES + 2);
    const docs = goDoc(single.dir);
    for (const layout of LAYOUTS) {
      expect(declarations(runs.get(layout)!.files)).toEqual(declarations(single.files));
      expect(goDoc(runs.get(layout)!.dir)).toBe(docs);
    }

    const changed = (a: Record<string, string>, b: Record<string, string>) =>
      [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
    // A new property in one model changes only the file of that model.
    const edited = spec((f, m) => (f === 13 && m === 4 ? "extra?: { note: string };" : undefined));
    // A new pattern changes that file and the shared file holding the pattern variables.
    const patterned = spec((f, m) => (f === 13 && m === 4 ? '@pattern("^new$") fresh: string;' : undefined));
    const expected: Record<Layout, [string[], string[]]> = {
      single: [["models.go"], ["models.go"]],
      "per-namespace": [["models.big.area5.go"], ["models.big.area5.go", "models.go"]],
      "per-source-file": [["models.area13.models_13.go"], ["models.area13.models_13.go", "models.go"]],
    };
    for (const layout of LAYOUTS) {
      const a = await generate(edited, `layout-big-${layout}-edit`, layout);
      expect(changed(runs.get(layout)!.files, goSources(a.dir))).toEqual(expected[layout][0]);
      const b = await generate(patterned, `layout-big-${layout}-pattern`, layout);
      expect(changed(runs.get(layout)!.files, goSources(b.dir))).toEqual(expected[layout][1]);
    }
  });
});

describe("file names", () => {
  it("are portable Go source names without build constraints", () => {
    const ns = fileNames(["Contoso.WidgetManager", "Contoso.HTTPServer.V2Beta", "Foo_Bar", "FooBar", "FOO_BAR", "Linux", "X_windows", "X_amd64", "Pkg_test", "Con", "`odd-name`.Ünïcode"], "per-namespace");
    expect(Object.fromEntries(ns)).toEqual({
      "Contoso.WidgetManager": "models.contoso.widget_manager.go",
      "Contoso.HTTPServer.V2Beta": "models.contoso.http_server.v2_beta.go",
      FOO_BAR: "models.foo_bar.go",
      FooBar: "models.foo_bar_2.go",
      Foo_Bar: "models.foo_bar_3.go",
      Linux: "models.linux.go",
      X_windows: "models.x_windows.go",
      X_amd64: "models.x_amd64.go",
      Pkg_test: "models.pkg_test_.go",
      Con: "models.con.go",
      "`odd-name`.Ünïcode": "models.odd_name.n_code.go",
    });
    const files = fileNames(["main.tsp", "sub/Dir/My-File.tsp", "../shared/x.tsp", "a_test.tsp", "UPPER.TSP", "upper.tsp", `${"deep/".repeat(40)}x.tsp`], "per-source-file");
    expect(files.get("sub/Dir/My-File.tsp")).toBe("models.sub.dir.my_file.go");
    expect(files.get("../shared/x.tsp")).toBe("models.up.shared.x.go");
    expect(files.get("a_test.tsp")).toBe("models.a_test_.go");
    expect([files.get("UPPER.TSP"), files.get("upper.tsp")]).toEqual(["models.upper.go", "models.upper_2.go"]);
    for (const name of [...ns.values(), ...files.values()]) {
      expect(name).toMatch(/^models(?:\.[a-z0-9_]+)+\.go$/); // the manifest accepts exactly these
      expect(name).not.toMatch(/_test\.go$/);
      expect(name.length).toBeLessThanOrEqual(140);
    }
    expect(new Set([...files.values()]).size).toBe(files.size);
  });
});
