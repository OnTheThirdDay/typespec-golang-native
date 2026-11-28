// Executable reuse assessment: emits each structured-output fixture with the official
// @typespec/json-schema emitter and diffs it against the Pydantic + OpenAI SDK reference.
// Usage: node experiments/json-schema-reuse/compare.mjs [case]
import { compile, NodeHost } from "@typespec/compiler";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const fixtures = join(root, "packages/typespec-structured-output/test/fixtures");
const work = join(root, "experiments/json-schema-reuse/.work");
const only = process.argv[2];
// The nine cases evaluated in docs/reuse-assessment.md (fixtures added later are not part of it).
const CASES = ["constraints", "enums-literals", "generics", "inheritance-defaults", "nested-docs", "optional-nullable", "primitives", "recursive", "unions"];

function diffs(a, b, path = "$", out = []) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of ka) if (!(k in b)) out.push(`${path}.${k}: only in official = ${JSON.stringify(a[k]).slice(0, 80)}`);
    for (const k of kb) if (!(k in a)) out.push(`${path}.${k}: only in reference = ${JSON.stringify(b[k]).slice(0, 80)}`);
    const common = ka.filter((k) => k in b);
    const commonB = kb.filter((k) => k in a);
    if (common.join() !== commonB.join()) out.push(`${path}: key order [${common}] vs [${commonB}]`);
    for (const k of common) diffs(a[k], b[k], `${path}.${k}`, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffs(a[i], b[i], `${path}[${i}]`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return out;
}

let total = 0;
for (const c of readdirSync(fixtures)) {
  if (only ? c !== only : !CASES.includes(c)) continue;
  const ref = JSON.parse(readFileSync(join(fixtures, c, "reference.json"), "utf8"));
  const src = readFileSync(join(fixtures, c, "main.tsp"), "utf8")
    .replace('import "typespec-structured-output";', 'import "@typespec/json-schema";')
    .replace("using StructuredOutput;", "using JsonSchema;")
    .replace(/@structuredOutput\b/g, "");
  const dir = join(work, c);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tsp"), src);
  const program = await compile(NodeHost, join(dir, "main.tsp"), {
    outputDir: join(dir, "out"),
    emit: ["@typespec/json-schema"],
    options: { "@typespec/json-schema": { emitAllModels: true, bundleId: "bundle.json", "file-type": "json", "int64-strategy": "number" } },
  });
  for (const d of program.diagnostics) console.log(`  [${c}] diag ${d.code}: ${d.message}`);
  const bundle = JSON.parse(readFileSync(join(dir, "out/@typespec/json-schema/bundle.json"), "utf8"));
  for (const [name, r] of Object.entries(ref.roots)) {
    const official = bundle.$defs[name];
    const d = diffs(official, r.pydantic);
    total += d.length;
    console.log(`\n=== ${c} / ${name}: ${d.length} differences vs Pydantic model_json_schema()`);
    for (const line of d) console.log("  " + line);
  }
}
console.log(`\nTOTAL differences: ${total}`);
