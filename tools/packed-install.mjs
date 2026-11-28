// Release check. Each tarball is installed in its own fresh consumer outside the workspaces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "TypeSpec packed "));
const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: "utf8" });
try {
  for (const name of ["typespec-go", "typespec-structured-output"]) {
    const go = name === "typespec-go";
    const cwd = join(scratch, name);
    mkdirSync(cwd);
    const [pack] = JSON.parse(npm(["pack", "--json", "--pack-destination", scratch], resolve(repo, "packages", name)));
    const deps = { [name]: "file:../" + pack.filename, "@typespec/compiler": "1.18.0" };
    if (go) deps["@typespec/http"] = "1.18.0";
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: deps }));
    npm(["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"], cwd);
    assert(!existsSync(join(cwd, "node_modules", go ? "typespec-structured-output" : "typespec-go")));
    assert(!existsSync(join(cwd, "node_modules/@typespec/versioning")));
    const source = go ? 'import "@typespec/http";\nusing Http;\n@service namespace Demo;\nmodel Item { n: int32; }\n@route("/item") op read(): Item;\n'
                      : 'using StructuredOutput;\nnamespace Packed;\n@structuredOutput model Item { n: int32; }\n';
    writeFileSync(join(cwd, "main.tsp"), `import "${name}";\n${source}`);
    const compile = () => execFileSync(process.execPath, [join(cwd, "node_modules/@typespec/compiler/cmd/tsp.js"), "compile", "main.tsp", "--emit", name,
      ...(go ? ["--option", "typespec-go.module=example.com/packed", "--option", "typespec-go.emit-go-mod=true"] : [])], { cwd, stdio: "pipe" });
    compile();
    const out = join(cwd, "tsp-output", name);
    const files = go ? ["models.go", "server.go", "tsgo/LICENSE", "tsgo/uri/LICENSE.ogen", "tsgo/THIRD_PARTY_NOTICES.md"] : ["Item.json"];
    const before = files.map(f => readFileSync(join(out, f)));
    compile();
    files.forEach((f, i) => assert.deepEqual(readFileSync(join(out, f)), before[i]));
    if (go) {
      writeFileSync(join(out, "consumer_test.go"), `package packed
import ("encoding/json"; "testing")
func TestPackedModel(t *testing.T) {
  var item Item
  if err := json.Unmarshal([]byte("{\\"n\\":0}"), &item); err != nil { t.Fatal(err) }
  if err := json.Unmarshal([]byte("{}"), &item); err == nil { t.Fatal("accepted absent field") }
}
`);
      execFileSync("go", ["test", "-count=1", "./..."], { cwd: out, env: { ...process.env, GOWORK: "off" }, stdio: "inherit" });
      // Another layout from the installed package: the manifest removes the previous models.go.
      execFileSync(process.execPath, [join(cwd, "node_modules/@typespec/compiler/cmd/tsp.js"), "compile", "main.tsp", "--emit", name, "--option", "typespec-go.module=example.com/packed",
        "--option", "typespec-go.emit-go-mod=true", "--option", "typespec-go.file-layout=per-source-file"], { cwd, stdio: "pipe" });
      assert(!existsSync(join(out, "models.go")) && existsSync(join(out, "models.main.go")));
      execFileSync("go", ["test", "-count=1", "./..."], { cwd: out, env: { ...process.env, GOWORK: "off" }, stdio: "inherit" });
    } else {
      assert(existsSync(join(cwd, "node_modules", name, "LICENSE.apache")));
      const schema = JSON.parse(before[0]);
      assert.deepEqual(schema.required, ["n"]);
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.n.maximum, 2147483647);
      execFileSync(process.execPath, [join(cwd, "node_modules/@typespec/compiler/cmd/tsp.js"), "compile", "main.tsp", "--emit", name,
        "--option", "typespec-structured-output.file-layout=per-namespace"], { cwd, stdio: "pipe" });
      assert(!existsSync(join(out, "Item.json")));
      assert.deepEqual(readFileSync(join(out, "packed", "Item.json")), before[0]);
    }
    console.log(`${name}: packed consumer passed`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
