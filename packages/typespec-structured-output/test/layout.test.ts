/**
 * Option file-layout: root schemas organized by namespace or source file. Every layout writes
 * byte-identical schema files (each self-contained with its own $defs); only directories differ.
 * Paths are deterministic and portable; stale files and emptied directories are removed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { directoryNames } from "../src/layout.js";
import { emitStructuredOutput } from "../src/testing/index.js";

const H = `import "typespec-structured-output";\nusing StructuredOutput;\n`;
const sources: Record<string, string> = {
  "main.tsp": `import "./catalog/products.tsp";\nimport "./catalog/offers.tsp";\nimport "./misc.tsp";\n${H}/** Outside any namespace. */\n@structuredOutput model Settings { verbose: boolean; }\n`,
  "catalog/products.tsp": `${H}namespace Shop.Catalog;\nmodel Money { amount: float64; currency: string; }\n@structuredOutput model Product { name: string; price: Money; parts: Part[]; }\nmodel Part { name: string; sub: Part[]; }\n`,
  "catalog/offers.tsp": `${H}namespace Shop.Catalog;\n@structuredOutput model Offer { product: Product; discount: Money; }\n`,
  "misc.tsp": `${H}namespace Shop.FooBar { @structuredOutput model A { a: string; } }\nnamespace Shop.Foo_Bar { @structuredOutput model B { b: string; } }\nnamespace Con { @structuredOutput model Device { id: string; } }\n`,
};
const LAYOUTS = ["single", "per-namespace", "per-source-file"] as const;

function rawFiles(outDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(outDir)) return out;
  for (const f of readdirSync(outDir, { recursive: true }).map((x) => String(x).replaceAll("\\", "/")).sort()) {
    if (f.endsWith(".json") && !f.startsWith(".")) out[f] = readFileSync(join(outDir, f), "utf8");
  }
  return out;
}

describe("file layouts", () => {
  const byLayout = new Map<string, Record<string, string>>();

  it.each(LAYOUTS)("%s", async (layout) => {
    const r = await emitStructuredOutput(sources, { "file-layout": layout }, `layout-${layout}`);
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    byLayout.set(layout, rawFiles(join(import.meta.dirname, ".tmp", `layout-${layout}`, "out", "typespec-structured-output")));
  });

  it("writes the expected paths", () => {
    expect(Object.keys(byLayout.get("single")!)).toEqual(["A.json", "B.json", "Device.json", "Offer.json", "Product.json", "Settings.json"]);
    expect(Object.keys(byLayout.get("per-namespace")!)).toEqual([
      "Settings.json", // global namespace
      "con_/Device.json", // Windows device name
      "shop/catalog/Offer.json", // namespace declared in two files
      "shop/catalog/Product.json",
      "shop/foo_bar/A.json", // Shop.FooBar
      "shop/foo_bar_2/B.json", // Shop.Foo_Bar: normalizes to the same directory
    ]);
    expect(Object.keys(byLayout.get("per-source-file")!)).toEqual([
      "catalog/offers/Offer.json",
      "catalog/products/Product.json",
      "main/Settings.json",
      "misc/A.json",
      "misc/B.json",
      "misc/Device.json",
    ]);
  });

  it("writes identical, self-contained schemas in every layout", () => {
    const base = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k.split("/").pop(), v]));
    const single = byLayout.get("single")!;
    for (const layout of LAYOUTS) expect(base(byLayout.get(layout)!)).toEqual(single);
    // Each file carries its own $defs (Money and the recursive Part in both Product and Offer).
    for (const f of ["Product.json", "Offer.json"]) expect(Object.keys(JSON.parse(single[f]).$defs).sort()).toEqual(["Money", "Part", ...(f === "Offer.json" ? ["Product"] : [])].sort());
  });

  it("bounds directory components and diagnoses oversized root file names", async () => {
    const long = "A".repeat(280);
    const generated = await emitStructuredOutput(`${H}namespace ${long} { @structuredOutput model R { ok: boolean; } }`,
      { "file-layout": "per-namespace" }, "long-directory");
    expect(generated.diagnostics.map(d => d.message)).toEqual([]);
    expect(Object.keys(generated.files)).toMatchObject([expect.stringMatching(/^[a-z_0-9]{120}\/R\.json$/)]);
    const invalid = await emitStructuredOutput(`${H}@structuredOutput("${"名".repeat(85)}") model R { ok: boolean; }`,
      { "target-profile": "none" }, "long-root");
    expect(invalid.diagnostics.map(d => d.code)).toContain("typespec-structured-output/invalid-root");
    expect(invalid.files).toEqual({});
  });

  it("is deterministic", async () => {
    for (const layout of ["per-namespace", "per-source-file"] as const) {
      await emitStructuredOutput(sources, { "file-layout": layout }, `layout-${layout}-again`);
      expect(rawFiles(join(import.meta.dirname, ".tmp", `layout-${layout}-again`, "out", "typespec-structured-output"))).toEqual(byLayout.get(layout));
    }
  });

  it("names portable, collision-free directories", () => {
    const ns = directoryNames(["Contoso.WidgetManager", "A.Nul", "FOO", "Foo", "foo"], "per-namespace");
    expect(Object.fromEntries(ns)).toEqual({ "A.Nul": "a/nul_", "Contoso.WidgetManager": "contoso/widget_manager", FOO: "foo", Foo: "foo_2", foo: "foo_3" });
    const files = directoryNames(["../shared/x.tsp", "sub/My File.tsp", "LPT1.tsp"], "per-source-file");
    expect(Object.fromEntries(files)).toEqual({ "../shared/x.tsp": "up/shared/x", "sub/My File.tsp": "sub/my_file", "LPT1.tsp": "lpt1_" });
  });
});

describe("stale outputs across layouts", () => {
  it("removes moved and removed roots, previous layouts and emptied directories", async () => {
    const root = join(import.meta.dirname, ".tmp", "layout-stale");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const out = join(root, "out", "typespec-structured-output");
    const run = async (main: string, layout: string) => {
      writeFileSync(join(root, "main.tsp"), main);
      const p = await compile(NodeHost, join(root, "main.tsp"), { outputDir: join(root, "out"), emit: ["typespec-structured-output"], options: { "typespec-structured-output": { "file-layout": layout } } });
      expect(p.diagnostics.map((d) => d.message)).toEqual([]);
      return Object.keys(rawFiles(out));
    };
    const two = `${H}namespace A { @structuredOutput model X { x: string; } }\nnamespace B.C { @structuredOutput model Y { y: string; } }\n`;
    expect(await run(two, "per-namespace")).toEqual(["a/X.json", "b/c/Y.json"]);
    // Y moves to namespace A: its old file and the emptied b/c and b directories disappear.
    expect(await run(`${H}namespace A { @structuredOutput model X { x: string; } @structuredOutput model Y { y: string; } }\n`, "per-namespace")).toEqual(["a/X.json", "a/Y.json"]);
    expect(existsSync(join(out, "b"))).toBe(false);
    // A file written by someone else keeps its directory.
    writeFileSync(join(out, "a", "notes.txt"), "kept");
    expect(await run(two, "single")).toEqual(["X.json", "Y.json"]);
    expect(readFileSync(join(out, "a", "notes.txt"), "utf8")).toBe("kept");
    mkdirSync(join(out, "X.jso"));
    expect(await run(`${H}namespace A { @structuredOutput model X { x: string; } }\n`, "per-source-file")).toEqual(["main/X.json"]);
    expect(existsSync(join(out, "Y.json"))).toBe(false);
    expect(existsSync(join(out, "X.jso"))).toBe(true);
    // A failing compilation removes every schema and the emptied directories.
    writeFileSync(join(root, "main.tsp"), `${H}namespace A { @structuredOutput model X { x?: string; } }\n`);
    await compile(NodeHost, join(root, "main.tsp"), { outputDir: join(root, "out"), emit: ["typespec-structured-output"], options: { "typespec-structured-output": { "file-layout": "per-source-file" } } });
    expect(Object.keys(rawFiles(out))).toEqual([]);
    expect(existsSync(join(out, "main"))).toBe(false);
  });
});
