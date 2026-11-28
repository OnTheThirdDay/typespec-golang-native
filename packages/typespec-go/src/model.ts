/**
 * Maps the TypeSpec semantic model to Go declarations and type expressions.
 *
 * Representation (documented in docs/go-emitter.md):
 *   required T            → T
 *   optional T            → *T                          (nil = absent)
 *   T | null              → tsgo.Nullable[T]
 *   optional T | null     → *tsgo.Nullable[T]           (absent / null / value)
 *   T[]                   → []T                         Record<T> → map[string]T
 *   model                 → struct + MarshalJSON/UnmarshalJSON/Validate/ApplyDefaults
 *   enum, literal unions  → defined type + constants (closed); `"a" | string` → open enum
 *   other unions          → sum-type struct (one variant at a time)
 *   @discriminator base   → <Base>Union sum type over the derived models
 */
import { contractTypeKey } from "./external.js";
import { createHash } from "node:crypto";
import {
  type DecoratorApplication,
  type Diagnostic,
  type Enum,
  type EnumMember,
  type Model,
  type ModelProperty,
  type Namespace,
  type Program,
  type Scalar,
  type Tuple,
  type Type,
  type Union,
  type UnionVariant,
  getDiscriminatedUnion,
  getDiscriminatedUnionFromInheritance,
  getDiscriminator,
  getDoc,
  getEncode,
  getFriendlyName,
  getMaxItems,
  getMaxLength,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinItems,
  getMinLength,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  getNamespaceFullName,
  getPattern,
  getProperty,
  getTypeName,
  isArrayModelType,
  isNeverType,
  isNullType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  isTemplateInstance,
  navigateTypesInNamespace,
  resolveEncodedName,
  Numeric,
} from "@typespec/compiler";
import { type MetadataInfo, getVisibilitySuffix, isMetadata, Visibility } from "@typespec/http";
import { Code, conversionRef, declRef, docComment, goRawString, goString, textRef } from "./gowriter.js";
import { createDiagnostic } from "./lib.js";
import { exportedName } from "./naming/index.js";
import { defaultJSON, enumWireValue } from "./values.js";
import { translateEcmaRegex } from "./regex.js";
import { unsupportedDecorators } from "./decorators-allowlist.js";

// ------------------------------------------------------------------------------------------ types

/** A Go type expression with everything needed to serialize, validate and default it. */
export interface GoType {
  expr: string;
  /** Go expression of type tsgo.Codec[expr]. */
  codec: string;
  /**
   * Codec for response bodies under `response-unset-nullable: null`, when it differs from codec
   * (the value holds, at some depth, a model with an optional nullable property). Evaluated
   * after collection.
   */
  rcodec?: () => string | undefined;
  /** Go expression of type tsgo.TextCodec[expr], when the type has a text form (parameters). */
  text?: string;
  /** JSON kinds the encoding can take (tsgo.Kind* constants); undefined = any. */
  kinds?: string[];
  /** Numeric Go type used for bound checks. */
  num?: NumKind;
  /** TypeSpec `integer` represented as int64 (`integer-type: int64`). */
  boundedInteger?: boolean;
  /** A record represented as tsgo.OrderedMap (option ordered-records). */
  ordered?: boolean;
  /** Category used for constraint checks. */
  cat: "string" | "bytes" | "number" | "integer" | "decimal" | "array" | "map" | "nullable" | "named" | "other";
  elem?: GoType;
  /** Named declaration backing this type, if any. */
  decl?: Decl;
  /** Statements validating value expression `val` with validator `v` (excluding property constraints). */
  validate(val: string, v: string, out: Code): void;
  /** Statements applying nested defaults to addressable expression `lval`. */
  defaults(lval: string, out: Code): void;
  /** True if defaults() can emit anything (evaluated after collection). */
  hasDefaults(): boolean;
  /** True if validate() can emit anything. */
  hasValidation(): boolean;
}

type NumKind = "int8" | "int16" | "int32" | "int64" | "uint8" | "uint16" | "uint32" | "uint64" | "float32" | "float64";

const noValidation = { validate() {}, hasValidation: () => false };
const noDefaults = { defaults() {}, hasDefaults: () => false };

export interface Field {
  prop: ModelProperty;
  json: string;
  goName: string;
  type: GoType;
  optional: boolean;
  /** Required single-literal property: no Go field, the literal is written/checked implicitly. */
  literal?: { codec: string; value: string; display: string };
  /** Default value as wire JSON. */
  defaultJson?: string;
  /** Optional property of type `never`: it has no value, so it must always be absent. */
  never?: boolean;
  /** Optional nullable property written as null when unset in responses (response-unset-nullable). */
  nullInResponse?: boolean;
  /** Scalar text codec before the optional-to-nullable JSON policy wrapped this field. */
  sourceText?: string;
  constraints: Constraints;
  doc?: string;
}

export interface Constraints {
  minLength?: number;
  maxLength?: number;
  patterns: string[];
  minItems?: number;
  maxItems?: number;
  min?: Numeric;
  max?: Numeric;
  minExclusive?: Numeric;
  maxExclusive?: Numeric;
}

export interface Variant {
  name: string;
  /** Discriminator value (discriminated unions). */
  tag?: string;
  type: GoType;
}

export type DeclKind = "model" | "enum" | "union" | "scalar" | "tuple" | "poly" | "array";

export interface Decl {
  id: number;
  kind: DeclKind;
  source: Type;
  vis?: number;
  /** Candidate Go names in preference order before collision handling. */
  baseName: string;
  qualifiers: string[];
  name: string;
  doc?: string;
  fields?: Field[];
  additional?: GoType;
  /** `...Record<never>` is the nearest indexer: undeclared properties are rejected whatever the global policy. */
  closed?: boolean;
  /**
   * Properties of the model excluded by the visibility of this variant, accepted and discarded
   * when decoding (`invisible-properties: ignore`); otherwise they are undeclared properties.
   */
  ignored?: ModelProperty[];
  /** enum */
  enumBase?: GoType;
  enumValues?: { name: string; value: string | number | bigint | boolean; doc?: string }[];
  enumOpen?: boolean;
  /** union / poly */
  variants?: Variant[];
  discriminator?: { property: string; envelope: "object" | "none"; envelopeProperty: string };
  /** Variant for undeclared discriminator values: the base model (inheritance) or the default variant. */
  fallback?: { name: string; type: GoType };
  /** scalar */
  scalarBase?: GoType;
  scalarConstraints?: Constraints;
  tupleItems?: GoType[];
  /** array: a named array model (`model Docs is Doc[]`), its element type and item constraints. */
  arrayElem?: GoType;
  arrayConstraints?: Constraints;
  hasDefaults?: boolean;
  hasValidation?: boolean;
  /** Has a response encoding (MarshalResponseJSON) under `response-unset-nullable: null`. */
  nullUnset?: boolean;
  /** Model generated for a JSON merge patch document. */
  mergePatch?: boolean;
  /**
   * Cross-package key of a named declaration: the fully qualified TypeSpec name, with `@<variant>`
   * for visibility, merge-patch and polymorphic variants (`Shop.Widget@Create`, `Shop.Pet@Union`).
   */
  key?: string;
  /** Excluded from Go generation (option `exclude`): never generated, must not be referenced. */
  excluded?: boolean;
  /** Declared by an external package (option `external`): referenced, never generated here. */
  external?: { alias: string; importPath: string; name: string };
}

/** Emitter options that change the generated representation. */
export interface GeneratorPolicies {
  unknownProperties?: "ignore" | "reject";
  /** Optional properties without defaults are also nullable (Structured Outputs policy). */
  optionalNullable?: boolean;
  /** `integer-type: int64`: TypeSpec `integer` is a Go int64 (values outside it are rejected). */
  integerInt64?: boolean;
  /** `invisible-properties: ignore`: properties excluded by visibility are accepted and discarded. */
  ignoreInvisible?: boolean;
  /**
   * `response-unset-nullable`: `null` writes every unset optional nullable property of a response
   * as null; a list writes only those of the named models (their own properties) and properties.
   */
  nullUnsetResponses?: boolean | readonly string[];
  /** `export-contract`: the package is shared with other packages (text marshaling methods). */
  exportContract?: boolean;
  /** `validation-hooks`: Validate calls the application's ValidateExtension. */
  validationHooks?: boolean;
  /** `float-format`: floats are written as Go (shortest), pydantic-core or Python's json.dumps writes them. */
  floatFormat?: "shortest" | "pydantic" | "python-repr";
  /** `string-escaping: minimal`: strings and keys are escaped only as JSON requires. */
  minimalEscaping?: boolean;
  /** `ordered-records`: records and additional properties keep insertion order. */
  orderedRecords?: boolean;
}

interface Ctx {
  vis?: number;
  hint: string;
  site: Type;
  /** JSON merge patch (RFC 7396) document: optional properties also accept null ("remove"). */
  mergePatch?: boolean;
}

class Fail extends Error {}

// ------------------------------------------------------------------------------------------ generator

export class GoModelGenerator {
  readonly decls: Decl[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly patterns = new Map<string, string>(); // Go var name → RE2 pattern
  /** Go var name → declared (ECMAScript) pattern, reported as the constraint's limit. */
  readonly patternSources = new Map<string, string>();
  /**
   * Initializers of the codecs converting custom scalars from and to an encoded base type. They
   * are package variables: their function literals are written on several lines, which gofmt
   * keeps whatever the identifier lengths (a one-line literal is expanded when it is long).
   */
  readonly conversions: string[] = [];
  private readonly declsByType = new Map<Type, Map<number, Decl>>();
  private readonly anonymousNames = new Map<Type, string>();
  readonly unknownPolicy: string;
  private readonly optionalNullable: boolean;
  private readonly integerInt64: boolean;
  private readonly ignoreInvisible: boolean;
  /** Responses may write unset nullable properties as null (own selection or inherited from contracts). */
  nullUnsetResponses: boolean;
  /** Selected models and properties (response-unset-nullable as a list); undefined: all or none. */
  private readonly responseNullNames?: ReadonlySet<string>;
  /** Selected names matched by each declaration (a model or an optional nullable property). */
  private readonly responseNullMatches = new Map<Decl, Set<string>>();
  readonly exportContract: boolean;
  readonly validationHooks: boolean;
  /** Go codecs of float64 and float32 values (float-format). */
  readonly floatCodecs: [string, string];
  /** Go expression of the string codec and of the key escaping (string-escaping). */
  readonly stringCodec: string;
  readonly escaping: string;
  readonly orderedRecords: boolean;

  constructor(
    readonly program: Program,
    readonly metadata: MetadataInfo,
    policies: GeneratorPolicies = {},
  ) {
    this.unknownPolicy = policies.unknownProperties === "reject" ? "tsgo.RejectUnknown" : "tsgo.IgnoreUnknown";
    this.optionalNullable = !!policies.optionalNullable;
    this.integerInt64 = !!policies.integerInt64;
    this.ignoreInvisible = !!policies.ignoreInvisible;
    const sel = policies.nullUnsetResponses;
    this.nullUnsetResponses = Array.isArray(sel) ? sel.length > 0 : !!sel;
    if (Array.isArray(sel)) this.responseNullNames = new Set(sel);
    this.exportContract = !!policies.exportContract;
    this.validationHooks = !!policies.validationHooks;
    this.floatCodecs = {
      shortest: ["tsgo.Float64Codec", "tsgo.Float32Codec"],
      pydantic: ["tsgo.PydanticFloat64Codec", "tsgo.PydanticFloat32Codec"],
      "python-repr": ["tsgo.PythonReprFloat64Codec", "tsgo.PythonReprFloat32Codec"],
    }[policies.floatFormat ?? "shortest"] as [string, string];
    this.stringCodec = policies.minimalEscaping ? "tsgo.MinimalStringCodec" : "tsgo.StringCodec";
    this.escaping = policies.minimalEscaping ? "tsgo.EscapeMinimal" : "tsgo.EscapeDefault";
    this.orderedRecords = !!policies.orderedRecords;
  }

  /**
   * Whether an unset optional nullable property is written as null in responses: always with
   * `response-unset-nullable: null`; with a list, when the list names the property (through the
   * model declaring it or the model it belongs to) or that model. Not inherited by nested models.
   */
  private writesNullInResponses(prop: ModelProperty, d: Decl): boolean {
    if (!this.nullUnsetResponses) return false;
    const names = this.responseNullNames;
    if (!names) return true;
    const modelNames = (m: Type | undefined): string[] => {
      if (!m || m.kind !== "Model" || !m.name) return [];
      const full = getTypeName(m);
      return [full, full.replace(/<.*$/, "")];
    };
    const candidates = [
      ...modelNames(d.source),
      ...[...new Set([...modelNames(prop.model), ...modelNames(d.source)])].map((m) => `${m}.${prop.name}`),
    ];
    const hit = candidates.filter((n) => names.has(n));
    if (hit.length) {
      let m = this.responseNullMatches.get(d);
      if (!m) this.responseNullMatches.set(d, (m = new Set()));
      for (const n of hit) m.add(n);
    }
    return hit.length > 0;
  }

  /**
   * Selected names that match no optional nullable property of a declaration written by a
   * response (reported as invalid options): a model or property reachable only from requests,
   * or excluded from every response by visibility, cannot be selected.
   */
  unmatchedResponseNullNames(responseDecls: ReadonlySet<Decl>): string[] {
    const matched = new Set<string>();
    for (const [d, names] of this.responseNullMatches) if (responseDecls.has(d)) for (const n of names) matched.add(n);
    return [...(this.responseNullNames ?? [])].filter((n) => !matched.has(n));
  }

  /** Codec encoding a response body (or stream item) of type t. */
  responseCodec(t: GoType): string {
    return (this.nullUnsetResponses && t.rcodec?.()) || t.codec;
  }

  // ------------------------------------------------------------------ diagnostics

  report(code: "unsupported-type" | "unsupported-encoding" | "unsupported-pattern" | "invalid-default" | "unsupported-decorator", target: Type, format: Record<string, string>): void {
    this.diagnostics.push(createDiagnostic({ code, target, format } as any));
  }

  private fail(target: Type, reason: string): never {
    this.report("unsupported-type", target, { type: safeName(target), reason });
    throw new Fail();
  }

  /** Runs f, converting failures into an "invalid" placeholder so collection continues. */
  guard<T>(f: () => T, fallback: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof Fail) return fallback();
      throw e;
    }
  }

  checkDecorators(t: Type & { decorators?: DecoratorApplication[] }): void {
    for (const d of unsupportedDecorators(t)) {
      if (this.allowVersioningDecorators && d.startsWith("TypeSpec.Versioning.")) continue; // applied by the projection
      this.report("unsupported-decorator", t, { decorator: d });
    }
  }

  // ------------------------------------------------------------------ entry points

  /** Registers every declared data type of user namespaces (standalone models included). */
  private readonly reportedPatterns = new Set<Type>();

  /** Server-sent events support (set by the emitter). */
  sse?: import("./sse.js").SseSupport;

  /** XML payload support (set by the emitter when XML bodies are generated). */
  xml?: import("./xml.js").XmlSupport;

  /** Set when versioned namespaces were projected: versioning decorators are then already applied. */
  allowVersioningDecorators = false;

  registerNamespace(ns: Namespace, skip?: Set<Namespace>): void {
    const full = getNamespaceFullName(ns);
    if (full === "TypeSpec" || full.startsWith("TypeSpec.")) return;
    if (skip?.has(ns)) return;
    navigateTypesInNamespace(
      ns,
      {
        model: (m) => {
          if (m.name && !isTemplateDeclaration(m) && !(isTemplateInstance(m) && !getFriendlyName(this.program, m))) {
            this.guard(() => this.typeRef(m, { hint: m.name, site: m }), () => undefined);
          }
        },
        enum: (e) => void this.guard(() => this.typeRef(e, { hint: e.name, site: e }), () => undefined),
        union: (u) => {
          if (u.name && !isTemplateDeclaration(u as any)) this.guard(() => this.typeRef(u, { hint: u.name!, site: u }), () => undefined);
        },
        scalar: (s) => {
          if (!isTemplateDeclaration(s as any)) this.guard(() => this.typeRef(s, { hint: s.name, site: s }), () => undefined);
        },
      },
      { includeTemplateDeclaration: false, skipSubNamespaces: true },
    );
    for (const sub of ns.namespaces.values()) this.registerNamespace(sub, skip);
  }

  /** Go type for a TypeSpec type in a value position. */
  typeRef(type: Type, ctx: Ctx): GoType {
    switch (type.kind) {
      case "Model":
        return this.modelRef(type, ctx);
      case "Scalar":
        return this.scalarRef(type, ctx, undefined);
      case "Enum":
        return this.namedRef(this.enumDecl(type));
      case "Union":
        return this.unionRef(type, [...type.variants.values()], ctx);
      case "String":
      case "Number":
      case "Boolean":
      case "EnumMember":
        return this.literalRef([type], ctx);
      case "Tuple":
        return this.namedRef(this.tupleDecl(type, ctx));
      case "Intrinsic":
        if (type.name === "null") return { expr: "tsgo.NullType", codec: "tsgo.NullCodec", kinds: ["tsgo.KindNull"], cat: "other", ...noValidation, ...noDefaults };
        if (type.name === "unknown") return { expr: "json.RawMessage", codec: "tsgo.RawCodec", cat: "other", ...noValidation, ...noDefaults };
        return this.fail(type, `'${type.name}' has no value representation`);
      case "StringTemplate":
        if (type.stringValue !== undefined) return this.literalRef([{ kind: "String", value: type.stringValue } as any], ctx);
        return this.fail(type, "string templates must be serializable");
      case "UnionVariant":
        return this.typeRef(type.type, ctx);
      default:
        return this.fail(type, `type kind '${type.kind}' is not a data type`);
    }
  }

  // ------------------------------------------------------------------ named types

  private namedRef(decl: Decl): GoType {
    const name = declRef(decl.id);
    const textCapable = decl.kind === "enum" || decl.kind === "scalar";
    const t: GoType = {
      expr: name,
      codec: `tsgo.JSONCodec[${name}]()`,
      text: textCapable && this.declHasText(decl) ? textRef(decl.id) : undefined,
      kinds: this.declKinds(decl),
      cat: "named",
      decl,
      rcodec: () => (decl.nullUnset ? `tsgo.WithEncoder(tsgo.JSONCodec[${name}](), ${name}.MarshalResponseJSON)` : undefined),
      validate: (val, v, out) => {
        if (decl.hasValidation !== false) out.line(`${val}.ValidateWith(${v})`);
      },
      hasValidation: () => decl.hasValidation !== false,
      defaults: (lval, out) => {
        if (decl.hasDefaults) out.line(`${lval}.ApplyDefaults()`);
      },
      hasDefaults: () => !!decl.hasDefaults,
    };
    if (decl.kind === "array") {
      // A named array is a Go slice type: parameters, forms and XML bind its items as for an
      // anonymous array (the element is read lazily: it is set once the declaration is complete).
      t.cat = "array";
      Object.defineProperty(t, "elem", { get: () => decl.arrayElem, enumerable: true });
    }
    return t;
  }

  private declHasText(d: Decl): boolean {
    if (d.kind === "enum") return !!d.enumBase?.text;
    if (d.kind === "scalar") return !!d.scalarBase?.text;
    return false;
  }

  private declKinds(d: Decl): string[] | undefined {
    switch (d.kind) {
      case "model":
      case "poly":
        return ["tsgo.KindObject"];
      case "tuple":
      case "array":
        return ["tsgo.KindArray"];
      case "enum":
        return d.enumBase?.kinds;
      case "scalar":
        return d.scalarBase?.kinds;
      case "union": {
        if (d.discriminator) return ["tsgo.KindObject"];
        const ks = new Set<string>();
        for (const v of d.variants ?? []) {
          if (!v.type.kinds) return undefined;
          v.type.kinds.forEach((k) => ks.add(k));
        }
        return [...ks];
      }
    }
  }

  private newDecl(kind: DeclKind, source: Type, vis: number | undefined, baseName: string, qualifiers: string[], key: number = vis ?? -1): Decl {
    const d: Decl = { id: this.decls.length, kind, source, vis, baseName, qualifiers, name: baseName };
    this.decls.push(d);
    let m = this.declsByType.get(source);
    if (!m) this.declsByType.set(source, (m = new Map()));
    m.set(key, d);
    return d;
  }

  /** Cross-package key of a named type (undefined for anonymous types). */
  private typeKey(t: Model | Enum | Union | Scalar, variant: string): string | undefined {
    if (!t.name) return undefined;
    return contractTypeKey(t) + (variant ? "@" + variant : "");
  }

  private existing(source: Type, vis?: number, key: number = vis ?? -1): Decl | undefined {
    return this.declsByType.get(source)?.get(key);
  }

  private qualifiersOf(t: { namespace?: Namespace }): string[] {
    const out: string[] = [];
    for (let ns = t.namespace; ns && ns.name; ns = ns.namespace) out.unshift(exportedName(ns.name));
    return out;
  }

  private declName(t: Model | Enum | Union | Scalar, ctx: Ctx): string {
    const friendly = getFriendlyName(this.program, t);
    if (friendly) return exportedName(friendly);
    // Anonymous models inside a template instance share its template mapper but are not instances.
    if (t.kind === "Model" && t.name && isTemplateInstance(t)) {
      return exportedName(t.name) + t.templateMapper!.args.map((a) => this.argName(a as Type)).join("");
    }
    if (t.name) return exportedName(t.name);
    return this.anonymousName(t, ctx);
  }

  private anonymousName(t: Type, ctx: Ctx): string {
    let n = this.anonymousNames.get(t);
    if (!n) {
      n = exportedName(ctx.hint);
      this.anonymousNames.set(t, n);
    }
    return n;
  }

  private argName(a: Type): string {
    // Template arguments that could be types or values (`OmitProperties<T, "id">`) are wrapped.
    if ((a as any).entityKind === "Indeterminate") return this.argName((a as any).type);
    switch (a.kind) {
      case "Model":
        const item = a.indexer?.value;
        if (item && this.program.checker.isStdType(a, "Array")) return this.argName(item) + "Array";
        if (isMapType(a)) return this.argName(a.indexer!.value) + "Map";
        return a.name ? this.declName(a, { hint: a.name, site: a }) : "Object";
      case "Scalar":
      case "Enum":
        return exportedName(a.name);
      case "Union":
        return a.name ? exportedName(a.name) : "Union";
      case "String":
        return exportedName(a.value) || "Literal";
      case "Number":
        return "N" + String(a.value).replace(/[^0-9]/g, "_");
      case "Boolean":
        return a.value ? "True" : "False";
      case "Intrinsic":
        return exportedName(a.name);
      default: {
        // Template arguments may be values (e.g. `Foo<"x">` for a `valueof` parameter).
        const v = a as any;
        if (v.entityKind === "Value") {
          if (typeof v.value === "string") return exportedName(v.value) || "Value";
          if (v.value !== undefined && typeof v.value !== "object") return "V" + String(v.value).replace(/[^0-9A-Za-z]/g, "_");
          return exportedName(v.valueKind ?? "Value");
        }
        return exportedName(String(a.kind ?? "Arg"));
      }
    }
  }

  // ------------------------------------------------------------------ models

  private modelRef(m: Model, ctx: Ctx): GoType {
    // A named array model (`model Docs is Doc[]`) is a named Go slice type with its own methods.
    if (isArrayModelType(m) && m.name && !this.program.checker.isStdType(m, "Array")) return this.namedRef(this.arrayDecl(m, ctx));
    if (isArrayModelType(m)) {
      this.checkDecorators(m);
      // Merge patch: arrays are replaced as a whole, their elements are complete values.
      const elem = this.typeRef(m.indexer!.value, { ...ctx, mergePatch: false, hint: ctx.hint + "Item" });
      const array = arrayType(elem);
      const constraints = { patterns: [], minItems: getMinItems(this.program, m), maxItems: getMaxItems(this.program, m) };
      if (constraints.minItems === undefined && constraints.maxItems === undefined) return array;
      return { ...array, hasValidation: () => true, validate: (val, v, out) => {
        this.emitConstraintChecks(array, constraints, val, v, out, m);
        array.validate(val, v, out);
      } };
    }
    if (isMapType(m)) {
      if (isNeverType(m.indexer!.value)) return this.namedRef(this.modelDecl(m, ctx));
      const elem = this.typeRef(m.indexer!.value, { ...ctx, hint: ctx.hint + "Value" });
      // Merge patch: a null map value removes the key.
      return (this.orderedRecords ? orderedMapType : mapType)(ctx.mergePatch ? nullableType(elem) : elem, this.escaping);
    }
    if (isTemplateDeclaration(m)) this.fail(m, "template declarations are not types");
    // Inheritance-based polymorphism: a reference to a @discriminator base with derived models.
    const disc = getDiscriminator(this.program, m);
    if (disc && m.derivedModels.length > 0) return this.namedRef(this.polyDecl(m, { ...ctx, mergePatch: false }));
    return this.namedRef(this.modelDecl(m, ctx));
  }

  /** Visibility actually applied to a model in context: undefined = canonical (all properties). */
  private effectiveVis(m: Model, vis: number | undefined): number | undefined {
    if (vis === undefined) return undefined;
    return this.metadata.isTransformed(m, vis) ? vis : undefined;
  }

  modelDecl(m: Model, ctx: Ctx): Decl {
    const vis = this.effectiveVis(m, ctx.vis);
    const key = ctx.mergePatch ? (vis ?? -1) - 3_000_000 : (vis ?? -1);
    const found = this.existing(m, vis, key);
    if (found) return found;
    const suffix = (vis === undefined ? "" : getVisibilitySuffix(vis, Visibility.All)) + (ctx.mergePatch ? "MergePatch" : "");
    // Anonymous members are named after the canonical model (never after the variant that
    // happens to be reached first), and carry their own suffix when they vary themselves.
    const base = this.declName(m, ctx);
    const d = this.newDecl("model", m, vis, base + suffix, this.qualifiersOf(m), key);
    d.key = this.typeKey(m, suffix);
    d.mergePatch = !!ctx.mergePatch;
    d.doc = getDoc(this.program, m);
    this.checkDecorators(m);
    this.guard(
      () => {
        d.fields = this.collectFields(m, d, vis, base);
        // The nearest indexer in the inheritance chain decides: `...Record<T>` keeps undeclared
        // properties as T; `...Record<never>` (TypeSpec's closed object) rejects them.
        const extras = nearestIndexer(m);
        if (extras && isNeverType(extras)) d.closed = true;
        else if (extras) {
          const t = this.typeRef(extras, { vis: ctx.vis, mergePatch: ctx.mergePatch, hint: base + "AdditionalProperty", site: m });
          d.additional = ctx.mergePatch ? nullableType(t) : t;
        }
      },
      () => undefined,
    );
    return d;
  }

  private collectFields(m: Model, d: Decl, vis: number | undefined, hintBase: string): Field[] {
    // Base properties first (flattened inheritance), derived overrides keep the base position.
    const chain: Model[] = [];
    for (let b: Model | undefined = m; b; b = b.baseModel) chain.unshift(b);
    const props = new Map<string, ModelProperty>();
    for (const b of chain) for (const p of b.properties.values()) props.set(p.name, p);

    const fields: Field[] = [];
    const used = new Set(["Validate", "ApplyDefaults", "MarshalJSON", "UnmarshalJSON", "AdditionalProperties", "FromXMLNode", "ToXMLNode"]);
    for (const prop of props.values()) {
      if (vis === undefined ? isMetadata(this.program, prop) : !this.metadata.isPayloadProperty(prop, vis)) {
        // Excluded by visibility (not HTTP metadata): known, so it may be accepted and ignored.
        if (vis !== undefined && this.ignoreInvisible && !isMetadata(this.program, prop)) (d.ignored ??= []).push(prop);
        continue;
      }
      this.checkDecorators(prop);
      const f = this.guard(() => this.field(prop, d, vis, used, hintBase), () => undefined);
      if (f) fields.push(f);
    }
    // `@discriminator("kind")` implies a required string property even when it is not declared.
    for (const b of chain) {
      const disc = getDiscriminator(this.program, b);
      if (disc && !fields.some((f) => f.json === disc.propertyName) && ![...props.values()].some((p) => p.name === disc.propertyName)) {
        let goName = exportedName(disc.propertyName);
        while (used.has(goName)) goName += "_";
        used.add(goName);
        fields.unshift({
          prop: b as any,
          json: disc.propertyName,
          goName,
          type: this.stdScalar("string", b),
          optional: false,
          constraints: { patterns: [] },
          doc: `${goName} is the discriminator property ${JSON.stringify(disc.propertyName)} implied by @discriminator.`,
        });
      }
    }
    return fields;
  }

  private field(prop: ModelProperty, d: Decl, vis: number | undefined, used: Set<string>, hintBase: string): Field {
    const json = resolveEncodedName(this.program, prop, "application/json");
    let goName = exportedName(prop.name);
    while (used.has(goName)) goName += "_";
    used.add(goName);
    const optional = vis === undefined ? prop.optional : this.metadata.isOptional(prop, vis);
    const constraints = this.constraintsOf(prop);
    if (prop.type.kind === "Intrinsic" && prop.type.name === "never") {
      // `never` has no value: the property is never serialized and must be absent (as in the
      // official emitters, which omit such properties), whether declared optional or not.
      return { prop, json, goName, type: this.stdScalar("string", prop), optional: true, constraints: { patterns: [] }, never: true };
    }
    const ctx: Ctx = { vis, hint: hintBase + exportedName(prop.name), site: prop, mergePatch: d.mergePatch };
    const sourceType = this.propertyType(prop, ctx);
    // RFC 7396: null removes an optional member, so optional members are absent | null | value.
    const type = optional && (d.mergePatch || (this.optionalNullable && !prop.defaultValue)) ? nullableType(sourceType) : sourceType;
    this.checkConstraintTargets(prop, type, constraints);
    const f: Field = { prop, json, goName, type, optional, constraints, doc: getDoc(this.program, prop) };
    if (!d.mergePatch && type !== sourceType) f.sourceText = sourceType.text;
    if (optional && type.cat === "nullable" && this.writesNullInResponses(prop, d)) f.nullInResponse = true;
    if (!optional && isSingleLiteral(prop.type)) {
      const lit = this.literalValue(prop.type);
      f.literal = { codec: type.codec, value: lit.go, display: lit.display };
    }
    if (prop.defaultValue) {
      try {
        f.defaultJson = defaultJSON(this.program, prop.defaultValue, prop, (n, t) => {
          if (this.integerInt64 && onlyInteger(t) && !fitsInt64(n)) {
            throw new Error(`${n.toString()} is outside the int64 range to which 'integer-type: int64' maps integer`);
          }
        });
      } catch (e) {
        this.report("invalid-default", prop, { name: prop.name, reason: (e as Error).message });
      }
      if (!optional) f.defaultJson = undefined; // defaults only fill absent optional properties
      if (d.mergePatch) f.defaultJson = undefined; // in a merge patch, absent means "leave unchanged"
    }
    return f;
  }

  /** Go type of a property, honouring property-level @encode. */
  propertyType(prop: ModelProperty, ctx: Ctx): GoType {
    const enc = getEncode(this.program, prop);
    if (enc) {
      const t = prop.type;
      if (t.kind === "Scalar") return this.scalarRef(t, ctx, { encoding: enc.encoding, wire: enc.type.name });
      const arrayEnc = enc.encoding?.replace(/^.*\./, "");
      if (t.kind === "Model" && isArrayModelType(t) && arrayEnc && /Delimited$/.test(arrayEnc)) {
        const elem = this.typeRef(t.indexer!.value, { ...ctx, hint: ctx.hint + "Item" });
        if (!elem.text) this.fail(prop, `array encoding '${arrayEnc}' requires elements with a text form`);
        const sep = { commaDelimited: ",", spaceDelimited: " ", pipeDelimited: "|", newlineDelimited: "\n" }[arrayEnc as "commaDelimited"];
        if (!sep) this.fail(prop, `unknown array encoding ${arrayEnc}`);
        const base = arrayType(elem);
        return { ...base, codec: `tsgo.DelimitedArrayCodec(${elem.text}, ${goString(sep)})`, kinds: ["tsgo.KindString"] };
      }
      if (t.kind === "Union") {
        const variants = [...t.variants.values()].filter(v => !isNeverType(v.type));
        const nonNull = variants.filter(v => !isNullType(v.type));
        if (nonNull.length === 1 && nonNull[0].type.kind === "Scalar") {
          const inner = this.scalarRef(nonNull[0].type, ctx, { encoding: enc.encoding, wire: enc.type.name });
          return variants.length === nonNull.length ? inner : nullableType(inner);
        }
      }
      this.report("unsupported-encoding", prop, { encoding: enc.encoding ?? enc.type.name, type: safeName(prop.type) });
    }
    return this.typeRef(prop.type, ctx);
  }

  private checkConstraintTargets(prop: ModelProperty, t: GoType, c: Constraints): void {
    const core = t.cat === "nullable" ? t.elem! : t;
    const cat = core.cat === "named" && core.decl?.kind === "scalar" ? core.decl.scalarBase!.cat : core.cat;
    const bad = (what: string) => this.fail(prop, `${what} constraints do not apply to Go type ${core.expr}`);
    if ((c.minLength !== undefined || c.maxLength !== undefined || c.patterns.length > 0) && cat !== "string") bad("string");
    if ((c.minItems !== undefined || c.maxItems !== undefined) && cat !== "array") bad("item");
    if ([c.min, c.max, c.minExclusive, c.maxExclusive].some((x) => x !== undefined) && !["number", "integer", "decimal"].includes(cat)) bad("value");
    // `integer` as int64: a bound that no int64 satisfies leaves the declared type without any
    // representable value (with arbitrary precision it would admit larger integers).
    const base = core.cat === "named" && core.decl?.kind === "scalar" ? core.decl.scalarBase! : core;
    if (base.boundedInteger) {
      const max = Numeric(INT64_MAX);
      const min = Numeric(INT64_MIN);
      const empty = (c.min && c.min.gt(max)) || (c.minExclusive && !c.minExclusive.lt(max)) || (c.max && c.max.lt(min)) || (c.maxExclusive && !c.maxExclusive.gt(min));
      if (empty) this.fail(prop, `its value bounds admit no int64 value, and 'integer-type: int64' maps integer to int64`);
    }
  }

  constraintsOf(t: Scalar | ModelProperty): Constraints {
    const p = this.program;
    // Patterns are checked here, at collection time, so that an untranslatable pattern fails the
    // compilation before any code is generated (never a silently missing constraint).
    const pattern = getPattern(p, t);
    if (pattern !== undefined) {
      const r = translateEcmaRegex(pattern);
      if (!r.ok && !this.reportedPatterns.has(t)) {
        this.reportedPatterns.add(t);
        this.report("unsupported-pattern", t, { pattern, feature: r.feature });
      }
    }
    return {
      minLength: getMinLength(p, t),
      maxLength: getMaxLength(p, t),
      patterns: getPattern(p, t) !== undefined ? [getPattern(p, t)!] : [],
      minItems: getMinItems(p, t),
      maxItems: getMaxItems(p, t),
      min: getMinValueAsNumeric(p, t),
      max: getMaxValueAsNumeric(p, t),
      minExclusive: getMinValueExclusiveAsNumeric(p, t),
      maxExclusive: getMaxValueExclusiveAsNumeric(p, t),
    };
  }

  // ------------------------------------------------------------------ polymorphism

  private polyDecl(base: Model, ctx: Ctx): Decl {
    const vis = this.effectiveVis(base, ctx.vis);
    const found = this.existing(base, (vis ?? -1) + 1_000_000);
    if (found) return found;
    const suffix = vis === undefined ? "" : getVisibilitySuffix(vis, Visibility.All);
    const d = this.newDecl("poly", base, (vis ?? -1) + 1_000_000, this.declName(base, ctx) + suffix + "Union", this.qualifiersOf(base));
    d.key = this.typeKey(base, suffix + "Union");
    d.doc = `${d.baseName} holds a ${base.name} or one of the models derived from it, selected by the discriminator.`;
    this.guard(
      () => {
        const disc = getDiscriminator(this.program, base)!;
        const [info, errors] = getDiscriminatedUnionFromInheritance(this.program, base, disc);
        this.diagnostics.push(...errors);
        const prop = getProperty(base, disc.propertyName);
        const key = prop ? resolveEncodedName(this.program, prop, "application/json") : disc.propertyName;
        d.discriminator = { property: key, envelope: "none", envelopeProperty: "" };
        d.variants = [];
        for (const [tag, derived] of info.variants) {
          const t = this.modelRef(derived, { ...ctx, hint: derived.name });
          d.variants.push({ name: exportedName(derived.name), tag, type: t });
        }
        d.fallback = { name: "Base", type: this.namedRef(this.modelDecl(base, ctx)) };
      },
      () => undefined,
    );
    return d;
  }

  // ------------------------------------------------------------------ enums & literals

  private enumDecl(e: Enum): Decl {
    const found = this.existing(e);
    if (found) return found;
    const members = [...e.members.values()];
    const values = members.map((m) => {
      this.checkDecorators(m);
      return { name: exportedName(m.name), value: this.literalValue(m).raw, doc: getDoc(this.program, m) };
    });
    const mixed = new Set(values.map(v => typeof v.value === "bigint" ? "number" : typeof v.value)).size > 1;
    const d = this.newDecl(mixed ? "union" : "enum", e, undefined, exportedName(e.name), this.qualifiersOf(e));
    d.key = this.typeKey(e, "");
    d.doc = getDoc(this.program, e);
    this.checkDecorators(e);
    const used = new Set<string>();
    for (const v of values) {
      while (used.has(v.name)) v.name += "_";
      used.add(v.name);
    }
    if (mixed) {
      d.variants = members.map((m, i) => ({ name: values[i].name, type: this.literalRef([m], { hint: d.baseName + values[i].name, site: m }) }));
    } else {
      d.enumValues = values;
      d.enumBase = this.literalBase(values.map((v) => v.value), e);
    }
    return d;
  }

  private literalBase(values: (string | number | bigint | boolean)[], site: Type): GoType {
    if (values.every((v) => typeof v === "string")) return this.stdScalar("string", site);
    if (values.every((v) => typeof v === "boolean")) return this.stdScalar("boolean", site);
    if (values.some(v => typeof v === "bigint")) {
      if (values.every(v => typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v)))) {
        if (values.every(v => BigInt(v) >= -(2n ** 63n) && BigInt(v) < 2n ** 63n)) return this.stdScalar("int64", site);
        if (values.every(v => BigInt(v) >= 0 && BigInt(v) < 2n ** 64n)) return this.stdScalar("uint64", site);
      }
      return this.fail(site, "this literal set exceeds the range of a native Go integer constant");
    }
    if (values.every((v) => typeof v === "number")) {
      return this.stdScalar(values.every((v) => Number.isInteger(v)) ? "int64" : "float64", site);
    }
    return this.fail(site, "enums and literal unions mixing strings, numbers and booleans are not supported; use a union of separate types");
  }

  private literalValue(t: Type): { raw: string | number | bigint | boolean; go: string; display: string } {
    let raw: string | number | bigint | boolean;
    switch (t.kind) {
      case "String":
      case "Boolean":
        raw = t.value;
        break;
      case "Number":
      case "EnumMember": {
        const n = t.kind === "Number" ? t.numericValue : enumWireValue(this.program, t);
        if (typeof n === "string") raw = n;
        else if (n.isInteger) {
          const integer = n.asBigInt()!;
          raw = Number.isSafeInteger(Number(integer)) ? Number(integer) : integer;
        } else {
          const f = n.asNumber();
          if (f === null) return this.fail(t, "fractional literal exceeds binary64 precision");
          raw = f;
        }
        break;
      }
      default:
        return this.fail(t, "not a literal");
    }
    const go = typeof raw === "string" ? goString(raw) : String(raw);
    return { raw, go, display: typeof raw === "bigint" ? String(raw) : JSON.stringify(raw) };
  }

  /** Literal type(s): single literal → base type with LiteralCodec; several → closed enum decl. */
  private literalRef(lits: Type[], ctx: Ctx, open?: GoType, union?: Union): GoType {
    const values = lits.map((l) => this.literalValue(l).raw);
    if (lits.length === 1 && !open) {
      const base = this.literalBase(values, lits[0]);
      const v = this.literalValue(lits[0]);
      return {
        ...base,
        codec: `tsgo.LiteralCodec(${base.codec}, ${base.expr}(${v.go}))`,
        hasValidation: () => true,
        validate: (value, validator, out) => out.line(`tsgo.OneOf(${validator}, ${value}, ${base.expr}(${v.go}))`),
        text: base.text ? `tsgo.LiteralText(${base.text}, ${base.expr}(${v.go}))` : undefined,
      };
    }
    const key = union ?? lits[0];
    const found = this.existing(key, open ? -2 : -1);
    if (found) return this.namedRef(found);
    const name = union?.name ? exportedName(union.name) : this.anonymousName(key, ctx);
    const d = this.newDecl("enum", key, open ? -2 : -1, name, union ? this.qualifiersOf(union) : []);
    if (union) d.key = this.typeKey(union, "");
    if (union) d.doc = getDoc(this.program, union);
    const seen = new Set<string>();
    d.enumValues = [];
    const usedNames = new Set<string>();
    for (let i = 0; i < lits.length; i++) {
      const l = lits[i];
      const v = values[i];
      const key2 = `${typeof v}:${v}`;
      if (seen.has(key2)) continue;
      seen.add(key2);
      const variantName = union ? [...union.variants.values()].find((x) => x.type === l)?.name : undefined;
      let n = typeof variantName === "string" ? exportedName(variantName) : l.kind === "EnumMember" ? exportedName(l.name) : literalIdent(v);
      while (usedNames.has(n)) n += "_";
      usedNames.add(n);
      d.enumValues.push({ name: n, value: v });
    }
    d.enumBase = open ?? this.literalBase(values, lits[0]);
    d.enumOpen = !!open;
    return this.namedRef(d);
  }

  // ------------------------------------------------------------------ unions

  private unionRef(self: Union, variants: UnionVariant[], ctxIn: Ctx): GoType {
    const ctx = { ...ctxIn, mergePatch: false }; // union values replace the target as a whole
    this.checkDecorators(self);
    for (const v of variants) this.checkDecorators(v);
    if (this.sse?.isEvents(self)) return this.namedRef(this.unionDecl(self, variants, ctx));
    const disc = getDiscriminatedUnion(this.program, self)[0];
    const members: UnionVariant[] = [];
    const collect = (v: UnionVariant) => {
      if (isNeverType(v.type)) return;
      if (!disc && v.type.kind === "Union" && !v.type.name && !getDiscriminatedUnion(this.program, v.type)[0]) {
        this.checkDecorators(v.type);
        for (const child of v.type.variants.values()) { this.checkDecorators(child); collect(child); }
      } else members.push(v);
    };
    for (const v of variants) collect(v);
    if (!members.length) return this.fail(self, "a union without inhabitable variants has no value");
    const nonNull = members.filter(v => !isNullType(v.type));
    const hasNull = nonNull.length !== members.length;
    if (!nonNull.length) return this.typeRef(members[0].type, ctx);
    let inner: GoType;
    if (disc) {
      inner = this.namedRef(this.discriminatedUnionDecl(self, disc, ctx));
    } else if (nonNull.length === 1) {
      inner = this.typeRef(nonNull[0].type, ctx);
    } else {
      const isLit = (t: Type) => ["String", "Number", "Boolean", "EnumMember"].includes(t.kind);
      const lits = nonNull.filter((v) => isLit(v.type)).map((v) => v.type);
      const others = nonNull.filter((v) => !isLit(v.type));
      const sameKind = new Set(lits.map((l) => typeof this.literalValue(l).raw === "bigint" ? "number" : typeof this.literalValue(l).raw)).size === 1;
      if (others.length === 0 && sameKind) {
        inner = this.literalRef(lits, ctx, undefined, self);
      } else if (others.length === 0) {
        // Literals of different JSON types ("a" | 2 | true): a union of single-literal variants.
        inner = this.namedRef(this.unionDecl(self, nonNull, ctx));
      } else if (lits.length > 0 && others.length === 1 && this.isOpenEnumBase(others[0].type, lits)) {
        inner = this.literalRef(lits, ctx, this.typeRef(others[0].type, ctx), self);
      } else {
        inner = this.namedRef(this.unionDecl(self, nonNull, ctx));
      }
    }
    return hasNull ? nullableType(inner) : inner;
  }

  private isOpenEnumBase(t: Type, lits: Type[]): boolean {
    if (t.kind !== "Scalar") return false;
    let s: Scalar | undefined = t;
    while (s && !(s.namespace && getNamespaceFullName(s.namespace) === "TypeSpec")) s = s.baseScalar;
    if (!s) return false;
    const values = lits.map((l) => this.literalValue(l).raw);
    if (s.name === "string") return values.every((v) => typeof v === "string");
    if (["int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "safeint", ...(this.integerInt64 ? ["integer"] : [])].includes(s.name)) return values.every((v) => typeof v === "number" && Number.isInteger(v));
    if (["float32", "float64", "float"].includes(s.name)) return values.every((v) => typeof v === "number");
    return false;
  }

  /** Visibility that changes some variant of a union (undefined: the canonical union). */
  private unionVis(u: Union, vis: number | undefined, seen = new Set<Type>()): number | undefined {
    if (vis === undefined || seen.has(u)) return undefined;
    seen.add(u);
    return [...u.variants.values()].some((v) => this.changesUnder(v.type, vis, seen)) ? vis : undefined;
  }

  /** Whether visibility `vis` changes the representation of a member type of a union or tuple. */
  private changesUnder(t: Type, vis: number, seen: Set<Type>): boolean {
    if (t.kind === "Model") {
      if (isArrayModelType(t) || isMapType(t)) return this.changesUnder(t.indexer!.value, vis, seen);
      return this.metadata.isTransformed(t, vis);
    }
    if (t.kind === "Union") return this.unionVis(t, vis, seen) !== undefined;
    if (t.kind === "Tuple") return t.values.some((v) => this.changesUnder(v, vis, seen));
    return false;
  }

  private unionDecl(self: Union, flat: UnionVariant[], ctxIn: Ctx): Decl {
    const ctx = { ...ctxIn, vis: this.unionVis(self, ctxIn.vis) };
    const found = this.existing(self, ctx.vis);
    if (found) return found;
    const base = self.name ? exportedName(self.name) : this.anonymousName(self, ctx);
    const name = base + (ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All));
    const d = this.newDecl("union", self, ctx.vis, name, self.name ? this.qualifiersOf(self) : []);
    d.key = this.typeKey(self, ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All));
    d.doc = getDoc(this.program, self);
    const used = new Set<string>();
    d.variants = flat.map((v, i) => {
      let vn = typeof v.name === "string" ? exportedName(v.name) : this.argName(v.type);
      while (used.has(vn)) vn += String(i);
      used.add(vn);
      return { name: vn, type: this.typeRef(v.type, { ...ctx, hint: base + vn }) };
    });
    return d;
  }

  private discriminatedUnionDecl(u: Union, disc: NonNullable<ReturnType<typeof getDiscriminatedUnion>[0]>, ctxIn: Ctx): Decl {
    const ctx = { ...ctxIn, vis: this.unionVis(u, ctxIn.vis) };
    const found = this.existing(u, ctx.vis);
    if (found) return found;
    const base = u.name ? exportedName(u.name) : this.anonymousName(u, ctx);
    const d = this.newDecl("union", u, ctx.vis, base + (ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All)), this.qualifiersOf(u));
    d.key = this.typeKey(u, ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All));
    d.doc = getDoc(this.program, u);
    d.discriminator = {
      property: disc.options.discriminatorPropertyName,
      envelope: disc.options.envelope,
      envelopeProperty: disc.options.envelopePropertyName,
    };
    d.variants = [];
    const usedNames = new Set(disc.defaultVariant ? ["Default"] : []);
    for (const [tag, t] of disc.variants) {
      let name = exportedName(tag);
      while (usedNames.has(name)) name += "_";
      usedNames.add(name);
      d.variants.push({ name, tag, type: this.typeRef(t, { ...ctx, hint: base + exportedName(tag) }) });
    }
    if (disc.defaultVariant) {
      // Unnamed variant: receives every undeclared discriminator value (encoded as-is).
      if (disc.options.envelope !== "none") this.fail(u, "a default variant needs envelope \"none\" (the envelope names the variant)");
      d.fallback = { name: "Default", type: this.typeRef(disc.defaultVariant, { ...ctx, hint: base + "Default" }) };
    }
    return d;
  }

  // ------------------------------------------------------------------ named arrays

  private arrayDecl(m: Model, ctxIn: Ctx): Decl {
    // Merge patch: arrays are replaced as a whole, their elements are complete values. One
    // declaration per visibility only when the visibility changes the element.
    const ctx = { ...ctxIn, mergePatch: false, vis: ctxIn.vis !== undefined && this.changesUnder(m, ctxIn.vis, new Set()) ? ctxIn.vis : undefined };
    const found = this.existing(m, ctx.vis);
    if (found) return found;
    const base = this.declName(m, ctx);
    const suffix = ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All);
    const d = this.newDecl("array", m, ctx.vis, base + suffix, this.qualifiersOf(m));
    d.key = this.typeKey(m, suffix);
    d.doc = getDoc(this.program, m);
    this.checkDecorators(m);
    d.arrayConstraints = { patterns: [], minItems: getMinItems(this.program, m), maxItems: getMaxItems(this.program, m) };
    d.arrayElem = this.guard(() => this.typeRef(m.indexer!.value, { ...ctx, hint: base + "Item" }), () => ({ expr: "json.RawMessage", codec: "tsgo.RawCodec", cat: "other", ...noValidation, ...noDefaults }));
    return d;
  }

  // ------------------------------------------------------------------ tuples

  private tupleDecl(t: Tuple, ctxIn: Ctx): Decl {
    // One declaration per visibility only when the visibility changes an item (as for unions).
    const ctx = { ...ctxIn, vis: ctxIn.vis !== undefined && this.changesUnder(t, ctxIn.vis, new Set()) ? ctxIn.vis : undefined };
    const found = this.existing(t, ctx.vis);
    if (found) return found;
    const base = this.anonymousName(t, ctx);
    const d = this.newDecl("tuple", t, ctx.vis, base + (ctx.vis === undefined ? "" : getVisibilitySuffix(ctx.vis, Visibility.All)), []);
    d.tupleItems = t.values.map((v, i) => this.typeRef(v, { ...ctx, hint: `${base}Item${i}` }));
    return d;
  }

  // ------------------------------------------------------------------ scalars

  private scalarRef(s: Scalar, ctx: Ctx, enc: { encoding?: string; wire: string } | undefined, location: "json" | "header" = "json"): GoType {
    const chain: Scalar[] = [];
    for (let x: Scalar | undefined = s; x; x = x.baseScalar) chain.push(x);
    const stdIndex = chain.findIndex((x) => x.namespace && getNamespaceFullName(x.namespace) === "TypeSpec");
    if (stdIndex < 0) this.fail(s, "custom scalars must extend a standard scalar");
    const std = chain[stdIndex];
    // Encoding: property-level overrides the nearest scalar-level @encode.
    let encoding = enc;
    if (!encoding) {
      for (const x of chain) {
        const e = getEncode(this.program, x);
        if (e) {
          encoding = { encoding: e.encoding, wire: e.type.name };
          break;
        }
      }
    }
    const base = this.stdScalar(std.name, s, encoding, location);
    if (stdIndex === 0) {
      if (encoding && enc) this.checkDecorators(s);
      return base;
    }
    // Custom scalar → defined Go type; property-level encodings get their own codec.
    const d = this.scalarDecl(chain.slice(0, stdIndex), std);
    const named = this.namedRef(d);
    if (enc) {
      const n = named.expr;
      const convert = (helper: string, of: string) =>
        this.conversion(`${helper}(${of}, func(b ${base.expr}) ${n} {\n\treturn ${n}(b)\n}, func(t ${n}) ${base.expr} {\n\treturn ${base.expr}(t)\n})`);
      return {
        ...named,
        codec: convert("tsgo.ConvertCodec", base.codec),
        text: base.text ? convert("tsgo.ConvertText", base.text) : undefined,
        kinds: base.kinds,
      };
    }
    return named;
  }

  private scalarDecl(custom: Scalar[], std: Scalar): Decl {
    const s = custom[0];
    const found = this.existing(s);
    if (found) return found;
    const d = this.newDecl("scalar", s, undefined, exportedName(s.name), this.qualifiersOf(s));
    d.key = this.typeKey(s, "");
    d.doc = getDoc(this.program, s);
    for (const x of custom) this.checkDecorators(x);
    let enc: { encoding?: string; wire: string } | undefined;
    for (const x of custom) {
      const e = getEncode(this.program, x);
      if (e) {
        enc = { encoding: e.encoding, wire: e.type.name };
        break;
      }
    }
    d.scalarBase = this.stdScalar(std.name, s, enc);
    let c: Constraints = { patterns: [] };
    for (const x of custom) c = mergeConstraints(c, this.constraintsOf(x));
    d.scalarConstraints = c;
    this.checkConstraintTargets(s as any, d.scalarBase, c);
    return d;
  }

  private conversion(init: string): string {
    let i = this.conversions.indexOf(init);
    if (i < 0) i = this.conversions.push(init) - 1;
    return conversionRef(i);
  }

  /** Go mapping of a TypeSpec standard scalar with an optional encoding. */
  stdScalar(name: string, site: Type, enc?: { encoding?: string; wire: string }, location: "json" | "header" = "json"): GoType {
    const simple = (expr: string, codec: string, text: string | undefined, kinds: string[], cat: GoType["cat"], num?: NumKind, extra?: (val: string, v: string, out: Code) => void): GoType => ({
      expr,
      codec,
      text,
      kinds,
      cat,
      num,
      validate: (val, v, out) => extra?.(val, v, out),
      hasValidation: () => !!extra,
      ...noDefaults,
    });
    const badEncoding = (): never => {
      this.report("unsupported-encoding", site, { encoding: enc!.encoding ?? enc!.wire, type: name });
      throw new Fail();
    };
    const asString = enc?.encoding === undefined && enc?.wire === "string";
    const num = ["tsgo.KindNumber"];
    const str = ["tsgo.KindString"];
    switch (name) {
      case "string":
        if (enc) badEncoding();
        return simple("string", this.stringCodec, "tsgo.StringText", str, "string");
      case "boolean":
        if (enc && !asString) badEncoding();
        return simple("bool", asString ? "tsgo.JSONString(tsgo.BoolStringText)" : "tsgo.BoolCodec", "tsgo.BoolText", asString ? str : ["tsgo.KindBool"], "other");
      case "integer":
        // The opt-in bounded representation is exactly the int64 mapping (encodings included).
        if (this.integerInt64) return { ...this.stdScalar("int64", site, enc, location), boundedInteger: true };
        if (enc && !asString) badEncoding();
        return simple("tsgo.Integer", asString ? "tsgo.NumberAsString(tsgo.IntegerText)" : "tsgo.IntegerCodec", "tsgo.IntegerText", asString ? str : num, "decimal");
      case "int8":
      case "int16":
      case "int32":
      case "int64":
      case "uint8":
      case "uint16":
      case "uint32":
      case "uint64":
      case "safeint": {
        const go = name === "safeint" ? "int64" : name;
        const text = `tsgo.IntText[${go}]()`;
        if (enc && !asString) badEncoding();
        const extra = name === "safeint" ? (val: string, v: string, out: Code) => void out.line(`tsgo.SafeInt(${v}, ${val})`) : undefined;
        return simple(go, asString ? `tsgo.NumberAsString(${text})` : `tsgo.IntCodec[${go}]()`, text, asString ? str : num, "integer", go as NumKind, extra);
      }
      case "float":
      case "float64":
        if (enc && !asString) badEncoding();
        return simple("float64", asString ? "tsgo.NumberAsString(tsgo.Float64Text)" : this.floatCodecs[0], "tsgo.Float64Text", asString ? str : num, "number", "float64", (val, v, out) => { out.line(`tsgo.Finite(${v}, float64(${val}))`); });
      case "float32":
        if (enc && !asString) badEncoding();
        return simple("float32", asString ? "tsgo.NumberAsString(tsgo.Float32Text)" : this.floatCodecs[1], "tsgo.Float32Text", asString ? str : num, "number", "float32", (val, v, out) => { out.line(`tsgo.Finite(${v}, float64(${val}))`); });
      case "numeric":
      case "decimal":
      case "decimal128": {
        if (enc && !asString) badEncoding();
        const extra = name === "decimal128" ? (val: string, v: string, out: Code) => void out.line(`tsgo.Decimal128(${v}, ${val})`) : undefined;
        return simple("tsgo.Decimal", asString ? "tsgo.NumberAsString(tsgo.DecimalText)" : "tsgo.DecimalCodec", "tsgo.DecimalText", asString ? str : num, "decimal", undefined, extra);
      }
      case "bytes": {
        const e = enc?.encoding ?? "base64";
        const text = e === "base64" ? "tsgo.Base64Text" : e === "base64url" ? "tsgo.Base64URLText" : badEncoding();
        return simple("[]byte", `tsgo.JSONString(${text})`, text, str, "bytes");
      }
      case "utcDateTime":
      case "offsetDateTime": {
        const e = enc?.encoding ?? (location === "header" ? "rfc7231" : "rfc3339");
        if (e === "rfc3339") return simple("time.Time", "tsgo.JSONString(tsgo.DateTimeRFC3339)", "tsgo.DateTimeRFC3339", str, "other");
        if (e === "rfc7231") return simple("time.Time", "tsgo.JSONString(tsgo.DateTimeRFC7231)", "tsgo.DateTimeRFC7231", str, "other");
        if (e === "unixTimestamp") {
          const w = enc!.wire === "int32" ? "int32" : enc!.wire === "int64" ? "int64" : badEncoding();
          return simple("time.Time", `tsgo.UnixTimestampCodec[${w}]()`, `tsgo.UnixTimestampText[${w}]()`, num, "other");
        }
        return badEncoding();
      }
      case "plainDate":
        if (enc) badEncoding();
        return simple("tsgo.Date", "tsgo.JSONString(tsgo.DateText)", "tsgo.DateText", str, "other");
      case "plainTime":
        if (enc) badEncoding();
        return simple("tsgo.TimeOfDay", "tsgo.JSONString(tsgo.TimeOfDayText)", "tsgo.TimeOfDayText", str, "other");
      case "duration": {
        const e = enc?.encoding ?? "ISO8601";
        if (e === "ISO8601") return simple("tsgo.Duration", "tsgo.JSONString(tsgo.DurationISO8601Text)", "tsgo.DurationISO8601Text", str, "other");
        if (e === "seconds" || e === "milliseconds") {
          const w = enc!.wire;
          if (!["int32", "int64", "float", "float32", "float64"].includes(w)) badEncoding();
          const ctor = e === "seconds" ? "tsgo.DurationSecondsCodec" : "tsgo.DurationMillisecondsCodec";
          const codec = `${ctor}(${goString(w === "float" ? "float64" : w)})`;
          return simple("tsgo.Duration", codec, `tsgo.DurationNumberText(${codec})`, num, "other");
        }
        return badEncoding();
      }
      case "url":
        if (enc) badEncoding();
        return simple("string", this.stringCodec, "tsgo.StringText", str, "string", undefined, (val, v, out) => void out.line(`tsgo.URL(${v}, ${val})`));
      default:
        return this.fail(site, `standard scalar '${name}' has no Go mapping`);
    }
  }

  /** Scalar for parameters/headers (rfc7231 default for date-times in headers). */
  paramScalar(prop: ModelProperty, location: "query" | "path" | "header" | "cookie", ctx: Ctx): GoType {
    const enc = getEncode(this.program, prop);
    const t = prop.type;
    const loc = location === "header" ? "header" : "json";
    if (t.kind === "Scalar") {
      return this.scalarRef(t, ctx, enc ? { encoding: enc.encoding, wire: enc.type.name } : undefined, loc);
    }
    return this.typeRef(t, ctx);
  }

  // ------------------------------------------------------------------ validation helpers

  /** Emits checks for property/scalar-level constraints on a non-null value. */
  emitConstraintChecks(t: GoType, c: Constraints, val: string, v: string, out: Code, site: Type): void {
    const core = t.cat === "named" && t.decl?.kind === "scalar" ? t.decl.scalarBase! : t;
    const conv = t.cat === "named" && t.decl?.kind === "scalar" ? `${core.expr}(${val})` : val;
    if (c.minLength !== undefined) out.line(`tsgo.MinLength(${v}, ${conv}, ${c.minLength})`);
    if (c.maxLength !== undefined) out.line(`tsgo.MaxLength(${v}, ${conv}, ${c.maxLength})`);
    for (const pattern of c.patterns) {
      const r = translateEcmaRegex(pattern);
      if (!r.ok) {
        // reported by constraintsOf at collection time; emitting no check here would be fail-open
        throw new Error(`internal error: untranslatable pattern ${pattern} reached code generation`);
      } else {
        let name = [...this.patternSources.entries()].find(([, p]) => p === pattern)?.[0];
        if (!name) {
          // Named after the declared pattern, not the registration order: adding a pattern
          // elsewhere never renames the variables used by unrelated declarations (or files).
          const hash = createHash("sha256").update(pattern).digest("hex");
          let n = 8;
          while (this.patterns.has(`pattern${hash.slice(0, n)}`)) n++;
          name = `pattern${hash.slice(0, n)}`;
          this.patterns.set(name, r.pattern);
          this.patternSources.set(name, pattern);
        }
        out.line(`tsgo.Pattern(${v}, ${conv}, ${name})`);
      }
    }
    if (c.minItems !== undefined) out.line(`tsgo.MinItems(${v}, ${val}, ${c.minItems})`);
    if (c.maxItems !== undefined) out.line(`tsgo.MaxItems(${v}, ${val}, ${c.maxItems})`);
    const bounds: [Numeric | undefined, boolean, boolean][] = [
      [c.min, false, false],
      [c.minExclusive, true, false],
      [c.max, false, true],
      [c.maxExclusive, true, true],
    ];
    for (const [b, exclusive, isMax] of bounds) {
      if (b === undefined) continue;
      emitBound(core, conv, b, exclusive, isMax, v, out);
    }
  }
}

// ------------------------------------------------------------------------------------------ helpers

function emitBound(t: GoType, val: string, b: Numeric, exclusive: boolean, isMax: boolean, v: string, out: Code): void {
  const fn = isMax ? "Maximum" : "Minimum";
  const constraint = isMax ? (exclusive ? "exclusiveMaximum" : "maximum") : exclusive ? "exclusiveMinimum" : "minimum";
  const text = b.toString();
  if (t.cat === "decimal") {
    const conv = t.expr === "tsgo.Integer" ? `tsgo.IntegerRat(${val})` : `tsgo.DecimalRat(${val})`;
    out.line(`tsgo.${fn}Rat(${v}, ${conv}, tsgo.RatBound(${goString(text)}), ${exclusive})`);
    return;
  }
  const num = t.num;
  if (!num) return;
  if (num.startsWith("float")) {
    const f = Number(text);
    if (Number.isFinite(f) && String(f) === normalizeNumberText(text)) {
      out.line(`tsgo.${fn}(${v}, float64(${val}), ${floatLiteral(f)}, ${exclusive})`);
    } else {
      out.line(`tsgo.${fn}Rat(${v}, new(big.Rat).SetFloat64(float64(${val})), tsgo.RatBound(${goString(text)}), ${exclusive})`);
    }
    return;
  }
  // Integer Go type: compare exactly, adjusting non-integer and out-of-range bounds.
  const [lo, hi] = INT_RANGES[num];
  let bound = ratOf(text);
  // x >= 1.5 ⇔ x >= 2 ; x > 1.5 ⇔ x >= 2 ; x <= 1.5 ⇔ x <= 1 ; x < 1.5 ⇔ x <= 1
  let inclusive = !exclusive;
  let intBound: bigint;
  if (bound.isInteger) {
    intBound = bound.num;
    if (!inclusive) {
      intBound = isMax ? intBound - 1n : intBound + 1n;
      inclusive = true;
    }
  } else {
    intBound = isMax ? floorDiv(bound.num, bound.den) : floorDiv(bound.num, bound.den) + 1n;
    inclusive = true;
  }
  if (!isMax && intBound <= lo) return; // every value satisfies it
  if (isMax && intBound >= hi) return;
  if ((!isMax && intBound > hi) || (isMax && intBound < lo)) {
    out.line(`tsgo.Unsatisfiable(${v}, ${goString(constraint)}, ${goString(text)})`);
    return;
  }
  out.line(`tsgo.${fn}(${v}, ${val}, ${num}(${intBound}), false)`);
  void inclusive;
}

const INT_RANGES: Record<string, [bigint, bigint]> = {
  int8: [-128n, 127n],
  int16: [-32768n, 32767n],
  int32: [-2147483648n, 2147483647n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint8: [0n, 255n],
  uint16: [0n, 65535n],
  uint32: [0n, 4294967295n],
  uint64: [0n, 2n ** 64n - 1n],
};

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function ratOf(text: string): { num: bigint; den: bigint; isInteger: boolean } {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) throw new Error(`invalid numeric ${text}`);
  const frac = m[3] ?? "";
  let num = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
  let den = 10n ** BigInt(frac.length);
  const exp = Number(m[4] ?? 0);
  if (exp > 0) num *= 10n ** BigInt(exp);
  else if (exp < 0) den *= 10n ** BigInt(-exp);
  const g = gcd(num < 0n ? -num : num, den);
  num /= g || 1n;
  den /= g || 1n;
  return { num, den, isInteger: den === 1n };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

function normalizeNumberText(t: string): string {
  return String(Number(t));
}

function floatLiteral(f: number): string {
  const s = String(f);
  return /[.eE]/.test(s) ? s : s + ".0";
}

/** gofmt writes `range *x`, not `range (*x)`. */
function rangeExpr(v: string): string {
  return /^\(\*[\w.]+\)$/.test(v) ? v.slice(1, -1) : v;
}

export function arrayType(elem: GoType): GoType {
  return {
    expr: `[]${elem.expr}`,
    codec: `tsgo.ArrayCodec(${elem.codec})`,
    rcodec: () => {
      const e = elem.rcodec?.();
      return e && `tsgo.ArrayCodec(${e})`;
    },
    kinds: ["tsgo.KindArray"],
    cat: "array",
    elem,
    validate: (val, v, out) => {
      if (!elem.hasValidation()) return;
      out.open(`for i, e := range ${rangeExpr(val)} {`);
      elem.validate("e", `${v}.At(i)`, out);
      out.close();
    },
    hasValidation: () => elem.hasValidation(),
    defaults: (lval, out) => {
      if (!elem.hasDefaults()) return;
      out.open(`for i := range ${rangeExpr(lval)} {`);
      elem.defaults(`${lval}[i]`, out);
      out.close();
    },
    hasDefaults: () => elem.hasDefaults(),
  };
}

export function mapType(elem: GoType, escaping = "tsgo.EscapeDefault"): GoType {
  const codec = (e: string) => (escaping === "tsgo.EscapeDefault" ? `tsgo.MapCodec(${e})` : `tsgo.MapCodecEscaping(${e}, ${escaping})`);
  return {
    expr: `map[string]${elem.expr}`,
    codec: codec(elem.codec),
    rcodec: () => {
      const e = elem.rcodec?.();
      return e && codec(e);
    },
    kinds: ["tsgo.KindObject"],
    cat: "map",
    elem,
    validate: (val, v, out) => {
      if (!elem.hasValidation()) return;
      out.open(`for k, e := range ${rangeExpr(val)} {`);
      elem.validate("e", `${v}.At(k)`, out);
      out.close();
    },
    hasValidation: () => elem.hasValidation(),
    defaults: (lval, out) => {
      if (!elem.hasDefaults()) return;
      out.open(`for k, e := range ${rangeExpr(lval)} {`);
      elem.defaults("e", out);
      out.line(`${lval}[k] = e`);
      out.close();
    },
    hasDefaults: () => elem.hasDefaults(),
  };
}

/** `Record<T>` as tsgo.OrderedMap[T] (option ordered-records): insertion order is kept. */
export function orderedMapType(elem: GoType, escaping = "tsgo.EscapeDefault"): GoType {
  return {
    expr: `tsgo.OrderedMap[${elem.expr}]`,
    codec: `tsgo.OrderedMapCodec(${elem.codec}, ${escaping})`,
    rcodec: () => {
      const e = elem.rcodec?.();
      return e && `tsgo.OrderedMapCodec(${e}, ${escaping})`;
    },
    kinds: ["tsgo.KindObject"],
    cat: "map",
    ordered: true,
    elem,
    validate: (val, v, out) => {
      if (!elem.hasValidation()) return;
      out.open(`for k, e := range ${val}.All() {`);
      elem.validate("e", `${v}.At(k)`, out);
      out.close();
    },
    hasValidation: () => elem.hasValidation(),
    defaults: (lval, out) => {
      if (!elem.hasDefaults()) return;
      out.open(`for k, e := range ${lval}.All() {`);
      elem.defaults("e", out);
      out.line(`${lval}.Set(k, e)`);
      out.close();
    },
    hasDefaults: () => elem.hasDefaults(),
  };
}

export function nullableType(inner: GoType): GoType {
  if (inner.cat === "nullable") return inner;
  return {
    expr: `tsgo.Nullable[${inner.expr}]`,
    codec: `tsgo.NullableCodec(${inner.codec})`,
    rcodec: () => {
      const e = inner.rcodec?.();
      return e && `tsgo.NullableCodec(${e})`;
    },
    kinds: inner.kinds ? [...inner.kinds, "tsgo.KindNull"] : undefined,
    cat: "nullable",
    elem: inner,
    validate: (val, v, out) => {
      if (!inner.hasValidation()) return;
      out.open(`if x, ok := ${val}.Get(); ok {`);
      inner.validate("x", v, out);
      out.close();
    },
    hasValidation: () => inner.hasValidation(),
    defaults: (lval, out) => {
      if (!inner.hasDefaults()) return;
      out.open(`if p := ${lval}.Ptr(); p != nil {`);
      inner.defaults("(*p)", out);
      out.close();
    },
    hasDefaults: () => inner.hasDefaults(),
  };
}

/** Declarations a value of the given types can contain (fields, variants, items, at any depth). */
export function reachableDecls(types: readonly GoType[]): Set<Decl> {
  const seen = new Set<Decl>();
  const visitType = (t: GoType | undefined): void => {
    if (!t) return;
    visitType(t.elem);
    if (t.decl && !seen.has(t.decl)) {
      const d = t.decl;
      seen.add(d);
      for (const f of d.fields ?? []) visitType(f.type);
      visitType(d.additional);
      for (const v of d.variants ?? []) visitType(v.type);
      visitType(d.fallback?.type);
      for (const item of d.tupleItems ?? []) visitType(item);
      visitType(d.arrayElem);
    }
  };
  for (const t of types) visitType(t);
  return seen;
}

export function mergeConstraints(a: Constraints, b: Constraints): Constraints {
  const maxN = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : Math.max(x, y));
  const minN = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const maxNum = (x?: Numeric, y?: Numeric) => (x === undefined ? y : y === undefined ? x : x.gt(y) ? x : y);
  const minNum = (x?: Numeric, y?: Numeric) => (x === undefined ? y : y === undefined ? x : x.lt(y) ? x : y);
  return {
    minLength: maxN(a.minLength, b.minLength),
    maxLength: minN(a.maxLength, b.maxLength),
    minItems: maxN(a.minItems, b.minItems),
    maxItems: minN(a.maxItems, b.maxItems),
    patterns: [...new Set([...(a.patterns ?? []), ...(b.patterns ?? [])])],
    min: maxNum(a.min, b.min),
    minExclusive: maxNum(a.minExclusive, b.minExclusive),
    max: minNum(a.max, b.max),
    maxExclusive: minNum(a.maxExclusive, b.maxExclusive),
  };
}

export function hasConstraints(c: Constraints): boolean {
  return c.patterns.length > 0 || Object.entries(c).some(([k, x]) => k !== "patterns" && x !== undefined);
}

function isSingleLiteral(t: Type): boolean {
  return t.kind === "String" || t.kind === "Number" || t.kind === "Boolean" || t.kind === "EnumMember";
}

function literalIdent(v: string | number | bigint | boolean): string {
  if (typeof v === "string") return exportedName(v) || "Empty";
  if (typeof v === "boolean") return v ? "True" : "False";
  return "N" + String(v).replace("-", "Minus").replace(".", "Point");
}

const INT64_MIN = "-9223372036854775808";
const INT64_MAX = "9223372036854775807";

function fitsInt64(n: Numeric): boolean {
  const i = n.asBigInt();
  return i !== null && i >= BigInt(INT64_MIN) && i <= BigInt(INT64_MAX);
}

/** Every scalar a number of type t can be stored as is `integer`-based (`null` aside). */
function onlyInteger(t: Type): boolean {
  if (t.kind === "Scalar") return stdScalarOf(t)?.name === "integer";
  if (t.kind !== "Union") return false;
  const numeric = [...t.variants.values()].map((v) => v.type).filter((x) => x.kind === "Scalar" || x.kind === "Union");
  return numeric.length > 0 && numeric.every(onlyInteger);
}

/** The standard (TypeSpec namespace) scalar a scalar derives from. */
function stdScalarOf(s: Scalar): Scalar | undefined {
  let x: Scalar | undefined = s;
  while (x && !(x.namespace && getNamespaceFullName(x.namespace) === "TypeSpec")) x = x.baseScalar;
  return x;
}

export function safeName(t: Type): string {
  try {
    return getTypeName(t);
  } catch {
    return t.kind;
  }
}

export type { EnumMember };
export { goRawString, docComment };

/**
 * A genuine map type (`Record<T>`), represented as a Go map. Named models with an indexer
 * (`model M { ...Record<T> }`, `model M is Record<T>`, closed models) are structs.
 */
export function isMapType(m: Model): boolean {
  return isRecordModelType(m) && m.properties.size === 0 && !m.baseModel && (!m.name || (m.name === "Record" && !!m.namespace && isStdNamespace(m.namespace)));
}

/**
 * The value type of the nearest string-keyed indexer in the inheritance chain: the type of
 * undeclared properties (`never` for a closed model declared with `...Record<never>`).
 */
export function nearestIndexer(m: Model): Type | undefined {
  for (let b: Model | undefined = m; b; b = b.baseModel) {
    if (b.indexer && !isArrayModelType(b)) return b.indexer.value;
  }
  return undefined;
}

/** A model closed by `...Record<never>` (directly or through its base). */
export function isClosedModel(m: Model): boolean {
  const extras = nearestIndexer(m);
  return !!extras && isNeverType(extras);
}
