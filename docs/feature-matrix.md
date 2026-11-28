# Feature coverage matrix

Generated from [feature-matrix.json](feature-matrix.json) by `node tools/feature-matrix/check.mjs --write`; every supported or restricted entry is backed by the executable tests listed in the JSON file.

HTTP conformance (@typespec/http-specs): {"specs":{"implemented-passing":67},"scenarios":{"passed":843,"failed":0,"notApplicable":13}}


## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Built-in scalars (string, boolean, int8–uint64, safeint, float32/64) | ✅ supported | ✅ supported<br>Sized integers carry their range as minimum/maximum (Pydantic Annotated[int, Field(ge, le)]). |
| Arbitrary precision (integer, numeric, decimal, decimal128), int64/uint64 extremes | ⚠️ restricted<br>tsgo.Integer (big.Int) and tsgo.Decimal (exact text); decimal128 digits validated; float bounds compared in binary64 or exactly via big.Rat when the bound is not representable. Literals and defaults keep every digit; float literal membership (enums, literal types, unions, text parameters) is checked on the wire token before binary rounding. Exact numbers are bounded (10,000 significant digits, exponent ±10,000) so untrusted input cannot force expensive conversions. Distinct literals that TypeSpec 1.18 conflates are rejected. Option integer-type: int64 maps integer to int64 everywhere (fields, collections, unions, parameters, derived scalars); out-of-range input is rejected, out-of-range defaults and unsatisfiable bounds fail the compilation. | ⚠️ restricted<br>integer → JSON integer; numeric/decimal rejected by default (Pydantic's Decimal schema accepts arbitrary strings); option scalar-encodings: wire maps them to JSON numbers (Annotated[Decimal, WithJsonSchema]). |
| utcDateTime, offsetDateTime, plainDate, plainTime, duration | ✅ supported<br>time.Time, tsgo.Date, tsgo.TimeOfDay, tsgo.Duration (ISO 8601 components, calendar units kept). | ✅ supported<br>Only the default (RFC 3339 / ISO 8601) encodings, as Pydantic. |
| bytes (base64, base64url, binary bodies) | ✅ supported | ⚠️ restricted<br>Rejected by default (Pydantic's default bytes form is UTF-8 text); option scalar-encodings: wire emits canonical base64/base64url string patterns. |
| url, unknown, null, never | ✅ supported<br>url validated as absolute URL; unknown = json.RawMessage (well-formed JSON, verbatim); never properties must be absent. | ⚠️ restricted<br>url/unknown produce schemas the OpenAI profile rejects (format uri, empty schema). |
| Custom scalars, inherited scalar constraints | ✅ supported<br>Defined Go types; constraints of the whole scalar chain and of the property are all enforced. | ✅ supported<br>Intersected constraints; two different patterns cannot be expressed in one Pydantic field (diagnostic). |

## Serialization

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| @encode (date-time, duration, bytes, numbers as strings, delimited arrays, boolean as string) | ✅ supported | ⚠️ restricted<br>Default encodings only, as Pydantic; with scalar-encodings: wire also base64url bytes and @encode(string) booleans. Other encodings are rejected. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Models, inheritance, spread, `is` | ✅ supported<br>Inheritance is flattened (base properties first). | ✅ supported |
| Template instantiations, @friendlyName | ✅ supported<br>Names concatenate template arguments (Page<Widget> → PageWidget). | ⚠️ restricted<br>Arguments are spelled as Pydantic displays them: models, enums, scalars (sized integers as Annotated bounds), date/time types, lists, dicts, tuples, unions, recursive union aliases by name, numeric/boolean/string literals (Python repr), null and unknown. Anonymous objects and values are rejected. |
| Enums, literal types, literal unions, open enums | ✅ supported<br>Closed enums reject undeclared values; `"a" \| string` is open. Enums mixing string and number members are closed sum types of their literal values. | ✅ supported<br>Pydantic representation; mixed-type enums are type-less (rejected by OpenAI profiles) unless mixed-enums: typed-union splits them into typed branches. |
| Arrays, records, tuples | ✅ supported | ⚠️ restricted<br>Records and tuples are generated as Pydantic does but rejected by the OpenAI profile. |
| Optional, nullable, optional+nullable (absent / null / value) | ✅ supported<br>*T, tsgo.Nullable[T], *tsgo.Nullable[T]. Option response-unset-nullable (null for all, or a list of models and properties) writes unset optional nullable properties as null in server responses (nested values, JSON Lines and SSE included); unselected and request models, MarshalJSON and request decoding unchanged. | ⚠️ restricted<br>Structured Outputs require every property: `a?: T` needs option optional-properties=nullable (explicit policy); `a?: T \| null` maps to `T \| None = None`. |
| Nested and recursive models (incl. through unions) | ✅ supported<br>Required non-nullable self-containment has no finite value and is rejected. | ✅ supported<br>Recursive models and recursive named unions (TypeAliasType definitions, also mutual and through dicts), as Pydantic; a recursive reference with its own metadata is rejected in strict mode, where the SDK's transformation recurses forever. |
| Undiscriminated unions, nested unions, ambiguous variants | ✅ supported<br>Documented policy: declaration order; the first variant that decodes, validates and re-encodes to JSON equivalent to the input (nested properties and exact numbers included); then the first valid; then the first decodable (Validate reports). Undeclared properties follow unknown-properties, as for plain models. Errors: the variants whose declared constants the input matches are reported (one: its own error and JSON Pointer; several: tsgo.UnionError), bounded and formatted lazily; constants never affect selection. | ✅ supported<br>anyOf with Pydantic flattening/dedup; literals grouped into one Literal[...]. |
| Uninhabited alternatives in nested unions and combined record indexers | ✅ supported<br>Nested null alternatives stay nullable, and never contributes no values to a union. An empty union has no decodable representation. | ✅ supported<br>The pinned Pydantic fixture projects a combined closed and typed spread to typed extras under target-profile none. OpenAI profiles reject the resulting open object. |
| @discriminated unions (envelope object/none, default variant) | ✅ supported | ✅ supported<br>envelope none: Union of the tagged variant models; envelope object: Union of synthesized <Union>_<tag> wrapper models (kind + value); a default variant becomes <Union>_Fallback with a tag-excluding string pattern (rejected when the discriminator is not a required plain string). |
| @discriminator inheritance (single, nested, enum discriminators) | ✅ supported<br><Base>Union sum type; undeclared values decode into the base model. | ⚠️ restricted<br>A @discriminator base with derived models is a TypeAliasType union of the derived models and a <Base>_Fallback with a tag-excluding pattern; rejected when the discriminator already has a pattern or is not a required plain string. |

## Serialization

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| @encodedName (JSON, XML, form) | ✅ supported | ✅ supported<br>Pydantic alias; titles derive from the alias; integer-like and Object.prototype names keep their declared position. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Lifecycle visibility, context-dependent representations | ✅ supported<br>Variants per visibility via @typespec/http createMetadataInfo (WidgetRead, WidgetCreate, ...); full model for standalone use. Excluded properties are undeclared in the variant (rejected by closed models and unknown-properties: reject) unless invisible-properties: ignore accepts and discards them. | ⚠️ restricted<br>Option visibility (Read, Create, Update, Delete, Query) keeps the properties visible in that lifecycle phase, recursively; without it, visibility is not applied and a warning is reported. |

## Serialization

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| JSON merge patch (application/merge-patch+json) | ✅ supported<br>RFC 7396 representation: optional members are absent \| null \| value; no defaults applied. | — n/a |

## Defaults

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Default values (scalars, enums, objects, arrays) | ✅ supported<br>ApplyDefaults: absent optional only; explicit null kept; fresh value per application. | ⚠️ restricted<br>`default` is outside the documented OpenAI subset: option default-values (error \| omit \| emit, where emit is only accepted with target-profile none). |

## Validation

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Length, pattern, numeric bounds (inclusive/exclusive), item counts | ⚠️ restricted<br>Patterns are ECMAScript regular expressions in Unicode mode (JSON Schema 2020-12), parsed with @eslint-community/regexpp and translated to RE2 with identical semantics (code points; \s and Unicode properties, including scripts, resolved to explicit code-point sets); lookaround, backreferences, lone surrogates, set operations and nested repetitions beyond RE2's limit are rejected. | ✅ supported<br>minItems/maxItems (and the string and number constraints) are kept for the openai profile; openai-fine-tuned reports every such keyword in the final schema as target-incompatible, it never removes one. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Additional properties (...Record<T>, extends Record<T>) | ✅ supported | ⚠️ restricted<br>Generated as Pydantic does; rejected by the OpenAI profile (additionalProperties must be false). |
| Closed models (...Record<never>): no properties beyond the declared ones | ✅ supported<br>The nearest indexer in the inheritance chain decides (inherited, reopened with ...Record<T>, or closed over an open base). Undeclared JSON properties are rejected whatever unknown-properties says, including visibility and merge-patch variants and union variant selection; form, query-object, XML and multipart inputs reject undeclared keys, elements, attributes and parts. | ✅ supported<br>Pydantic ConfigDict(extra="forbid"): additionalProperties: false in the model's own schema, at Pydantic's key position in both pydantic and strict modes (the SDK keeps it in place). Accepted by the OpenAI profiles. |
| Namespaces, name collisions, reserved identifiers | ✅ supported<br>One Go package; colliding names are namespace-qualified, then numbered; Go keywords and generated identifiers reserved. Union variants and template arguments distinguish genuine maps (Record<T>) from named models with indexers (closed models included); anonymous types are named after the canonical declaring model, independent of visibility variants. | ✅ supported<br>Pydantic definition-name collision algorithm (module = namespace). |
| File layout / output organization (single, per namespace, per source file) | ✅ supported<br>Option file-layout. One Go package; anonymous and synthetic declarations live with their owners, template instances with their first project argument; portable names (no build-constraint or test suffixes, case-folded collisions numbered); identical public API and declarations in every layout; manifest-based removal of stale files; a change to one declaration changes only its file. | ✅ supported<br>Option file-layout: root schemas in namespace or source-file directories; byte-identical, self-contained schemas in every layout; portable, collision-numbered directories; manifest removes files and emptied directories of previous layouts. @schemaName names classes independently of declarations (titles, $defs, refs, collisions). |
| Separately compiled specifications sharing generated packages (external mappings) | ✅ supported<br>Options export-contract and external: mapped namespaces/types are imported (type identity) after verifying each declaration's fingerprint, the representation options and the shared runtime; missing variants and instances are generated in the consumer; mismatches are diagnosed. XML of mapped declarations is generated in the consumer; dependencies of a mapped type are bound to the same package. Dotted names map through tspconfig lists or nested objects; anonymous types are identified by declaration (containing declaration, path, template arguments, projection), not content; exporters may select any of their declarations for response nulls. | — n/a<br>Every schema is self-contained ($defs). |
| Standalone models not referenced by operations | ✅ supported | ✅ supported<br>Roots via @structuredOutput or emit-all-models. |
| @typespec/versioning | ✅ supported<br>One projected version per generation (option api-version, default latest), via the official versioning mutators. | ✅ supported<br>One projected version per generation (option api-version, default latest), via the official versioning mutators. |

## Safety

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Unknown decorators and semantics fail closed; stale outputs removed | ✅ supported<br>Every generated Go file is gofmt-clean as emitted, in every layout and package configuration (all fixtures, http-specs and the example) and with long identifiers (function literals are always multi-line). | ✅ supported |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Cross-emitter value-domain consistency (same TypeSpec, both emitters) | ⚠️ restricted<br>Absent, null and zero survive for the tested overlapping representations with aligned policies. Binary floats can round an accepted number or reject overflow. | ⚠️ restricted<br>Pydantic float projects to JSON number. JSON Schema cannot express the entire IEEE-754 binary32 value set in the OpenAI subset. Strict schemas require explicit keys, including nullable keys. |

## HTTP

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Routing on net/http.ServeMux (RFC 6570 templates: simple, reserved, label, matrix, path, optional, explode, records, literal query) | ⚠️ restricted<br>Expressions with several variables are supported for required scalar values (not with + or .); prefix modifiers when @maxLength does not exceed the prefix; fragments are never sent to servers. | — n/a |
| Path, query, header, cookie parameters (arrays, records, flat models in path and query, encodings) | ⚠️ restricted<br>Nullable parameters (no wire form for null) and record/model header and cookie parameters are rejected. Flat path models use RFC 6570 key/value pairs and the declared field codecs. Nested fields, reserved expansion and exploded label expansion for models are diagnosed. | — n/a |
| Request/response bodies: JSON, text, binary, Http.File, multipart (model and tuple form), form-urlencoded, XML | ⚠️ restricted<br>Multipart and form-urlencoded responses are encoded from the typed response; XML follows @typespec/xml (nullable and nested collections have no XML mapping). | — n/a |
| Operation-specific response variants: status codes, ranges, default, headers | ✅ supported | — n/a |
| Multiple media types, @sharedRoute content negotiation (406/415) | ✅ supported | — n/a |
| Streaming: server-sent events, JSON Lines (requests and responses) | ⚠️ restricted<br>iter.Seq bodies, per-item flush, cancellation through the request context, lazy per-item decoding/defaults/validation; an invalid request item fails the request (400) even if the handler stopped reading; with ValidateResponses each response item is validated (500 before the first item, aborted stream after). Union-typed event variants, nested @data envelopes and text events of any type with a text codec are supported; set optional envelope fields are a runtime error (never dropped). Rejected: text events without a text codec, @data envelopes with other required properties. | — n/a |
| Authentication hooks (@useAuth schemes as OperationInfo.Security) | ✅ supported<br>Credential verification is application code (Authenticate hook); operations fail closed without one. | — n/a |
| Middleware, request/response validation, problem details, body limits, cancellation, concurrency | ✅ supported | — n/a |
| @server URLs and base paths | ⚠️ restricted<br>Deployment configuration: the handler serves operation routes; mount under the server path (http.StripPrefix). | — n/a |
| Agreement with @typespec/openapi3 (operations, parameters, status codes) | ⚠️ restricted<br>Latest version per spec. Checks normalized routes, parameter identity and presence, request body requirement, statuses, media and header names. Payload schemas and serialization are checked separately on selected cases. Eight literal-query operations have no reference route. The reference requires a body for two metadata-only visibility requests whose upstream scenarios specify no body. | — n/a |

## Structured Outputs

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Pydantic 2.14.4 model_json_schema reproduction (key order, titles, $defs naming, root unpacking) | — n/a | ✅ supported |
| OpenAI SDK 3.59.0 strict transformation (to_strict_json_schema) | — n/a | ✅ supported |
| OpenAI target validation (keywords, formats, root, required, additionalProperties, limits, fine-tuned profile) | — n/a | ✅ supported |
| Leaf keyword parity with @typespec/json-schema | — n/a | ✅ supported |
| Output formats (schema, Responses text.format, Chat response_format) | — n/a | ✅ supported |

## Representation boundaries

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Exact literals that the pinned compiler interns to the same number | ⚠️ restricted<br>A source-level guard diagnoses a lost digit before generation. | ⚠️ restricted<br>The same compiler limitation applies to schema bounds and defaults. |
| Binary floating point compared with the JSON number domain | ⚠️ restricted<br>Rounds to the declared binary width. Overflow and nonzero underflow fail decoding. | ⚠️ restricted<br>The Pydantic float annotation has no binary32 range or binary precision keyword. |
| Machine-sized integer representation policy | ⚠️ restricted<br>The explicit int64 option checks range on decode and generation. | ✅ supported<br>TypeSpec sized integers include exact Pydantic annotation bounds. |
| Record<never> as a value, array item and template argument | ✅ supported<br>The sole value is an empty object. | ✅ supported<br>Profile v2 maps the built-in empty record to a closed EmptyRecord class. |
| Integer-like encoded property names and declaration order | ✅ supported<br>Numeric aliases survive decoding and encoding at property boundaries. | ✅ supported<br>Ordered schema output preserves the declared alias order, including after remapping generic definitions. |

## Packages and representations

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Transitive type identity and representation drift across Go modules | ✅ supported<br>Mapped nominal types and dependencies retain identity across three separately generated modules. Changing a reachable contract fails generation. | — n/a |
| Consumer-local and exported nullable-response policy | ✅ supported<br>Mapped types must agree on their response codec. Local selections can differ. Model-only exporters can publish the selected codec. | — n/a |
| File layout changes and ownership of stale artifacts | ✅ supported<br>The output manifest drives cleanup of generated files when layout or declarations change. | ✅ supported<br>Manifests preserve unrelated files and remove stale schema paths. |

## Wire contracts

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Absent body, present empty representation and unknown request length | ✅ supported<br>Required empty JSON objects still need an object. A media type distinguishes a present empty text body from absence. Untyped nonempty chunked input is rejected. | — n/a |
| Escaped separators inside RFC 6570 query list and record values | ✅ supported<br>Separate the raw delimiters before decoding each component. | — n/a |
| Response item validation and HTTP commitment | ✅ supported<br>Invalid first item produces a problem response. A later invalid item aborts an already-started stream. | — n/a |
| Single-cursor request validation after a partial or concurrent read | ✅ supported<br>The handler and final drain consume one bounded cursor. The first failure survives repeated finalization. | — n/a |
| Physical record boundaries for JSON Lines | ✅ supported<br>Indented raw JSON occupies one wire line. A malformed codec result fails encoding. | — n/a |
| SSE data projection, nested event unions and envelope metadata | ⚠️ restricted<br>Only the data field is serialized. Unrepresentable required envelope fields and selections that can never affect JSON data are diagnosed. | — n/a |
| Independent values of decoded official query, path and header fixtures | ✅ supported<br>Checks concrete handler arguments for eighteen pinned scenarios including optional path, percent-encoded names, array separators and URI-template query expansions. | — n/a |

## Structured Outputs

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Typed literal membership and object depth across composition | — n/a | ✅ supported<br>The offline profile checks enum and const declarations and follows branches alongside object properties. |

## Serialization

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Records that keep insertion order (opt-in) | ✅ supported<br>Option ordered-records: tsgo.OrderedMap[T] for records and additional properties, through decoding, mutation, defaults, unions, responses and external packages; ordered XML record elements, including model values; record parameters and form additional properties diagnosed. Standalone MarshalJSON/UnmarshalJSON use the runtime's default codecs (tsgo.DefaultCodec), other policies per codec (OrderedMapCodec), no global setting. | — n/a<br>JSON Schema objects are unordered. |
| JSON text policies matching pydantic-core or Python's json.dumps (float format, string escaping) | ✅ supported<br>Options float-format: pydantic or python-repr and string-escaping: minimal, verified byte for byte against the pinned Pydantic and against CPython's json.dumps (3,000 values: negative zero, both exponent thresholds, subnormals, extremes, rounding, random bit patterns, float32, control characters, U+2028, keys). | — n/a<br>Schemas only. |

## Validation

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Machine-readable request errors, collected errors, application validation hooks | ✅ supported<br>tsgo.Details (kind, location, JSON Pointer, constraint and limit, value, identified union variants with their paths, candidates); decoding problems as data (tsgo.DecodeProblem: type, required, enum, literal, discriminator, range, format, ... with expected type, allowed values and range); ServerOptions.CollectErrors (every parameter and the body, bounded, fail-fast by default) and ErrorDetails; option validation-hooks after decoding only. | — n/a<br>Schemas only. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Declarations excluded from Go generation but used by other emitters | ✅ supported<br>Option exclude; references from generated code are diagnosed (excluded-declaration). | — n/a<br>Every declaration remains available. |

## Safety

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Arbitrary documentation in gofmt-clean Go doc comments | ✅ supported<br>Port of go/doc/comment and go/printer's doc comment formatting, iterated to a fixed point; checked against Go's implementation and gofmt. | — n/a<br>Schema descriptions are copied unchanged. |

## Structured Outputs

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Explicit schema names and default factories (@schemaName, @defaultFactory) | — n/a<br>Accepted without effect on Go (no wire change). | ✅ supported<br>@schemaName: Pydantic class name (title, $defs, refs, root name, collisions, generics); @defaultFactory: no schema default, requiredness and profile checks unchanged. |

## Validation

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Validation of the decoded parts of an invalid input; application checks on complete values only | ✅ supported<br>Decoders keep what decoded and record exactly the positions that did not (tsgo.Partial, FailedPaths, ValidateDecoded); with ServerOptions.CollectErrors siblings of failures are validated, zero values of failed parts never are; validation hooks run on values that decoded completely and never during union variant selection; custom errors with values (AddErrorValue, AddLimit). | — n/a<br>Schemas only. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Named array models (model Docs is Doc[]) and zero-element tuples | ✅ supported<br>Named slice types with codecs, defaults, validation (their item constraints wherever used) and hooks, in properties, bodies, parameters, templates and XML; [] (also OAuth2Auth's default scopes) is an empty tuple. | — n/a<br>A Go representation choice: Structured Output schemas are unaffected. |

## Packages and representations

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Shared declarations keep their response-unset-nullable selection across packages | ✅ supported<br>The contract records each declaration's response nulls; consumers inherit them (also through local types containing shared ones) and conflicting selections are diagnosed. | — n/a<br>No shared packages. |

## Structured Outputs

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Root selection and exclusion (roots, exclude-roots) | — n/a<br>Option exclude selects Go declarations. | ✅ supported<br>Roots left out are not written as files and stay byte-identical $defs of the roots that reference them, validated there; entries that select nothing are errors. |

## Types

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Recursive named list and dictionary declarations, including fields and generic arguments | ✅ supported | ⚠️ restricted<br>Named recursive collections use Pydantic TypeAliasType definitions. Typed dictionary values require target-profile none. |

## Structured Outputs

| Feature | typespec-go | typespec-structured-output |
|---|---|---|
| Pydantic field titles for Unicode wire aliases | — n/a<br>Go uses the declared wire name. | ⚠️ restricted<br>Python titlecase, whitespace and context-sensitive lowercase conventions. Case properties can vary for characters added after the reference Unicode version. |
