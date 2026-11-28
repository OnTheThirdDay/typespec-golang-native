# Conformance testing

All suites run with `npm test` at the repository root (Node ≥ 22, Go ≥ 1.24). No external service
and no Python are needed; Go modules are fetched by the Go toolchain for the runtime's own tests.

| Suite | What it proves | Location |
|---|---|---|
| Official HTTP specs | Applicable upstream requests run against generated servers. Assertions cover operation dispatch, wire responses, request bodies and selected decoded parameters of `@typespec/http-specs` 0.1.0-alpha.46 (67 specs) | `packages/typespec-go/test/http-specs.test.ts`, results in `test/http-specs/results.json` |
| OpenAPI cross-check | Compares routes, parameter names and presence, request-body requirement, statuses, media types and response header names against `@typespec/openapi3` 1.18.0. Two visibility differences are recorded. A crash of the reference emitter fails the test (see below) | `packages/typespec-go/test/openapi-crosscheck.test.ts`, `test/http-specs/openapi-crosscheck.json` |
| Regressions | Wire bytes and decoded Go values for: nested-field-preserving union selection, union defaults round trip, exact large defaults (also in headers and query bounds), code-point patterns, mixed enums, `Accept` q-values, malformed queries, float range | `packages/typespec-go/test/go/regressions` |
| Independent wire checks | Form-urlencoded and multipart responses, multi-variable and prefix URI expressions, decoded from raw HTTP bytes | `packages/typespec-go/test/go/wire` |
| Streaming semantics | Per-event flush over TCP, cancellation, lazy JSON Lines, 400 for an invalid item even after the handler stopped reading, per-item response validation, union-typed SSE events | `packages/typespec-go/test/go/streaming`, `test/go/sse-nested` |
| Cross-emitter | Checks concrete JSON against schema validation and generated Go decoding, validation and re-encoding, including recursive projections, exact integers, empty records, nulls and floating-point domain differences | `tests/cross-emitter` (`npm run test:cross`) |
| Generated Go behaviour | Serialization, presence/null, unions, polymorphism, defaults, validation paths, numeric precision, inherited constraints, malformed input, server binding, auth, middleware, limits, cancellation, concurrency, streaming semantics; gofmt and go vet clean | `packages/typespec-go/test/go/*` |
| Fail-closed diagnostics | Unsupported constructs are diagnosed at the declaration, no files are written, stale outputs are removed; generation is deterministic | `packages/typespec-go/test/diagnostics.test.ts` |
| Runtime | Codecs, scalars, parameter styles (incl. ogen's upstream `uri` tests), URI templates, XML, SSE, JSONL; fuzz targets | `packages/typespec-go/runtime/*_test.go` |
| Example | `examples/widget-service` compiles through its `tspconfig.yaml`, builds and passes its tests | `packages/typespec-go/test/examples.test.ts` |
| Pydantic differential | 54 TypeSpec/Pydantic pairs check schema structure and key order against Pydantic 2.14.4 and openai-python 3.59.0 in both modes. JSON numbers are compared by value. A further 33 fixtures check rejection | `packages/typespec-structured-output/test/fixtures.test.ts` |
| JSON Schema oracle | Leaf keywords agree with `@typespec/json-schema` 1.18.0 | `packages/typespec-structured-output/test/oracle.test.ts` |
| OpenAI profile | Validator rules, strict-transform port details, output formats | `packages/typespec-structured-output/test/emitter.test.ts` |
| Feature matrix | Every supported/restricted feature references existing tests; specs referenced from the matrix pass | `tools/feature-matrix/check.mjs` |

Fuzz targets (run with `go test -fuzz=<name>`): `FuzzDurationRoundTrip`, `FuzzIntegerCodec`,
`FuzzObjectReader`, `FuzzOrderedMapCopies`, `FuzzDecimalEquivalence`, `FuzzXMLParse`, `FuzzSSEParse`, `FuzzJSONLFraming`, `FuzzCookieEscapeUnescape` (runtime and URI codecs) and `FuzzHolderDecode` (generated
package of `test/go/combinations`, canonical round-trip of decoded values).

Packaging check: `npm run test:packed` (`tools/packed-install.mjs`) packs each package, installs
the tarball alone into a fresh consumer outside the workspaces (a temporary directory whose name
contains a space), compiles twice to check deterministic output, checks the vendored licenses, and
runs a Go test against the generated package. Race detection: `npm run test:race`
(`tools/go-race.mjs`, needs cgo) runs `go test -race` on the runtime, 24 generated fixture configurations and seven cross-package consumer workspaces. CI (`.github/workflows/conformance.yml`, Linux) runs `npm test`, executes the generated collected-error fixture on 386, runs the race check and the
packaging check, then fails on any uncommitted change (`git diff --exit-code`), which catches
stale recorded evidence.

Paths with spaces: the suite is verified from a clean clone into a directory whose path contains
spaces (`git clone`, `npm ci`, `npm test`). On Windows, keep the clone root under about 150 characters
(the deepest tracked path is 109 characters and Windows limits paths to 260 characters), or
enable long paths.

## HTTP spec categories

`results.json` records, per spec, one of `implemented-passing`, `implemented-failing`
(fails the test), `rejected-unsupported` (must be listed with the missing feature in
`expected-rejections.json`; it is **not** counted as support) and, per scenario, `passed`,
`failed` or `skipped` with the reviewed reason. Corrected upstream inputs carry an `adjustment` and added rejection cases identify the original scenario in `replacement`. Current state: 67/67 specs implemented and
passing, 843 scenarios passed (827 upstream replays and 16 replacement scenarios), 0 failed, 13 not applicable.

### How scenarios are replayed

The scenarios are written from a client's perspective. The harness sends the scenario request to
the generated `http.Handler`; a generated implementation of `StrictServerInterface` answers with
the scenario response through the operation's own response variants (so response encoding is
exercised too). The test then checks the status, the body (JSON/XML structurally, SSE per event,
JSON Lines per line, binary exactly), the declared headers, and that the decoded request
re-encodes to what was sent (multipart part by part, streams item by item). Versioned scenarios
run against a server generated for their `api-version`. `by-key` scenarios are replayed like the
others. Eighteen collection-format, URI-template, optional-path, query and visibility cases compare the handler's actual parameter values with independent expectations. Eleven pinned decoded CSV examples supply the exact item boundaries for reconstructing query strings. Ordinary and repeated values preserve escaped data commas. Five UTC datetime scenarios compare instants, permitting equivalent RFC 3339 spellings. Ordinary strings are compared exactly outside the two boolean-string cases.

### Not-applicable scenarios (13) and replacements

| Scenario | Reason | Replacement |
|---|---|---|
| `Payload_ContentNegotiation_{SameBody,DifferentBody}_2` | The mock answers an unacceptable `Accept` with 400 and an error body that the spec does not declare. | `Replacement_…`: the server answers **406 Not Acceptable**. |
| `Payload_Pageable_*_link_1`, `linkString_1`, `nestedLink_1`, `AlternateInitialVerb_post_1`, `XmlPagination_listWithNextLink_1` | Requests to a next-page link: a URL chosen by the server implementation, not an operation of the spec. | — (the first-page scenarios, which return the links, pass) |
| `Type_Enum_Fixed_String_putUnknownValue` | Client error-handling scenario: the mock answers with 500. | `Replacement_…`: the server rejects the undeclared value of the closed enum with **400**. |
| `Type_Model_Inheritance_*MissingDiscriminator`, `…getFixedModelWrongDiscriminator` (5) | Client-tolerance scenarios: the mock *response* violates the contract. | `Replacement_…`: requests with a missing or invalid discriminator are rejected with **400**. |

### Reviewed adjustments

* **Media type replacements** (`CONTENT_TYPE_OVERRIDES`): for `Type_Scalar_{String,Unknown}_put`,
  `Type_Enum_Extensible_String_put*`, `Payload_JsonMergePatch_update*` and
  `Versioning_ReturnTypeChangedFrom_test` the mock sends a media type that contradicts the one
  `main.tsp` declares (the mock server does not check it). They are replayed with the declared
  type, and replacement scenarios assert that the contradicting type is rejected with **415**.
* **Case-insensitive booleans**: `Encode_Boolean_Property_{trueUpper,falseMixed}` send `"TRUE"`,
  `"FaLsE"`; a boolean has no letter case, so the server canonicalizes to `"true"`/`"false"`.
* **Undeclared response headers** in mock responses (e.g. `foo` in pageable continuation-token
  scenarios) are not part of the contract and are not compared; `Content-Type` is compared by
  media type.
* **Server base paths** (`@server("{endpoint}/server/path/…")`): the handler is mounted under the
  path, as a deployment would.
* **`type/union/discriminated/extends`** uses the experimental `union-extends` compiler feature;
  the harness enables it as a user would in `tspconfig.yaml`.

* **Explicit empty request.** The upstream `putReadOnlyModel` mock omits the JSON body that its required `@body` and its own scenario documentation specify. Its positive replay sends `{}`. A separate replacement replays the original omission and expects 415.
* **Metadata-only requests.** The GET and HEAD visibility scenarios specify only `?queryProp=123` on the wire. The generated handler checks this value and accepts an absent body. The OpenAPI reference marks both request bodies required. The cross-check pins this disagreement to those two operations.

### OpenAPI reference workaround (`special-words`)

`@typespec/openapi3` 1.18.0 crashes on `special-words` ("Cannot read properties of undefined
(reading '0')"). It looks up parameter examples with `examples.parameters[name]` on a plain
object; for the query parameter `constructor` this yields `Object.prototype.constructor`, so the
`?? []` fallback never applies. The crash was previously recorded as "reference unavailable" and
counted as a passing test; it no longer is. The reference is now computed from a copy of the spec
in which only that parameter's wire name is aliased (`REFERENCE_WORKAROUNDS` in the test), and
the alias is mapped back when comparing. The test fails on any other reference-emitter failure,
on a different crash, and when the workaround is no longer needed (upstream fix).

### Coverage of the reference comparison

For versioned services the cross-check uses the latest document. It normalizes URI templates and compares the union of media types and headers per status. Eight operations with literal query text lack an OpenAPI counterpart. It does not establish schema equivalence for every request and response, serialization style, security requirement, status range or earlier version. Selected generated values and raw wire fixtures cover these separately.

### Recorded evidence

`results.json` and `openapi-crosscheck.json` are written only by complete runs; a filtered run
(`vitest -t …`) leaves them untouched, so they always describe all 67 specs.

## Upgrading pinned upstreams

Pinned: `@typespec/*` 1.18.0 / 0.88.0, `@typespec/http-specs` 0.1.0-alpha.46 (exact versions in
`package.json`/`package-lock.json`), Go ≥ 1.24, Pydantic 2.14.4 + openai 3.59.0
(`tools/pydantic-reference/pyproject.toml` + `uv.lock`), vendored ogen `uri` at commit
`3d90c0ca`.

1. Bump the versions and run `npm install`.
2. Run `npm test`. New HTTP semantics show up as failing specs, new rejections (a rejected spec
   missing from `expected-rejections.json` fails), OpenAPI disagreements, or new decorators
   rejected by the allowlists (`decorators-allowlist.ts` in both packages) — never silently.
3. For Pydantic/OpenAI SDK upgrades run `npm run refresh:pydantic-fixtures` and review the diff of
   `reference.json` files; bump the profile version in `docs/pydantic-compatibility-profile.md`.
4. Update `docs/feature-matrix.json` and run `node tools/feature-matrix/check.mjs --write`.
