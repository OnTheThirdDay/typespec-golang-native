# OpenAI Structured Outputs target profiles

Source: <https://developers.openai.com/api/docs/guides/structured-outputs>, section "Supported
schemas" (checked 2026-11-27). Implemented in
`packages/typespec-structured-output/src/profile.ts`; profile name `openai`, plus
`openai-fine-tuned`.

| Rule | Source | Check |
|---|---|---|
| Root is an object and does not use `anyOf` | "the root level object of a schema must be an object, and not use anyOf" | `type: "object"`, no root `anyOf` |
| Every property is required | "All fields … must be specified as required" | `required` = all `properties` keys |
| `additionalProperties: false` on every object | "must always be set in objects" | enforced per object schema |
| Supported types | String, Number, Boolean, Integer, Object, Array, Enum, anyOf | `type` values limited to these (+ `null`) |
| String keywords | `pattern`, `format` (date-time, time, date, duration, email, hostname, ipv4, ipv6, uuid) | other formats rejected |
| `minLength`, `maxLength` | listed as unsupported **only for fine-tuned models**, hence accepted for the default profile | inference documented here |
| Number keywords | `multipleOf`, `maximum`, `exclusiveMaximum`, `minimum`, `exclusiveMinimum` | |
| Array keywords | `items`, `minItems`, `maxItems` | `prefixItems` (tuples) rejected |
| Composition | `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if/then/else` unsupported | rejected; `oneOf` rejected as undocumented |
| Definitions and recursion | `$defs` + `$ref` (`#/$defs/x` or `#`) | refs must resolve; `$ref` must not have siblings |
| `const`, `enum`, `title`, `description` | used throughout the guide and by the SDK | requires a declared type for literals. The guide shows an enum with `type: ["string","null"]`. The profile permits one value type plus null and checks each literal against the declaration. It conservatively rejects several non-null types in one enum. JSON Schema still requires membership in the enum itself. |
| `default` | not part of the documented subset | always rejected by both OpenAI profiles; `default-values: omit` drops it, `emit` is only accepted with `target-profile: none` |
| Keyword value types | JSON Schema | `type` names, `$ref` targets and `$defs` names are looked up as own properties (never through `Object.prototype`); `required` must be an array of unique names; `enum` non-empty; `title`/`description`/`pattern`/`format` strings |
| Size limits | 5,000 properties, 10 nesting levels, 120,000 characters (property names, definition names, enum and const values), 1,000 enum values, ≤15,000 characters for a string enum with >250 values | all enforced; character budgets count code points; nesting depth counts nested object schemas (arrays do not add a level — the guide does not say; this interpretation is pinned by a unit test and is the first thing to check if the acceptance suite reports drift), following references and stopping at recursion |
| Schema name | `^[a-zA-Z0-9_-]{1,64}$` (API parameter) | checked |
| Fine-tuned models | strings: minLength, maxLength, pattern, format; numbers: minimum, maximum, multipleOf; objects: patternProperties; arrays: minItems, maxItems unsupported ("For fine-tuned models, we additionally do not support … For arrays: minItems, maxItems"; re-checked 2026-11-26; `minItems`/`maxItems` are listed as supported array properties for other models) | `openai-fine-tuned` reports each of these keywords wherever it occurs in the final schema (and the exclusive bounds) as `target-incompatible` and emits nothing; no keyword is ever removed to make a schema pass. `openai` keeps them. |

The SDK's `to_strict_json_schema` is applied first (as the SDK does) and is **not** treated as a
validator: the profile checks its result independently. Schemas the profile rejects are not
emitted.

The opt-in acceptance suite (`npm run test:openai`, requires `OPENAI_API_KEY`) emits every
OpenAI-profile fixture, checks that the output is identical to the committed SDK reference, and
submits it to the Responses API to detect drift between this documented profile and the service.
Each submission is classified as **accepted** (a response was started), **rejected** (HTTP 400
naming the schema or `text.format`) or **unverified** (missing key, authentication/permission
error, rate limit, server or network failure, non-JSON or unexpected reply). Unverified results
are never counted as acceptance. Exit code: 0 all accepted, 1 any rejection or emitter/reference
mismatch, 2 anything unverified. The classification is unit-tested offline
(`test/acceptance.test.mjs`).
