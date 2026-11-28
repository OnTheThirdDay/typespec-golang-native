import { compile, NodeHost, type Diagnostic, type Program } from "@typespec/compiler";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "../emitter.js";
import { parseJson, type Json } from "../json.js";
import type { StructuredOutputEmitterOptions } from "../lib.js";

const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

function findPackageRoot(start: string): string {
  for (let d = start; ; d = dirname(d)) {
    try {
      if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "typespec-structured-output") return d;
    } catch {
      // keep searching
    }
    if (dirname(d) === d) throw new Error("package root not found");
  }
}

export interface EmitResult {
  program: Program;
  diagnostics: readonly Diagnostic[];
  /** Emitted files by path relative to the output directory (posix), parsed. */
  files: Record<string, Json>;
}

/**
 * Compiles TypeSpec source with this emitter in a scratch directory inside the package (so that
 * `import "typespec-structured-output"` resolves through the workspace) and returns the outputs.
 */
export async function emitStructuredOutput(
  code: string | Record<string, string>,
  options: StructuredOutputEmitterOptions = {},
  name = "case",
): Promise<EmitResult> {
  const dir = join(packageRoot, "test", ".tmp", name.replace(/[^a-zA-Z0-9_-]/g, "_"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(typeof code === "string" ? { "main.tsp": code } : code)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const outputDir = join(dir, "out");
  const program = await compile(NodeHost, join(dir, "main.tsp"), {
    outputDir,
    emit: ["typespec-structured-output"],
    options: { "typespec-structured-output": options as Record<string, unknown> },
  });
  const files: Record<string, Json> = {};
  const emitted = join(outputDir, "typespec-structured-output");
  if (existsSync(emitted)) {
    for (const f of listRecursive(emitted).map((x) => x.replaceAll("\\", "/")).sort()) {
      if (f.endsWith(".json") && f !== MANIFEST) files[f] = parseJson(readFileSync(join(emitted, f), "utf8"));
    }
  }
  return { program, diagnostics: program.diagnostics, files };
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
