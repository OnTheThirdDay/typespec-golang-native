# Reuse assessment

This records what was evaluated for reuse, the executable evidence, and the decision. The
experiments live in [`experiments/`](../experiments) and can be re-run at any time.

## 1. `@typespec/json-schema` (1.18.0) for `typespec-structured-output`

### What was inspected

* Public API (`dist/src/index.d.ts`): `$onEmit`, the `TypeSpec.JsonSchema` decorators and their
  getters (`getMultipleOf`, `getPrefixItems`, `getExtensions`, ...). The generator class
  `JsonSchemaEmitter` is marked `@internal` and is not reachable through the package `exports`
  map, so it cannot be subclassed or called without importing a private file path.
* Implementation (`dist/src/json-schema-emitter.js`, ~900 lines): an `@typespec/asset-emitter`
  `TypeEmitter`. Scalar mapping (`#getSchemaForStdScalars`), constraint application
  (`#applyConstraints`), default serialization (`serializeValueAsJson`), docs (`getDoc` →
  `description`, `getSummary` → `title`). All of these are thin calls to **public compiler APIs**.
* Options: `bundleId`, `emitAllModels`, `int64-strategy`, `polymorphic-models-strategy`, ...

### Executable comparison

`node experiments/json-schema-reuse/compare.mjs` emits every Structured Output fixture with the
official emitter (bundled, `emitAllModels`) and diffs the result with the committed Pydantic
2.14.4 + OpenAI SDK 3.59.0 reference (`model_json_schema()`). Result: **all 9 cases differ (105
differences)**. `node experiments/json-schema-reuse/semantic-loss/run.mjs` shows additional
semantic problems.

| # | Difference (measured) | Needs TypeSpec semantics to fix? |
|---|---|---|
| 1 | `$schema` / `$id` on every declaration | no |
| 2 | `$ref: "X.json"` file references vs `#/$defs/X` | no |
| 3 | Generic instance names `PageItem` vs Pydantic `Page_Item_` / title `Page[Item]` | **yes** (template arguments) |
| 4 | Two `Foo` types in different namespaces → `duplicate-id` **error**; Pydantic disambiguates (`A__Foo`) | **yes** |
| 5 | `@encodedName("application/json", …)` ignored — property emitted under the TypeSpec name | **yes** (semantic loss) |
| 6 | Inheritance as `allOf: [{$ref: Base}]`; Pydantic flattens inherited fields first | partly |
| 7 | Named unions and custom scalars hoisted to their own definitions; Pydantic inlines them | **yes** (which defs are unions/scalars) |
| 8 | Literal unions as `anyOf` of `const` (`type: number` for ints); Pydantic `Literal[...]` → `enum` + `type: integer` | no |
| 9 | No model titles, no field titles (`"Title"` from `str.title()`), no enum titles | partly (field-title rule depends on the type) |
| 10 | Optional nullable fields lack `default: null` | no |
| 11 | Non-recursive roots must be unpacked, unreachable defs removed, keys sorted (Pydantic `generate()`) | no |
| 12 | `bytes`, `decimal`, `int64` silently emitted as `{type: string}` / `contentEncoding` with **no diagnostic** | **yes** (fail-closed needs source locations) |
| 13 | Unknown decorators are silently ignored | **yes** |

### Decision

Reusing the official emitter would mean: invoking a private class or running `$onEmit` against a
proxied program to capture its output, recomputing `@typespec/asset-emitter`'s internal declaration
naming to map `$defs` back to TypeSpec types (needed for rows 3, 4, 5, 7, 12, 13), and then rewriting
nearly every node. What remains genuinely reused would be the ~60-line scalar table and the
constraint getters — which are themselves calls to public compiler APIs.

So `typespec-structured-output` generates directly from the semantic model using the **same public
compiler APIs** the official emitter uses (`getMinLength`, `getPattern`, `getFormat`,
`getMinValueAsNumeric`, `serializeValueAsJson`, `getDoc`, `getSummary`, `resolveEncodedName`,
`getDiscriminatedUnion`, ...), and implements only the Pydantic-specific representation:

* `src/pydantic/defs.ts` – port of Pydantic's definition naming, collision remapping, root
  unpacking, garbage collection and key sorting (needed for rows 3, 4, 11; copied, MIT).
* `src/strict.ts` – port of the OpenAI SDK `to_strict_json_schema` (copied, Apache-2.0).
* `src/pydantic/generator.ts` – the type mapping (rows 5–10, 12, 13).
* `src/profile.ts` – independent OpenAI target validation.

The official emitter is still used, as a **differential oracle**: the test suite checks that leaf
fragments (scalar `type`/`format`, constraint keywords and values, defaults) agree with
`@typespec/json-schema` output for the same declarations, so the two cannot drift apart silently.

## 2. Go emitter (`typespec-go`)

Inspected revisions: Azure/typespec-azure `6d580c67` (packages/typespec-go 0.19.0),
ogen-go/ogen `3d90c0ca`, oapi-codegen/oapi-codegen `977b0d44`, @typespec/http 1.18.0,
@typespec/http-specs 0.1.0-alpha.46.

| Component | Candidate | Evidence | Decision |
|---|---|---|---|
| Overall generator | Azure `typespec-go` | 23k lines; built on `@azure-tools/typespec-client-generator-core` and its own Go codemodel; generates **clients** plus "fake" servers; generated code imports `github.com/Azure/azure-sdk-for-go/sdk/azcore` for serde/null handling. | Not reused as a whole: client-SDK and azcore assumptions, TCGC dependency. |
| Go naming (reserved words, acronyms, word splitting) | Azure `src/naming/{mappings,naming}.ts` | Self-contained, MIT, tested in production. | **Copied** (`src/naming/naming.ts`, `src/naming/mappings.ts`). |
| JSON kind probe for unions | Azure `unions.ts` (`probeJSONKind`, `jsonNumberIsFloat`) | 40 lines of Go, MIT. | **Copied** into the runtime (`union.go`). Azure's object-variant matcher (required-field presence heuristics) is *not* used: it accepts values that fail full decoding of the chosen variant. |
| Sum-type union representation | Azure union struct (one pointer per variant) | Allows several fields set at once (checked only at marshal time). | Same idea, but a single private value + kind so invalid states are unrepresentable. |
| Parameter style codec (path/query/header/cookie; simple, label, matrix, form, space/pipe delimited, explode) | ogen `uri` package | ~2,000 lines + tests, Apache-2.0, only external dep `go-faster/errors`. Closure-based API suits static code generation. | **Copied** into `runtime/uri` with `go-faster/errors` → stdlib `errors`/`fmt`; upstream tests copied. |
| Reflection-based param binding | oapi-codegen `runtime.BindStyledParameterWithOptions` | Reflection over OpenAPI-shaped structs; extra deps. | Not used: the generator knows every type statically and emits direct calls into the ogen codec. |
| Strict server shape | oapi-codegen `strict/strict-interface.tmpl`, `strict-http.tmpl` | Mature, widely used API: `StrictServerInterface`, `<Op>RequestObject`, `<Op>ResponseObject` with `Visit<Op>Response`, `StrictHandlerFunc`/`StrictMiddlewareFunc`, request/response error handlers. | **Adapted** (template text ported to the TypeScript generator, same names/semantics), extended with typed parameters, validation, defaults, auth hooks and body limits. |
| Validators | ogen `validate` | Flat field-name errors; String validator also enforces `email`/`hostname` formats (TypeSpec `@format` is only a hint); regex via `ogenregex` (extra deps). | Not copied; generated code emits direct checks with JSON-pointer error paths (`runtime/validate.go`, ~150 lines). |
| Scalar conversions | ogen `conv`, `json` | Built on `go-faster/jx`, `google/uuid`, `shopspring/decimal`; Go-format durations, no RFC 7231 / ISO 8601 durations. | Not copied; TypeSpec encodings implemented on the stdlib. |
| Optional/nullable | ogen `Opt[T]`/`Nil[T]` generated per type; oapi-codegen pointers + `nullable.Nullable` (map-based) | | Pointers for optional (idiomatic, recursion-safe) + one generic `Nullable[T]`. |
| HTTP semantics | `@typespec/http` | `getAllHttpServices`, `HttpOperation` parameters/body/responses, `createMetadataInfo` (visibility transforms, payload properties), `resolveRequestVisibility`, `getVisibilitySuffix`, `getAuthenticationForOperation`. | **Used directly**; no re-interpretation of HTTP decorators. |
| Conformance scenarios | `@typespec/http-specs` | 67 specs with machine-readable `mockapi.js` request/response pairs. | **Reused** as server conformance tests (generated server driven by the scenario requests). |
| OpenAPI cross-check | `@typespec/openapi3` | | Used in tests as an independent reference for routes, parameters and status codes. |
