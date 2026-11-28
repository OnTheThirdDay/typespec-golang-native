import { Numeric } from "@typespec/compiler";
import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";

/**
 * JSON value helpers that mirror the Python `dict`/`list` semantics used by Pydantic and the
 * OpenAI SDK (insertion-ordered objects, `==` equality, hashable keys for de-duplication).
 *
 * Ordered dictionaries preserve Python field order for all JSON member names.
 */
export type Json = null | boolean | number | bigint | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python dictionary for arbitrary user-supplied keys, including indices and __proto__. */
export function orderedObject(): JsonObject {
  const order = new Set<string>();
  return new Proxy(Object.create(null) as JsonObject, {
    ownKeys: () => [...order],
    set(target, key: string, value: Json) {
      order.add(key);
      target[key] = value;
      return true;
    },
    deleteProperty(target, key: string) {
      order.delete(key);
      return delete target[key];
    },
  });
}

/** Python equality: `True == 1`, `1.0 == 1`, dict equality ignores order, list equality does not. */
export function pyEquals(a: Json, b: Json): boolean {
  const na = pyNumber(a);
  const nb = pyNumber(b);
  if (na !== undefined && nb !== undefined) return numEq(na, nb);
  if (na !== undefined || nb !== undefined) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEquals(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b as JsonObject);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEquals((a as JsonObject)[k], (b as JsonObject)[k]));
}

function pyNumber(v: Json): number | bigint | undefined {
  if (typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

function numEq(a: number | bigint, b: number | bigint): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "number" && !Number.isInteger(a)) return false;
  if (typeof b === "number" && !Number.isInteger(b)) return false;
  return BigInt(a) === BigInt(b);
}

/** Port of pydantic's `_make_json_hashable`, rendered as a canonical string key. */
export function hashableKey(v: Json): string {
  const n = pyNumber(v);
  if (n !== undefined) return `n:${typeof n === "number" && !Number.isInteger(n) ? n : BigInt(n)}`;
  if (v === null) return "null";
  if (typeof v === "string") return `s:${JSON.stringify(v)}`;
  if (Array.isArray(v)) return `[${v.map(hashableKey).join(",")}]`;
  const keys = Object.keys(v).sort(pySortCompare);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${hashableKey((v as JsonObject)[k])}`).join(",")}}`;
}

/** Port of pydantic's `_deduplicate_schemas`: last occurrence wins, first position is kept. */
export function deduplicateSchemas(schemas: JsonObject[]): JsonObject[] {
  const map = new Map<string, JsonObject>();
  for (const s of schemas) map.set(hashableKey(s), s);
  return [...map.values()];
}

/** Python `sorted()` order for `str` keys (code point order). */
export function pySortCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0)!;
    const y = cb[i].codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}

export function deepClone<T extends Json>(v: T): T {
  if (Array.isArray(v)) return v.map(x => deepClone(x)) as T;
  if (isObject(v)) {
    const out = orderedObject();
    for (const [k, x] of Object.entries(v)) out[k] = deepClone(x);
    return out as T;
  }
  return v;
}

/** Normalizes an exact integer to `number` when safe, `bigint` otherwise. */
export function exactInteger(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

/** `JSON.stringify` equivalent that supports `bigint` and `indent` (0 = compact). */
export function stringifyJson(v: Json, indent = 2): string {
  const nl = indent > 0 ? "\n" : "";
  const sep = indent > 0 ? ": " : ":";
  const pad = (n: number) => " ".repeat(n * indent);
  const go = (x: Json, level: number): string => {
    if (x === null) return "null";
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new Error("non-finite number in JSON");
      return JSON.stringify(x);
    }
    if (typeof x === "boolean" || typeof x === "string") return JSON.stringify(x);
    if (Array.isArray(x)) {
      if (x.length === 0) return "[]";
      return `[${nl}${x.map((e) => pad(level + 1) + go(e, level + 1)).join(`,${nl}`)}${nl}${pad(level)}]`;
    }
    const keys = Object.keys(x);
    if (keys.length === 0) return "{}";
    const body = keys.map((k) => `${pad(level + 1)}${JSON.stringify(k)}${sep}${go(x[k], level + 1)}`).join(`,${nl}`);
    return `{${nl}${body}${nl}${pad(level)}}`;
  };
  return go(v, 0);
}

/** Preserve source member order, including integer-like keys, and read numeric tokens exactly. */
export function parseJson(text: string): Json {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!root || errors.length) throw new SyntaxError(`Invalid JSON at offset ${errors[0]?.offset ?? 0}`);
  function convert(n: JsonNode): Json {
    if (n.type === "object") {
      const obj = orderedObject();
      for (const property of n.children ?? []) {
        const [key, value] = property.children!;
        if (Object.hasOwn(obj, key.value)) throw new SyntaxError(`Duplicate JSON property ${key.value}`);
        obj[key.value] = convert(value);
      }
      return obj;
    }
    if (n.type === "array") return (n.children ?? []).map(convert);
    if (n.type === "number") {
      const token = text.slice(n.offset, n.offset + n.length);
      const numeric = Numeric(token);
      const integer = numeric.asBigInt();
      if (integer !== null) return exactInteger(integer);
      const number = numeric.asNumber();
      if (number === null) throw new RangeError(`JSON number ${token} exceeds the precision of a Python float`);
      return number;
    }
    return n.value;
  }
  return convert(root);
}

/**
 * Order-sensitive structural comparison used by golden tests. Reports the first difference.
 * Numbers compare by value (Python `1.0` and `1` are the same JSON number).
 */
export function orderedDiff(a: Json, b: Json, path = "$"): string | undefined {
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((key, i) => key !== kb[i])) {
      return `${path}: key order differs: [${ka.join(", ")}] vs [${kb.join(", ")}]`;
    }
    for (const k of ka) {
      const d = orderedDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return undefined;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = orderedDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  const na = typeof a === "number" || typeof a === "bigint" ? a : undefined;
  const nb = typeof b === "number" || typeof b === "bigint" ? b : undefined;
  if (na !== undefined && nb !== undefined) {
    return numEq(na, nb) ? undefined : `${path}: ${String(a)} vs ${String(b)}`;
  }
  if (typeof a !== typeof b || a !== b) {
    return `${path}: ${stringifyJson(a, 0)} vs ${stringifyJson(b, 0)}`;
  }
  return undefined;
}
