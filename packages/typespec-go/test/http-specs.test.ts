/**
 * Official TypeSpec HTTP conformance (@typespec/http-specs).
 *
 * Categories are tracked separately (test/http-specs/results.json and docs/feature-matrix.md):
 *   implemented-passing   generated server passes every replayable scenario
 *   implemented-failing   generated server fails a scenario            → test failure
 *   rejected-unsupported  compilation fails closed with diagnostics    → must be listed in
 *                         expected-rejections.json with the missing feature; it is NOT support
 *   not-applicable        individual scenarios that do not apply to a server (reviewed reasons
 *                         in harness.ts; replacement tests in test/go/conformance-replacements)
 * A rejected spec that is not listed, or a listed spec that is no longer rejected, fails the
 * test so the matrix cannot drift from reality.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_TYPE_OVERRIDES, EXPECTED_FIELDS, NOT_APPLICABLE, scenarioQuery, listSpecs, runSpec, type SpecResult } from "./http-specs/harness.js";

const tmp = join(import.meta.dirname, ".tmp", "http-specs");
const expectedRejections: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dirname, "http-specs", "expected-rejections.json"), "utf8"));
const results: SpecResult[] = [];

function category(r: SpecResult): string {
  if (r.status === "rejected") return "rejected-unsupported";
  if (r.status === "failed") return "implemented-failing";
  if (r.status === "no-server") return "no-operations";
  return "implemented-passing";
}

describe("@typespec/http-specs", () => {
  mkdirSync(tmp, { recursive: true });
  for (const spec of listSpecs()) {
    it(spec, async () => {
      const r = await runSpec(spec, tmp);
      results.push(r);
      const failed = r.scenarios.filter((s) => s.status === "failed");
      expect(failed.map((f) => `${f.name}: ${f.detail}`), r.output?.slice(-3000)).toEqual([]);
      if (r.status === "rejected") {
        expect(expectedRejections[spec], `${spec} is rejected but not listed in expected-rejections.json:\n${r.diagnostics.join("\n")}`).toBeDefined();
        expect(r.diagnostics.length).toBeGreaterThan(0);
      } else {
        expect(r.status, r.output).toBe("passed");
        expect(r.scenarios.some(s => s.status === "passed"), spec).toBe(true);
        expect(expectedRejections[spec], `${spec} is no longer rejected; remove it from expected-rejections.json`).toBeUndefined();
      }
    });
  }
  afterAll(() => {
    // Recorded evidence covers complete runs only: a filtered run (-t) must not truncate it.
    if (results.length !== listSpecs().length || results.some(r => r.status !== "passed" && !(r.status === "rejected" && expectedRejections[r.spec]))) return;
    const rows = results
      .map(({ output, ...rest }) => ({ ...rest, category: category(rest as SpecResult), missingFeature: expectedRejections[rest.spec] }))
      .sort((a, b) => a.spec.localeCompare(b.spec));
    const passed = new Set(rows.flatMap(r => r.scenarios.filter(s => s.status === "passed").map(s => s.name)));
    for (const name of Object.keys(EXPECTED_FIELDS)) expect(passed.has(name), name).toBe(true);
    const cases = rows.flatMap(r => r.scenarios);
    expect(cases.filter(s => s.status === "skipped").map(s => s.name).sort()).toEqual(Object.keys(NOT_APPLICABLE).sort());
    expect(cases.filter(s => s.adjustment).map(s => s.name).sort()).toEqual([...Object.keys(CONTENT_TYPE_OVERRIDES), "Type_Model_Visibility_putReadOnlyModel"].sort());
    const scenarios = { passed: 0, failed: 0, notApplicable: 0 };
    for (const r of rows) for (const s of r.scenarios) s.status === "passed" ? scenarios.passed++ : s.status === "failed" ? scenarios.failed++ : scenarios.notApplicable++;
    const specs: Record<string, number> = {};
    for (const r of rows) specs[r.category] = (specs[r.category] ?? 0) + 1;
    writeFileSync(join(import.meta.dirname, "http-specs", "results.json"), JSON.stringify({ summary: { specs, scenarios }, specs: rows }, null, 2) + "\n");
  });
});

it("distinguishes CSV punctuation from commas in individual query members", () => {
  expect(scenarioQuery("ordinary", { "a,b": ["x,y", "z"] })).toBe("?a%2Cb=x%2Cy&a%2Cb=z");
  expect(scenarioQuery("Parameters_CollectionFormat_Query_csv", { colors: "blue,red,green", other: "x,y" }))
    .toBe("?colors=blue,red,green&other=x%2Cy");
  expect(() => scenarioQuery("Parameters_CollectionFormat_Query_csv", { colors: "different" })).toThrow(/review the upstream/);
});
