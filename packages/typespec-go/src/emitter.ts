import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Diagnostic, type EmitContext, type Namespace, type Program, emitFile, getNamespaceFullName, joinPaths, listServices } from "@typespec/compiler";
import { Visibility, createMetadataInfo, getAllHttpServices, getHttpService } from "@typespec/http";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { assignNames, computeFlags, emitConversions, emitDecl, emitPatterns } from "./declgen.js";
import { Code, goFile, resolveDeclRefs, validGoPath } from "./gowriter.js";
import { type GoEmitterOptions, createDiagnostic } from "./lib.js";
import { conflatedNumericLiterals } from "./values.js";
import { type Decl, GoModelGenerator, reachableDecls } from "./model.js";
import { GoServerGenerator, type ServerDescription } from "./server.js";
import { XmlSupport } from "./xml.js";
import { SHARED_FILE, assignFiles } from "./layout.js";
import { CONTRACT, Fingerprints, applyMappings, inheritResponseNulls, loadMappings, matchingKey, representationOptions, runtimeHash, writeContract } from "./external.js";
import { type EventLibs, SseSupport } from "./sse.js";

export const MANIFEST = ".typespec-go-manifest.json";
const RUNTIME_DIR = findRuntimeDir(dirname(fileURLToPath(import.meta.url)));

/** The runtime ships next to package.json (works from dist/src and from src). */
function findRuntimeDir(start: string): string {
  for (let d = start; dirname(d) !== d; d = dirname(d)) {
    if (existsSync(join(d, "runtime", "go.mod")) && existsSync(join(d, "package.json"))) return join(d, "runtime");
  }
  throw new Error("typespec-go: runtime sources not found");
}
const RUNTIME_MODULE = "typespecgo/runtime";

export interface GoOutput {
  files: Map<string, string>;
  diagnostics: Diagnostic[];
  /** Generated operations and response variants (empty without HTTP services). */
  server?: ServerDescription;
}

/** Generates all Go files in memory. */
export async function generateGo(program: Program, options: GoEmitterOptions): Promise<GoOutput> {
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, string>();
  if (program.hasError()) return { files, diagnostics: [...program.diagnostics] };
  const module = options.module?.replace(/\/+$/, "");
  if (!module || !validGoPath(module)) {
    diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: `'module' must be a Go import path (got '${options.module ?? ""}')` } }));
    return { files, diagnostics };
  }
  const conflated = conflatedNumericLiterals(program);
  if (conflated.length) {
    for (const c of conflated) diagnostics.push(createDiagnostic({ code: "conflated-numeric-literal", target: c.node, format: { written: c.written, modelled: c.modelled } }));
    return { files, diagnostics };
  }
  const pkg = options["package-name"] ?? sanitizePackage(module.split("/").pop()!);
  if (!/^[a-z_][a-z0-9_]*$/.test(pkg) || /^(?:_|break|default|func|interface|select|case|defer|go|map|struct|chan|else|goto|package|switch|const|fallthrough|if|range|type|continue|for|import|return|var)$/.test(pkg)) {
    diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: `'package-name' must be a lower-case Go identifier (got '${pkg}')` } }));
    return { files, diagnostics };
  }
  const runtimeMode = options.runtime ?? "vendor";
  const runtimeImport = runtimeMode === "vendor" ? `${module}/tsgo` : options["runtime-module"];
  if (!runtimeImport || !validGoPath(runtimeImport)) {
    diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: "'runtime-module' must be a valid Go import path when 'runtime' is 'import'" } }));
    return { files, diagnostics };
  }

  const mappings = loadMappings(program, options, diagnostics);
  if (diagnostics.length) return { files, diagnostics };

  const metadata = createMetadataInfo(program, { canonicalVisibility: Visibility.All });
  const g = new GoModelGenerator(program, metadata, {
    unknownProperties: options["unknown-properties"],
    optionalNullable: options["optional-properties"] === "nullable",
    integerInt64: options["integer-type"] === "int64",
    ignoreInvisible: options["invisible-properties"] === "ignore",
    nullUnsetResponses: Array.isArray(options["response-unset-nullable"]) ? options["response-unset-nullable"] : options["response-unset-nullable"] === "null",
    exportContract: !!options["export-contract"],
    validationHooks: !!options["validation-hooks"],
    floatFormat: options["float-format"] ?? "shortest",
    minimalEscaping: options["string-escaping"] === "minimal",
    orderedRecords: !!options["ordered-records"],
  });
  let xmlLib: typeof import("@typespec/xml") | undefined;
  try {
    xmlLib = await import("@typespec/xml");
  } catch {
    xmlLib = undefined; // optional peer dependency
  }
  g.xml = new XmlSupport(program, g, xmlLib);
  const eventLibs: EventLibs = {};
  for (const [key, mod] of [["streams", "@typespec/streams"], ["events", "@typespec/events"], ["sse", "@typespec/sse"]] as const) {
    try {
      (eventLibs as any)[key] = await import(mod);
    } catch {
      // optional peer dependency
    }
  }
  g.sse = new SseSupport(program, g, eventLibs);
  const server = new GoServerGenerator(program, g);
  // Versioned services are generated for one projected version (official versioning mutators,
  // as used by @typespec/openapi3); the unprojected declarations of such namespaces are skipped.
  const projected = await projectVersions(program, options, diagnostics);
  if (projected.namespaces.size) g.allowVersioningDecorators = true;
  if (options["generate-server"] !== false) {
    const [services] = getAllHttpServices(program);
    for (const s of services) {
      const p = projected.namespaces.get(s.namespace);
      if (p) {
        const [svc] = getHttpService(program, p);
        server.collect(svc);
      } else server.collect(s);
    }
  }
  for (const p of projected.namespaces.values()) g.registerNamespace(p);
  g.registerNamespace(program.getGlobalNamespaceType(), new Set(projected.namespaces.keys()));
  computeFlags(g.decls, g.nullUnsetResponses, g.validationHooks);
  // Shared declarations keep the response nulls of their packages (their contracts).
  const inheritance = inheritResponseNulls(g.decls, mappings, diagnostics);
  if (inheritance.inherited) {
    g.nullUnsetResponses = true;
    computeFlags(g.decls, g.nullUnsetResponses, g.validationHooks);
  }
  // An exporting package publishes response codecs that downstream services may write, with or
  // without HTTP operations of its own: all of its declarations can be selected.
  const responseDecls = options["export-contract"] ? new Set(g.decls) : reachableDecls(server.responseTypes());
  for (const name of g.unmatchedResponseNullNames(responseDecls)) {
    diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: `'response-unset-nullable' names '${name}', which selects no optional nullable property written by a server response (unknown, not optional and nullable, or reachable only from requests)` } }));
  }
  checkInfiniteTypes(g);
  diagnostics.push(...g.diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) return { files, diagnostics };

  // Cross-package mapping: decided from fingerprints, before names are assigned.
  const fingerprints = mappings.length || options["export-contract"]
    ? new Fingerprints(g.decls, (d) => {
        const c = new Code();
        emitDecl(g, d, c, true);
        return c.toString();
      }, g.conversions)
    : undefined;
  const own = { options: representationOptions(options), runtime: runtimeImport, runtimeHash: runtimeHash(RUNTIME_DIR) };
  if (fingerprints) applyMappings(g.decls, mappings, fingerprints, own, diagnostics, inheritance.conflicts);
  // Option exclude: declarations other emitters use but Go does not generate.
  const exclude = options.exclude ?? [];
  for (const k of exclude) {
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(k)) diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: `'exclude' entries are TypeSpec namespace or type names (got '${k}')` } }));
  }
  if (exclude.length) {
    const used = new Set<string>();
    for (const d of g.decls) {
      const k = d.external ? undefined : matchingKey(d, exclude);
      if (k) {
        d.excluded = true;
        used.add(k);
      }
    }
    for (const k of exclude) if (!used.has(k)) diagnostics.push(createDiagnostic({ code: "invalid-option", target: program.getGlobalNamespaceType(), format: { reason: `'exclude' names '${k}', which matches no declaration` } }));
  }
  if (diagnostics.some((d) => d.severity === "error")) return { files: new Map(), diagnostics };
  const local = g.decls.filter((d) => !d.external && !d.excluded);
  assignNames(local, server.reservedNames());
  for (const d of g.decls) if (d.external) d.name = `${d.external.alias}.${d.external.name}`;

  const names = (id: number) => g.decls[id].name;
  const texts = (id: number) => (g.decls[id].external ? `tsgo.MarshalerText[${names(id)}]()` : undefined);
  const imports: Record<string, string> = { tsgo: runtimeImport };
  for (const d of g.decls) if (d.external) imports[d.external.alias] = d.external.importPath;

  const code = new Map<Decl, string>();
  for (const d of [...local].sort((a, b) => a.name.localeCompare(b.name))) {
    const c = new Code();
    emitDecl(g, d, c);
    code.set(d, c.toString());
  }
  let serverCode: string | undefined;
  if (server.ops.length) {
    const s = new Code();
    server.emit(s);
    g.sse.emit(s);
    for (const d of g.xml.marked) if (d.external) g.xml.emit(d, s);
    serverCode = s.toString();
  }
  // With external packages or exclusions, anonymous declarations reached only through mapped or
  // excluded ones are not generated. A generated declaration or the server using an excluded one
  // would leave an unresolved Go name: that is an error.
  if (mappings.length || exclude.length) {
    const reached = new Set<Decl>();
    const misuse = new Map<Decl, string>();
    const visit = (text: string, user: string) => {
      for (const m of text.matchAll(/\u0000(\d+)\u0000/g)) {
        const d = g.decls[Number(m[1])];
        if (d.excluded) {
          if (!misuse.has(d)) misuse.set(d, user);
        } else if (!d.external && !reached.has(d)) {
          reached.add(d);
          visit(code.get(d) ?? "", `'${d.key ?? d.name}'`);
        }
      }
    };
    for (const d of local) if (d.key && !reached.has(d)) {
      reached.add(d);
      visit(code.get(d) ?? "", `'${d.key}'`);
    }
    visit(serverCode ?? "", "an HTTP operation");
    for (const [d, user] of misuse) diagnostics.push(createDiagnostic({ code: "excluded-declaration", target: d.source, format: { name: d.key ?? d.name, user } }));
    if (misuse.size) return { files: new Map(), diagnostics };
    for (const d of local) if (!reached.has(d)) code.delete(d);
  }
  const layout = options["file-layout"] ?? "single";
  const homes = assignFiles(program, [...code.keys()], layout);
  const bodies = new Map<string, Code>([[SHARED_FILE, new Code()]]);
  for (const [d, text] of code) {
    const file = homes.get(d)!;
    if (!bodies.has(file)) bodies.set(file, new Code());
    bodies.get(file)!.raw(text);
  }
  const patterns = new Code();
  // After all checks registered their patterns; fingerprinting also registers those of external
  // declarations, which this package does not use.
  const emitted = fingerprints ? [...code.values(), serverCode ?? ""].join("") : undefined;
  emitPatterns(g, patterns, emitted ? (name) => emitted.includes(name) : undefined);
  // Defense in depth: nothing may be reported during emission without failing the output.
  const late = g.diagnostics.filter((d) => !diagnostics.includes(d));
  if (late.length) {
    diagnostics.push(...late);
    if (late.some((d) => d.severity === "error")) return { files: new Map(), diagnostics };
  }
  // Conversion codecs are named after their resolved initializer (stable across unrelated
  // changes, like pattern variables); only those used by emitted code are declared.
  const usedCode = [...code.values(), serverCode ?? ""].join("");
  const conversionNames = new Map<number, string>();
  const conversionVars: [string, string][] = [];
  g.conversions.forEach((init, i) => {
    if (!usedCode.includes(`\u0002${i}\u0002`)) return;
    const resolved = resolveDeclRefs(init, names, texts);
    const hash = createHash("sha256").update(resolved).digest("hex");
    const existing = conversionVars.find(([, r]) => r === resolved);
    let name = existing?.[0];
    for (let n = 8; !name; n++) if (!conversionVars.some(([v]) => v === `convert${hash.slice(0, n)}`)) name = `convert${hash.slice(0, n)}`;
    conversionNames.set(i, name);
    if (!existing) conversionVars.push([name, resolved]);
  });
  conversionVars.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  emitConversions(conversionVars, patterns);
  const resolve = (text: string) => resolveDeclRefs(text, names, texts, (i) => conversionNames.get(i)!);
  // The shared file holds the pattern variables and the declarations without a home of their
  // own; with another layout it is written only when it has content (or nothing else exists).
  const shared = patterns.toString() + bodies.get(SHARED_FILE)!.toString();
  if (layout === "single" || shared.trim() || bodies.size === 1) files.set(SHARED_FILE, goFile(pkg, resolve(shared), imports));
  for (const file of [...bodies.keys()].filter((f) => f !== SHARED_FILE).sort()) {
    files.set(file, goFile(pkg, resolve(bodies.get(file)!.toString()), imports));
  }
  if (serverCode) files.set("server.go", goFile(pkg, resolve(serverCode), imports));
  if (options["export-contract"]) files.set(CONTRACT, writeContract(g.decls, fingerprints!, { importPath: module, package: pkg, ...own }, (d) => code.has(d)));

  if (runtimeMode === "vendor") {
    for (const [path, text] of runtimeFiles(`${module}/tsgo`)) files.set(`tsgo/${path}`, text);
  }
  if (options["emit-go-mod"]) files.set("go.mod", `module ${module}\n\ngo 1.24\n`);
  return { files, diagnostics, server: server.describe(resolve) };
}

/** Applies @typespec/versioning projections (if the library is used) to versioned services. */
async function projectVersions(program: Program, options: GoEmitterOptions, diagnostics: Diagnostic[]): Promise<{ namespaces: Map<Namespace, Namespace> }> {
  const namespaces = new Map<Namespace, Namespace>();
  let versioning: typeof import("@typespec/versioning") | undefined;
  try {
    versioning = await import("@typespec/versioning");
  } catch {
    return { namespaces };
  }
  const owners = new Set(listServices(program).map(s => s.type));
  const visit = (ns: Namespace) => {
    if (versioning.getVersion(program, ns)) owners.add(ns);
    for (const child of ns.namespaces.values()) visit(child);
  };
  visit(program.getGlobalNamespaceType());
  for (const owner of owners) {
    const mutators = versioning.getVersioningMutators(program, owner);
    if (!mutators) continue;
    let mutator;
    if (mutators.kind === "transient") mutator = mutators.mutator;
    else {
      const wanted = options["api-version"] ?? "latest";
      const snap = wanted === "latest" ? mutators.snapshots[mutators.snapshots.length - 1] : mutators.snapshots.find((s) => s.version?.value === wanted || s.version?.name === wanted);
      if (!snap) {
        diagnostics.push(
          createDiagnostic({
            code: "invalid-option",
            target: owner,
            format: { reason: `'api-version' ${wanted} is not a version of ${getNamespaceFullName(owner)} (${mutators.snapshots.map((s) => s.version?.value).join(", ")})` },
          }),
        );
        continue;
      }
      mutator = snap.mutator;
    }
    const sub = unsafe_mutateSubgraphWithNamespace(program, [mutator], owner);
    if (sub.type.kind === "Namespace") namespaces.set(owner, sub.type);
  }
  return { namespaces };
}

function sanitizePackage(s: string): string {
  const p = s.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return /^[a-z_]/.test(p) ? p : "api";
}

/** Runtime sources (without tests) with the uri import rewritten to the vendored path. */
function runtimeFiles(vendorPath: string): [string, string][] {
  const out: [string, string][] = [];
  const add = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
      const text = readFileSync(join(dir, f), "utf8").replaceAll(`"${RUNTIME_MODULE}/uri"`, `"${vendorPath}/uri"`);
      out.push([prefix + f, text]);
    }
  };
  add(RUNTIME_DIR, "");
  add(join(RUNTIME_DIR, "uri"), "uri/");
  out.push(["LICENSE", readFileSync(join(RUNTIME_DIR, "..", "LICENSE"), "utf8")]);
  out.push(["THIRD_PARTY_NOTICES.md", readFileSync(join(RUNTIME_DIR, "..", "THIRD_PARTY_NOTICES.md"), "utf8")]);
  out.push(["uri/LICENSE.ogen", readFileSync(join(RUNTIME_DIR, "uri", "LICENSE.ogen"), "utf8")]);
  return out;
}

/** Required, non-nullable direct model references forming a cycle have no finite value. */
function checkInfiniteTypes(g: GoModelGenerator): void {
  const edges = (d: Decl): { to: Decl; via: string }[] => {
    const out: { to: Decl; via: string }[] = [];
    if (d.kind === "model") {
      for (const f of d.fields ?? []) {
        if (!f.optional && !f.literal && f.type.cat === "named" && (f.type.decl?.kind === "model" || f.type.decl?.kind === "tuple")) out.push({ to: f.type.decl, via: f.json });
      }
    }
    if (d.kind === "tuple") {
      (d.tupleItems ?? []).forEach((t, i) => {
        if (t.cat === "named" && (t.decl?.kind === "model" || t.decl?.kind === "tuple")) out.push({ to: t.decl, via: String(i) });
      });
    }
    return out;
  };
  const state = new Map<Decl, 1 | 2>();
  const stack: { d: Decl; via: string }[] = [];
  const reported = new Set<Decl>();
  const visit = (d: Decl) => {
    state.set(d, 1);
    for (const e of edges(d)) {
      stack.push({ d, via: e.via });
      if (state.get(e.to) === 1) {
        const start = stack.findIndex((s) => s.d === e.to);
        const cycle = stack.slice(start);
        if (!reported.has(e.to)) {
          reported.add(e.to);
          g.diagnostics.push(
            createDiagnostic({
              code: "infinite-type",
              target: e.to.source,
              format: { name: e.to.baseName, path: cycle.map((c) => `${c.d.baseName}.${c.via}`).join(" → ") },
            }),
          );
        }
      } else if (!state.has(e.to)) visit(e.to);
      stack.pop();
    }
    state.set(d, 2);
  };
  for (const d of g.decls) if (!state.has(d)) visit(d);
}

export async function $onEmit(context: EmitContext<GoEmitterOptions>): Promise<void> {
  const program = context.program;
  const outDir = context.emitterOutputDir;
  if (!program.compilerOptions.noEmit) await removePreviousOutputs(program, outDir);
  const { files, diagnostics } = await generateGo(program, context.options);
  program.reportDiagnostics(diagnostics);
  if (program.compilerOptions.noEmit) return;
  if (program.hasError() || diagnostics.some((d) => d.severity === "error")) return; // fail closed
  await emitFile(program, { path: joinPaths(outDir, MANIFEST), content: JSON.stringify({ files: [...files.keys()].sort() }, null, 2) + "\n" });
  try {
    for (const [path, content] of files) await emitFile(program, { path: joinPaths(outDir, path), content });
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
  if (!Array.isArray(files) || !files.every(f => typeof f === "string" && /^(?:models(?:\.[a-z0-9_]+)*\.go|server\.go|go\.mod|typespec-go-contract\.json|tsgo\/(?:[a-zA-Z0-9_]+\.go|LICENSE|THIRD_PARTY_NOTICES\.md|uri\/(?:[a-zA-Z0-9_]+\.go|LICENSE\.ogen)))$/.test(f))) {
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
}
