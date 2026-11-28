import { compile, NodeHost } from "@typespec/compiler";
import { readFileSync } from "node:fs";
const dir = import.meta.dirname;
const p = await compile(NodeHost, dir + "/main.tsp", { outputDir: dir + "/.out", emit: ["@typespec/json-schema"],
  options: { "@typespec/json-schema": { emitAllModels: true, bundleId: "bundle.json", "file-type": "json" } } });
console.log("diagnostics:", p.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`));
const b = JSON.parse(readFileSync(dir + "/.out/@typespec/json-schema/bundle.json", "utf8"));
console.log("$defs keys:", Object.keys(b.$defs));
console.log("Root.properties:", JSON.stringify(b.$defs.Root?.properties));
