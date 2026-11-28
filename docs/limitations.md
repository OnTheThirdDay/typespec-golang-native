# Known limitations

The tables distinguish **source** limits in TypeSpec or the pinned compiler, **target** limits in a protocol, runtime or documented profile, **policy** choices, **implementation** restrictions in working features and **missing** functionality. A row can have more than one cause. ⛔ denotes a diagnostic and ⚠️ denotes a supported behavior with a boundary. The [feature inventory](feature-matrix.json) links the executable evidence.

## Both emitters

| Behavior | Limitation | Classification | Reason |
|---|---|---|---|
| ⛔ | Distinct numeric literals that round to the same binary64 value in one program, e.g. `9007199254740995` and `9007199254740997`, or `0.1` and `0.10000000000000000001` | Source | TypeSpec 1.18 interns literal types by their JavaScript `number` (`program.literalTypes`). The later literal silently takes the earlier one's exact value in literal types, defaults, constraints and examples. Emitting it would change a digit. (`conflated-numeric-literal`) |
| ⛔ | Unknown decorators, e.g. `TypeSpec.JsonSchema.*`, on reachable types | Policy / missing | The emitters fail closed rather than ignore semantics. |

## typespec-go

| Behavior | Limitation | Classification | Reason |
|---|---|---|---|
| ⛔ | Patterns with lookaround, backreferences, lone surrogates, Unicode set operations (`v` mode), or nested counted repetitions whose product exceeds 1000 | Target / implementation | The backend uses Go's RE2. Some backreferences describe non-regular languages. Count expansion, Unicode mode and exclusion of lookaround are implementation or profile choices. Unicode properties (including scripts) are resolved into explicit code-point sets from the generator's ECMAScript tables. |
| ⛔ | Identity escapes that Unicode mode forbids, such as `\a` or `\q` | Target | These are syntax errors in Unicode-mode ECMAScript. |
| ⛔ | Nullable parameters (`@query q: T \| null`) | Target / policy | HTTP parameters have no representation of null. |
| ⛔ | Record- or model-typed header or cookie parameters | Missing | Flat models bind in query and path parameters. Header and cookie object binding still needs a specified serialization convention. |
| ⛔ | URI expressions with several variables where a value is optional, composite, or uses `+`/`.` | Target / implementation | Some forms have multiple valid inverses. The current check also rejects bounded combinations for which a unique inverse could be established. |
| ⛔ | Nested properties in a model-valued path parameter, reserved expansion of a model, or exploded label expansion of a model | Target / implementation | RFC 6570 represents flat name/value pairs. Reserved punctuation or a literal dot in exploded labels can make the inverse ambiguous. Simple, matrix and segment expansions bind typed fields and preserve escaped separators. |
| ⛔ | Prefix modifiers (`{x:3}`) without a `@maxLength` no larger than the prefix | Target | The suffix would be lost. |
| ⛔ | Fragment expansions (`{#x}`) | Target | Fragments are never sent to a server. |
| ⛔ | Media types other than JSON, text, binary, files, multipart/form-data, form-urlencoded, XML, SSE and JSON Lines | Missing | Not implemented. |
| ⛔ | Multipart parts with custom MIME headers | Missing | These need a typed header binding. |
| ⛔ | XML: nullable properties, nested collections and additional properties | Policy / missing | The supported XML mapping has no chosen null marker. The implementation covers records of scalars or models and one collection level. XML record keys must be unqualified element names. Further structural XML codecs would be possible with explicit conventions. Closed models and `unknown-properties: reject` are enforced on XML elements, attributes and text. |
| ⛔ | SSE: text events whose payload has no text codec (e.g. a model); `@data` envelopes with other required properties, at any depth | Target / policy | SSE transmits event, id, retry and text data. Extra required model values need an agreed payload convention. Optional envelope fields that are set are a runtime error, never dropped. |
| ⛔ | Required non-nullable self-containment (`model A { a: A }`) | Source | No finite value exists. |
| ⛔ | `package-name` that is a Go keyword | Target | It would generate invalid Go. |
| ⚠️ | `float` maps to `float64`. Nonzero numbers that underflow to 0, and numbers beyond range, are rejected. | Target / policy | Arbitrary-precision binary floats are not representable. `numeric` and `decimal` are exact. |
| ⚠️ | Float bounds are compared on the decoded binary64 value, exactly via `big.Rat` when the bound is not representable | Target / policy | The input's decimal precision is lost when decoding into `float64`/`float32`. |
| ⚠️ | An undiscriminated union whose variants are all inexact for an input selects the first valid variant. Properties undeclared there follow `unknown-properties`. | Policy | This is the documented decoding policy. An exactly matching variant, nested properties included, is always preferred. To refuse such inputs, use a discriminator or `unknown-properties: reject`. |
| ⛔ | `response-unset-nullable` names that select no optional nullable property written by a server response (unknown, not optional and nullable, reachable only from requests, or excluded by the response visibility) | Policy | The selection would have no effect on serialized JSON. Model-only contract exporters validate against the codecs they publish. |
| ⚠️ | `response-unset-nullable` selects models and named properties; unset properties of anonymous models are written as null only with `null` (all) | Implementation | The selector matches TypeSpec declaration names. Model-only contract exporters may select properties of exported types. |
| ⚠️ | A read-only (visibility-excluded) property in a request is undeclared for that request: rejected by closed models and `unknown-properties: reject` | Policy | The request variant (`WidgetCreate`) does not declare it. Option `invisible-properties: ignore` accepts and discards such properties while still rejecting undeclared ones. |
| ⚠️ | One Go package per generation; `file-layout` distributes declarations over files of that package | Policy | One program is not partitioned into several packages. Separately compiled specifications can share a package (`external`, `export-contract`). |
| ⛔ | External mappings whose declaration differs from the shared package's (fingerprint), names it does not declare, different representation options, runtime package or runtime version | Policy | The imported Go type would not have the semantics the consumer's TypeSpec declares. (`external-package`) |
| ⛔ | A consumer `response-unset-nullable` selection of a shared declaration's property that the shared package does not select (or `null` for all against a shared selection) | Policy | The shared Go type's response encoding cannot change; consumers inherit the shared selection instead of repeating it. |
| ⚠️ | Collected-error validation skips a whole collection that reached `MaxCollectedErrors` (its later items were not decoded), and form, multipart, XML and text bodies and parameters that failed (they keep no partial value) | Policy / implementation | Only JSON bodies keep partial values. A malformed query string excludes query bindings. An unusable Content-Type excludes the body and its media-type parameter. Independent request positions are still checked. |
| ⚠️ | A diagnostic walk that exhausts its work or adapter budget reports `traversal-limit` and skips partial validation of the unresolved value or request segment | Policy | HTTP status lookup uses the remaining budget. On cutoff it uses an already diagnosed request classification or the applicable 401 or 400 default. Opaque adapters control the visibility of hidden failures and the cost of their own methods. [Error handling](../packages/typespec-go/README.md#errors-and-application-checks) |
| ⚠️ | Text that an application's error wrapper adds around several problems (`fmt.Errorf("input: %w", errors.Join(a, b))`) stays on the group in the original error tree. An enclosing `MultiError.Error()` displays only its first failure | Target | Go exposes the wrapper's complete message and its children. It provides no per-child attribution for shared text. The original wrapper remains reachable through the error tree. |
| ⚠️ | Validation hooks run only on values that decoded completely, and never while a union variant is selected (variants are selected by declared constraints) | Policy | Application code never sees zero values of failed parts and never changes which variant a value is. |
| ⚠️ | `float-format: python-repr` writes `float32` values from their shortest float32 digits (the Python float of that decimal) | Target / policy | Python has no binary32 type. |
| ⚠️ | Anonymous types of a shared namespace are matched by where they are written (containing declaration, path, template arguments, projection) and checked by fingerprint; derived variants the shared package never generated are generated in the consumer | Implementation | A variant that does not exist there cannot be imported. |
| ⚠️ | Union decoding errors identify the intended variant only by declared constants (required single-literal properties) | Implementation | Other shapes give no reliable evidence; all candidates are then reported (bounded). Selection never uses this evidence. |
| ⛔ | `ordered-records` with record-valued parameters or form additional properties | Implementation | These binders currently use `url.Values` and lose original key order. An ordered wire parser could support them. XML child elements and JSON record entries retain insertion order. |
| ⚠️ | `float-format: pydantic` and `python-repr` apply to `float32`/`float64` values written as JSON numbers | Policy | Numbers encoded as strings and numeric durations keep their encodings; `decimal` and `integer` are exact and unaffected. |
| ⚠️ | Validation hooks run after decoding and only add errors | Policy | Pre-decode transformation or coercion is HTTP middleware, outside the generated contract; TypeSpec checks cannot be relaxed. |
| ⚠️ | Doc comments are written in gofmt's canonical form | Policy | go/doc/comment may reflow indented spans into code blocks or lists and replace `` and '' by curly quotes in Go comments; schema descriptions are unchanged. |
| ⚠️ | One API version per generation (`api-version`) | Policy | Generate one package per version to serve several. |
| ⚠️ | `@server` URLs are not applied | Policy | That is deployment configuration: mount the handler under the server path. |
| ⚠️ | Credential verification is application code | Policy | The generated server exposes the declared schemes and fails closed without an `Authenticate` hook. |
| ⚠️ | Duplicate JSON object keys are rejected | Policy | The input is ambiguous (RFC 8259 §4). |
| ⚠️ | A request stream is read to the end, within the body limit, after the handler returns, so an invalid trailing item still fails the request | Policy | The request body is one contract value. |
| ⚠️ | An invalid streamed response item after the first one aborts the connection | Target | The status line has already been sent. |
| ⚠️ | `go test -race` needs cgo. The independent run used Linux and GCC under WSL. CI runs the race suite on Linux. | Target | The generated handler shares only read-only options between requests. |
| ⚠️ | Exact numbers (`integer`, `numeric`, `decimal`, numeric durations) are limited to 10,000 significant digits and a decimal exponent within ±10,000; larger inputs are rejected | Policy | A resource limit: exact conversion cost grows superlinearly with digits and exponent, so a small token such as `1e1000000` could otherwise consume tens of milliseconds of CPU. |

## typespec-structured-output

| Behavior | Limitation | Classification | Reason |
|---|---|---|---|
| ⛔ | `bytes`, `numeric`, `decimal` and non-default `@encode` in the default `scalar-encodings: pydantic` | Policy / missing | Pydantic's default schema for the equivalent declaration differs from the TypeSpec wire form or accepts arbitrary strings. Option `scalar-encodings: wire` maps base64/base64url bytes, string-encoded booleans and JSON decimals to explicit Pydantic annotations (other encodings stay rejected). |
| ⛔ | Fractional literals beyond binary64 precision | Target | They have no Python `float` equivalent. |
| ⛔ | `a?: T` without `optional-properties: nullable`; required properties with defaults | Target / policy | Not representable in Pydantic or Structured Outputs without an explicit policy. |
| ⛔ | Non-null defaults in OpenAI profiles, unless `default-values: omit` | Target / policy | `default` is outside the documented subset. `emit` is only accepted with `target-profile: none`. |
| ⛔ | Discriminated-union fallbacks (default variants, or a `@discriminator` base with derived models) whose discriminator is not a required plain string, or already has a `pattern`; fallbacks with an envelope | Implementation / target | The fallback is expressed as a string `pattern` excluding the known tags (`not` is outside the profile), which needs a free string discriminator. |
| ⛔ | Enums or literal unions mixing value types in OpenAI profiles, with the default `mixed-enums: pydantic` | Policy / target | The schema is exactly Pydantic's type-less `enum`, which the profile rejects. Option `mixed-enums: typed-union` emits one typed branch per value type (documented Pydantic equivalent). |
| ⛔ | Records, tuples, `unknown`, `url`, additional properties, and unsupported formats, in OpenAI profiles | Target | Rejected by the target. They are emitted with `target-profile: none`. |
| ⛔ | Template arguments without a Pydantic spelling, such as anonymous objects or values | Policy / implementation | Python has no unique implicit class name for an anonymous TypeSpec shape. The current mapping requires an explicit `@friendlyName`. String literals are spelled as Python `repr` does. |
| ⛔ | An unknown `api-version`; duplicate JSON property names; root names that are not portable file names or that clash case-insensitively | Source / policy | Configuration and representation errors. |
| ⛔ | A recursive reference that carries its own metadata (e.g. `/** doc */ child: Self`) in strict mode | Target | The OpenAI SDK's strict transformation inlines such references and recurses forever (`RecursionError`, verified with the pinned SDK). |
| ⛔ | `roots`/`exclude-roots` entries that select no root, or a selection that leaves none | Policy | A mistyped name must not silently change the emitted files. |
| ⚠️ | Visibility applies only with option `visibility`; otherwise a warning is reported | Policy | A Structured Output schema describes one representation. |
| ⚠️ | Documentation of named unions is not emitted (warning) | Policy | Pydantic type aliases carry no description. |
| ⚠️ | `float32` is a JSON number without range | Target | Pydantic has no binary32 annotation. The schema accepts `16777217`, which Go rounds to `16777216`, and `1e39`, which Go rejects for a binary32 field. A bare JSON number cannot guarantee exact binary round trips. |
| ⚠️ | Numbers are emitted without the int/float distinction (`1` for Python `1.0`) | Source | TypeSpec numeric values do not carry it. |
| ⚠️ | Nesting depth counts object levels, not arrays | Policy | The OpenAI guide does not specify this. See [openai-profile.md](openai-profile.md). |
