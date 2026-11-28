import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const pkg = fileURLToPath(new URL("../packages/typespec-go/", import.meta.url));
const env = { ...process.env, CGO_ENABLED: "1", GOWORK: "off" };
const goTest = (cwd, work = "off") => execFileSync("go", ["test", "-race", "-count=1", "./..."], { cwd, stdio: "inherit", env: { ...env, GOWORK: work } });
goTest(join(pkg, "runtime"));
const fixtures = readdirSync(join(pkg, "test/go")).filter(name => existsSync(join(pkg, "test/go", name, "main.tsp")));
for (const name of [...fixtures.sort(), "wire-objects-nullable"]) {
  const dir = join(pkg, "test/.tmp", "go-" + name, "out/typespec-go");
  if (!readdirSync(dir).some(f => f.endsWith("_test.go"))) throw new Error(`Missing generated tests for ${name}`);
  console.log(name);
  goTest(dir);
}

for (const name of ["consumer", "transitive", "xml", "local-response-policy", "ordered-consumer", "selected-inherited", "selected-repeated"]) {
  const dir = join(pkg, "test/.tmp", "ext-" + name);
  const module = join(dir, "out/typespec-go");
  if (!readdirSync(module).some(f => f.endsWith("_test.go"))) throw new Error(`Missing external package tests for ${name}`);
  console.log("external " + name);
  goTest(module, join(dir, "go.work"));
}
