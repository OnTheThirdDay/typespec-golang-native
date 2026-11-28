import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost, type Diagnostic, type Program } from "@typespec/compiler";
import type { GoEmitterOptions } from "../lib.js";

const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

function findPackageRoot(start: string): string {
  for (let d = start; ; d = dirname(d)) {
    try {
      if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "typespec-go") return d;
    } catch {
      // keep searching
    }
    if (dirname(d) === d) throw new Error("package root not found");
  }
}

export interface GoGenResult {
  program: Program;
  diagnostics: readonly Diagnostic[];
  /** Directory of the generated Go package (also the Go module root). */
  dir: string;
  files: string[];
}

/**
 * Compiles TypeSpec with typespec-go into test/.tmp/<name>/out/typespec-go (module example.com/gen).
 * `code` is main.tsp, or a map of project-relative paths to sources (including main.tsp).
 */
export async function generateGoPackage(code: string | Record<string, string>, name: string, options: Partial<GoEmitterOptions> = {}): Promise<GoGenResult> {
  const root = join(packageRoot, "test", ".tmp", name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [path, text] of Object.entries(typeof code === "string" ? { "main.tsp": code } : code)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const program = await compile(NodeHost, join(root, "main.tsp"), {
    outputDir: join(root, "out"),
    emit: ["typespec-go"],
    options: { "typespec-go": { module: "example.com/gen", "emit-go-mod": true, ...options } },
  });
  const dir = join(root, "out", "typespec-go");
  const files = existsSync(dir) ? listRecursive(dir) : [];
  return { program, diagnostics: program.diagnostics, dir, files };
}

/** Entries below dir relative to it, like readdirSync(dir, { recursive: true }), which misses
 * entries of long Windows paths in Node 22.0. */
function listRecursive(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    out.push(rel);
    if (entry.isDirectory()) out.push(...listRecursive(dir, rel));
  }
  return out;
}

/** Copies Go test sources next to the generated package. */
export function addGoFiles(fromDir: string, toDir: string): void {
  for (const f of readdirSync(fromDir)) if (f.endsWith(".go")) cpSync(join(fromDir, f), join(toDir, f));
  // Go test data (read by the tests relative to the package directory).
  if (existsSync(join(fromDir, "testdata"))) cpSync(join(fromDir, "testdata"), join(toDir, "testdata"), { recursive: true });
}

export function runGo(dir: string, args: string[], timeout = 300_000): { ok: boolean; output: string } {
  try {
    const output = execFileSync("go", args, { cwd: dir, encoding: "utf8", stdio: "pipe", timeout, maxBuffer: 1 << 28, env: { ...process.env, GOFLAGS: "-mod=mod", GOWORK: "off" } });
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

export function gofmtList(dir: string): string {
  return execFileSync("gofmt", ["-l", "."], { cwd: dir, encoding: "utf8" }).trim();
}
