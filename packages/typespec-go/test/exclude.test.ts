/**
 * Option `exclude`: declarations that other emitters use but Go does not generate. Excluding a
 * declaration that generated Go code still references is an error (never an unresolved name).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { generateGoPackage, gofmtList, runGo } from "../src/testing/index.js";

const SPEC = `import "@typespec/http";
import "typespec-structured-output";
using Http;
using StructuredOutput;

namespace Prompts {
  /** Only used for Structured Outputs. */
  @structuredOutput model Suggestion { text: string; detail: { score: float64 }; }
  model Scratch { note: string; }
}

@service namespace Api {
  model Item { id: string; tags?: string[]; }
  /** Internal bookkeeping model, not part of the Go API. */
  model Audit { at: utcDateTime; who: { name: string }; }
  @route("/items") op read(): Item;
}
`;

describe("exclude", () => {
  it("omits excluded declarations from Go while other emitters still use them", async () => {
    const root = join(import.meta.dirname, ".tmp", "exclude-both");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "main.tsp"), SPEC);
    const program = await compile(NodeHost, join(root, "main.tsp"), {
      outputDir: join(root, "out"),
      emit: ["typespec-go", "typespec-structured-output"],
      options: {
        "typespec-go": { module: "example.com/gen", "emit-go-mod": true, exclude: ["Prompts", "Api.Audit"], "export-contract": true },
        "typespec-structured-output": { "emit-all-models": true, "target-profile": "none", "optional-properties": "nullable" },
      },
    });
    expect(program.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const go = join(root, "out", "typespec-go");
    const models = readFileSync(join(go, "models.go"), "utf8");
    expect([...models.matchAll(/^type (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["Item"]);
    // Anonymous members of excluded declarations go with them.
    expect(models).not.toMatch(/Detail|Who/);
    const contract = JSON.parse(readFileSync(join(go, "typespec-go-contract.json"), "utf8"));
    expect(Object.keys(contract.decls)).toEqual(["Api.Item"]);
    expect(gofmtList(go)).toBe("");
    const vet = runGo(go, ["vet", "./..."]);
    expect(vet.ok, vet.output).toBe(true);
    // The Structured Output emitter still sees every declaration.
    const so = join(root, "out", "typespec-structured-output");
    for (const f of ["Suggestion.json", "Scratch.json", "Audit.json", "Item.json"]) expect(existsSync(join(so, f)), f).toBe(true);
  });

  for (const [name, exclude, message] of [
    ["used-by-model", ["Api.Item"], /'Api\.Item' is excluded from Go generation .* an HTTP operation uses it/],
    ["used-by-operation", ["Api"], /is excluded from Go generation .* uses it/],
  ] as const) {
    it(`rejects exclusions that generated code still references (${name})`, async () => {
      const r = await generateGoPackage(SPEC.replace('import "typespec-structured-output";\n', "").replace("using StructuredOutput;\n", "").replace("@structuredOutput ", ""), `exclude-${name}`, { exclude: [...exclude] });
      const d = r.diagnostics.find((x) => x.code === "typespec-go/excluded-declaration");
      expect(d?.message, r.diagnostics.map((x) => x.message).join("\n")).toMatch(message);
      expect(r.files.filter((f) => f.endsWith(".go"))).toEqual([]);
    });
  }

  it("rejects references from generated models", async () => {
    const code = `model Kept { dep: Dropped; } model Dropped { a: string; }`;
    const r = await generateGoPackage(code, "exclude-model-ref", { exclude: ["Dropped"] });
    expect(r.diagnostics.map((x) => x.message).join("\n")).toMatch(/'Dropped' is excluded from Go generation .* 'Kept' uses it/);
    expect(r.files.filter((f) => f.endsWith(".go"))).toEqual([]);
  });

  it("rejects names that match nothing or are not names", async () => {
    const r = await generateGoPackage(`model M { a: string; }`, "exclude-unknown", { exclude: ["Nowhere", "not a name"] });
    const messages = r.diagnostics.map((x) => x.message).join("\n");
    expect(messages).toMatch(/'exclude' names 'Nowhere', which matches no declaration/);
    expect(messages).toMatch(/'exclude' entries are TypeSpec namespace or type names/);
  });
});
