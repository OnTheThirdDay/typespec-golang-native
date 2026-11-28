/**
 * Output organization (option `file-layout`): where each root's schema file is written.
 *
 *  - `single`: `<Root>.json` (default).
 *  - `per-namespace`: `<namespace path>/<Root>.json`, e.g. `shop/catalog/Product.json`.
 *  - `per-source-file`: `<source path>/<Root>.json` for the project .tsp file declaring the root,
 *    e.g. `catalog/products/Product.json`.
 *
 * Only the directory changes: file names (the root names), schema contents and `$defs` are the
 * same in every layout. Directory segments are lower-case `[a-z0-9_]` (the same normalization as
 * typespec-go's file layout), Windows device names get a trailing `_`, and distinct namespaces or
 * files that normalize to the same directory are numbered in sorted order. Roots outside a
 * namespace or outside the project are written at the top level.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type Model, type Program, getNamespaceFullName, getSourceLocation } from "@typespec/compiler";

export type FileLayout = "single" | "per-namespace" | "per-source-file";

/** Relative output path of each root schema (posix separators). */
export function rootFiles(program: Program, roots: { model: Model; name: string }[], layout: FileLayout): string[] {
  if (layout === "single") return roots.map((r) => `${r.name}.json`);
  const keys = roots.map((r) => homeKey(program, r.model, layout));
  const dirs = directoryNames([...new Set(keys.filter((k): k is string => k !== undefined))], layout);
  return roots.map((r, i) => (keys[i] === undefined ? "" : dirs.get(keys[i]!)! + "/") + `${r.name}.json`);
}

function homeKey(program: Program, model: Model, layout: FileLayout): string | undefined {
  if (layout === "per-namespace") {
    const ns = model.namespace ? getNamespaceFullName(model.namespace) : "";
    return ns || undefined;
  }
  const file = model.node ? getSourceLocation(model.node).file : undefined;
  if (!file || program.getSourceFileLocationContext(file).type !== "project") return undefined;
  return posix.relative(program.projectRoot, file.path);
}

export function directoryNames(keys: string[], layout: Exclude<FileLayout, "single">): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = layout === "per-namespace" ? key.split(".").map(snake) : key.replace(/\.tsp$/i, "").split("/").map((s) => (s === ".." ? "up" : sanitize(s)));
    const base = segments.map(s => {
      if (s.length > 120) return s.slice(0, 111) + "_" + createHash("sha256").update(s).digest("hex").slice(0, 8);
      return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(s) ? s + "_" : s;
    }).join("/");
    let dir = base;
    for (let i = 2; used.has(dir); i++) dir = `${base}_${i}`;
    used.add(dir);
    out.set(key, dir);
  }
  return out;
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/** `WidgetManager` → `widget_manager`, `HTTPServer` → `http_server`. */
function snake(s: string): string {
  return sanitize(s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2"));
}
