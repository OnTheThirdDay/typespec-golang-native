/**
 * Port of the definition-reference bookkeeping of `pydantic.json_schema.GenerateJsonSchema`
 * (`get_defs_ref`, `normalize_name`, `_DefinitionsRemapping`, `generate`, `sort`, garbage collection).
 *
 * Source: https://github.com/pydantic/pydantic/blob/v2.14.4/pydantic/json_schema.py
 * Copyright (c) 2017 to present Pydantic Services Inc. and individual contributors, MIT License
 * (see THIRD_PARTY_NOTICES.md).
 */
import { orderedObject, deduplicateSchemas, deepClone, isObject, pyEquals, pySortCompare, type Json, type JsonObject } from "../json.js";

const MODE_TITLE = "Input"; // validation mode, the mode used by `model_json_schema()` and the OpenAI SDK

export function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/gu, "_").replace(/\./g, "__");
}

// Unicode 15.0 titlecase exceptions from CPython 3.12 str.title. The ordinary mapping is
// the uppercase expansion with its tail lowercased. Digraphs and Greek iota subscripts have
// their own titlecase forms. Mkhedruli letters have no initial capital in titlecase.
const titleForms = new Map<string, string>();
for (const [letters, title] of [
  ["ŉ", "ʼN"],
  ["Ǆǅǆ", "ǅ"],
  ["Ǉǈǉ", "ǈ"],
  ["Ǌǋǌ", "ǋ"],
  ["Ǳǲǳ", "ǲ"],
  ["ჽ", "ჽ"],
  ["ჾ", "ჾ"],
  ["ჿ", "ჿ"],
  ["ᾲ", "Ὰͅ"],
  ["ᾳᾼ", "ᾼ"],
  ["ᾴ", "Άͅ"],
  ["ᾷ", "ᾼ͂"],
  ["ῂ", "Ὴͅ"],
  ["ῃῌ", "ῌ"],
  ["ῄ", "Ήͅ"],
  ["ῇ", "ῌ͂"],
  ["ῲ", "Ὼͅ"],
  ["ῳῼ", "ῼ"],
  ["ῴ", "Ώͅ"],
  ["ῷ", "ῼ͂"],
]) for (const ch of letters) titleForms.set(ch, title);

function initialTitle(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x10d0 && cp <= 0x10fa) return ch;
  if (cp >= 0x1f80 && cp <= 0x1f87) return String.fromCodePoint(cp + 8);
  if (cp >= 0x1f88 && cp <= 0x1f8f) return ch;
  if (cp >= 0x1f90 && cp <= 0x1f97) return String.fromCodePoint(cp + 8);
  if (cp >= 0x1f98 && cp <= 0x1f9f) return ch;
  if (cp >= 0x1fa0 && cp <= 0x1fa7) return String.fromCodePoint(cp + 8);
  if (cp >= 0x1fa8 && cp <= 0x1faf) return ch;
  const upper = [...ch.toUpperCase()];
  return titleForms.get(ch) ?? (upper[0] + upper.slice(1).join("").toLowerCase());
}

/** Python str.title uses the preceding character's Cased property. Lowercase the whole input
 * for context-sensitive mappings such as Greek final sigma. */
export function pyTitle(s: string): string {
  const lower = s.toLowerCase();
  let offset = 0;
  let result = "";
  let prevCased = false;
  for (const ch of s) {
    const end = offset + ch.toLowerCase().length;
    result += prevCased ? lower.slice(offset, end) : initialTitle(ch);
    offset = end;
    prevCased = /\p{Cased}/u.test(ch);
  }
  return result;
}

/** `GenerateJsonSchema.get_title_from_name`, including Python's whitespace set. */
export function titleFromName(name: string): string {
  return pyTitle(name).replace(/_/g, " ").replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
}

/**
 * Bookkeeping equivalent to Pydantic's `core_to_defs_refs` / `definitions` /
 * `_prioritized_defsref_choices` state for one `generate()` call.
 */
export class DefinitionRegistry {
  readonly definitions = new Map<string, JsonObject>();
  private readonly prioritized = new Map<string, string[]>();
  private readonly coreToDefs = new Map<string, string>();
  private readonly collisionCounter = new Map<string, number>();
  private readonly collisionIndex = new Map<string, number>();

  /** `get_cache_defs_ref_schema`: returns the provisional defs ref for a core ref. */
  defsRefFor(coreRef: string): string {
    const existing = this.coreToDefs.get(coreRef);
    if (existing) return existing;
    const ref = this.getDefsRef(coreRef);
    this.coreToDefs.set(coreRef, ref);
    return ref;
  }

  private getDefsRef(coreRef: string): string {
    const components = coreRef.split(/([\][,])/).map((x) => rsplitColon(x));
    const coreRefNoId = components.join("");
    const shortRef = components.map((x) => x.replace(/(?:[^.[\]]+\.)+((?:[^.[\]]+))/g, "$1")).join("");
    const name = normalizeName(shortRef);
    const nameMode = `${normalizeName(shortRef)}-${MODE_TITLE}`;
    const moduleQualname = normalizeName(coreRefNoId);
    const moduleQualnameMode = `${moduleQualname}-${MODE_TITLE}`;
    const moduleQualnameId = normalizeName(coreRef);
    let occurrence = this.collisionIndex.get(moduleQualnameId);
    if (occurrence === undefined) {
      const c = (this.collisionCounter.get(moduleQualname) ?? 0) + 1;
      this.collisionCounter.set(moduleQualname, c);
      occurrence = c;
      this.collisionIndex.set(moduleQualnameId, c);
    }
    const occ = `${moduleQualname}__${occurrence}`;
    const occMode = `${moduleQualnameMode}__${occurrence}`;
    this.prioritized.set(occMode, [name, nameMode, moduleQualname, moduleQualnameMode, occ, occMode]);
    return occMode;
  }

  /**
   * `generate()` post-processing: root unpacking, garbage collection, definition remapping and
   * sorting. `root` is the schema returned for the top-level type (typically `{"$ref": ...}`).
   */
  finalize(root: JsonObject, origins?: WeakMap<object, unknown>): JsonObject {
    let schema = root;
    const counts = this.jsonRefCounts(schema);
    const ref = schema["$ref"];
    if (typeof ref === "string") {
      const target = this.definitions.get(defsRefOf(ref));
      if (counts.get(ref) === 1 && target !== undefined && Object.keys(schema).length === 1) {
        schema = { ...target };
        const o = origins?.get(target);
        if (o !== undefined) origins!.set(schema, o);
      }
    }
    this.garbageCollect(schema);
    const remapping = this.buildRemapping();
    if (this.definitions.size > 0) {
      schema["$defs"] = Object.fromEntries(this.definitions);
    }
    schema = remapping.remap(schema) as JsonObject;
    return sortSchema(schema, undefined, origins);
  }

  private jsonRefCounts(schema: Json): Map<string, number> {
    const counts = new Map<string, number>();
    const visit = (s: Json): void => {
      if (isObject(s)) {
        const r = s["$ref"];
        if (typeof r === "string") {
          const visited = counts.has(r);
          counts.set(r, (counts.get(r) ?? 0) + 1);
          if (visited) return;
          const def = this.definitions.get(defsRefOf(r));
          if (def) visit(def);
        }
        for (const [k, v] of Object.entries(s)) {
          if (k === "examples" && Array.isArray(v)) continue;
          visit(v);
        }
      } else if (Array.isArray(s)) {
        s.forEach(visit);
      }
    };
    visit(schema);
    return counts;
  }

  private garbageCollect(schema: Json): void {
    const visited = new Set<string>();
    const pending = [...allJsonRefs(schema)];
    while (pending.length) {
      const next = defsRefOf(pending.pop()!);
      if (visited.has(next)) continue;
      visited.add(next);
      const def = this.definitions.get(next);
      if (def) pending.push(...allJsonRefs(def));
    }
    for (const k of [...this.definitions.keys()]) if (!visited.has(k)) this.definitions.delete(k);
  }

  private buildRemapping(): Remapping {
    const copied = deepClone(Object.fromEntries(this.definitions)) as JsonObject;
    let definitionsSchema: JsonObject = { $defs: copied };
    for (let iter = 0; iter < 100; iter++) {
      const schemasFor = new Map<string, JsonObject[]>();
      for (const defsRef of Object.keys(copied)) {
        for (const alt of this.prioritized.get(defsRef)!) {
          const list = schemasFor.get(alt) ?? [];
          list.push(copied[defsRef] as JsonObject);
          schemasFor.set(alt, list);
        }
      }
      for (const [k, list] of schemasFor) if (list.length > 1) schemasFor.set(k, deduplicateSchemas(list));
      const defsRemap = new Map<string, string>();
      const jsonRemap = new Map<string, string>();
      for (const original of this.definitions.keys()) {
        const alts = this.prioritized.get(original)!;
        const chosen = alts.find((x) => schemasFor.get(x)!.length === 1)!;
        defsRemap.set(original, chosen);
        for (const alt of alts.slice(alts.indexOf(chosen))) jsonRemap.set(jsonRef(alt), jsonRef(chosen));
      }
      const remapping = new Remapping(defsRemap, jsonRemap);
      const next = remapping.remap({ $defs: copied }) as JsonObject;
      if (pyEquals(definitionsSchema, next)) return remapping;
      definitionsSchema = next;
    }
    throw new Error("Failed to simplify the JSON schema definitions");
  }
}

class Remapping {
  constructor(
    private readonly defs: Map<string, string>,
    private readonly json: Map<string, string>,
  ) {}

  /** `_DefinitionsRemapping.remap_json_schema` (mutates dicts in place, like the reference). */
  remap(schema: Json): Json {
    if (typeof schema === "string") return this.json.get(schema) ?? schema;
    if (Array.isArray(schema)) return schema.map((x) => this.remap(x));
    if (isObject(schema)) {
      for (const [key, value] of Object.entries(schema)) {
        if (key === "$ref" && typeof value === "string") {
          schema["$ref"] = this.json.get(value) ?? value;
        } else if (key === "$defs" && isObject(value)) {
          const next= orderedObject();
          for (const [k, v] of Object.entries(value)) next[this.defs.get(k) ?? k] = this.remap(v);
          schema["$defs"] = next;
        } else {
          schema[key] = this.remap(value);
        }
      }
    }
    return schema;
  }
}

/** `GenerateJsonSchema.sort` / `_sort_recursive`. */
export function sortSchema(value: JsonObject, parentKey?: string, origins?: WeakMap<object, unknown>): JsonObject {
  return sortRecursive(value, parentKey, origins) as JsonObject;
}

function sortRecursive(value: Json, parentKey: string | undefined, origins: WeakMap<object, unknown> | undefined): Json {
  if (isObject(value)) {
    let keys = Object.keys(value);
    if (parentKey !== "properties" && parentKey !== "default") keys = [...keys].sort(pySortCompare);
    const out= orderedObject();
    for (const k of keys) out[k] = sortRecursive(value[k], k, origins);
    const o = origins?.get(value);
    if (o !== undefined) origins!.set(out, o);
    return out;
  }
  if (Array.isArray(value)) return value.map((x) => sortRecursive(x, parentKey, origins));
  return value;
}

export function jsonRef(defsRef: string): string {
  return `#/$defs/${defsRef}`;
}

function defsRefOf(ref: string): string {
  return ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : ref;
}

function rsplitColon(x: string): string {
  const i = x.lastIndexOf(":");
  return i < 0 ? x : x.slice(0, i);
}

function allJsonRefs(item: Json): Set<string> {
  const refs = new Set<string>();
  const stack: Json[] = [item];
  while (stack.length) {
    const cur = stack.pop()!;
    if (isObject(cur)) {
      for (const [k, v] of Object.entries(cur)) {
        if (k === "examples" && Array.isArray(v)) continue;
        if (k === "$ref" && typeof v === "string") refs.add(v);
        else if (isObject(v)) stack.push(v);
        else if (Array.isArray(v)) stack.push(...v);
      }
    } else if (Array.isArray(cur)) {
      stack.push(...cur);
    }
  }
  return refs;
}
