/**
 * Distribution of generated declarations over the files of the (single) Go package.
 *
 *  - `single`: every declaration in models.go.
 *  - `per-namespace`: one file per TypeSpec namespace, `models.<namespace>.go`.
 *  - `per-source-file`: one file per project .tsp file, `models.<relative path>.go`.
 *
 * A declaration lives where its TypeSpec type is written: anonymous types, literal unions and
 * tuples next to the declaration that contains them, visibility and merge-patch variants next to
 * their model, template instances (and their anonymous members) next to their first
 * project-declared template argument, else next to the template. Declarations without a project
 * location (library types, synthesized types) and the shared pattern variables stay in models.go.
 * The layout only moves code between files: names, imports and behaviour are unchanged.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type Program, type Type, getSourceLocation } from "@typespec/compiler";
import { type Node, SyntaxKind } from "@typespec/compiler/ast";
import type { Decl } from "./model.js";

export type FileLayout = "single" | "per-namespace" | "per-source-file";

export const SHARED_FILE = "models.go";

/** Output file of each declaration (SHARED_FILE when it has no home of its own). */
export function assignFiles(program: Program, decls: Decl[], layout: FileLayout): Map<Decl, string> {
  const out = new Map<Decl, string>();
  if (layout === "single") {
    for (const d of decls) out.set(d, SHARED_FILE);
    return out;
  }
  const keys = new Map<Decl, string>();
  for (const d of decls) {
    const key = homeKey(program, d.source, layout, new Set());
    if (key !== undefined) keys.set(d, key);
  }
  const names = fileNames([...new Set(keys.values())], layout);
  for (const d of decls) out.set(d, keys.has(d) ? names.get(keys.get(d)!)! : SHARED_FILE);
  return out;
}

/** Namespace full name or project-relative source path of the declaration's home, if any. */
function homeKey(program: Program, t: Type, layout: FileLayout, seen: Set<Type>): string | undefined {
  if (seen.has(t)) return undefined;
  seen.add(t);
  // Template instances, and the anonymous types written inside them (which share the instance's
  // template mapper), belong to their first template argument declared in the project, so that
  // `Page<Order>` lives with Order; otherwise to the template declaration.
  for (const a of (t as { templateMapper?: { args: readonly unknown[] } }).templateMapper?.args ?? []) {
    const arg = (a as { entityKind?: string }).entityKind === "Indeterminate" ? (a as { type: Type }).type : (a as Type);
    if (arg.entityKind !== "Type") continue;
    const k = homeKey(program, arg, layout, seen);
    if (k !== undefined) return k;
  }
  const node = t.node;
  const file = node ? getSourceLocation(node).file : undefined;
  if (!node || !file || program.getSourceFileLocationContext(file).type !== "project") return undefined;
  if (layout === "per-source-file") return posix.relative(program.projectRoot, file.path);
  return namespaceOfNode(node) || undefined;
}

/** Namespace in which a type is written (anonymous types included); undefined without a node. */
export function typeNamespace(t: Type): string | undefined {
  return t.node ? namespaceOfNode(t.node) : undefined;
}

/** Full name of the namespace a node is written in (block and blockless namespaces). */
export function namespaceOfNode(node: Node): string {
  const parts: string[] = [];
  let n: Node = node;
  for (; n.parent; n = n.parent) {
    if (n.kind === SyntaxKind.NamespaceStatement) parts.unshift(n.id.sv);
  }
  // Blockless `namespace A.B;` statements scope the rest of the file without containing it.
  const scope = n.kind === SyntaxKind.TypeSpecScript ? n.inScopeNamespaces.map((x) => x.id.sv).reverse() : [];
  return [...scope, ...parts].join(".");
}

/**
 * Portable, collision-free file names. Names start with `models.`, so the part before the first
 * dot (which go/build examines for _GOOS/_GOARCH constraints, and Windows for reserved device
 * names) is always `models`; segments are lower-case [a-z0-9_] (no case-only differences), a
 * trailing `_test` is never produced, and colliding keys are numbered in sorted key order.
 */
export function fileNames(keys: string[], layout: Exclude<FileLayout, "single">): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = layout === "per-namespace" ? key.split(".").map(snake) : key.replace(/\.tsp$/i, "").split("/").map((s) => (s === ".." ? "up" : sanitize(s)));
    let stem = segments.join(".");
    if (stem.length > 120) stem = stem.slice(0, 111).replace(/[._]+$/, "") + "_" + createHash("sha256").update(key).digest("hex").slice(0, 8);
    if (stem.endsWith("_test")) stem += "_"; // `_test.go` files are test sources
    let name = stem;
    for (let i = 2; used.has(name); i++) name = `${stem}_${i}`;
    used.add(name);
    out.set(key, `models.${name}.go`);
  }
  return out;
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/** `WidgetManager` → `widget_manager`, `HTTPServer` → `http_server`, `v2Beta` → `v2_beta`. */
function snake(s: string): string {
  return sanitize(s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2"));
}
