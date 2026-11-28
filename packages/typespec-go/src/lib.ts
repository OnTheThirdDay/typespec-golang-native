import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

/** Option `external`: name → path, as a list or as (possibly nested) objects. */
export type ExternalMappings = { name: string; path: string }[] | { [name: string]: string | ExternalMappings };

export interface GoEmitterOptions {
  /** Go import path of the emitter output directory (e.g. `example.com/svc/api`). Required. */
  module: string;
  /** Go package name. Defaults to the last element of `module`. */
  "package-name"?: string;
  /**
   * `vendor` (default): copy the runtime into `<output>/tsgo` (no external dependency).
   * `import`: import the runtime from `runtime-module`.
   */
  runtime?: "vendor" | "import";
  /** Import path of the runtime module when `runtime: import`. */
  "runtime-module"?: string;
  /** Write a go.mod declaring `module` (for standalone output directories). */
  "emit-go-mod"?: boolean;
  /** Match the Structured Outputs optional-to-nullable policy for fields without defaults. */
  "optional-properties"?: "source" | "nullable";
  /** Handling of undeclared JSON object properties: `ignore` (default) or `reject`. */
  "unknown-properties"?: "ignore" | "reject";
  /** Generate the strict HTTP server for `@service` namespaces (default true). */
  "generate-server"?: boolean;
  /** Version of a @typespec/versioning service to generate: a version value/name or `latest` (default). */
  "api-version"?: string;
  /**
   * Distribution of model declarations over files of the one Go package: `single` (default,
   * models.go), `per-namespace` (models.<namespace>.go) or `per-source-file` (models.<path>.go).
   */
  "file-layout"?: "single" | "per-namespace" | "per-source-file";
  /**
   * Go type of TypeSpec `integer`: `arbitrary-precision` (default, tsgo.Integer) or `int64`
   * (values outside int64 are rejected, never rounded, truncated or wrapped).
   */
  "integer-type"?: "arbitrary-precision" | "int64";
  /**
   * Properties a visibility excludes from a payload (e.g. a read-only `id` in a create request):
   * `unknown` (default) treats them as undeclared, so closed models and `unknown-properties:
   * reject` reject them; `ignore` accepts and discards them (undeclared properties still follow
   * the unknown-properties policy and closed models).
   */
  "invisible-properties"?: "unknown" | "ignore";
  /**
   * Encoding of unset (absent) optional nullable properties (`p?: T | null`) in server responses:
   * `omit` (default), `null` (all), or a list of fully qualified model names (their own such
   * properties) and property names (`Shop.Widget.note`) written as null. Request decoding,
   * MarshalJSON and the Go values are unchanged.
   */
  "response-unset-nullable"?: "omit" | "null" | string[];
  /**
   * TypeSpec namespaces or types provided by separately generated Go packages, each mapped to the
   * package's output directory (or its typespec-go-contract.json), relative to the project root.
   * Mapped declarations are imported instead of generated; they must be identical there. Three
   * equivalent forms: a list `[{ name: "Shop.Common", path: "../common" }]`, nested objects
   * `{ Shop: { Common: "../common" } }` (tspconfig.yaml and `--option` forbid dots in keys), or
   * a flat map `{ "Shop.Common": "../common" }` (programmatic use).
   */
  external?: ExternalMappings;
  /** Write typespec-go-contract.json so that other packages can map declarations to this one. */
  "export-contract"?: boolean;
  /**
   * TypeSpec namespaces (with their sub-namespaces) or types not generated in Go; other emitters
   * still see them. A generated declaration or operation that uses an excluded one is an error.
   */
  exclude?: string[];
  /**
   * Application-defined validation: the Validate method of every model, union and custom scalar
   * also calls `ValidateExtension(v *tsgo.Validator)` when the application declares it for that
   * type (in the generated package). It runs after decoding and the generated checks, and can
   * only add errors (Validator.Add, Validator.AddError).
   */
  "validation-hooks"?: boolean;
  /**
   * JSON text of float32/float64 values: `shortest` (default, Go's shortest form: 1, 1e-05),
   * `pydantic` (pydantic-core's model_dump_json: 1.0, -0.0, 0.00001, 1e+16) or `python-repr`
   * (Python's json.dumps, float.__repr__: 1.0, -0.0, 0.0001, 1e-05, 1e+16). Decoding is unchanged.
   */
  "float-format"?: "shortest" | "pydantic" | "python-repr";
  /**
   * Escaping of JSON strings and object keys: `default` (encoding/json without HTML escaping;
   * U+2028 and U+2029 escaped) or `minimal` (only `"`, `\` and control characters, with short
   * forms, as pydantic-core writes). Decoding is unchanged.
   */
  "string-escaping"?: "default" | "minimal";
  /**
   * Records (`Record<T>`) and additional properties as `tsgo.OrderedMap[T]`, which keeps
   * insertion order through decoding, mutation and encoding (default: Go maps, encoded with
   * sorted keys). Records in parameters, form bodies and XML are not supported with it.
   */
  "ordered-records"?: boolean;
}

const optionsSchema: JSONSchemaType<GoEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    module: { type: "string" },
    "package-name": { type: "string", nullable: true },
    runtime: { type: "string", enum: ["vendor", "import"], nullable: true },
    "runtime-module": { type: "string", nullable: true },
    "emit-go-mod": { type: "boolean", nullable: true },
    "optional-properties": { type: "string", enum: ["source", "nullable"], nullable: true },
    "unknown-properties": { type: "string", enum: ["ignore", "reject"], nullable: true },
    "generate-server": { type: "boolean", nullable: true },
    "api-version": { type: "string", nullable: true },
    "file-layout": { type: "string", enum: ["single", "per-namespace", "per-source-file"], nullable: true },
    "integer-type": { type: "string", enum: ["arbitrary-precision", "int64"], nullable: true },
    "invisible-properties": { type: "string", enum: ["unknown", "ignore"], nullable: true },
    "response-unset-nullable": { anyOf: [{ type: "string", enum: ["omit", "null"] }, { type: "array", items: { type: "string" }, uniqueItems: true }] } as any,
    // Validated by the emitter (nested objects and lists); see loadMappings.
    external: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] } as any,
    "export-contract": { type: "boolean", nullable: true },
    exclude: { type: "array", items: { type: "string" }, nullable: true },
    "validation-hooks": { type: "boolean", nullable: true },
    "float-format": { type: "string", enum: ["shortest", "pydantic", "python-repr"], nullable: true },
    "string-escaping": { type: "string", enum: ["default", "minimal"], nullable: true },
    "ordered-records": { type: "boolean", nullable: true },
  },
  required: ["module"],
};

export const $lib = createTypeSpecLibrary({
  name: "typespec-go",
  diagnostics: {
    "unsupported-type": {
      severity: "error",
      messages: { default: paramMessage`Type '${"type"}' is not supported by the Go emitter: ${"reason"}` },
    },
    "unsupported-decorator": {
      severity: "error",
      messages: {
        default: paramMessage`Decorator '${"decorator"}' has no Go mapping; the emitter refuses to silently ignore it.`,
      },
    },
    "unsupported-encoding": {
      severity: "error",
      messages: { default: paramMessage`Encoding '${"encoding"}' is not supported for '${"type"}'.` },
    },
    "unsupported-http": {
      severity: "error",
      messages: { default: paramMessage`HTTP feature not supported by the Go strict server: ${"reason"}` },
    },
    "unsupported-pattern": {
      severity: "error",
      messages: {
        default: paramMessage`Pattern '${"pattern"}' uses ECMAScript regular expression features that Go's RE2 engine does not implement (${"feature"}).`,
      },
    },
    "infinite-type": {
      severity: "error",
      messages: {
        default: paramMessage`Model '${"name"}' requires itself through required, non-nullable properties ('${"path"}'); no finite value exists.`,
      },
    },
    "conflated-numeric-literal": {
      severity: "error",
      messages: {
        default: paramMessage`Numeric literal ${"written"} is represented as ${"modelled"} by the TypeSpec compiler: it interns numeric literals by their binary64 value, so distinct literals that round to the same double share one exact value. The literal cannot be emitted faithfully; avoid declaring both values in one program.`,
      },
    },
    "invalid-default": {
      severity: "error",
      messages: { default: paramMessage`Default value of '${"name"}' cannot be represented: ${"reason"}` },
    },
    "excluded-declaration": {
      severity: "error",
      messages: { default: paramMessage`'${"name"}' is excluded from Go generation (option 'exclude') but ${"user"} uses it; exclude that too, or remove the exclusion.` },
    },
    "external-package": {
      severity: "error",
      messages: { default: paramMessage`External Go package: ${"reason"}` },
    },
    "invalid-option": {
      severity: "error",
      messages: { default: paramMessage`Invalid emitter option: ${"reason"}` },
    },
    "name-collision": {
      severity: "warning",
      messages: { default: paramMessage`Go name '${"name"}' is used by several declarations; '${"type"}' was renamed to '${"renamed"}'.` },
    },
  },
  emitter: { options: optionsSchema },
} as const);

export const { reportDiagnostic, createDiagnostic } = $lib;
