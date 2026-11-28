# typespec-go

A TypeSpec emitter that generates native Go: data models with JSON (and XML) serialization,
defaults and validation, plus a complete strict HTTP server on `net/http`. It consumes the
TypeSpec semantic model and the official `@typespec/http` APIs directly; OpenAPI is never used
as an intermediate representation.

```yaml
# tspconfig.yaml
emit: [typespec-go]
options:
  typespec-go:
    module: example.com/svc/api          # Go import path of the output directory (required)
    emitter-output-dir: "{project-root}/api"
```

Generated files: `models.go`, `server.go` (when the program has HTTP operations) and `tsgo/`, a
small vendored runtime that depends only on the Go standard library (Go ≥ 1.24).

## Options

| Option | Default | Meaning |
|---|---|---|
| `module` | — (required) | Go import path of the output directory. |
| `package-name` | last element of `module` | Go package name. |
| `runtime` | `vendor` | `vendor` copies the runtime to `<output>/tsgo`; `import` imports it from `runtime-module`. |
| `runtime-module` | — | Runtime import path when `runtime: import`. |
| `emit-go-mod` | `false` | Write a `go.mod` for standalone output directories. |
| `optional-properties` | `source` | `source`: `a?: T` is absent or a value. `nullable`: optional properties without a default also accept `null` (`*tsgo.Nullable[T]`: absent, null and value stay distinct), matching the Structured Output emitter's `optional-properties: nullable` policy so that Go types decode what a model returns for that schema. |
| `unknown-properties` | `ignore` | Undeclared JSON object properties of open models: `ignore` (JSON Schema/OpenAPI open-object semantics) or `reject`. Closed models (`...Record<never>`) always reject them. |
| `generate-server` | `true` | Generate the strict server for HTTP services. |
| `api-version` | `latest` | Version of a `@typespec/versioning` service to generate (projected with the official versioning mutators). |
| `file-layout` | `single` | Files of the (single) Go package: `single` (`models.go`), `per-namespace` (`models.<namespace>.go`) or `per-source-file` (`models.<path>.go`). See [File layout](#file-layout). |
| `integer-type` | `arbitrary-precision` | Go type of `integer`: `arbitrary-precision` (`tsgo.Integer`) or `int64`. With `int64`, values outside int64 are rejected when decoding (never rounded, truncated or wrapped), and defaults outside int64 or bounds that no int64 satisfies fail the compilation. |
| `invisible-properties` | `unknown` | Properties a lifecycle visibility excludes from a payload (a read-only `id` in a create request): `unknown` treats them as undeclared, so closed models and `unknown-properties: reject` reject them; `ignore` accepts and discards them. See [Visibility and undeclared properties](#visibility-and-undeclared-properties). |
| `export-contract` | `false` | Also write `typespec-go-contract.json`, so that other packages can import this package's declarations (option `external`); enums and scalars then also implement `encoding.TextMarshaler`. |
| `external` | — | TypeSpec namespaces or types provided by separately generated packages, mapped to the package's output directory or its contract (relative to the project root). In `tspconfig.yaml` (which rejects dotted keys) use a list `[{ name: Shop.Common, path: ../common/tsp-output/typespec-go }]` or nested objects `{ Shop: { Common: ../common/… } }`; `--option typespec-go.external.Shop.Common=…` produces the nested form; programmatic callers may use `{ "Shop.Common": "…" }`. See [Shared packages](#shared-packages). |
| `exclude` | — | TypeSpec namespaces (with sub-namespaces) or types not generated in Go, while other emitters still see them. A generated declaration or operation that uses an excluded one is an error (`excluded-declaration`); so is a name that matches nothing. |
| `validation-hooks` | `false` | Validation of models, named arrays, unions and custom scalars also calls `ValidateExtension(v *tsgo.Validator)` when the application declares it for that type in the generated package. See [Errors and application checks](#errors-and-application-checks). |
| `float-format` | `shortest` | JSON text of `float32`/`float64`: `shortest` (Go: `1`, `1e-05`), `pydantic` (pydantic-core's `model_dump_json`: `1.0`, `-0.0`, `0.00001`, `1000000000000000.0`, `1e+16`, `1.5e-7`) or `python-repr` (Python's `json.dumps`, i.e. `float.__repr__`: `1.0`, `-0.0`, `0.0001`, `1e-05`, `1.5e-07`, `1e+16`, `5e-324`). Verified byte for byte against the pinned Pydantic and against CPython (3,000 values: rounding, both exponent thresholds, subnormal and extreme values, random bit patterns). `float32` values are written from their shortest float32 digits. Decoding is unchanged. |
| `string-escaping` | `default` | Escaping of JSON strings, object and record keys and discriminator tags: `default` (encoding/json without HTML escaping; U+2028/U+2029 escaped) or `minimal` (only `"`, `\` and control characters, with `\b \t \n \f \r` short forms; HTML characters, non-ASCII and U+2028/U+2029 raw, as pydantic-core writes). Decoding is unchanged. |
| `ordered-records` | `false` | `Record<T>` and additional properties as `tsgo.OrderedMap[T]` (insertion order kept through decoding, `Set`/`Delete`, iteration, defaults and encoding; duplicates rejected) instead of Go maps encoded with sorted keys. XML records of scalars and models retain child element order. Record-valued parameters and form additional properties are diagnosed with this option. |
| `response-unset-nullable` | `omit` | Unset (absent) optional nullable properties (`p?: T \| null`) in server responses: `omit`, `null` (all of them), or a list of fully qualified names written as `null`: a model (`Shop.Widget`, or a template such as `Shop.Page` for every instance) selects its own such properties, inherited ones included; a property (`Shop.Widget.note`, `Shop.Base.note` for every model inheriting it) selects that property. Selection never extends to nested models, so a model reused by requests or nested in a selected model keeps omitting unset properties unless it is named. Responses (bodies, JSON Lines and SSE items) apply it at every depth; `MarshalJSON`, request decoding, merge patch and the Go values are unchanged. Every listed name must select an optional nullable property that a server response writes (directly or nested, in the response visibility); models reachable only from requests, SSE envelope fields outside the serialized data, and properties that the response visibility excludes are rejected. A model-only package with `export-contract: true` can select model properties for its exported response codec. |

## Data representation

| TypeSpec | Go |
|---|---|
| `string`, `boolean`, `int8`…`uint64`, `float32`, `float64` | Go built-ins (`float` → `float64`, `safeint` → `int64` + range check) |
| `integer` / `numeric`, `decimal`, `decimal128` | `tsgo.Integer` (big.Int), or `int64` with `integer-type: int64` / `tsgo.Decimal` (exact decimal text) |
| `utcDateTime`, `offsetDateTime` / `plainDate` / `plainTime` / `duration` | `time.Time` / `tsgo.Date` / `tsgo.TimeOfDay` / `tsgo.Duration` (ISO 8601 components) |
| `bytes` | `[]byte` (base64 / base64url in JSON, raw for binary bodies) |
| `unknown` | `json.RawMessage` (any well-formed JSON, kept verbatim) |
| `prop: T` / `prop?: T` / `prop: T \| null` / `prop?: T \| null` | `T` / `*T` / `tsgo.Nullable[T]` / `*tsgo.Nullable[T]` — absent, null, zero and value are all distinct |
| `T[]`, `Record<T>`, tuples | `[]T`, `map[string]T` (`tsgo.OrderedMap[T]` with `ordered-records`), a struct encoded as a JSON array (`[]`: an empty struct, only `[]`) |
| named array model (`model Docs is Doc[]`, `model Page<T> is T[]`) | named slice type `type Docs []Doc` with `MarshalJSON`, `UnmarshalJSON`, `Validate` (its `@minItems`/`@maxItems` wherever it is used, then the items), `ApplyDefaults`; assignable to and from `[]Doc` |
| `...Record<T>` in a model | `AdditionalProperties map[string]T` (typed, validated) |
| `Record<never>` as a value | closed empty struct whose only JSON representation is `{}` |
| `...Record<never>` in a model (closed object) | struct whose decoder rejects undeclared properties, whatever `unknown-properties` says; the nearest indexer in the `extends` chain decides (inherited, or reopened by `...Record<T>`) |
| model (`extends` flattened, spread, `is`, template instance) | struct with `MarshalJSON`, `UnmarshalJSON`, `Validate` (and `ValidateWith`), `ApplyDefaults` |
| enum, `"a" \| "b"` | defined type with constants (closed: undeclared values rejected) |
| enum mixing string and number members | closed sum type of the literal values (`New<E><Member>(v)`, checked by `Validate`) |
| `"a" \| "b" \| string` | open enum (any string) |
| other unions | sum type: `New<U><Variant>(v)`, `Kind()`, `As<Variant>()`; variants are named after the union variant, else the variant type (`AsWidget`, `AsStringMap` for `Record<string>`, `AsStringArray`) |
| `@discriminator` base with derived models | `<Base>Union` (undeclared values decode into the base model) |
| custom scalar | defined Go type with `Validate` for the whole constraint chain |
| model under a lifecycle visibility (`WidgetCreate`, `WidgetRead`, …) | variant struct, only when the property set differs (`@typespec/http` `createMetadataInfo`) |
| `application/merge-patch+json` body | `<Model>MergePatch`: optional members are absent / null / value (RFC 7396) |

Required properties of a single literal type (`kind: "cat"`) have no Go field; the constant is
always written and checked when decoding. Properties of type `never` must be absent.

Anonymous types are named after the canonical model that declares them (`ProductKind`,
`ProductShape`), never after the visibility variant reached first; a visibility variant of an
anonymous type gets its own suffix (`ProductShapeCreate`) only when that visibility changes it.
Template instances are named after their arguments (`Page<Widget>` → `PageWidget`).

## File layout

All declarations form one Go package (separate packages per namespace are not generated); the
layout only distributes them over files, so names, imports and behaviour are identical in every
layout (tested by comparing `go doc -all` output and every declaration). `server.go` and the
vendored runtime are unchanged by the layout.

| Declaration | `per-namespace` | `per-source-file` |
|---|---|---|
| named model, enum, union, scalar | its namespace | the `.tsp` file declaring it |
| anonymous model, union, tuple, literal union, alias | where it is written (with the declaration containing it) | same |
| visibility (`WidgetCreate`) and merge-patch (`WidgetUpdateMergePatch`) variants, `<Base>Union` | with the model | same |
| template instance (`Page<Order>`) and its anonymous members | with the first template argument declared in the project, else with the template | same |
| request bodies synthesized from operation parameters | the operation's namespace | the operation's file |
| global namespace, library types without a project argument, pattern variables | `models.go` | `models.go` (pattern variables and library types) |

File names are lower-case and portable: namespaces become `models.contoso.widget_manager.go`,
source files `models.sub.dir.file.go` (relative to the project root; `..` → `up`). Every name
starts with `models.`, so no name carries a `_GOOS`/`_GOARCH` build constraint or a Windows device
name; a `_test` suffix gets a trailing `_`; names that collide after case folding are numbered in
sorted order (`models.foo_bar.go`, `models.foo_bar_2.go`). Within a file, declarations are sorted by
name, and pattern variables are named after their pattern, so a change to one declaration leaves
unrelated files byte-identical. The manifest (`.typespec-go-manifest.json`) lists every generated
file; the next compilation removes them first, so files of a previous layout or of removed
namespaces never linger (hand-written files are left alone).

## Shared packages

Several independently compiled specifications can import common TypeSpec declarations and share
one generated Go package for them, instead of generating copies:

```yaml
# common/tspconfig.yaml (main.tsp imports the shared .tsp files)
options:
  typespec-go: { module: example.com/shared, export-contract: true }
# orders/tspconfig.yaml (main.tsp imports the same shared .tsp files)
options:
  typespec-go:
    module: example.com/orders
    runtime: import
    runtime-module: example.com/shared/tsgo      # the shared package's runtime
    external: { Shop.Common: ../common/tsp-output/typespec-go }
```

* **Mapping.** A key is a namespace (with its sub-namespaces) or a single type; the most specific
  key wins. Mapped declarations are imported as `externalRef0.Money` (oapi-codegen's alias
  convention; sorted import paths) and not generated: `Order.Total` *is* `shared.Money`.
* **Contract.** `typespec-go-contract.json` lists every declaration of the shared package by its
  fully qualified TypeSpec name (`Shop.Common.Widget`, `Shop.Common.Page<Shop.Common.Widget>`,
  `Shop.Common.Widget@Create`, `Shop.Common.Pet@Union`; anonymous types by where they are written), with
  its Go name and a fingerprint of its generated code, plus the runtime and the
  representation options. The consumer computes the same fingerprint from its own program and
  rejects a mapping whose declaration differs: changed sources or versions, augment decorators,
  models derived from a shared `@discriminator` base (which would change `PetUnion`), or different
  `unknown-properties`, `optional-properties`, `integer-type` or `invisible-properties`.
  Mapped names that the shared package does not declare are rejected.
* **Anonymous types** are identified by where they are written (the containing declaration, the
  path to the type expression, template arguments, visibility projection), so structurally
  identical anonymous types keep distinct identities across packages.
* **Null responses.** A package exporting a contract may select, with `response-unset-nullable`,
  any of its declarations (its consumers may respond with them). The contract records each
  declaration's selected properties and consumers inherit them: a consumer does not repeat the
  shared selection, its local types containing shared ones write it, and its own selection
  applies to its own declarations. A consumer selection that a shared type does not implement
  (a property the shared package omits, or `null` for all) is reported as a conflict.
* **Generated in the consumer.** Declarations the shared package does not have: visibility and
  merge-patch variants it never used (`WidgetCreate`, whose nested types are the shared ones),
  template instances over consumer types (`Page<Order>`), unions and models of the consumer.
  Anonymous members of shared declarations are the shared ones.
* **Runtime.** Both packages must use the same runtime package (the consumer imports the shared
  package's vendored `tsgo`, or both `runtime: import` the same module), generated by the same
  typespec-go version; otherwise the mapping is rejected. Without `external` and
  `export-contract`, generation is self-contained and unchanged.
* **XML** payloads of mapped declarations are encoded and decoded by functions generated in the
  consumer from the (fingerprint-checked) declaration. Go modules are linked by the user
  (`go.work`, or `require` + `replace`).

### Upgrading to contract format 4

Contract keys of template instances now record the declaration site of anonymous template
arguments, recursively. `Parcel<{ code: string }>` written in two places is therefore two
declarations with distinct Go types, nested anonymous members included. A consumer rejects a
contract of another format (`... is not a typespec-go contract of version 4`). It also checks
compatibility, not the typespec-go package version: the runtime import path and a hash of the
runtime sources, the representation options, and for every mapped declaration a fingerprint of
its generated code must match. A shared package generated by another typespec-go version is
therefore accepted when that version's runtime and generated code are identical, and rejected
otherwise. Regenerate the shared package (`export-contract: true`) first, then every consumer.
Using the same typespec-go version for both is the reliable way to pass these checks. The
`external` mappings and `response-unset-nullable` selections in `tspconfig.yaml` are unchanged.

The same version also changes generated Go code that existing applications may rely on:

* A template instance whose argument is a named array model is named after that model:
  `Page<Docs>` (`model Docs is Doc[]`) is `PageDocs`, formerly `PageDocArray`. `Page<Doc[]>`
  stays `PageDocArray`. A model of the specification's own namespace named `Array` or `Record`
  is an ordinary named model, never the built-in.
* Copies of an initialized `tsgo.OrderedMap` share their entries, as Go maps do. Formerly a copy
  shared the values but not the key order, and changing it could corrupt the original. To copy
  a record, `Set` every entry of `All()` into a new map.
* Validation errors of closed enums carry values of the enum's underlying type (`Limit` is, for
  example, `[]uint64` or `[]string` and `Value` a `uint64` or `string`), not values of the enum
  type, so that undeclared and wide integer values stay exact and encodable. Numeric discriminator values in `ErrorDetail.Allowed` are
  `json.Number`. A malformed URL query found while decoding an operation's parameters is a
  `*tsgo.DecodeProblem` of kind `format`; its message is unchanged.
* With `ServerOptions.CollectErrors`, a malformed query or an unsupported request media type no
  longer stops collection once the operation is selected: the other parameters (and the body,
  for a malformed query) are still decoded and validated. The response status is that of the
  first failure and the handler is not called, as before. Failures during operation selection
  still end the request immediately, without collection, as before: a malformed query on a route
  whose operations are told apart by literal query values (reported as a parameter error without
  a `DecodeProblem`), and a `Content-Type` that no `@sharedRoute` operation accepts (415).

## Errors and application checks

Every error returned by generated code can be read as data: `tsgo.Details(err, max)` lists
`tsgo.ErrorDetail` records with a stable `Kind` (`decode`, `validation`, `parameter`,
`content-type`, `unauthenticated`, `body-too-large`, `not-acceptable`, `traversal-limit`), `Location` and
`Parameter` (also for validation errors of parameters and bodies), the JSON Pointer `Path`, the
`Constraint` with its `Limit` (the declared pattern, the bound, the length, the allowed values),
the offending `Value` (bounded to 256 bytes), and union `Variant` (the innermost identified one),
`Unions` (every identified union with its path, from the outermost) and `Variants` (the
candidates when none was identified).

**Wrapped and joined errors.** `Details`, `FailedPaths`, `Validator.Merge` and both request
problem handlers follow real `Unwrap` children in order. A wrapper that forwards `errors.As`
therefore preserves every child of a join. Runtime validation entries, decoding problems and
union failures are terminal problems. Their check, parser and candidate causes remain accessible
through Go's error APIs.

* A custom error with a non-nil `Unwrap() error` child or a nonempty `Unwrap() []error` result
  contributes its actual children to diagnostics and failed positions. To publish validation
  entries alongside technical causes, return `ValidationErrors` and set each entry's `Err` to
  its cause.
* An opaque error can supply one representation through `As(any) bool`. A `*RequestError`
  supplies request metadata. When it has a cause, that cause becomes the next node. Otherwise
  the walker prefers a nonempty validation list, then an individual validation entry, then a
  `*DecodeProblem`. Both validation forms accept values and pointers. An opaque error with
  no applicable representation contributes one plain failure. Reusing the same error on
  separate branches reports each occurrence. An opaque adapter that forwards `errors.As`
  into a private join can expose just the first matching child. Expose the join through
  `Unwrap` or publish all its failures in one representation when consumers need every branch.
* `WithPath` and enclosing decoding errors prefix each descendant's JSON Pointer. The nearest
  request with an explicit wire location supplies the location and parameter name.
* `Validator.Merge` retains each validation entry's constraint, original message, value, limit
  and cause at its prefixed path. Other failures become `invalid` entries. The legacy HTTP
  `errors` list also keeps validation messages. On a completed walk, the top-level HTTP
  `detail` is the source error's full message.

**HTTP status and authentication.** Generated authentication code and both problem handlers
use the first non-nil `*tsgo.RequestError` in Go's `errors.As` order, subject to the traversal
budget. A wrapper can publish a status through `As` before its children are searched. A
request error in a validation check's underlying cause also qualifies. For example, an
authenticator can publish 413 and unwrap to two invalid credential fields. Both fields
keep their own paths, constraints and messages. An unclassified authentication failure
defaults to 401. Other unclassified request errors default to 400. In fail-fast mode the
authenticator classifies the first retained failure of a native collection. With
`CollectErrors` it classifies the full collection.

Diagnostics have first use of the work and adapter budgets. Before calling a wrapping
`As` for status, the runtime accounts for the repeated searches that nested forwarding
methods can make through visible children. If the lookup cannot finish, the first request
classification already found during diagnosis supplies the status, followed by the applicable
default. Earlier unbounded lookups could reach a different status. A status-only cutoff
preserves completed diagnostics and failed positions.

**Message compatibility.** A single problem keeps its own application's wrapper text, including
text outside a path or request wrapper. For example, wrapping `WithPath("sku", RequiredError("missing"))`
with `fmt.Errorf("read: %w", err)` yields the detail message `read: /sku: missing` and the
separate path `/sku`. Earlier versions could return just `missing`. A one-child join can likewise
include its child’s path or `validation failed` prefix in the display message. A wrapper around a fork
keeps its text on the group. Earlier versions could concatenate joined plain errors into one
detail. Each branch now supplies its own message. A nested group's wrapper remains reachable on the source tree even if
an enclosing `MultiError.Error()` displays only its first failure.

**Traversal limits.** `max` limits displayed details. Independently, one walk can examine
`MaxErrorTreeWork` (16,384) nodes and entries in total and query `MaxErrorTreeViews` (100)
opaque adapters across all branches. Validation entries, recorded positions and the work of
checking whether a request retained its body share the work budget. These bounds cover the
runtime's traversal. Application-defined `Error`, `Unwrap` and `As` methods are trusted code.
They must bound their own work, including searches of hidden errors, and expose stable causes
and views across calls. Authentication dispatch and the installed problem handler may inspect
the same error separately. An inconclusive transport size lookup makes the body ineligible
for partial validation.

On diagnostic exhaustion, completed diagnoses stay in order. A root `traversal-limit` record identifies the
unexamined remainder and carries `ErrErrorTreeLimit`. `FailedPaths` then returns the root
pointer, and partial validation skips the entire value or affected request segment.
`Validator.Merge` records the limit at its current prefix. Both HTTP handlers include the
marker in `errors` and use the limit message as the summary. The detailed handler also includes
the marker in `details` when its display limit permits it. A detail-only call that already
filled `max` returns its prefix immediately. If a native collection exceeds the copying budget,
`WithPath` keeps the original tree and partial value under a single prefixed `DecodeError`.
Fail-fast normalization reports the limit if it cannot reach the first failure within budget.

Decoding failures carry a `*tsgo.DecodeProblem` (`errors.As`) whose `Kind` is stable: `syntax`,
`type` (`Expected` JSON type, `Got`), `required`, `unknown-property`, `duplicate-property`,
`never`, `enum` and `literal` and `discriminator` (`Allowed` values), `union`, `range` (`Expected`
Go type, `Minimum`, `Maximum`), `precision`, `format` (`Expected`: `date-time`, `duration`,
`base64`, `int32`, …, also for parameters), `unicode`, `items` (tuple length). In details the kind
is the `Constraint` and the metadata fill `Expected`, `Got`, `Allowed`, `Minimum` and `Maximum`.
Use these fields for classification. The display text follows the wrapper rules above.

Decoding keeps every independent failure of an object, array, record or tuple (at most
`tsgo.MaxCollectedErrors` per value), while the first failure remains the error's message and
what `errors.As` finds: code written for fail-fast decoding sees no difference. A union variant
identified by its constant properties or its discriminator reports all of its failures, each
with its path and the variant. The server reports the first failure by default;
`ServerOptions.CollectErrors` decodes every parameter and the body, then validates what decoded
and hands everything to `RequestErrorHandler` (the first failure stays the message);
`ServerOptions.ErrorDetails` adds `details` to the default problem response and
`ServerOptions.MaxErrors` bounds them.

Once the operation is selected, a malformed query excludes its parameter bindings and an unsupported request media type excludes the body. Other independently decoded values still contribute errors. Failures during operation selection (literal query values, `@sharedRoute` media types) are reported alone. Custom hook metadata must be JSON-encodable to appear in a problem document. Applications can retrieve the original metadata through `tsgo.Details`.

**Validation of what decoded.** A failing decoder keeps what did decode (properties, items,
entries, the identified union variant) and records exactly which positions did not decode. With
`CollectErrors` the server validates the decoded parts: a constraint violated by a sibling of a
failure is reported, while a value that did not decode (its zero value, a missing property, a
union without an identified variant) is never checked. Joined request failures can retain different fields of the same body. Every branch must identify a retained body through `DecodedBodyError` to validate its surviving fields. A transport failure on any branch excludes that request segment. A collection that reached
`MaxCollectedErrors` counts as failed as a whole. Outside servers, `tsgo.Partial[T](err)` returns
the partially decoded value of a generated type `T` (the `json.Unmarshal` target itself is left
unchanged), `tsgo.FailedPaths(err)` the failed positions and `tsgo.ValidateDecoded(err,
partial.ValidateWith)` adds the violations of the decoded parts. Every generated type has
`ValidateWith(v *tsgo.Validator)`, which records its violations at `v`'s position.

With `validation-hooks`, an application adds checks to a generated type by declaring, in the
generated package, `func (m Widget) ValidateExtension(v *tsgo.Validator)`. It runs after decoding
and the generated checks, at every depth, on values that decoded completely (also next to failed
siblings with `CollectErrors`), never on partially decoded values and never while a union variant
is selected: variants are selected by the declared constraints alone, then checked once. It can
only add errors: `v.Add(constraint, format, …)`, `v.AddLimit(constraint, limit, value, format,
…)`, `v.AddError(constraint, err)` or `v.AddErrorValue(constraint, value, err)` (the offending
value, reported in details); `errors.As` finds `err`. Transforming or coercing input before
decoding is not part of the generated contract; it belongs in HTTP middleware, where it is
explicit, and TypeSpec semantics are never relaxed.

**Standalone records.** `tsgo.OrderedMap` used outside generated code (`MarshalJSON`,
`UnmarshalJSON`) encodes and decodes values with `tsgo.DefaultCodec[T]`, the codecs of generated
code without serialization options (runtime codecs for Go primitives, a type's own JSON methods),
and keys with the default escaping; options such as `float-format` and `string-escaping` apply to
the records of generated types, and `tsgo.OrderedMapCodec(elem, escaping)` selects them for a
standalone map, per call (there is no global setting). `encoding/json` itself transforms what any
`MarshalJSON` returns: `json.Marshal` escapes `<`, `>` and `&` (an `Encoder` with
`SetEscapeHTML(false)` does not), and both escape U+2028 and U+2029 that `string-escaping:
minimal` writes raw. To keep the runtime's exact bytes, call `MarshalJSON` or a codec directly.

Documentation from TypeSpec is arbitrary text. gofmt reformats doc comments of top-level
declarations (go/doc/comment), so the emitter writes them in that canonical form, iterated to a
fixed point because go/doc/comment is not idempotent; it is a port of Go's parser and printer,
checked against Go's own implementation.

## Decoding, defaults and validation

The three steps are separate and usable outside HTTP (for example on LLM output):

1. `json.Unmarshal` (generated `UnmarshalJSON`) checks **structure**: JSON types, required
   presence, nullability, literal and enum membership, discriminators, tuple arity, duplicate
   keys (rejected), integer range and exactness (`1.0` is an integer; `1.5` is not), and the
   unknown-property policy.
2. `ApplyDefaults()` sets **absent optional** properties that declare a default, recursively. An
   explicit `null` is kept; each application produces a fresh value (no shared slices/maps).
3. `Validate()` checks **constraints** (`@minLength`, `@pattern`, `@minValue`, `@minItems`, …,
   including those of the scalar chain), recursively, returning `tsgo.ValidationErrors` with JSON
   Pointer paths and constraint names.

The strict server runs decode → defaults → validate for every request.

**Union decoding policy** (undiscriminated unions): variants are tried in declaration order; the
selected variant is the first one that decodes, validates and represents the input exactly (its
re-encoding is JSON-equivalent to the input, nested properties and exact number values included);
otherwise the first one that decodes and validates; otherwise the first one that decodes (its
constraint violations are then reported by `Validate`). So `{"o":{"x":"a","y":5}}` selects a
variant whose nested model declares `y` over an earlier one that would drop it. When no variant
represents the input exactly, properties undeclared in the selected variant follow
`unknown-properties`, as for any model; a closed variant (`...Record<never>`) never selects input
with undeclared properties. Use `unknown-properties: reject`, a discriminated union, closed
models, or distinct shapes when that matters.

**Union decoding errors**: when no variant decodes, the error names the variants the input was
meant for, judged only by the constants the variants declare (required single-literal properties
such as `kind: "circle"` or `revision: 2`; property names carry no weight, and these constants
never influence which variant is selected). A single such variant's own error is returned with its
precise JSON Pointer (`/shapes/0/radius: expected number, got string (union variant Circle)`,
`errors.As` → `*tsgo.VariantError`); several are reported as a `*tsgo.UnionError` listing each
candidate's `*tsgo.DecodeError`; a constant that every variant declares and the input matches in
none is reported at that property (`/shapes/0/kind: "hexagon" identifies no union variant (expected
"circle" or "square")`). Messages list at most three variants and truncate nested messages, and
failures are formatted only when reported. Constraint violations of a decodable variant are
validation errors (`tsgo.ValidationErrors`, `ErrValidation` for requests), not decoding errors.
Request error handlers receive these errors inside `*tsgo.RequestError`.

### Visibility and undeclared properties

A request body is decoded with the payload visibility of the operation: a create request uses
`WidgetCreate`, which has no read-only `id`. By default such an excluded property is an undeclared
property of that variant, so it is ignored under `unknown-properties: ignore` and **rejected** by
closed models (`...Record<never>`) and `unknown-properties: reject`. With `invisible-properties:
ignore`, properties declared by the model but excluded by the visibility (not HTTP metadata) are
accepted and discarded at every depth, in JSON and form bodies: the value is never decoded or
handed to the handler, so visibility and writable-property rules are unchanged, and genuinely
undeclared properties are still rejected where the policy or closure says so.

**Patterns** are ECMAScript regular expressions in Unicode mode (the `u` flag that JSON Schema
2020-12 prescribes; also the semantics of Pydantic and JSON Schema validators): they match code
points. They are translated to RE2 with identical semantics (`.`, `\s`, `\uXXXX` and surrogate
pairs, `\u{…}`, `[\b]`, `[^]`, `\p{General_Category}`). Lookaround, backreferences, lone
surrogates, script properties, identity escapes that Unicode mode forbids and repetition counts
above 1000 are rejected at compile time.

**Numeric literals** keep every digit in defaults, literal types and constraints. TypeSpec 1.18
interns numeric literals by their binary64 value, so two distinct literals that round to the same
double (e.g. `9007199254740995` and `9007199254740997`) share one exact value in its semantic
model; such programs are rejected (`conflated-numeric-literal`) instead of emitting a wrong digit.
Membership in float literals and float enums is decided on the wire token, before binary rounding:
`0.30000000000000001` is not the literal `0.3`, although both decode to the same `float64`. Exact
numbers (`integer`, `numeric`, `decimal`, numeric durations) are limited to 10,000 significant
digits and an exponent within ±10,000 (`tsgo.MaxExactDigits`, `tsgo.MaxExactExponent`): conversion
cost grows superlinearly, so larger inputs are rejected rather than allowed to exhaust CPU.
`@format` is a hint (TypeSpec semantics) and is not enforced.

## Strict server

```go
type StrictServerInterface interface {
	WidgetsRead(ctx context.Context, request WidgetsReadRequestObject) (WidgetsReadResponseObject, error)
	// ...
}

h := api.NewHandler(impl, api.ServerOptions{
	Authenticate:      myAuth,         // required when operations use @useAuth (fail closed otherwise)
	Middlewares:       []api.StrictMiddlewareFunc{logging},
	ValidateResponses: true,
	MaxRequestBodyBytes: 1 << 20,      // default 10 MiB
})
// or api.RegisterHandlers(mux, impl, opts) on an existing *http.ServeMux
```

* Request objects carry typed, decoded, defaulted and validated parameters (`tsp:"query,name"`
  tags document the wire names) and the body.
* Each operation has its own response interface implemented only by its variants
  (`WidgetsRead200JSONResponse`, `WidgetsRead404JSONResponse`, `…4XXJSONResponse` with
  `StatusCode`, `…DefaultJSONResponse`), so variants of other operations do not compile.
* Flat model-valued path parameters bind from RFC 6570 key/value pairs. For example, `/items/{filter}` can accept `/items/n,2,label,a%2Cb`. Binding validates required fields, encoded property names and closed objects. Exploded matrix keys with an empty text value use `;label`.
* Routing uses Go 1.22 `ServeMux` patterns. Routes with RFC 6570 expressions inside segments,
  label/matrix/path styles, optional `{/x}`, records or literal query text are dispatched by a
  compiled template regex behind a `{tail...}` pattern; `@sharedRoute` operations are selected by
  `Accept` (most specific matching media range, then q-value) and `Content-Type` (406/415 when
  none matches). URI expressions with several variables (`{a,b}`) and prefix modifiers (`{s:3}`,
  when `@maxLength` does not exceed the prefix) are supported. Malformed query strings are 400.
* Bodies: JSON (`*/*+json`), text, binary, `Http.File`, multipart/form-data (model and tuple
  form; requests and responses), `application/x-www-form-urlencoded` (requests and responses), XML
  (`@typespec/xml` rules), JSON merge patch, server-sent events (`SSEStream<E>` →
  `iter.Seq[tsgo.SSE[E]]`, flushed per event; union-typed event variants, nested `@data` envelopes and text events of any type with a text form allowed) and JSON Lines
  (`JsonlStream<T>`: `iter.Seq[T]` responses, lazily decoded `iter.Seq2[T, error]` requests).
* A request stream is the request body: an invalid item fails the request with 400 even when the
  handler stopped reading early (the remainder is read, within the body limit). With
  `ValidateResponses`, every streamed response item is validated: an invalid first item yields a
  500 problem response; a later one aborts the connection (the status line is already sent).
* Errors use RFC 9457 problem details by default (`RequestErrorHandler`,
  `ResponseErrorHandler`); handler errors are never written to clients; 400/401/406/413/415 are
  distinguished.
* Context cancellation propagates through `r.Context()`; streams stop when the client goes away.
* `@server` URLs are deployment configuration: mount the handler under the server path
  (`http.StripPrefix`).

## Limitations

See [docs/limitations.md](../../docs/limitations.md) and the
[feature matrix](../../docs/feature-matrix.md). Everything listed as unsupported fails the
compilation with a diagnostic at the offending declaration and removes previously generated
files, so a partial or stale package is never left behind.
