/** End-to-end example: compile examples/widget-service with its tspconfig.yaml, then build and test the Go program. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost, resolveCompilerOptions } from "@typespec/compiler";
import { describe, expect, it } from "vitest";
import { runGo } from "../src/testing/index.js";

const example = join(import.meta.dirname, "..", "..", "..", "examples", "widget-service");

describe("examples/widget-service", () => {
  it("generates, builds and passes its tests", async () => {
    rmSync(join(example, "api"), { recursive: true, force: true });
    rmSync(join(example, "schemas"), { recursive: true, force: true });
    const [options, diags] = await resolveCompilerOptions(NodeHost, { entrypoint: join(example, "main.tsp"), cwd: example });
    expect(diags).toEqual([]);
    const program = await compile(NodeHost, join(example, "main.tsp"), options);
    expect(program.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const schema = JSON.parse(readFileSync(join(example, "schemas", "WidgetSuggestion.json"), "utf8"));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["name", "color", "weight_grams", "confidence"]);
    expect(existsSync(join(example, "api", "server.go"))).toBe(true);
    const vet = runGo(example, ["vet", "./..."]);
    expect(vet.ok, vet.output).toBe(true);
    const test = runGo(example, ["test", "-count=1", "./..."]);
    expect(test.ok, test.output).toBe(true);
  });
});
