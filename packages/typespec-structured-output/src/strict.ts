/**
 * Port of `openai.lib._pydantic._ensure_strict_json_schema` / `to_strict_json_schema`.
 *
 * Source: https://github.com/openai/openai-python/blob/v3.59.0/src/openai/lib/_pydantic.py
 * Copyright 2024 OpenAI, licensed under the Apache License 2.0 (see THIRD_PARTY_NOTICES.md).
 *
 * The port intentionally preserves the reference behaviour, including dict key ordering,
 * in-place mutation and aliasing of resolved `$ref` targets, because the emitted schema must be
 * structurally identical to what the SDK sends to the API.
 */
import { orderedObject, isObject, type Json, type JsonObject } from "./json.js";

export class StrictTransformError extends Error {}

/** Applies the SDK transformation in place and returns the (possibly replaced) root. */
export function toStrictJsonSchema(schema: JsonObject): JsonObject {
  return ensureStrict(schema, [], schema, new Set());
}

function ensureStrict(jsonSchema: Json, path: string[], root: JsonObject, active: Set<JsonObject>): JsonObject {
  if (!isObject(jsonSchema)) {
    throw new StrictTransformError(`Expected ${JSON.stringify(jsonSchema)} to be a dictionary; path=${path.join("/")}`);
  }

  if (active.has(jsonSchema)) throw new StrictTransformError(`SDK reference expansion revisits a recursive field at ${path.join("/")}`);
  active.add(jsonSchema);
  const defs = jsonSchema["$defs"];
  if (isObject(defs)) {
    for (const [name, def] of Object.entries(defs)) ensureStrict(def, [...path, "$defs", name], root, active);
  }
  const definitions = jsonSchema["definitions"];
  if (isObject(definitions)) {
    for (const [name, def] of Object.entries(definitions)) ensureStrict(def, [...path, "definitions", name], root, active);
  }

  if (jsonSchema["type"] === "object" && !("additionalProperties" in jsonSchema)) {
    jsonSchema["additionalProperties"] = false;
  }

  const properties = jsonSchema["properties"];
  if (isObject(properties)) {
    jsonSchema["required"] = Object.keys(properties);
    const next = orderedObject();
    for (const [key, prop] of Object.entries(properties)) {
      next[key] = ensureStrict(prop, [...path, "properties", key], root, active);
    }
    jsonSchema["properties"] = next;
  }

  const items = jsonSchema["items"];
  if (isObject(items)) {
    jsonSchema["items"] = ensureStrict(items, [...path, "items"], root, active);
  }

  const anyOf = jsonSchema["anyOf"];
  if (Array.isArray(anyOf)) {
    jsonSchema["anyOf"] = anyOf.map((v, i) => ensureStrict(v, [...path, "anyOf", String(i)], root, active));
  }

  const allOf = jsonSchema["allOf"];
  if (Array.isArray(allOf)) {
    if (allOf.length === 1) {
      Object.assign(jsonSchema, ensureStrict(allOf[0], [...path, "allOf", "0"], root, active));
      delete jsonSchema["allOf"];
    } else {
      jsonSchema["allOf"] = allOf.map((v, i) => ensureStrict(v, [...path, "allOf", String(i)], root, active));
    }
  }

  if ("default" in jsonSchema && jsonSchema["default"] === null) {
    delete jsonSchema["default"];
  }

  const ref = jsonSchema["$ref"];
  if (ref && Object.keys(jsonSchema).length > 1) {
    if (typeof ref !== "string") throw new StrictTransformError(`Received non-string $ref - ${JSON.stringify(ref)}`);
    const resolved = resolveRef(root, ref);
    if (!isObject(resolved)) {
      throw new StrictTransformError(`Expected \`$ref: ${ref}\` to resolved to a dictionary but got ${JSON.stringify(resolved)}`);
    }
    // properties from the json schema take priority over the ones on the `$ref`
    Object.assign(jsonSchema, { ...resolved, ...jsonSchema });
    delete jsonSchema["$ref"];
    active.delete(jsonSchema);
    return ensureStrict(jsonSchema, path, root, active);
  }
  active.delete(jsonSchema);
  return jsonSchema;
}

export function resolveRef(root: JsonObject, ref: string): Json {
  if (!ref.startsWith("#/")) throw new StrictTransformError(`Unexpected $ref format '${ref}'; Does not start with #/`);
  let resolved: Json = root;
  for (const key of ref.slice(2).split("/")) {
    if (!isObject(resolved) || !(key in resolved)) {
      throw new StrictTransformError(`Cannot resolve ${ref}`);
    }
    const value: Json = resolved[key];
    if (!isObject(value)) throw new StrictTransformError(`encountered non-dictionary entry while resolving ${ref}`);
    resolved = value;
  }
  return resolved;
}
