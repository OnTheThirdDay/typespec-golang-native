# TypeSpec emitters: native Go and OpenAI Structured Outputs

This repository has two independent [TypeSpec](https://typespec.io) 1.18 emitters.

| Package | Output | Docs |
|---|---|---|
| [`typespec-go`](packages/typespec-go) | Go (net/http, Go ≥ 1.24) strict HTTP servers. It also produces models, JSON/XML/multipart/form/SSE/JSON Lines serialization, defaults and validation. | [README](packages/typespec-go/README.md) |
| [`typespec-structured-output`](packages/typespec-structured-output) | JSON Schemas for OpenAI Structured Outputs. They are structurally identical to Pydantic 2.14.4 + openai 3.59.0 output. | [README](packages/typespec-structured-output/README.md) |

Both emitters **fail closed**. A construct they cannot represent exactly gets a diagnostic at its declaration, nothing is written, and earlier outputs are removed. Rejected constructs are listed as limitations, never as supported features.

## Quick start

```sh
npm ci            # Node >= 22
npm test          # builds, runs every suite (incl. go vet/go test), checks the feature matrix
```

The emitters can be used together, as in [examples/widget-service](examples/widget-service). That example has the following files:

* `main.tsp`: the TypeSpec definition.
* `tspconfig.yaml`: emits the Go package to `api/` and the schemas to `schemas/`.
* `main.go`: implements the generated `StrictServerInterface`.

## Documentation

* [Feature matrix](docs/feature-matrix.md) (machine-readable: [feature-matrix.json](docs/feature-matrix.json)): every feature with its status per emitter and the tests that prove it.
* [Conformance testing](docs/conformance.md) covers:
  * the test suites and how to run them
  * the HTTP spec categories
  * the not-applicable and adjusted upstream scenarios
  * how to upgrade pinned upstream versions
* [Known limitations](docs/limitations.md)
* Cross-emitter consistency test: [tests/cross-emitter](tests/cross-emitter) (`npm run test:cross`)
* [Pydantic compatibility profile](docs/pydantic-compatibility-profile.md) and [OpenAI target profile](docs/openai-profile.md)
* [Reuse assessment](docs/reuse-assessment.md) evaluates the official JSON Schema emitter, Azure's Go emitter, ogen and oapi-codegen, with executable experiments in [experiments/](experiments).

## Reproducibility

The following are pinned:

* TypeSpec and npm dependencies, by exact versions and `package-lock.json`.
* The Go runtime module, by `go.sum`.
* The Python reference toolchain, by `tools/pydantic-reference/uv.lock`.

The Pydantic reference fixtures are committed, so tests need neither Python nor network access. To regenerate them, install [uv](https://docs.astral.sh/uv/) and run `npm run refresh:pydantic-fixtures`. Generation is deterministic, and tests assert byte-identical output across runs.

## License

MIT, see [LICENSE](LICENSE). Code copied or adapted from Azure typespec-go, ogen, oapi-codegen, Pydantic and openai-python is attributed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
