/**
 * Pydantic differential / golden tests. Every fixture directory holds:
 *   main.tsp                 TypeSpec declaration (the emitter input)
 *   model.py                 the equivalent Pydantic declaration (reference input)
 *   reference.json           committed output of tools/pydantic-reference/generate.py
 *   options.json             (optional) emitter options
 *   expected-diagnostics.json (optional) negative case: expected diagnostic codes
 * The emitter output must be *structurally identical, including key order* to the reference.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitStructuredOutput } from "../src/testing/index.js";
import { orderedDiff, parseJson, type Json, type JsonObject } from "../src/json.js";

const root = join(import.meta.dirname, "fixtures");
const cases = readdirSync(root).filter((c) => existsSync(join(root, c, "main.tsp")));

describe("pydantic reference fixtures", () => {
  for (const c of cases) {
    const dir = join(root, c);
    const code = readFileSync(join(dir, "main.tsp"), "utf8");
    const options = existsSync(join(dir, "options.json")) ? JSON.parse(readFileSync(join(dir, "options.json"), "utf8")) : {};
    const expectedDiags = existsSync(join(dir, "expected-diagnostics.json"))
      ? (JSON.parse(readFileSync(join(dir, "expected-diagnostics.json"), "utf8")) as { code: string; severity?: string }[])
      : undefined;
    const reference = existsSync(join(dir, "reference.json"))
      ? (parseJson(readFileSync(join(dir, "reference.json"), "utf8")) as JsonObject)
      : undefined;

    if (expectedDiags) {
      it(`${c}: reports diagnostics and emits nothing`, async () => {
        const { diagnostics, files } = await emitStructuredOutput(code, options, `fx-${c}`);
        const codes = diagnostics.map((d) => d.code.replace(/^typespec-structured-output\//, ""));
        for (const e of expectedDiags) expect(codes).toContain(e.code);
        if (expectedDiags.some((e) => (e.severity ?? "error") === "error")) expect(Object.keys(files)).toEqual([]);
      });
      continue;
    }
    if (!reference) throw new Error(`${c}: expected a committed Python reference or expected-diagnostics.json`);
    const roots = reference.roots as Record<string, JsonObject>;
    for (const mode of ["strict", "pydantic"] as const) {
      it(`${c}: ${mode} schema equals reference`, async () => {
        const { diagnostics, files } = await emitStructuredOutput(
          code,
          { "target-profile": mode === "strict" ? options["target-profile"] ?? "openai" : "none", ...options, "schema-mode": mode },
          `fx-${c}-${mode}`,
        );
        expect(diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
        expect(Object.keys(files).sort()).toEqual(Object.keys(roots).map(name => `${name}.json`).sort());
        for (const [name, r] of Object.entries(roots)) {
          const actual = files[`${name}.json`];
          expect(actual, `missing ${name}.json; got ${Object.keys(files)}`).toBeDefined();
          const diff = orderedDiff(actual as Json, r[mode]);
          expect(diff, diff).toBeUndefined();
        }
      });
    }
  }
});
