# Pydantic compatibility profile — version 3

| | |
|---|---|
| Profile | `pydantic-2.14-openai-3.59` (v3) |
| Reference implementation | Pydantic **2.14.4** (pydantic-core 2.50.5), openai-python **3.59.0** |
| Schema generation | `BaseModel.model_json_schema()` (validation mode, `by_alias=True`) |
| Strict transformation | `openai.lib._pydantic.to_strict_json_schema` |
| Fixtures | `packages/typespec-structured-output/test/fixtures/*/reference.json` (committed) |

Version 3 maps recursive named lists and dictionaries to Pydantic named type aliases. It also covers class names supplied by `@schemaName`, defaults represented by `@defaultFactory` and Python titlecase for Unicode field aliases. Both reference package versions stay pinned. Existing inline mappings continue to apply to ordinary collections. The title tests cover multi-character titlecase mappings, Greek final sigma, whitespace and aliases containing supplementary characters. JavaScript and the reference Python can have different Unicode data for newly assigned characters.

**Migrating from version 2.** Regenerate committed schemas and review these differences for
declarations version 2 already accepted:

* Field titles of aliases whose Python titlecase the version 2 approximation got wrong now
  follow CPython: `ßeta` is `Sseta` (formerly `SSeta`), `ǳone` is `ǲone`, `ΟΣ` is `Ος`,
  Georgian Mkhedruli keeps its letters, a cased letter without case mapping such as `ʰ` lowers
  the next letter, U+0085 and U+001C–U+001F are stripped and U+FEFF is kept.
* A definition name containing a supplementary character gets one `_` per character (formerly
  two).
* With `emit-all-models`, a `@structuredOutput` root that is not an object model is reported
  (`invalid-root`) instead of silently skipped. A `roots` entry whose roots are all absent from the
  selected `api-version` is reported (`root-selection`), even when other roots remain. `roots` and
  `exclude-roots` match TypeSpec identifier spelling, so a name that needs backticks in TypeSpec
  needs them in the option.

Recursive named collections failed (stack overflow) under version 2. They are new mappings, not
changes.

Version 2 adds a class convention for the value type `Record<never>` and omits uninhabited `never` branches from anonymous union annotations. It preserves version 1 output for declarations previously accepted.

## Three levels of equivalence

1. **JSON Schema semantic equivalence** — the same set of JSON values validates. Necessary but not
   sufficient: schemas that are equivalent can still present different information to a model
   (titles, descriptions, `$defs` names) and influence output ordering.
2. **Pydantic-compatible representation** — the schema Pydantic produces for the *equivalent
   Pydantic declaration* defined by this profile (the conventions below fix which declaration is
   equivalent when several exist).
3. **Exact structural compatibility** — identical keys, key order, list order and values
   (numbers compared by value). This is what the fixture tests assert, for `model_json_schema()`
   and for the SDK's strict output.

The emitter targets level 3 for everything it accepts. Where level 3 cannot be reached from the
information in the TypeSpec program the emitter reports a diagnostic instead of approximating.
One representational difference is inherent: JSON numbers have no int/float distinction in
TypeSpec, so `1.0` written in Python is emitted as `1`.

## Mapping conventions (TypeSpec ↔ equivalent Pydantic declaration)

| TypeSpec | Pydantic |
|---|---|
| `model M { … }` in namespace `A.B` | `class M(BaseModel)` in module `A.B` (global namespace: `__main__`) |
| `/** doc */` on a model / property | class docstring / `Field(description=…)` (`inspect.cleandoc`) |
| `@summary("T")` on a model / property | `model_config = ConfigDict(title="T")` / `Field(title="T")` |
| property name / `@encodedName("application/json", "x")` | field name / `Field(alias="x")` (titles derive from the alias) |
| `string`, `boolean`, `integer`, `float`, `float64` | `str`, `bool`, `int`, `float`, `float` |
| `int8`…`uint64`, `safeint` | `Annotated[int, Field(ge=<min>, le=<max>)]` (declared bounds intersected with the type range) |
| `float32` | `float` (range and precision of binary32 are not expressible) |
| `utcDateTime`, `offsetDateTime`, `plainDate`, `plainTime`, `duration` | `datetime`, `datetime`, `date`, `time`, `timedelta` |
| `url` | `AnyUrl` |
| `unknown` | `Any` |
| `@format("x")` | `Field(json_schema_extra={"format": "x"})` |
| `@minLength/@maxLength/@pattern` on strings | `Field(min_length=…, max_length=…, pattern=…)` (intersection along the scalar chain) |
| `@minValue/@maxValue/@minValueExclusive/@maxValueExclusive` | `Field(ge=…, le=…, gt=…, lt=…)` |
| `@minItems/@maxItems` | `Field(min_length=…, max_length=…)` on the list |
| custom scalar with constraints | `Annotated[…, Field(…)]` alias (inlined; scalar doc becomes the field description) |
| `T[]`, `Record<T>`, `[A, B]` | `list[T]`, `dict[str, T]`, `tuple[A, B]` |
| Recursive named `model T is T[]` or `model T is Record<T>` | `TypeAliasType` with recursive references. A tighter field bound specializes only the outer list. A typed dictionary requires `target-profile: none`. |
| `@schemaName("N")` on a model or enum | Pydantic class `N`, including the generic origin name |
| `@defaultFactory` on an optional property with a TypeSpec default | `Field(default_factory=…)` with no schema `default`. Target default policies still apply. |
| `enum E { a, b: "x" }` | `class E(str, Enum)` (`int, Enum` for integers) |
| `"a" \| "b"`, `E.a \| E.b` | `Literal["a", "b"]`, `Literal[E.a, E.b]` |
| literal and non-literal variants | `Union[Literal[...], …]` with all literals grouped at the first literal's position |
| `A \| B` (named or anonymous union, nested unions flattened) | `Union[A, B]` (inlined; a named union has no definition) |
| `T \| null` | `Optional[T]` |
| `a?: T \| null` | `a: Optional[T] = None` |
| `a?: T = v` | `a: T = v` |
| `a?: T` | not representable (Pydantic needs a default); option `optional-properties: nullable` maps it to `a: Optional[T] = None` |
| `a: T = v` (required with default) | not representable (a Pydantic field with a default is not required) — diagnostic |
| `model B extends A` | `class B(A)` (inherited fields first; a redeclared field keeps the base position) |
| `...A` spread, `model B is A` | fields copied in place / an independent class with A's fields |
| `Page<Item>` | generic `Page[Item]` (title `Page[Item]`, definition `Page_Item_`) |
| template arguments | spelled as Pydantic displays them: models/enums by class name, `str`/`bool`/`int`/`float`, `datetime`/`date`/`time`/`timedelta`, sized integers as `Annotated[int, FieldInfo(…, metadata=[Ge(ge=…), Le(le=…)])]`, `list[T]`, `dict[str, T]`, `tuple[…]`, `Union[…]`, `Literal[1]`/`Literal[True]`/`Literal['a']` (Python `repr` quoting and escapes), recursive named unions by alias name, `NoneType`, `Any` |
| `@friendlyName("N")` | a non-generic class `N` |
| `@discriminated(#{envelope: "none"})` union | `Union[…]` of the tagged variant models (not `Field(discriminator=…)`, whose `oneOf` OpenAI rejects) |
| `@discriminated` union (envelope `object`) | `Union[U_a, U_b]` of wrapper classes `class U_a(BaseModel): kind: Literal["a"]; value: A` (names `<Union>_<tag>`, property names from the decorator options) |
| enum mixing string and integer values | `class E(Enum)` — Pydantic emits a type-less `enum`; accepted with `target-profile: none`, rejected by the OpenAI profiles (enum/const schemas must declare a single type) |
| … with option `mixed-enums: typed-union` | an enum whose JSON schema is one typed branch per value type (`anyOf: [{enum: ["red", "blue"], type: string}, {const: 1, type: integer}]`, via `__get_pydantic_json_schema__`); literal unions as `Union[Literal["red", "blue"], Literal[1]]` |
| named union that reaches itself through lists, dicts, tuples or other unions (not through a model) | `TypeAliasType("Tree", Union[str, list["Tree"]])`: a `$defs` entry referenced by `$ref` (a cycle through a named model stays an inlined `Union`, as in Pydantic) |
| discriminated union with a default variant `Other` | `Union[A, U_Fallback]` with `class U_Fallback(BaseModel): kind: Annotated[str, Field(pattern=…)]`, the pattern accepting every string except the declared tags |
| `@discriminator` base `Pet` with derived models | `Pet = TypeAliasType("Pet", Union[Cat, …, Pet_Fallback])`, the fallback carrying the base properties and a tag-excluding pattern |
| option `scalar-encodings: wire` | `bytes` (base64 / base64url) as `Annotated[str, Field(pattern=<canonical base64>)]`; `@encode(string) boolean` as `Literal["true", "false"]`; `numeric`/`decimal` as `Annotated[Decimal, WithJsonSchema({"type": "number", …})]` |
| integer-like or `__proto__` property names | `Field(alias="1")` — declared position preserved |
| model `B extends A` where `A` has `@discriminator` | `class B(A)` (a concrete model) |
| option `visibility: Read` (etc.) | classes with only the properties visible in that lifecycle phase (same class names) |
| `@versioned` namespace, option `api-version` | the classes of that version's projection (official versioning mutators) |
| defaults with large or exact numbers | the exact literal text (`= 18446744073709551615`) |
| `...Record<T>` in a model | `model_config = ConfigDict(extra="allow")` with `__pydantic_extra__: dict[str, T]` |
| `...Record<never>` in a model (TypeSpec's closed object; the official emitters write `additionalProperties: {not: {}}` / `unevaluatedProperties: {not: {}}`) | `model_config = ConfigDict(extra="forbid")`: `additionalProperties: false` in the model's own schema, sorted with the other keywords (first), in both modes; the SDK strict transformation keeps it there, while ordinary models get it appended last. A property-less `model Empty { ...Record<never>; }` is an empty forbid model. |
| `Record<never>` in a field, collection or generic argument | A shared `class EmptyRecord(BaseModel)` with `model_config = ConfigDict(extra="forbid")` and no fields. Its only JSON value is `{}`. Pydantic uses `EmptyRecord` in the generic title and definitions. |
| inherited indexers | the nearest indexer in the `extends` chain decides, as inherited `model_config` does: a derived model without one inherits its base's (`forbid` or typed extras); `...Record<T>` reopens a closed base (`extra="allow"`); `...Record<never>` closes an open base (`extra="forbid"`). Spreading a closed model copies the closure. |

## Not representable (diagnostics)

`bytes` (Pydantic's default JSON form is UTF-8 text, not base64), `numeric`/`decimal` (Pydantic's
schema accepts any string) and non-default `@encode`, unless option `scalar-encodings: wire` maps
them (other encodings remain rejected); fallbacks whose discriminator is not a required plain
string or already has a pattern, and fallbacks with an envelope; documentation on named unions
(warning: Pydantic aliases carry none); template arguments without a Pydantic spelling (anonymous
objects, values; use `@friendlyName`); recursive references with their own metadata in strict
mode (the SDK's strict transformation raises `RecursionError`);
fractional literals beyond binary64 precision (Python `float`), numeric literals that the
TypeSpec 1.18 compiler conflates (two distinct literals rounding to the same double share one
value in its semantic model), conflicting patterns or formats along a scalar chain, duplicate
JSON property names, and any decorator without a mapping.

## Versioning the profile

The profile version changes whenever the reference versions change or a convention changes.
To refresh: update the pins in `tools/pydantic-reference/pyproject.toml`, run
`npm run refresh:pydantic-fixtures`, review the fixture diff, and run `npm test`. Any changed
reference output is either reproduced by the emitter or documented as a new profile version.
