import type { DecoratorApplication, Type } from "@typespec/compiler";

/**
 * Decorators whose effect the generator either maps or that have no influence on the JSON
 * representation. Any other decorator on a reachable type is reported, so that new or
 * library-specific semantics (e.g. `@JsonSchema.uniqueItems`, `@Http.header`) are never
 * silently ignored.
 */
const HANDLED = new Set([
  // documentation / naming (mapped)
  "TypeSpec.@doc",
  "TypeSpec.@summary",
  "TypeSpec.@encodedName",
  "TypeSpec.@friendlyName",
  // constraints (mapped)
  "TypeSpec.@minLength",
  "TypeSpec.@maxLength",
  "TypeSpec.@pattern",
  "TypeSpec.@format",
  "TypeSpec.@minValue",
  "TypeSpec.@maxValue",
  "TypeSpec.@minValueExclusive",
  "TypeSpec.@maxValueExclusive",
  "TypeSpec.@minItems",
  "TypeSpec.@maxItems",
  "TypeSpec.@encode", // validated per scalar
  "TypeSpec.@discriminated", // validated per union
  "TypeSpec.@discriminator", // rejected with a specific diagnostic
  // lifecycle visibility (reported as a warning; properties are kept)
  "TypeSpec.@visibility",
  "TypeSpec.@invisible",
  "TypeSpec.@removeVisibility",
  // model transforms whose effect is already reflected in the resulting properties
  "TypeSpec.@withOptionalProperties",
  "TypeSpec.@withUpdateableProperties",
  "TypeSpec.@withoutOmittedProperties",
  "TypeSpec.@withPickedProperties",
  "TypeSpec.@withoutDefaultValues",
  "TypeSpec.@withVisibility",
  "TypeSpec.@withDefaultKeyVisibility",
  "TypeSpec.@withLifecycleUpdate",
  "TypeSpec.@withVisibilityFilter",
  // no effect on the data representation
  "TypeSpec.@key",
  "TypeSpec.@error",
  "TypeSpec.@tag",
  "TypeSpec.@service",
  "TypeSpec.@secret",
  "TypeSpec.@mediaTypeHint",
  "TypeSpec.@parameterVisibility",
  "TypeSpec.@returnTypeVisibility",
  "TypeSpec.@returnsDoc",
  "TypeSpec.@errorsDoc",
  "TypeSpec.@inspectType",
  "TypeSpec.@inspectTypeName",
  "StructuredOutput.@structuredOutput",
  "StructuredOutput.@schemaName",
  "StructuredOutput.@defaultFactory",
]);

/** Implementation-detail decorators without a declaration (doc comments, template instantiation helpers). */
const HANDLED_FUNCTIONS = new Set(["docFromCommentDecorator", "$docFromComment", "indexerDecorator"]);

export function decoratorId(d: DecoratorApplication): string {
  if (d.definition) {
    const ns = namespacePath(d.definition.namespace);
    return `${ns}.${d.definition.name}`;
  }
  return d.decorator.name;
}

function namespacePath(ns: { name: string; namespace?: any } | undefined): string {
  const parts: string[] = [];
  for (let n = ns; n && n.name; n = n.namespace) parts.unshift(n.name);
  return parts.join(".");
}

/** Returns the ids of decorators on `type` that have no Structured Output mapping. */
export function checkDecorators(type: Type & { decorators?: DecoratorApplication[] }): string[] {
  const bad: string[] = [];
  for (const d of type.decorators ?? []) {
    if (!d.definition) {
      if (!HANDLED_FUNCTIONS.has(d.decorator.name)) bad.push(d.decorator.name || "<anonymous decorator>");
      continue;
    }
    const id = decoratorId(d);
    if (!HANDLED.has(id)) bad.push(id);
  }
  return bad;
}
