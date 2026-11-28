# typespec-structured-output

A language-independent TypeSpec emitter that produces JSON Schemas for
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
The schemas are **structurally identical, including key order**, to what Pydantic v2 plus the
official OpenAI Python SDK send for the equivalent Pydantic model
(`client.responses.parse(text_format=Model)`), under a documented, versioned
[compatibility profile](../../docs/pydantic-compatibility-profile.md) (version 3; see its
[migration notes](../../docs/pydantic-compatibility-profile.md) for output changes from
version 2). The emitter does not need Python, Go or any other emitter.

```tsp
import "typespec-structured-output";
using StructuredOutput;

/** A calendar event extracted from text. */
@structuredOutput
model CalendarEvent {
  name: string;
  date: plainDate;
  participants: string[];
  location: string | null;
}
```

```yaml
emit: [typespec-structured-output]
```

writes `CalendarEvent.json`, ready to use as `text.format.schema` / `response_format.json_schema.schema`.

## Decorator

`@structuredOutput(name?: valueof string)` marks a root model. `name` is the schema name
(`json_schema.name`); it defaults to the Pydantic class name and must match `^[a-zA-Z0-9_-]{1,64}$`.

`@schemaName("Name")` sets the Pydantic class name of a model or enum, independently of the
TypeSpec declaration name and of other emitters (it wins over `@friendlyName`): the schema's
`title`, `$defs` key and `$ref` target, the default root name, and Pydantic's collision handling
(`Billing__PostalAddress`). On a template declaration it names the generic class
(`Envelope[Item]`); `model X is Y` does not inherit it. Names are Python identifiers.

`@defaultFactory` on a property with a default reproduces `Field(default_factory=…)`: the schema
has no `default`, the property stays optional, and target profile restrictions on defaults still
apply (the OpenAI profile rejects it instead of dropping the default).

## Options

| Option | Default | Meaning |
|---|---|---|
| `target-profile` | `openai` | `openai`, `openai-fine-tuned` (no string/number/array constraint keywords) or `none` (no target validation). |
| `schema-mode` | `strict` | `strict`: output of the SDK's `to_strict_json_schema`; `pydantic`: plain `model_json_schema()`. |
| `output-format` | `schema` | `schema`, `text-format` (Responses API `text.format`) or `response-format` (Chat Completions). |
| `optional-properties` | `error` | Policy for `a?: T`: `error`, or `nullable` (= Pydantic `a: T \| None = None`). Never applied implicitly. |
| `default-values` | `error` | Non-null defaults are outside the documented OpenAI subset: `error`, `omit` (drop the keyword), or `emit` (as Pydantic does; only with `target-profile: none`, never as a way around profile validation). |
| `mixed-enums` | `pydantic` | `pydantic`: enums and literal unions mixing value types are emitted exactly as Pydantic does (a type-less `enum`, rejected by the OpenAI profiles). `typed-union`: one typed branch per value type (`anyOf`), the documented equivalent of a Pydantic enum with a custom JSON schema. |
| `scalar-encodings` | `pydantic` | `pydantic`: `bytes`, `numeric`/`decimal` and non-default encodings are rejected (Pydantic's defaults differ from the TypeSpec wire form). `wire`: base64/base64url bytes as canonical-base64 string patterns, `@encode(string)` booleans as `"true"`/`"false"`, decimals as JSON numbers, each with a documented Pydantic annotation. |
| `api-version` | latest | Version of a `@typespec/versioning` namespace to describe (projected with the official versioning mutators). |
| `visibility` | — | `Read`, `Create`, `Update`, `Delete` or `Query`: keep only the properties visible in that lifecycle phase, recursively. Without it visibility is not applied (warning). |
| `emit-all-models` | `false` | Emit every concrete model, not only `@structuredOutput` roots. |
| `roots` | — | Root selection: only the roots (`@structuredOutput` models, or every model with `emit-all-models`) named here, or declared in a namespace named here (sub-namespaces included), are written as schema files. |
| `exclude-roots` | — | Roots not written as schema files, by namespace or type name, e.g. the `@structuredOutput` models of an imported library. With `roots` and `exclude-roots`, roots left out stay definitions (`$defs`) of the schemas that reference them, byte-identical to their definitions without the selection, and are validated there; a root left out and not referenced is not generated. An explicit inclusion that is absent in the selected API version is diagnosed. Use TypeSpec identifier spelling for Unicode or backtick-escaped names. Every entry must select a root and the selection must leave one (`root-selection` errors). |
| `file-layout` | `single` | Directories of the root schema files: `single` (`<Root>.json`), `per-namespace` (`shop/catalog/<Root>.json`) or `per-source-file` (`catalog/products/<Root>.json`, the project `.tsp` file declaring the root). File names, schema contents, `$defs` and key order are identical in every layout. Directory segments are lower-case `[a-z0-9_]`, Windows device names get a trailing `_`, and namespaces or files that normalize to the same directory are numbered in sorted order; roots outside a namespace or the project stay at the top level. Root names stay unique across all directories. The manifest removes the files (and emptied directories) of a previous layout. |

## What is checked

1. **Pydantic representation** — generated directly from the TypeSpec semantic model with a port
   of Pydantic's definition naming/collision remapping, root unpacking, garbage collection and
   key sorting.
2. **SDK strict transformation** — a line-by-line port of `_ensure_strict_json_schema` (including
   its `$ref` unravelling and key ordering).
3. **Target validation**, independent of 1 and 2 ([OpenAI profile](../../docs/openai-profile.md)):
   allowed keywords per type, supported formats, root object (no `anyOf`), every property
   required, `additionalProperties: false`, `$ref` resolution, and the size limits (5,000
   properties, 10 nesting levels, 120,000 characters of names/enum/const values, 1,000 enum
   values, the 250-value/15,000-character rule). Violations are diagnostics located at the
   TypeSpec declaration that produced the offending schema node.

**Closed models** use TypeSpec's native closed object, `...Record<never>` (which the official
JSON Schema and OpenAPI emitters also read as closed): they are Pydantic models with
`ConfigDict(extra="forbid")`, so `additionalProperties: false` appears where Pydantic puts it
(first, by its key sorting) in both schema modes, and the Go emitter rejects their undeclared
properties. A field or array item of type `Record<never>` uses an empty, closed `EmptyRecord` model.

Every decorator on a reachable type must have a mapping; unknown decorators (e.g.
`@JsonSchema.uniqueItems`) are errors, so no constraint is dropped silently. Failed compilations
remove previously emitted schemas.

## Tests

* `test/fixtures/*`: 50 paired TypeSpec/Pydantic cases (including ports of the OpenAI SDK's own
  `test_pydantic.py` models) compared byte-structurally with committed reference output of
  Pydantic 2.14.4 + openai 3.59.0, in both `strict` and `pydantic` mode; 33 fail-closed fixtures.
* `test/oracle.test.ts`: leaf keyword parity with the official `@typespec/json-schema` emitter.
* `tools/pydantic-reference/generate.py` (Python, only for refreshing fixtures):
  `npm run refresh:pydantic-fixtures` at the repository root.
* `npm run test:openai` (opt-in, needs `OPENAI_API_KEY`): submits the emitted OpenAI-profile
  schemas to the real API and reports each as accepted, rejected or unverified (auth, quota,
  infrastructure); only full acceptance exits 0. See [openai-profile.md](../../docs/openai-profile.md).
