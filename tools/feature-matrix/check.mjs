// Validates docs/feature-matrix.json and renders docs/feature-matrix.md.
//  - every supported/restricted entry must reference at least one test ("path#needle")
//  - every referenced file must exist and contain the needle
//  - references into the HTTP conformance results must name a spec that is implemented-passing
// Usage: node tools/feature-matrix/check.mjs [--write]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const matrix = JSON.parse(readFileSync(join(root, "docs/feature-matrix.json"), "utf8"));
const results = JSON.parse(readFileSync(join(root, "packages/typespec-go/test/http-specs/results.json"), "utf8"));
const errors = [];
const statuses = new Set(["supported", "restricted", "unsupported", "not-applicable"]);
const ids = new Set();
for (const f of matrix.features) {
  if (!f.id || ids.has(f.id)) errors.push(`missing or duplicate feature id '${f.id}'`);
  ids.add(f.id);
  for (const side of ["go", "so"]) {
    const e = f[side];
    if (!e) {
      errors.push(`${f.id}: missing ${side}`);
      continue;
    }
    if (!statuses.has(e.status)) errors.push(`${f.id}/${side}: unknown status ${e.status}`);
    if (["supported", "restricted", "unsupported"].includes(e.status) && !(e.tests?.length)) errors.push(`${f.id}/${side}: ${e.status} without tests`);
    for (const ref of e.tests ?? []) {
      const [path, needle] = ref.split("#");
      const file = join(root, path);
      if (!existsSync(file)) {
        errors.push(`${f.id}/${side}: missing file ${path}`);
        continue;
      }
      if (needle && !readFileSync(file, "utf8").includes(needle)) errors.push(`${f.id}/${side}: '${needle}' not found in ${path}`);
      if (path.endsWith("http-specs/results.json") && (e.status === "supported" || e.status === "restricted")) {
        const spec = (needle ?? "").replace(/"/g, "");
        const r = results.specs.find((s) => s.spec === spec);
        if (!r || r.category !== "implemented-passing") errors.push(`${f.id}/${side}: spec ${spec} is not implemented-passing (${r?.category})`);
      }
    }
  }
}
const icon = { supported: "✅ supported", restricted: "⚠️ restricted", unsupported: "⛔ unsupported", "not-applicable": "— n/a" };
let md = "# Feature coverage matrix\n\nGenerated from [feature-matrix.json](feature-matrix.json) by `node tools/feature-matrix/check.mjs --write`; every supported or restricted entry is backed by the executable tests listed in the JSON file.\n\n";
md += `HTTP conformance (@typespec/http-specs): ${JSON.stringify(results.summary)}\n\n`;
let area = "";
for (const f of matrix.features) {
  if (f.area !== area) {
    area = f.area;
    md += `\n## ${area}\n\n| Feature | typespec-go | typespec-structured-output |\n|---|---|---|\n`;
  }
  const cell = (e) => `${icon[e.status]}${e.notes ? `<br>${e.notes.replace(/(?<!\\)\|/g, "\\|")}` : ""}`;
  md += `| ${f.feature.replace(/(?<!\\)\|/g, "\\|")} | ${cell(f.go)} | ${cell(f.so)} |\n`;
}
if (process.argv.includes("--write")) writeFileSync(join(root, "docs/feature-matrix.md"), md);
else if (!existsSync(join(root, "docs/feature-matrix.md")) || readFileSync(join(root, "docs/feature-matrix.md"), "utf8") !== md) errors.push("docs/feature-matrix.md is out of date (run with --write)");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`feature matrix ok: ${matrix.features.length} features`);
