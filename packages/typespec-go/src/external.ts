/**
 * Declarations shared between independently compiled TypeSpec programs (option `external`).
 *
 * A package generated with `export-contract: true` writes typespec-go-contract.json: its Go import
 * path, its runtime import path and runtime version, the options that change the representation,
 * and for every declaration its cross-package key (the fully qualified TypeSpec name, with an
 * `@<variant>` suffix for visibility, merge-patch and polymorphic variants, and a declaration-site
 * key for source-backed anonymous types), its Go name and a fingerprint of its generated code.
 *
 * A consumer maps TypeSpec namespaces or types to such packages. It still collects the mapped
 * declarations from its own program, but references the external Go types instead of generating
 * them, after checking that each one's fingerprint equals the contract's: the generated code
 * (codecs, validation, defaults, variants, nested types) must be identical, otherwise the mapping
 * is rejected. Declarations the shared package does not have (a visibility variant it never used,
 * a template instance over consumer types) are generated in the consumer. Like oapi-codegen's
 * import-mapping, packages are imported as externalRef0, externalRef1, … (sorted import paths).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, Program, Type } from "@typespec/compiler";
import { resolveDeclRefs, validGoPath } from "./gowriter.js";
import { createDiagnostic, type GoEmitterOptions } from "./lib.js";
import { namespaceOfNode, typeNamespace } from "./layout.js";
import { type Node, SyntaxKind, visitChildren } from "@typespec/compiler/ast";
import { type Entity, getEntityName, getNamespaceFullName, isStdNamespace, isTemplateInstance, printIdentifier } from "@typespec/compiler";
import { Visibility, getVisibilitySuffix } from "@typespec/http";
import type { Decl, GoType } from "./model.js";

export const CONTRACT = "typespec-go-contract.json";
// Version 2: anonymous declarations are keyed by their declaration identity, not their content.
// Version 3: declarations record their response nulls (response-unset-nullable), and generated
// types implement ValidateWith (nested validation across packages).
// Version 4: template arguments retain their declaration identity, including anonymous arguments.
const CONTRACT_VERSION = 4;

/** Options that change generated code; they must be equal on both sides of a mapping. */
const REPRESENTATION_OPTIONS = {
  "unknown-properties": "ignore",
  "optional-properties": "source",
  "integer-type": "arbitrary-precision",
  "invisible-properties": "unknown",
  "response-unset-nullable": "omit",
  "float-format": "shortest",
  "string-escaping": "default",
  "ordered-records": "false",
} as const;

/**
 * responseNulls: the declaration's own optional nullable properties (JSON names) written as null
 * when unset in responses (response-unset-nullable); consumers inherit them.
 */
type Entry = { name: string; fingerprint: string; importPath?: string; responseNulls?: string[] } | { ambiguous: true };

export interface Contract {
  version: number;
  importPath: string;
  package: string;
  runtime: string;
  runtimeHash: string;
  options: Record<string, string>;
  decls: Record<string, Entry>;
}

interface Mapping {
  key: string;
  file: string;
  contract: Contract;
}

export function representationOptions(options: GoEmitterOptions): Record<string, string> {
  // A list (response-unset-nullable) is recorded in a canonical, order-independent form.
  const value = (v: unknown) => (Array.isArray(v) ? `[${[...v].sort().join(",")}]` : typeof v === "boolean" ? String(v) : (v as string | undefined));
  return Object.fromEntries(Object.entries(REPRESENTATION_OPTIONS).map(([k, d]) => [k, value((options as unknown as Record<string, unknown>)[k]) ?? d]));
}

/** Hash of the runtime sources: independently generated packages must share one runtime version. */
export function runtimeHash(runtimeDir: string): string {
  const h = createHash("sha256");
  for (const dir of [runtimeDir, join(runtimeDir, "uri")]) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
      h.update(f).update("\0").update(readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).update("\0");
    }
  }
  return h.digest("hex").slice(0, 32);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isContract(v: unknown): v is Contract {
  const digest = (x: unknown) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);
  const path = (x: unknown) => typeof x === "string" && validGoPath(x);
  return isRecord(v) && v.version === CONTRACT_VERSION && path(v.importPath) && path(v.runtime)
    && typeof v.package === "string" && /^[a-z_][a-z0-9_]*$/.test(v.package) && digest(v.runtimeHash)
    && isRecord(v.options) && Object.values(v.options).every(o => typeof o === "string")
    && Object.keys(REPRESENTATION_OPTIONS).every(k => Object.hasOwn(v.options as object, k))
    && isRecord(v.decls) && Object.values(v.decls).every(e => isRecord(e) && (
      e.ambiguous === true || (typeof e.name === "string" && /^\p{Lu}[\p{L}\p{Nd}_]*$/u.test(e.name)
        && digest(e.fingerprint) && (e.importPath === undefined || path(e.importPath))
        && (e.responseNulls === undefined || (Array.isArray(e.responseNulls) && e.responseNulls.every((n) => typeof n === "string"))))
    ));
}

/**
 * The `[name, path]` pairs of option `external`, from its three equivalent forms: a list of
 * `{ name, path }`, nested objects whose keys are name segments (the only form tspconfig.yaml
 * and `--option a.b.c=…` can express for dotted names), or a flat map with dotted keys.
 */
export function mappingEntries(external: unknown, bad: (reason: string) => void): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const add = (name: string, path: unknown, where: string) => {
    if (typeof path !== "string" || path === "") return bad(`'external' ${where}: the path must be a non-empty string`);
    if (seen.has(name)) return bad(`'external' maps '${name}' more than once`);
    seen.add(name);
    out.push([name, path]);
  };
  if (external === undefined) return out;
  if (Array.isArray(external)) {
    external.forEach((e, i) => {
      if (!isRecord(e) || typeof e.name !== "string" || Object.keys(e).some((k) => k !== "name" && k !== "path")) {
        return bad(`'external[${i}]' must be { name, path }`);
      }
      add(e.name, e.path, `entry '${e.name}'`);
    });
    return out;
  }
  if (!isRecord(external)) {
    bad("'external' must be a list of { name, path } or an object");
    return out;
  }
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (isRecord(v)) walk(v, name);
      else add(name, v, `'${name}'`);
    }
  };
  walk(external, "");
  return out;
}

/** Reads the contracts named by option `external`; problems are reported as invalid-option. */
export function loadMappings(program: Program, options: GoEmitterOptions, diagnostics: Diagnostic[]): Mapping[] {
  const target = program.getGlobalNamespaceType();
  const bad = (reason: string) => diagnostics.push(createDiagnostic({ code: "invalid-option", target, format: { reason } }));
  const out: Mapping[] = [];
  const contracts = new Map<string, Contract>();
  for (const [key, path] of mappingEntries(options.external, bad)) {
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key)) {
      bad(`'external' keys are TypeSpec namespace or type names (got '${key}')`);
      continue;
    }
    let file = resolve(program.projectRoot, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, CONTRACT);
    let contract = contracts.get(file);
    if (!contract) {
      try {
        contract = JSON.parse(readFileSync(file, "utf8")) as Contract;
      } catch (e) {
        bad(`external '${key}': cannot read the contract ${file} (${(e as Error).message.split("\n")[0]}); generate the shared package with 'export-contract: true'`);
        continue;
      }
      if (!isContract(contract)) {
        bad(`external '${key}': ${file} is not a typespec-go contract of version ${CONTRACT_VERSION}`);
        continue;
      }
      if (contract.importPath === options.module?.replace(/\/+$/, "")) {
        bad(`external '${key}': the contract is the package being generated (${contract.importPath})`);
        continue;
      }
      contracts.set(file, contract);
    }
    out.push({ key, file, contract });
  }
  return out;
}

/**
 * Cross-package keys and fingerprints. The canonical text of a declaration is its generated
 * code with references replaced by keys (itself by "Self"). Anonymous types with source nodes
 * use declaration identity. Synthesized types without a source location use canonical text.
 */
export class Fingerprints {
  private readonly texts = new Map<Decl, string>();
  private readonly edges = new Map<Decl, Set<Decl>>();
  private readonly anonKeys = new Map<Decl, string>();

  constructor(
    private readonly decls: Decl[],
    private readonly emitCanonical: (d: Decl) => string,
    private readonly conversions: readonly string[] = [],
  ) {}

  key(d: Decl): string {
    if (d.key) return d.key;
    let k = this.anonKeys.get(d);
    if (!k) {
      // Content hashes only for types without a source location (synthesized by libraries).
      k = anonymousIdentity(d) ?? "~" + hash(this.canonical(d));
      this.anonKeys.set(d, k);
    }
    return k;
  }

  fingerprint(d: Decl): string {
    return hash(this.canonical(d));
  }

  dependencies(d: Decl): ReadonlySet<Decl> {
    this.canonical(d);
    return this.edges.get(d)!;
  }

  private canonical(d: Decl): string {
    let t = this.texts.get(d);
    if (t === undefined) {
      const refs = new Set<Decl>();
      const name = (id: number) => {
        if (id === d.id) return "Self";
        refs.add(this.decls[id]);
        return this.key(this.decls[id]);
      };
      const text = (id: number) => `Text(${name(id)})`;
      t = resolveDeclRefs(this.emitCanonical(d), name, text, (i) => `Conversion(${resolveDeclRefs(this.conversions[i], name, text)})`);
      this.edges.set(d, refs);
      this.texts.set(d, t);
    }
    return t;
  }
}

const DECLARATIONS = new Set<SyntaxKind>([
  SyntaxKind.ModelStatement, SyntaxKind.UnionStatement, SyntaxKind.EnumStatement, SyntaxKind.ScalarStatement,
  SyntaxKind.AliasStatement, SyntaxKind.OperationStatement, SyntaxKind.InterfaceStatement,
]);

/**
 * Identity of an anonymous declaration, equal in every program compiled from the same sources:
 * the declaration that contains its type expression (namespace, interface, name), the path of
 * child indexes from that declaration down to the expression, the template arguments of the
 * instance it belongs to, and its visibility or merge-patch projection. Structurally identical
 * anonymous types written in different places therefore keep distinct identities.
 */
function anonymousIdentity(d: Decl): string | undefined {
  const key = anonymousSourceKey(d.source);
  if (!key) return undefined;
  const variant = (d.vis !== undefined && d.vis >= 0 ? getVisibilitySuffix(d.vis, Visibility.All) : "") + (d.mergePatch ? "MergePatch" : "");
  return variant ? `${key}@${variant}` : key;
}

function anonymousSourceKey(type: Type): string | undefined {
  const node = type.node;
  if (!node) return undefined;
  const path: number[] = [];
  let n: Node = node;
  while (n.parent && !DECLARATIONS.has(n.kind)) {
    path.unshift(childIndex(n.parent, n));
    n = n.parent;
  }
  if (!DECLARATIONS.has(n.kind)) return undefined;
  const names: string[] = [];
  for (let s: Node | undefined = n; s; s = s.parent) {
    if (DECLARATIONS.has(s.kind) && "id" in s && s.id) names.unshift((s.id as { sv: string }).sv);
  }
  const ns = namespaceOfNode(n);
  let key = `~${[ns, ...names].filter(Boolean).join(".")}/${path.join(".")}`;
  const args = "templateMapper" in type ? type.templateMapper?.args : undefined;
  if (args?.length) key += `<${args.map(contractTypeKey).join(", ")}>`;
  return key;
}

function childIndex(parent: Node, child: Node): number {
  let i = 0;
  let found = -1;
  visitChildren(parent, (c) => {
    if (c === child) {
      found = i;
      return true;
    }
    i++;
    return undefined;
  });
  return found;
}

/** The compiler's display name prints anonymous arguments structurally, so distinct source
 * declarations with identical fields can have the same display name. Key concrete arguments
 * recursively, retaining normal qualified names for selectors and human-readable contracts. */
export function contractTypeKey(arg: Entity): string {
  if (arg.entityKind === "Indeterminate") return contractTypeKey(arg.type);
  if (arg.entityKind !== "Type") return getEntityName(arg);
  if ((arg.kind === "Model" || arg.kind === "Union" || arg.kind === "Tuple") && !("name" in arg && arg.name)) {
    return anonymousSourceKey(arg) ?? getEntityName(arg);
  }
  if (arg.kind === "Model" && arg.name === "Array" && arg.namespace && isStdNamespace(arg.namespace) && arg.indexer) {
    return `${contractTypeKey(arg.indexer.value)}[]`;
  }
  if ("name" in arg && typeof arg.name === "string" && "templateMapper" in arg && isTemplateInstance(arg)) {
    const ns = arg.namespace && !isStdNamespace(arg.namespace) ? getNamespaceFullName(arg.namespace, { printable: true }) : "";
    const name = printIdentifier(arg.name);
    return `${ns ? ns + "." : ""}${name}<${arg.templateMapper!.args.map(contractTypeKey).join(", ")}>`;
  }
  if (arg.kind === "Number") return arg.numericValue.toString();
  if (arg.kind === "String") return JSON.stringify(arg.value);
  return getEntityName(arg, { printable: true });
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/**
 * The most specific of `keys` (namespace or type names) naming a declaration: its fully qualified
 * name for named types (a namespace includes its sub-namespaces, a type its variants and template
 * instances), the namespace it is written in for anonymous types.
 */
export function matchingKey(d: Decl, keys: readonly string[]): string | undefined {
  const name = d.key ? d.key.replace(/@.*$/, "") : undefined;
  const ns = name === undefined ? typeNamespace(d.source) : undefined;
  if (name === undefined && ns === undefined) return undefined;
  let best: string | undefined;
  for (const k of keys) {
    const hit = name !== undefined ? name === k || name.startsWith(k + ".") || name.startsWith(k + "<") : ns === k || ns!.startsWith(k + ".");
    if (hit && (!best || k.length > best.length)) best = k;
  }
  return best;
}

/** The mapping covering a declaration (its most specific key), if any. */
function mappingOf(d: Decl, mappings: readonly Mapping[]): Mapping | undefined {
  const k = matchingKey(d, mappings.map((m) => m.key));
  return k === undefined ? undefined : mappings.find((m) => m.key === k);
}

/** Declarations referenced directly by a declaration's code (fields, variants, items, values). */
function directDecls(d: Decl): Decl[] {
  const out: Decl[] = [];
  const visit = (t: GoType | undefined) => {
    for (; t; t = t.elem) {
      if (t.decl && t.decl !== d) {
        out.push(t.decl);
        return;
      }
    }
  };
  for (const f of d.fields ?? []) visit(f.type);
  visit(d.additional);
  for (const v of d.variants ?? []) visit(v.type);
  visit(d.fallback?.type);
  for (const t of d.tupleItems ?? []) visit(t);
  visit(d.arrayElem);
  return out;
}

/**
 * Response nulls of shared declarations (response-unset-nullable) come from their contracts: a
 * consumer does not repeat the shared package's selection, which its Go types implement. A
 * selection of the consumer that a shared type does not implement is a conflict, reported here
 * (that type cannot change); such declarations are returned so that the mapping does not report
 * them again. Returns whether a selection was inherited (the consumer then writes response nulls).
 */
export function inheritResponseNulls(decls: Decl[], mappings: readonly Mapping[], diagnostics: Diagnostic[]): { inherited: boolean; conflicts: Set<Decl> } {
  const conflicts = new Set<Decl>();
  let inherited = false;
  const visited = new Set<Decl>();
  const visit = (d: Decl, m: Mapping): void => {
    if (visited.has(d)) return;
    const key = d.key ?? anonymousIdentity(d);
    const entry = key !== undefined && Object.hasOwn(m.contract.decls, key) ? m.contract.decls[key] : undefined;
    if (!entry || "ambiguous" in entry) return;
    visited.add(d);
    const shared = new Set(entry.responseNulls ?? []);
    for (const f of d.fields ?? []) {
      if (f.never || f.literal) continue;
      if (shared.has(f.json) && !f.nullInResponse && f.optional && f.type.cat === "nullable") {
        f.nullInResponse = true;
        inherited = true;
      } else if (!shared.has(f.json) && f.nullInResponse) {
        conflicts.add(d);
        diagnostics.push(createDiagnostic({ code: "external-package", target: f.prop, format: {
          reason: `'response-unset-nullable' writes '${(key ?? "").replace(/@.*$/, "")}.${f.json}' as null when unset, but ${entry.importPath ?? m.contract.importPath}.${entry.name} (external '${m.key}') omits it: select it when generating the shared package, or not here`,
        } }));
      }
    }
    for (const dep of directDecls(d)) visit(dep, m);
  };
  for (const d of decls) {
    const m = mappingOf(d, mappings);
    if (m) visit(d, m);
  }
  return { inherited, conflicts };
}

/** Marks the declarations provided by external packages; reports what cannot be mapped. */
export function applyMappings(
  decls: Decl[],
  mappings: Mapping[],
  fp: Fingerprints,
  own: { options: Record<string, string>; runtime: string; runtimeHash: string },
  diagnostics: Diagnostic[],
  reported: ReadonlySet<Decl> = new Set(),
): void {
  if (!mappings.length) return;
  const report = (target: Type, reason: string) => diagnostics.push(createDiagnostic({ code: "external-package", target, format: { reason } }));
  const checked = new Map<Contract, boolean>();
  const usable = (m: Mapping, target: Type): boolean => {
    const known = checked.get(m.contract);
    if (known !== undefined) return known;
    let ok = true;
    for (const [k, v] of Object.entries(own.options)) {
      // This selection can name consumer-only models. The per-declaration fingerprints
      // include MarshalResponseJSON and every nested encoding, so compare its actual effect.
      if (k === "response-unset-nullable") continue;
      if ((m.contract.options[k] ?? REPRESENTATION_OPTIONS[k as keyof typeof REPRESENTATION_OPTIONS]) !== v) {
        report(target, `option '${k}' is '${v}' here but '${m.contract.options[k]}' in ${m.contract.importPath}; both packages must use the same representation`);
        ok = false;
      }
    }
    if (m.contract.runtime !== own.runtime) {
      report(target, `${m.contract.importPath} uses the runtime ${m.contract.runtime}; set 'runtime: import' and 'runtime-module: ${m.contract.runtime}' so that both packages share the runtime types`);
      ok = false;
    } else if (m.contract.runtimeHash !== own.runtimeHash) {
      report(target, `${m.contract.importPath} was generated by a typespec-go version with a different runtime; regenerate both packages with the same version`);
      ok = false;
    }
    checked.set(m.contract, ok);
    return ok;
  };
  // Each references a concrete Go type in its owner's API. Follow that graph even for a
  // single-type mapping. Mark a pair before descending so recursive models terminate.
  const visited = new Map<Contract, Set<Decl>>();
  const bind = (d: Decl, m: Mapping, dependency: boolean): void => {
    const key = fp.key(d);
    const entry = Object.hasOwn(m.contract.decls, key) ? m.contract.decls[key] : undefined;
    if (!entry || "ambiguous" in entry) {
      if (dependency || (d.key && !d.key.includes("@") && !d.key.includes("<"))) {
        report(d.source, `'${key}' is mapped to ${m.contract.importPath} (external '${m.key}'), which does not declare it unambiguously; regenerate the shared package or narrow the mapping`);
      }
      return;
    }
    let seen = visited.get(m.contract);
    if (!seen) visited.set(m.contract, seen = new Set());
    if (seen.has(d)) return;
    seen.add(d);
    const owner = entry.importPath ?? m.contract.importPath;
    if (reported.has(d)) return; // a conflicting response-null selection, already reported
    if (entry.fingerprint !== fp.fingerprint(d)) {
      report(d.source, `'${key.replace(/@.*$/, "")}' differs from ${owner}.${entry.name} (external '${m.key}'): regenerate the shared package from the same declarations and options`);
      return;
    }
    if (d.external && (d.external.importPath !== owner || d.external.name !== entry.name)) {
      report(d.source, `conflicting Go types for '${key}': ${d.external.importPath}.${d.external.name} and ${owner}.${entry.name}`);
      return;
    }
    d.external = { alias: "", importPath: owner, name: entry.name };
    for (const dep of fp.dependencies(d)) bind(dep, m, true);
  };
  for (const d of decls) {
    const name = d.key ? d.key.replace(/@.*$/, "") : undefined;
    const ns = name === undefined ? typeNamespace(d.source) : undefined;
    if (name === undefined && ns === undefined) continue;
    let best: Mapping | undefined;
    for (const m of mappings) {
      const k = m.key;
      const hit = name !== undefined ? name === k || name.startsWith(k + ".") || name.startsWith(k + "<") : ns === k || ns!.startsWith(k + ".");
      if (hit && (!best || k.length > best.key.length)) best = m;
    }
    if (!best || !usable(best, d.source)) continue;
    bind(d, best, false);
  }
  const paths = [...new Set(decls.flatMap(d => d.external ? [d.external.importPath] : []))].sort();
  for (const d of decls) if (d.external) d.external.alias = `externalRef${paths.indexOf(d.external.importPath)}`;
}

/** Include the owning package of imported dependencies for downstream consumers. */
export function writeContract(
  decls: Decl[],
  fp: Fingerprints,
  info: { importPath: string; package: string; runtime: string; runtimeHash: string; options: Record<string, string> },
  generated: (d: Decl) => boolean = () => true,
): string {
  const entries: Record<string, Entry> = Object.create(null);
  for (const d of decls) {
    const key = fp.key(d);
    // Only what the package declares: generated declarations and the external ones it uses.
    if (d.excluded || (!d.external && !generated(d))) continue;
    const nulls = (d.fields ?? []).filter((f) => f.nullInResponse).map((f) => f.json);
    entries[key] = Object.hasOwn(entries, key) ? { ambiguous: true } : {
      name: d.external?.name ?? d.name,
      fingerprint: fp.fingerprint(d),
      ...(d.external && { importPath: d.external.importPath }),
      ...(nulls.length && { responseNulls: nulls }),
    };
  }
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
  const contract: Contract = { version: CONTRACT_VERSION, ...info, decls: sorted };
  return JSON.stringify(contract, null, 2) + "\n";
}
