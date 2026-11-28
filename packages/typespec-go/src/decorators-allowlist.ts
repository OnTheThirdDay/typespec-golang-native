import type { DecoratorApplication, Type } from "@typespec/compiler";

/**
 * Decorators on data types and properties that the Go emitter maps (directly or through the
 * official @typespec/http APIs) or that do not affect the wire representation. Anything else on
 * a reachable type is reported. Notably *not* listed, and therefore rejected:
 *  - TypeSpec.Versioning.* (versioned projections are not generated)
 *  - TypeSpec.Events/SSE/Streams.* (streaming payloads are not generated)
 *  - TypeSpec.JsonSchema.* (extra constraints without a Go implementation)
 */
const HANDLED = new Set([
  // documentation, naming, encoding
  "TypeSpec.@doc",
  "TypeSpec.@summary",
  "TypeSpec.@encodedName",
  "TypeSpec.@friendlyName",
  "TypeSpec.@encode",
  "TypeSpec.@format", // a hint, never enforced (TypeSpec semantics)
  "TypeSpec.@secret",
  "TypeSpec.@mediaTypeHint",
  "TypeSpec.@example",
  "TypeSpec.@opExample",
  "TypeSpec.@returnsDoc",
  "TypeSpec.@errorsDoc",
  // constraints
  "TypeSpec.@minLength",
  "TypeSpec.@maxLength",
  "TypeSpec.@pattern",
  "TypeSpec.@minValue",
  "TypeSpec.@maxValue",
  "TypeSpec.@minValueExclusive",
  "TypeSpec.@maxValueExclusive",
  "TypeSpec.@minItems",
  "TypeSpec.@maxItems",
  // polymorphism
  "TypeSpec.@discriminated",
  "TypeSpec.@discriminator",
  // visibility (applied through @typespec/http createMetadataInfo)
  "TypeSpec.@visibility",
  "TypeSpec.@invisible",
  "TypeSpec.@removeVisibility",
  "TypeSpec.@defaultVisibility",
  "TypeSpec.@parameterVisibility",
  "TypeSpec.@returnTypeVisibility",
  "TypeSpec.@withOptionalProperties",
  "TypeSpec.@withUpdateableProperties",
  "TypeSpec.@withoutOmittedProperties",
  "TypeSpec.@withPickedProperties",
  "TypeSpec.@withoutDefaultValues",
  "TypeSpec.@withVisibility",
  "TypeSpec.@withDefaultKeyVisibility",
  "TypeSpec.@withLifecycleUpdate",
  "TypeSpec.@withVisibilityFilter",
  "TypeSpec.@applyMergePatch",
  // no wire effect
  "TypeSpec.@key",
  "TypeSpec.@error",
  "TypeSpec.@tag",
  "TypeSpec.@service",
  "TypeSpec.@list",
  "TypeSpec.@offset",
  "TypeSpec.@pageIndex",
  "TypeSpec.@pageItems",
  "TypeSpec.@pageSize",
  "TypeSpec.@continuationToken",
  "TypeSpec.@nextLink",
  "TypeSpec.@prevLink",
  "TypeSpec.@firstLink",
  "TypeSpec.@lastLink",
  "TypeSpec.@inspectType",
  "TypeSpec.@inspectTypeName",
  // HTTP metadata, interpreted by @typespec/http
  "TypeSpec.Http.@header",
  "TypeSpec.Http.@query",
  "TypeSpec.Http.@path",
  "TypeSpec.Http.@cookie",
  "TypeSpec.Http.@body",
  "TypeSpec.Http.@bodyRoot",
  "TypeSpec.Http.@bodyIgnore",
  "TypeSpec.Http.@multipartBody",
  "TypeSpec.Http.@statusCode",
  "TypeSpec.Http.Private.@httpPart",
  "TypeSpec.Http.Private.@httpFile",
  "TypeSpec.Http.Private.@plainData",
  "TypeSpec.Http.Private.@mergePatchModel",
  "TypeSpec.Http.Private.@mergePatchProperty",
  "TypeSpec.Http.Private.@applyMergePatch",
  // HTTP operation decorators (routes, verbs, auth are resolved by @typespec/http)
  "TypeSpec.Http.@get",
  "TypeSpec.Http.@put",
  "TypeSpec.Http.@post",
  "TypeSpec.Http.@patch",
  "TypeSpec.Http.@delete",
  "TypeSpec.Http.@head",
  "TypeSpec.Http.@route",
  "TypeSpec.Http.@useAuth",
  "TypeSpec.Http.@sharedRoute", // dispatched by literal headers / request media type
  "TypeSpec.Http.@server",
  "TypeSpec.@overload",
  "TypeSpec.@deprecated",
  "TypeSpec.Rest.@action",
  "TypeSpec.Rest.@collectionAction",
  "TypeSpec.Rest.@actionSeparator",
  "TypeSpec.Rest.@autoRoute",
  "TypeSpec.Rest.@createsOrReplacesResource",
  "TypeSpec.Rest.@createsOrUpdatesResource",
  "TypeSpec.Rest.@createsResource",
  "TypeSpec.Rest.@deletesResource",
  "TypeSpec.Rest.@listsResource",
  "TypeSpec.Rest.@readsResource",
  "TypeSpec.Rest.@updatesResource",
  // REST resource modelling (routes are resolved by @typespec/http)
  "TypeSpec.Rest.@resource",
  "TypeSpec.Rest.@parentResource",
  "TypeSpec.Rest.@segment",
  "TypeSpec.Rest.@segmentOf",
  "TypeSpec.Rest.@copyResourceKeyParameters",
  "TypeSpec.Rest.Private.@resourceLocation",
  "TypeSpec.Rest.Private.@validateHasKey",
  "TypeSpec.Rest.Private.@validateIsError",
  "TypeSpec.Rest.Private.@resourceTypeForKeyParam",
  // Streams / events / server-sent events (interpreted by the SSE support)
  "TypeSpec.Streams.@streamOf",
  "TypeSpec.Events.@events",
  "TypeSpec.Events.@contentType",
  "TypeSpec.Events.@data",
  "TypeSpec.SSE.@terminalEvent",
  // typespec-structured-output root selection and schema naming (no wire effect); a default
  // factory has the default's meaning, which Go's ApplyDefaults implements
  "StructuredOutput.@structuredOutput",
  "StructuredOutput.@schemaName",
  "StructuredOutput.@defaultFactory",
  // Spector (official HTTP conformance specs) scenario documentation
  "TypeSpec.Spector.@scenario",
  "TypeSpec.Spector.@scenarioDoc",
  "TypeSpec.Spector.@scenarioService",
  // OpenAPI documentation metadata
  "TypeSpec.OpenAPI.@extension",
  "TypeSpec.OpenAPI.@externalDocs",
  "TypeSpec.OpenAPI.@info",
  "TypeSpec.OpenAPI.@operationId",
  "TypeSpec.OpenAPI.@tagMetadata",
  "TypeSpec.OpenAPI.@defaultResponse",
  // XML representation (XML payloads themselves are rejected at the HTTP layer)
  "TypeSpec.Xml.@name",
  "TypeSpec.Xml.@attribute",
  "TypeSpec.Xml.@unwrapped",
  "TypeSpec.Xml.@ns",
  "TypeSpec.Xml.@nsDeclarations",
]);

const HANDLED_FUNCTIONS = new Set([
  "docFromCommentDecorator",
  "indexerDecorator",
  // Spector (official HTTP conformance specs) JavaScript helper decorator, documentation only
  "$modelNameScenario",
]);

export function decoratorId(d: DecoratorApplication): string {
  if (!d.definition) return d.decorator.name;
  const parts: string[] = [];
  for (let n: any = d.definition.namespace; n && n.name; n = n.namespace) parts.unshift(n.name);
  return `${parts.join(".")}.${d.definition.name}`;
}

export function unsupportedDecorators(t: Type & { decorators?: DecoratorApplication[] }): string[] {
  const out: string[] = [];
  for (const d of t.decorators ?? []) {
    if (!d.definition) {
      // Spector helper decorators ($modelNameScenario, $opNameScenario, ...) are documentation only.
      if (!HANDLED_FUNCTIONS.has(d.decorator.name) && !/^\$\w+Scenario$/.test(d.decorator.name)) out.push(d.decorator.name || "<anonymous>");
      continue;
    }
    const id = decoratorId(d);
    if (!HANDLED.has(id)) out.push(id);
  }
  return out;
}
