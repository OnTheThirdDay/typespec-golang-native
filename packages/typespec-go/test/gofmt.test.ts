/**
 * Every generated Go file is gofmt-clean: all test fixtures, the official HTTP specs, the example
 * and the multi-file layout fixture, in every file layout and in package configurations that
 * change the generated code (imported runtime, representation policies, contract export).
 * The vendored runtime is included. Regression: models.go of a service without models had
 * trailing blank lines after its package clause.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { expect, it } from "vitest";
import { generateGo } from "../src/emitter.js";

const repo = join(import.meta.dirname, "..", "..", "..");
const CONFIGS: Record<string, unknown>[] = [
  {},
  { "file-layout": "per-namespace" },
  { "file-layout": "per-source-file" },
  { runtime: "import", "runtime-module": "example.com/rt/tsgo", "optional-properties": "nullable", "unknown-properties": "reject" },
  { "response-unset-nullable": "null", "invisible-properties": "ignore", "integer-type": "int64", "export-contract": true, "file-layout": "per-namespace" },
];

// Adding null to an optional field is incompatible with these declared non-JSON media types.
const nullableRejections = new Map<string, string>([
  // The XML record property is optional. Adding explicit JSON null has no XML spelling here.
  ["packages/typespec-go/test/go/ordered", "XML: nullable properties have no XML representation"],
  ["packages/typespec-go/test/go/closed", "form field 'tags' has no text representation"],
  ["packages/typespec-go/test/go/server", "form field 'tags' has no text representation"],
  ["packages/typespec-go/test/go/sse-nested", "SSE: text events require a declared text codec"],
  ["node_modules/@typespec/http-specs/specs/payload/pageable", "XML: nullable properties have no XML representation"],
  ["node_modules/@typespec/http-specs/specs/payload/xml", "XML: nullable properties have no XML representation"],
]);

function specs(): string[] {
  const out: string[] = [];
  const go = join(import.meta.dirname, "go");
  for (const d of readdirSync(go)) if (existsSync(join(go, d, "main.tsp"))) out.push(join(go, d, "main.tsp"));
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === "main.tsp") out.push(join(dir, e.name));
    }
  };
  walk(join(repo, "node_modules", "@typespec", "http-specs", "specs"));
  out.push(join(repo, "examples", "widget-service", "main.tsp"), join(import.meta.dirname, "layout", "main.tsp"));
  return out;
}

it("generates gofmt-clean Go in every layout and configuration", async () => {
  const out = join(import.meta.dirname, ".tmp", "gofmt");
  rmSync(out, { recursive: true, force: true });
  let packages = 0;
  const entries = specs();
  for (const spec of entries) {
    const fixture = relative(repo, dirname(spec)).replaceAll("\\", "/");
    let program = await compile(NodeHost, spec, { noEmit: true });
    if (program.diagnostics.some(d => d.code === "union-extends-disabled")) {
      program = await compile(NodeHost, spec, { noEmit: true, configFile: { features: ["union-extends"] } } as any);
    }
    expect(program.diagnostics.filter(d => d.severity === "error").map(d => d.message), fixture).toEqual([]);
    for (const config of CONFIGS) {
      const r = await generateGo(program, { module: "example.com/gen", ...config } as any);
      const errors = r.diagnostics.filter(d => d.severity === "error");
      const reason = config["optional-properties"] === "nullable" && nullableRejections.get(fixture);
      if (reason) {
        expect([...new Set(errors.map(d => d.code))], fixture).toEqual(["typespec-go/unsupported-http"]);
        expect(errors.every(d => d.message.endsWith(reason)), fixture).toBe(true);
        expect(r.files.size, fixture).toBe(0);
        continue;
      }
      expect(errors.map(d => d.message), fixture).toEqual([]);
      expect(r.files.has("server.go") || [...r.files.keys()].some(f => f.startsWith("models") && f.endsWith(".go")), fixture).toBe(true);
      const dir = join(out, String(packages++));
      for (const [f, text] of r.files) {
        if (!f.endsWith(".go")) continue;
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), text);
      }
    }
  }
  expect(packages).toBe(entries.length * CONFIGS.length - nullableRejections.size);
  expect(execFileSync("gofmt", ["-l", out], { encoding: "utf8", maxBuffer: 1 << 26 }).trim()).toBe("");
});
