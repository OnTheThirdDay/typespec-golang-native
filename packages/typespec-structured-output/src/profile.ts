/**
 * Independent validation of a final schema against the OpenAI Structured Outputs subset.
 *
 * Reference: https://developers.openai.com/api/docs/guides/structured-outputs ("Supported schemas"),
 * profile version `openai-2025-11`. The SDK transformation is *not* a validator; this module
 * checks the result explicitly. See docs/openai-profile.md for the rule list and its sources.
 */
import { isObject, type Json, type JsonObject } from "./json.js";
import type { TargetProfile } from "./lib.js";

export interface ProfileViolation {
  path: string;
  reason: string;
  node: JsonObject;
}

export const SUPPORTED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
export const LIMITS = {
  totalProperties: 5000,
  nestingDepth: 10,
  totalStringLength: 120_000,
  totalEnumValues: 1000,
  largeEnumThreshold: 250,
  largeEnumStringLength: 15_000,
};
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const COMMON = new Set(["type", "description", "title", "anyOf", "enum", "const", "$ref"]);
const BY_TYPE: Record<string, Set<string>> = {
  string: new Set(["pattern", "format", "minLength", "maxLength"]),
  number: new Set(["multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum"]),
  integer: new Set(["multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum"]),
  array: new Set(["items", "minItems", "maxItems"]),
  object: new Set(["properties", "required", "additionalProperties"]),
  boolean: new Set(),
  null: new Set(),
};
const FINE_TUNED_UNSUPPORTED = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "patternProperties",
]);

function matchesType(value: Json, types: Json[]): boolean {
  if (typeof value === "bigint" || typeof value === "number") return types.includes("number") || (types.includes("integer") && (typeof value === "bigint" || Number.isInteger(value)));
  return types.includes(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
}

export function validateProfile(
  root: JsonObject,
  name: string,
  profile: Exclude<TargetProfile, "none">,
): ProfileViolation[] {
  const out: ProfileViolation[] = [];
  const report = (path: string, node: JsonObject, reason: string) => out.push({ path, node, reason });

  if (!NAME_PATTERN.test(name)) {
    report("$", root, `schema name '${name}' must match ${NAME_PATTERN.source}`);
  }
  if (root.type !== "object") report("$", root, "the root schema must be an object");
  if ("anyOf" in root) report("$", root, "the root schema must not use anyOf");

  const defs = isObject(root.$defs) ? root.$defs : {};
  let totalProps = 0;
  let stringBudget = 0;
  let enumValues = 0;
  for (const k of Object.keys(defs)) stringBudget += [...k].length;

  const visitSchema = (s: Json, path: string, isRoot = false): void => {
    if (!isObject(s)) {
      out.push({ path, node: {}, reason: "schema must be an object" });
      return;
    }
    const allowed = new Set(COMMON);
    if (s.$defs !== undefined && !isObject(s.$defs)) report(path, s, "'$defs' must be an object");
    if (s.anyOf !== undefined && !Array.isArray(s.anyOf)) report(path, s, "'anyOf' must be an array");
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) report(path, s, "'enum' must be a nonempty array");
    for (const k of ["description", "title", "pattern", "format"]) {
      if (s[k] !== undefined && typeof s[k] !== "string") report(path, s, `'${k}' must be a string`);
    }
    const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
    if (Array.isArray(s.type) && (!types.length || new Set(types).size !== types.length)) report(path, s, "'type' must contain distinct type names");
    for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) {
      const v = s[k];
      if (v !== undefined && !(typeof v === "bigint" && v >= 0n || typeof v === "number" && Number.isInteger(v) && v >= 0)) report(path, s, `'${k}' must be a nonnegative integer`);
    }
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      const v = s[k];
      if (v !== undefined && !(typeof v === "bigint" || (typeof v === "number" && Number.isFinite(v)))) report(path, s, `'${k}' must be a finite number`);
      else if (k === "multipleOf" && (typeof v === "number" || typeof v === "bigint") && v <= 0) report(path, s, "'multipleOf' must be positive");
    }
    if (typeof s.pattern === "string") {
      try { new RegExp(s.pattern, "u"); } catch { report(path, s, "'pattern' must be a valid Unicode-mode ECMAScript expression"); }
    }
    for (const t of types) {
      if (typeof t !== "string" || !Object.hasOwn(BY_TYPE, t)) {
        report(path, s, `unsupported type ${JSON.stringify(t)}`);
        continue;
      }
      for (const k of BY_TYPE[t]) allowed.add(k);
    }
    if (isRoot) allowed.add("$defs");
    for (const key of Object.keys(s)) {
      if (!allowed.has(key)) {
        const why =
          key === "default"
            ? "'default' is not part of the documented subset (option 'default-values')"
            : ["allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "oneOf"].includes(key)
              ? `composition keyword '${key}' is not supported`
              : `keyword '${key}' is not supported${types.length ? ` for type ${types.join("|")}` : " without a type"}`;
        report(`${path}.${key}`, s, why);
      } else if (profile === "openai-fine-tuned" && FINE_TUNED_UNSUPPORTED.has(key)) {
        report(`${path}.${key}`, s, `keyword '${key}' is not supported for fine-tuned models`);
      }
    }
    if (types.length === 0 && !("anyOf" in s) && !("$ref" in s) && !("enum" in s) && !("const" in s)) {
      report(path, s, "schema must declare a type (empty schemas accept any value)");
    }
    if (("enum" in s || "const" in s) && !(types.length === 1 || (types.length === 2 && types.includes("null")))) {
      report(path, s, "enum/const schemas must declare one type, optionally paired with null");
    }
    if (typeof s.format === "string" && !SUPPORTED_FORMATS.has(s.format)) {
      report(`${path}.format`, s, `format '${s.format}' is not supported (supported: ${[...SUPPORTED_FORMATS].join(", ")})`);
    }
    if ("$ref" in s) {
      const ref = s.$ref;
      if (Object.keys(s).length > 1) report(path, s, "'$ref' must not have sibling keywords");
      if (typeof ref !== "string" || !(ref === "#" || (ref.startsWith("#/$defs/") && Object.hasOwn(defs, ref.slice(8))))) {
        report(`${path}.$ref`, s, `reference ${JSON.stringify(ref)} must be '#' or resolve within $defs`);
      }
    }
    if (Array.isArray(s.enum)) {
      enumValues += s.enum.length;
      if (s.enum.some(v => !matchesType(v, types))) report(path, s, "enum value outside its declared type");

      let len = 0;
      for (const v of s.enum) if (typeof v === "string") len += [...v].length;
      stringBudget += len;
      if (s.enum.length > LIMITS.largeEnumThreshold && len > LIMITS.largeEnumStringLength) {
        report(`${path}.enum`, s, `an enum with more than ${LIMITS.largeEnumThreshold} values may total at most ${LIMITS.largeEnumStringLength} characters (has ${len})`);
      }
    }
    if (s.const !== undefined && !matchesType(s.const, types)) report(path, s, "const value outside its declared type");
    if (typeof s.const === "string") stringBudget += [...s.const].length;
    if (Array.isArray(s.anyOf)) {
      if (s.anyOf.length === 0) report(`${path}.anyOf`, s, "anyOf must not be empty");
      s.anyOf.forEach((m, i) => visitSchema(m, `${path}.anyOf[${i}]`));
    }
    if (types.includes("array")) {
      if (!isObject(s.items)) report(path, s, "array schemas must declare 'items'");
      else visitSchema(s.items, `${path}.items`);
    }
    if (types.includes("object")) {
      if (s.additionalProperties !== false) report(path, s, "objects must set 'additionalProperties: false'");
      const props = isObject(s.properties) ? s.properties : undefined;
      if (!props) {
        report(path, s, "object schemas must declare 'properties'");
      } else {
        const keys = Object.keys(props);
        totalProps += keys.length;
        for (const k of keys) stringBudget += [...k].length;
        const req = Array.isArray(s.required) ? s.required : [];
        if (!Array.isArray(s.required) || new Set(req).size !== req.length) report(path, s, "required must be an array of unique property names");
        const missing = keys.filter((k) => !req.includes(k));
        if (missing.length) report(`${path}.required`, s, `every property must be required (missing: ${missing.join(", ")})`);
        const extra = req.filter((r) => typeof r !== "string" || !keys.includes(r));
        if (extra.length) report(`${path}.required`, s, `required lists unknown properties: ${extra.join(", ")}`);
        for (const k of keys) visitSchema(props[k], `${path}.properties.${k}`);
      }
    }
  };

  visitSchema(root, "$", true);
  for (const [k, d] of Object.entries(defs)) visitSchema(d, `$.$defs.${k}`);

  if (totalProps > LIMITS.totalProperties) {
    report("$", root, `the schema has ${totalProps} object properties; at most ${LIMITS.totalProperties} are allowed`);
  }
  if (stringBudget > LIMITS.totalStringLength) {
    report("$", root, `property names, definition names, enum and const values total ${stringBudget} characters; at most ${LIMITS.totalStringLength} are allowed`);
  }
  if (enumValues > LIMITS.totalEnumValues) {
    report("$", root, `the schema has ${enumValues} enum values; at most ${LIMITS.totalEnumValues} are allowed`);
  }
  const depth = nestingDepth(root, defs);
  if (depth > LIMITS.nestingDepth) {
    report("$", root, `object nesting depth is ${depth}; at most ${LIMITS.nestingDepth} levels are allowed`);
  }
  return out;
}

/**
 * Maximum depth of nested object schemas (the root object is level 1). References are followed;
 * a reference back to a definition already on the current path (recursion) ends that path, since
 * OpenAI explicitly supports recursive schemas.
 */
export function nestingDepth(root: JsonObject, defs: JsonObject): number {
  const go = (s: Json, stack: string[]): number => {
    if (!isObject(s)) return 0;
    if (typeof s.$ref === "string") {
      const name = s.$ref === "#" ? "#" : s.$ref.slice(8);
      if (stack.includes(name)) return 0;
      const target = name === "#" ? root : defs[name];
      return go(target, [...stack, name]);
    }
    let child = 0;
    if (Array.isArray(s.anyOf)) for (const m of s.anyOf) child = Math.max(child, go(m, stack));
    if (isObject(s.items)) child = Math.max(child, go(s.items, stack));
    const isObj = s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"));
    if (isObj && isObject(s.properties)) {
      let inner = 0;
      for (const p of Object.values(s.properties)) inner = Math.max(inner, go(p, stack));
      return Math.max(1 + inner, child);
    }
    return child;
  };
  return go(root, ["#"]);
}
