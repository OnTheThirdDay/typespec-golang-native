/**
 * Generated-Go tests: each test/go/<case>/ holds main.tsp and hand-written *_test.go files that
 * exercise the generated package's runtime behaviour. The harness generates the package,
 * checks gofmt and go vet, and runs go test.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addGoFiles, generateGoPackage, gofmtList, runGo } from "../src/testing/index.js";

const root = join(import.meta.dirname, "go");

describe("generated Go packages", () => {
  const cases = readdirSync(root).filter(c => existsSync(join(root, c, "main.tsp"))).map(c => ({name: c, fixture: c, options: {} as Record<string, unknown>}));
  cases.push({name: "wire-objects-nullable", fixture: "wire-objects", options: {"optional-properties": "nullable"}});
  for (const c of cases) {
    const dir = join(root, c.fixture);
    it(c.name, async () => {
      const defaults = existsSync(join(dir, "options.json")) ? JSON.parse(readFileSync(join(dir, "options.json"), "utf8")) : {};
      const options = { ...defaults, ...c.options };
      const r = await generateGoPackage(readFileSync(join(dir, "main.tsp"), "utf8"), `go-${c.name}`, options);
      expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
      expect(gofmtList(r.dir)).toBe("");
      addGoFiles(dir, r.dir);
      const vet = runGo(r.dir, ["vet", "./..."]);
      expect(vet.ok, vet.output).toBe(true);
      const test = runGo(r.dir, ["test", "-count=1", "./..."]);
      expect(test.ok, test.output).toBe(true);
    });
  }
});
