import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

/**
 * Compatibility profile of the target model family.
 *
 * - `openai`: OpenAI Structured Outputs for current non-fine-tuned models.
 * - `openai-fine-tuned`: OpenAI Structured Outputs for fine-tuned models, which additionally reject
 *   string/number/array constraint keywords.
 * - `none`: no target validation; emits the Pydantic-compatible schema only.
 */
export type TargetProfile = "openai" | "openai-fine-tuned" | "none";

export interface StructuredOutputEmitterOptions {
  /** Target profile used for compatibility validation. Default `openai`. */
  "target-profile"?: TargetProfile;
  /**
   * `strict` (default): apply the OpenAI SDK strict transformation (`to_strict_json_schema`).
   * `pydantic`: emit Pydantic's `model_json_schema()` representation without the SDK transformation.
   */
  "schema-mode"?: "strict" | "pydantic";
  /**
   * File layout: `schema` (default) writes the JSON schema; `text-format` writes the Responses API
   * `text.format` object; `response-format` writes the Chat Completions `response_format` object.
   */
  "output-format"?: "schema" | "text-format" | "response-format";
  /**
   * Policy for optional properties that are not nullable (`a?: T`). Structured Outputs require all
   * properties. `error` (default) reports a diagnostic; `nullable` maps `a?: T` to the Pydantic
   * declaration `a: T | None = None` (the property becomes required and nullable in strict mode).
   */
  "optional-properties"?: "error" | "nullable";
  /**
   * Policy for non-null default values, which are not part of the documented OpenAI subset.
   * `error` (default) reports a diagnostic in OpenAI profiles; `emit` keeps the `default` keyword
   * exactly as Pydantic does; `omit` drops the keyword from the emitted schema.
   */
  "default-values"?: "error" | "emit" | "omit";
  /** Split mixed enums into homogeneous anyOf branches for typed target profiles. */
  "mixed-enums"?: "pydantic" | "typed-union";
  /** Explicit Python wire annotations for encoded bytes, boolean strings and JSON decimals. */
  "scalar-encodings"?: "pydantic" | "wire";
  /** Select a snapshot of each versioned root's namespace (default latest). */
  "api-version"?: string;
  /** Filter model properties by a TypeSpec lifecycle modifier. */
  visibility?: "Read" | "Create" | "Update" | "Delete" | "Query";
  /** Emit schemas for every model in user namespaces instead of only `@structuredOutput` roots. */
  "emit-all-models"?: boolean;
  /**
   * Root selection: only the roots (`@structuredOutput` models, or every model with
   * `emit-all-models`) named here, or declared in the namespaces named here, are written as
   * schema files. Roots left out remain definitions (`$defs`) of the schemas that reference them.
   */
  roots?: string[];
  /**
   * Roots not written as schema files (namespace or type names), for example `@structuredOutput`
   * models of an imported library; they remain definitions of the schemas that reference them.
   */
  "exclude-roots"?: string[];
  /** Directories of the root schema files: `single` (default, flat), `per-namespace` or `per-source-file`. */
  "file-layout"?: "single" | "per-namespace" | "per-source-file";
}

const optionsSchema: JSONSchemaType<StructuredOutputEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "target-profile": { type: "string", enum: ["openai", "openai-fine-tuned", "none"], nullable: true },
    "schema-mode": { type: "string", enum: ["strict", "pydantic"], nullable: true },
    "output-format": { type: "string", enum: ["schema", "text-format", "response-format"], nullable: true },
    "scalar-encodings": { type: "string", enum: ["pydantic", "wire"], nullable: true },
    "mixed-enums": { type: "string", enum: ["pydantic", "typed-union"], nullable: true },
    "optional-properties": { type: "string", enum: ["error", "nullable"], nullable: true },
    "default-values": { type: "string", enum: ["error", "emit", "omit"], nullable: true },
    "api-version": { type: "string", nullable: true },
    visibility: { type: "string", enum: ["Read", "Create", "Update", "Delete", "Query"], nullable: true },
    "emit-all-models": { type: "boolean", nullable: true },
    roots: { type: "array", items: { type: "string" }, nullable: true },
    "exclude-roots": { type: "array", items: { type: "string" }, nullable: true },
    "file-layout": { type: "string", enum: ["single", "per-namespace", "per-source-file"], nullable: true },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "typespec-structured-output",
  diagnostics: {
    "unsupported-type": {
      severity: "error",
      messages: {
        default: paramMessage`Type '${"type"}' cannot be represented in a Pydantic-compatible Structured Output schema: ${"reason"}`,
      },
    },
    "unsupported-decorator": {
      severity: "error",
      messages: {
        default: paramMessage`Decorator '${"decorator"}' has no Structured Output mapping; the emitter refuses to silently ignore it.`,
      },
    },
    "unsupported-encoding": {
      severity: "error",
      messages: {
        default: paramMessage`Encoding '${"encoding"}' on '${"type"}' is not representable by the Pydantic compatibility profile (Pydantic serializes this type as ${"pydantic"}).`,
      },
    },
    "optional-property": {
      severity: "error",
      messages: {
        default: paramMessage`Optional property '${"name"}' is not representable: Structured Outputs require every property. Declare it as '${"name"}: T' or '${"name"}?: T | null' (Pydantic 'T | None = None'), or set option 'optional-properties: nullable'.`,
      },
    },
    "optional-without-default": {
      severity: "error",
      messages: {
        default: paramMessage`Optional property '${"name"}' has no Pydantic equivalent in schema-mode 'pydantic' (a non-required Pydantic field needs a default). Add a default value or make it required.`,
      },
    },
    "default-value": {
      severity: "error",
      messages: {
        default: paramMessage`Property '${"name"}' declares a default value, but the 'default' keyword is not part of the documented ${"profile"} Structured Outputs subset. Choose 'default-values: omit' or retain the default with 'target-profile: none'.`,
      },
    },
    "unsupported-default": {
      severity: "error",
      messages: {
        default: paramMessage`Default value of '${"name"}' cannot be serialized: ${"reason"}`,
      },
    },
    "target-incompatible": {
      severity: "error",
      messages: {
        default: paramMessage`Schema for '${"root"}' is not accepted by target profile '${"profile"}' at '${"path"}': ${"reason"}`,
      },
    },
    "conflated-numeric-literal": {
      severity: "error",
      messages: {
        default: paramMessage`Numeric literal ${"written"} is represented as ${"modelled"} by the TypeSpec compiler: it interns numeric literals by their binary64 value, so distinct literals that round to the same double share one exact value. The literal cannot be emitted faithfully; avoid declaring both values in one program.`,
      },
    },
    "invalid-schema-name": {
      severity: "error",
      messages: { default: paramMessage`@schemaName("${"name"}") must be a Python identifier: ${"reason"}` },
    },
    "default-factory-without-default": {
      severity: "error",
      messages: { default: paramMessage`@defaultFactory on '${"name"}' requires a default value (the value the factory produces).` },
    },
    "invalid-root": {
      severity: "error",
      messages: {
        default: paramMessage`'${"name"}' cannot be a Structured Output root: ${"reason"}`,
      },
    },
    "root-selection": {
      severity: "error",
      messages: {
        default: paramMessage`'${"option"}' entry '${"name"}' ${"reason"}.`,
      },
    },
    "no-roots": {
      severity: "warning",
      messages: {
        default: "No models are marked with @structuredOutput and 'emit-all-models' is not set; nothing was emitted.",
      },
    },
    "duplicate-root-name": {
      severity: "error",
      messages: {
        default: paramMessage`Two Structured Output roots resolve to the same name '${"name"}'.`,
      },
    },
    "integer-like-key": {
      severity: "error",
      messages: {
        default: paramMessage`Property name '${"name"}' is an array-index-like string; its position cannot be preserved deterministically. Rename it or use @encodedName.`,
      },
    },
    "template-argument": {
      severity: "error",
      messages: {
        default: paramMessage`Template instance '${"name"}' uses an argument without a deterministic Pydantic generic name: ${"reason"}`,
      },
    },
    "metadata-lost": {
      severity: "warning",
      messages: {
        default: paramMessage`${"what"} on '${"name"}' has no Pydantic schema representation and is not emitted.`,
      },
    },
    "visibility-ignored": {
      severity: "warning",
      messages: {
        default: paramMessage`Property '${"name"}' has lifecycle visibility; Structured Output schemas do not apply visibility and include the property.`,
      },
    },
  },
  emitter: { options: optionsSchema },
  state: {
    structuredOutput: { description: "Models marked as Structured Output roots" },
    schemaName: { description: "Explicit Pydantic class names (@schemaName)" },
    defaultFactory: { description: "Properties whose default is a default_factory (@defaultFactory)" },
  },
} as const);

export const { reportDiagnostic, createDiagnostic, stateKeys: StateKeys } = $lib;
