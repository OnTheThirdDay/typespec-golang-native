import { rmdir } from "node:fs/promises";
import { posix } from "node:path";
import {
  type Diagnostic,
  type EmitContext,
  type Model,
  type Namespace,
  type Program,
  NodeHost,
  emitFile,
  getNamespaceFullName,
  printIdentifier,
  isArrayModelType,
  isTemplateDeclaration,
  joinPaths,
  navigateTypesInNamespace,
} from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { getStructuredOutputRoots } from "./decorators.js";
import { stringifyJson, type JsonObject } from "./json.js";
import { createDiagnostic, type StructuredOutputEmitterOptions } from "./lib.js";
import { validateProfile } from "./profile.js";
import { conflatedNumericLiterals } from "./values.js";
import { PydanticSchemaGenerator, isMapModel } from "./pydantic/generator.js";
import { StrictTransformError, toStrictJsonSchema } from "./strict.js";
import { type FileLayout, rootFiles } from "./layout.js";

// Optional library. Keep the synchronous programmatic generation API for ordinary callers.
const versioning = await import("@typespec/versioning").catch((err: NodeJS.ErrnoException) => {
  if (err.code === "ERR_MODULE_NOT_FOUND" && err.message.includes("'@typespec/versioning'")) return undefined;
  throw err;
});

export const MANIFEST = ".structured-output-manifest.json";

export interface ResolvedOptions {
  profile: "openai" | "openai-fine-tuned" | "none";
  schemaMode: "strict" | "pydantic";
  outputFormat: "schema" | "text-format" | "response-format";
  scalarEncodings: "pydantic" | "wire";
  mixedEnums: "pydantic" | "typed-union";
  optionalProperties: "error" | "nullable";
  defaultValues: "error" | "emit" | "omit";
  emitAllModels: boolean;
  /** Root selection (options roots and exclude-roots): namespace or type names. */
  roots?: string[];
  excludeRoots: string[];
  fileLayout: FileLayout;
  apiVersion?: string;
  visibility?: StructuredOutputEmitterOptions["visibility"];
}

export function resolveOptions(o: StructuredOutputEmitterOptions): ResolvedOptions {
  return {
    profile: o["target-profile"] ?? "openai",
    schemaMode: o["schema-mode"] ?? "strict",
    outputFormat: o["output-format"] ?? "schema",
    scalarEncodings: o["scalar-encodings"] ?? "pydantic",
    mixedEnums: o["mixed-enums"] ?? "pydantic",
    optionalProperties: o["optional-properties"] ?? "error",
    defaultValues: o["default-values"] ?? "error",
    apiVersion: o["api-version"],
    visibility: o.visibility,
    emitAllModels: o["emit-all-models"] ?? false,
    roots: o.roots,
    excludeRoots: o["exclude-roots"] ?? [],
    fileLayout: o["file-layout"] ?? "single",
  };
}

export interface GeneratedSchema {
  model: Model;
  name: string;
  schema: JsonObject;
  /** Output path relative to the emitter output directory (posix), per option file-layout. */
  file: string;
}

/** Generates all root schemas; returns diagnostics instead of writing files. */
export function generateSchemas(program: Program, options: ResolvedOptions): { schemas: GeneratedSchema[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (program.hasError()) return { schemas: [], diagnostics: [...program.diagnostics] };
  const origins = new WeakMap<object, any>();
  const conflated = conflatedNumericLiterals(program);
  if (conflated.length) {
    for (const c of conflated) diagnostics.push(createDiagnostic({ code: "conflated-numeric-literal", target: c.node, format: { written: c.written, modelled: c.modelled } }));
    return { schemas: [], diagnostics };
  }
  const all = collectRoots(program, options);
  const declared = selectRoots(program, all, options, diagnostics);
  const projected = new Map<Namespace, Namespace>();
  const absent = new Set<Model>();
  const roots = declared.flatMap(root => {
    if (!versioning || !root.model.namespace) return [root];
    const [owner] = versioning.getVersions(program, root.model);
    const ns = owner ?? root.model.namespace;
    let snapshot = projected.get(ns);
    if (!snapshot) {
      const plans = versioning.getVersioningMutators(program, ns);
      if (!plans) return [root];
      const version = options.apiVersion ?? "latest";
      const plan = plans.kind === "transient" ? plans : version === "latest" ? plans.snapshots.at(-1) :
        plans.snapshots.find(x => x.version.value === version || x.version.name === version);
      if (!plan) {
        diagnostics.push(createDiagnostic({ code: "invalid-root", target: root.model, format: { name: root.model.name, reason: `unknown api-version '${version}' for ${getNamespaceFullName(ns)}` } }));
        return [];
      }
      const sub = unsafe_mutateSubgraphWithNamespace(program, [plan.mutator], ns);
      if (sub.type.kind !== "Namespace") return [];
      snapshot = sub.type;
      projected.set(ns, snapshot);
    }
    const path: string[] = [];
    for (let cur: Namespace | undefined = root.model.namespace; cur && cur !== ns; cur = cur.namespace) path.unshift(cur.name);
    for (const name of path) snapshot = snapshot?.namespaces.get(name);
    const model = snapshot && [...snapshot.models.values()].find(m => m === root.model || m.node === root.model.node);
    if (!model) absent.add(root.model);
    return model ? [{ ...root, model }] : [];
  });
  for (const key of options.roots ?? []) {
    const matches = declared.filter(r => matchesRoot(key, r.model));
    if (matches.length && matches.every(r => absent.has(r.model))) {
      diagnostics.push(createDiagnostic({ code: "root-selection", target: matches[0].model, format: {
        option: "roots", name: key, reason: `selects no root in api-version '${options.apiVersion ?? "latest"}'`,
      } }));
    }
  }
  const gen = new PydanticSchemaGenerator(program, {
    mixedEnums: options.mixedEnums,
    scalarEncodings: options.scalarEncodings,
    optionalProperties: options.optionalProperties, defaultValues: options.defaultValues,
    profileName: options.profile, rejectDefaults: options.profile !== "none",
    projected: projected.size > 0, visibility: options.visibility,
  }, origins);
  if (all.length === 0) {
    diagnostics.push(createDiagnostic({ code: "no-roots", target: program.getGlobalNamespaceType() }));
  }
  const schemas: GeneratedSchema[] = [];
  const names = new Map<string, Model>();
  for (const { model, name: explicit } of roots) {
    if (isTemplateDeclaration(model) || isArrayModelType(model) || isMapModel(model)) {
      diagnostics.push(
        createDiagnostic({ code: "invalid-root", target: model, format: { name: model.name, reason: "roots must be concrete object models" } }),
      );
      continue;
    }
    let schema = gen.generate(model);
    if (!schema) continue;
    if (options.schemaMode === "strict") {
      try {
        schema = toStrictJsonSchema(schema);
      } catch (err) {
        if (!(err instanceof StrictTransformError)) throw err;
        diagnostics.push(createDiagnostic({ code: "invalid-root", target: model, format: { name: model.name, reason: err.message } }));
        continue;
      }
    }
    const name = explicit ?? gen.pythonClassName(model);
    if (!name || Buffer.byteLength(`${name}.json`, "utf8") > 255 || /[<>:"/\\\\|?*\x00-\x1f]/u.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      diagnostics.push(createDiagnostic({ code: "invalid-root", target: model, format: { name, reason: "root name must be a portable filename" } }));
      continue;
    }
    if (`${name}.json`.toLowerCase() === MANIFEST || names.has(name.toLowerCase())) {
      diagnostics.push(createDiagnostic({ code: "duplicate-root-name", target: model, format: { name } }));
      continue;
    }
    names.set(name.toLowerCase(), model);
    if (options.profile !== "none") {
      for (const v of validateProfile(schema, name, options.profile)) {
        const target = origins.get(v.node) ?? model;
        diagnostics.push(
          createDiagnostic({
            code: "target-incompatible",
            target,
            format: { root: name, profile: options.profile, path: v.path, reason: v.reason },
          }),
        );
      }
    }
    schemas.push({ model, name, schema, file: "" });
  }
  rootFiles(program, schemas, options.fileLayout).forEach((file, i) => (schemas[i].file = file));
  diagnostics.push(...gen.diagnostics);
  return { schemas: diagnostics.some(d => d.severity === "error") ? [] : schemas, diagnostics };
}

/** Fully qualified name of a root model (namespace and name). */
function rootName(m: Model): string {
  const ns = m.namespace ? getNamespaceFullName(m.namespace, { printable: true }) : "";
  const name = printIdentifier(m.name);
  return ns ? `${ns}.${name}` : name;
}

function matchesRoot(key: string, m: Model): boolean {
  if (rootName(m) === key) return true;
  for (let ns = m.namespace; ns?.name; ns = ns.namespace) {
    if (getNamespaceFullName(ns, { printable: true }) === key) return true;
  }
  return false;
}

/**
 * Options roots and exclude-roots: a name selects the root of that name, or every root declared
 * in that namespace or its sub-namespaces. Each entry must select a root (a mistyped name is an
 * error, never a silently different set of files). Roots left out are still generated as the
 * definitions of the roots that reference them, unchanged.
 */
function selectRoots(program: Program, all: { model: Model; name?: string }[], options: ResolvedOptions, diagnostics: Diagnostic[]): { model: Model; name?: string }[] {
  const target = program.getGlobalNamespaceType();
  const check = (option: string, keys: readonly string[]) => {
    for (const key of keys) {
      if (all.some((r) => matchesRoot(key, r.model))) continue;
      if (!key || key.split(".").some(part => !part)) {
        diagnostics.push(createDiagnostic({ code: "root-selection", target, format: { option, name: key, reason: "is not a TypeSpec namespace or type name" } }));
      } else {
        diagnostics.push(createDiagnostic({ code: "root-selection", target, format: { option, name: key, reason: "selects no root (a @structuredOutput model, or a model with 'emit-all-models')" } }));
      }
    }
  };
  check("roots", options.roots ?? []);
  check("exclude-roots", options.excludeRoots);
  const selected = all.filter((r) => (!options.roots || options.roots.some((k) => matchesRoot(k, r.model))) && !options.excludeRoots.some((k) => matchesRoot(k, r.model)));
  if (all.length && !selected.length && !diagnostics.length) {
    diagnostics.push(createDiagnostic({ code: "root-selection", target, format: { option: options.roots ? "roots" : "exclude-roots", name: (options.roots ?? options.excludeRoots).join(", "), reason: "leaves no root to emit" } }));
  }
  return selected;
}

function collectRoots(program: Program, options: ResolvedOptions): { model: Model; name?: string }[] {
  const marked = getStructuredOutputRoots(program);
  if (!options.emitAllModels) return marked;
  const explicit = new Map(marked.map((r) => [r.model, r.name]));
  const out: { model: Model; name?: string }[] = [];
  const visitNs = (ns: Namespace) => {
    const full = getNamespaceFullName(ns);
    if (full === "TypeSpec" || full.startsWith("TypeSpec.")) return;
    navigateTypesInNamespace(
      ns,
      {
        model: (m) => {
          if (m.name && !isTemplateDeclaration(m) && !isArrayModelType(m) && !isMapModel(m)) {
            out.push({ model: m, name: explicit.get(m) });
          }
        },
      },
      { includeTemplateDeclaration: false, skipSubNamespaces: true },
    );
    for (const sub of ns.namespaces.values()) visitNs(sub);
  };
  visitNs(program.getGlobalNamespaceType());
  const collected = new Set(out.map(r => r.model));
  for (const root of marked) if (!collected.has(root.model)) out.push(root);
  return out;
}

export function wrapOutput(name: string, schema: JsonObject, format: ResolvedOptions["outputFormat"]): JsonObject {
  switch (format) {
    case "schema":
      return schema;
    case "text-format":
      return { type: "json_schema", strict: true, name, schema };
    case "response-format":
      return { type: "json_schema", json_schema: { schema, name, strict: true } };
  }
}

export async function $onEmit(context: EmitContext<StructuredOutputEmitterOptions>): Promise<void> {
  const program = context.program;
  const outDir = context.emitterOutputDir;
  if (!program.compilerOptions.noEmit) await removePreviousOutputs(program, outDir);
  const options = resolveOptions(context.options);
  const { schemas, diagnostics } = generateSchemas(program, options);
  program.reportDiagnostics(diagnostics);
  if (program.compilerOptions.noEmit) return;

  const failed = diagnostics.some((d) => d.severity === "error") || program.hasError();
  if (failed) return; // fail closed: never leave a partial or stale set of schemas behind

  const files = schemas.map(root => root.file);
  await emitFile(program, { path: joinPaths(outDir, MANIFEST), content: JSON.stringify({ files }, null, 2) + "\n" });
  try {
    for (const { name, schema, file } of schemas) {
      await emitFile(program, { path: joinPaths(outDir, file), content: stringifyJson(wrapOutput(name, schema, options.outputFormat)) + "\n" });
    }
  } catch (err) {
    await removePreviousOutputs(program, outDir);
    throw err;
  }
}

async function removePreviousOutputs(program: Program, outDir: string): Promise<void> {
  const manifest = joinPaths(outDir, MANIFEST);
  let text: string;
  try {
    text = (await program.host.readFile(manifest)).text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const { files } = JSON.parse(text);
  if (!Array.isArray(files) || !files.every(f => typeof f === "string" && /^(?:[a-z0-9_]+\/)*[^<>:"/\\|?*\x00-\x1f]+\.json$/u.test(f) && f !== MANIFEST)) {
    throw new Error(`Invalid emitter manifest at ${manifest}`);
  }
  for (const f of files) {
    try {
      await program.host.rm(joinPaths(outDir, f));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await program.host.rm(manifest);
  // Directories of a previous layout that are now empty (deepest first; others are kept).
  const dirs = new Set<string>();
  for (const f of files as string[]) for (let d = posix.dirname(f); d !== "."; d = posix.dirname(d)) dirs.add(d);
  for (const d of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1))) {
    try {
      const path = joinPaths(outDir, d);
      if (program.host.rm === NodeHost.rm) await rmdir(path);
      else if ((await program.host.readDir(path)).length === 0) await program.host.rm(path);
    } catch (err) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  }
}
