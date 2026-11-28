/**
 * Generates, directly from the TypeSpec semantic model, the JSON Schema that Pydantic v2
 * (`BaseModel.model_json_schema()`, validation mode) produces for the equivalent Pydantic
 * declaration defined by the compatibility profile (see docs/pydantic-compatibility-profile.md).
 *
 * The generator mirrors the relevant `GenerateJsonSchema` methods (model_schema, literal_schema,
 * enum_schema, nullable_schema, union_schema, default_schema, field title handling, ...). Every
 * TypeSpec construct either has an explicit mapping here or produces a diagnostic.
 */
import {
  type DecoratorApplication,
  type Diagnostic,
  type Entity,
  type Enum,
  type EnumMember,
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Tuple,
  type Type,
  type Union,
  type Value,
  getDiscriminatedUnion,
  getDiscriminatedUnionFromInheritance,
  getProperty,
  getDoc,
  getEncode,
  getFormat,
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
  getSummary,
  getTypeName,
  isArrayModelType,
  isNeverType,
  isNullType,
  isRecordModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  resolveEncodedName,
  getLifecycleVisibilityEnum, hasVisibility, getDiscriminator,
  type Numeric,
} from "@typespec/compiler";
import { defaultJSON, enumWireValue } from "../values.js";
import { createDiagnostic } from "../lib.js";
import { getSchemaName, isDefaultFactory } from "../decorators.js";
import { exactInteger, hashableKey as hashKey, orderedObject, parseJson, isObject, pyEquals, type Json, type JsonObject } from "../json.js";
import { DefinitionRegistry, jsonRef, titleFromName } from "./defs.js";
import { checkDecorators } from "./decorators-allowlist.js";

export interface GeneratorOptions {
  scalarEncodings?: "pydantic" | "wire";
  mixedEnums?: "pydantic" | "typed-union";
  optionalProperties: "error" | "nullable";
  /** Whether non-null defaults are kept, dropped, or rejected (rejection decided by caller). */
  defaultValues: "error" | "emit" | "omit";
  /** Profile name used in diagnostics for rejected defaults. */
  profileName: string;
  rejectDefaults: boolean;
  visibility?: "Read" | "Create" | "Update" | "Delete" | "Query";
  projected?: boolean;
}

/** Schema node → TypeSpec type that produced it, used to locate profile diagnostics. */
export type Origins = WeakMap<object, Type>;

class Fail extends Error {}

export class PydanticSchemaGenerator {
  private readonly recursiveAliases = new WeakMap<Union | Model, boolean>();
  private readonly ids = new Map<object, number>();
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly program: Program,
    private readonly options: GeneratorOptions,
    readonly origins: Origins,
  ) {}

  /** `model_json_schema()` for a root model. Returns undefined when diagnostics were reported. */
  generate(root: Model): JsonObject | undefined {
    const ctx = new RootContext(new DefinitionRegistry());
    const before = this.diagnostics.length;
    let schema: JsonObject;
    try {
      schema = this.modelRef(root, ctx);
    } catch (e) {
      if (e instanceof Fail) return undefined;
      throw e;
    }
    if (this.diagnostics.some((d, i) => i >= before && d.severity === "error")) return undefined;
    return ctx.registry.finalize(schema, this.origins);
  }

  /** Python class name of a model/enum per the profile (`Page[Item]` for template instances). */
  pythonClassName(type: Model | Enum): string {
    // @schemaName (Structured Output only) names the class, ahead of the TypeSpec-wide @friendlyName.
    const explicit = getSchemaName(this.program, type);
    const friendly = getFriendlyName(this.program, type);
    if (type.kind === "Model" && isTemplateInstance(type) && (explicit || !friendly)) {
      const args = type.templateMapper!.args.map((a) => this.pythonDisplayName(a, type));
      return `${explicit ?? type.name}[${args.join(", ")}]`;
    }
    return explicit ?? friendly ?? type.name;
  }

  // ---------------------------------------------------------------- errors

  private report(code: Parameters<typeof createDiagnostic>[0]["code"], target: Type, format: Record<string, string>): never {
    this.diagnostics.push(createDiagnostic({ code, target, format } as any));
    throw new Fail();
  }

  private reportSoft(code: Parameters<typeof createDiagnostic>[0]["code"], target: Type, format: Record<string, string>): void {
    this.diagnostics.push(createDiagnostic({ code, target, format } as any));
  }

  private unsupported(type: Type, reason: string): never {
    this.report("unsupported-type", type, { type: safeTypeName(type), reason });
  }

  private checkDecorators(type: Type & { decorators?: DecoratorApplication[] }): void {
    for (const bad of checkDecorators(type)) {
      if (this.options.projected && bad.startsWith("TypeSpec.Versioning.@")) continue;
      this.reportSoft("unsupported-decorator", type, { decorator: bad });
    }
  }

  // ---------------------------------------------------------------- core refs

  private idOf(t: object): number {
    let id = this.ids.get(t);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(t, id);
    }
    return id;
  }

  private moduleOf(type: Model | Enum | Union): string {
    const ns = type.namespace ? getNamespaceFullName(type.namespace) : "";
    return ns === "" ? "__main__" : ns;
  }

  /** Pydantic `get_type_ref` equivalent. */
  private coreRef(type: Model | Enum): string {
    const explicit = getSchemaName(this.program, type);
    const friendly = getFriendlyName(this.program, type);
    if (type.kind === "Model" && isTemplateInstance(type) && (explicit || !friendly)) {
      // All instances of one template share the declaration node, i.e. Pydantic's generic origin class.
      const origin = (type.node ?? type) as object;
      const args = type.templateMapper!.args.map((a) => `${this.pythonDisplayName(a, type)}:${this.idOf(a as Type)}`);
      return `${this.moduleOf(type)}.${explicit ?? type.name}:${this.idOf(origin)}[${args.join(",")}]`;
    }
    return `${this.moduleOf(type)}.${explicit ?? friendly ?? type.name}:${this.idOf(type)}`;
  }

  /** `_repr.display_as_type` for the argument kinds the profile supports. */
  private pythonDisplayName(arg: Entity, instance: Model): string {
    if (arg.entityKind === "Indeterminate") return this.pythonDisplayName(arg.type, instance);
    if (arg.entityKind !== "Type") {
      this.report("template-argument", instance, { name: getTypeName(instance), reason: "a value argument needs an explicit @friendlyName" });
    }
    switch (arg.kind) {
      case "Model":
        if ((isArrayModelType(arg) || isMapModel(arg)) && this.isRecursiveAlias(arg)) return this.pythonClassName(arg);
        if (isArrayModelType(arg)) return `list[${this.pythonDisplayName(arg.indexer!.value, instance)}]`;
        if (isEmptyRecord(arg)) return "EmptyRecord";
        if (isMapModel(arg)) return `dict[str, ${this.pythonDisplayName(arg.indexer!.value, instance)}]`;
        if (!arg.name) break;
        return this.pythonClassName(arg);
      case "Enum":
        return this.pythonClassName(arg);
      case "Tuple":
        return `tuple[${arg.values.map(t => this.pythonDisplayName(t, instance)).join(", ")}]`;
      case "Intrinsic":
        if (arg.name === "null") return "NoneType";
        if (arg.name === "unknown") return "Any";
        break;
      case "Union":
        if (this.isRecursiveAlias(arg)) return arg.name!;
        return `Union[${[...arg.variants.values()].map(v => this.pythonDisplayName(v.type, instance)).join(", ")}]`;
      case "String":
        return `Literal[${pythonStringRepr(arg.value)}]`;
      case "Number":
        return `Literal[${arg.numericValue.toString()}]`;
      case "Boolean":
        return `Literal[${arg.value ? "True" : "False"}]`;
      case "Scalar": {
        const py: Record<string, string> = { string: "str", boolean: "bool", integer: "int", float: "float", float32: "float", float64: "float", utcDateTime: "datetime", offsetDateTime: "datetime", plainDate: "date", plainTime: "time", duration: "timedelta" };
        const bounds = INTEGER_RANGES[arg.name];
        if (bounds && arg.namespace && getNamespaceFullName(arg.namespace) === "TypeSpec") {
          return `Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=${bounds[0]}), Le(le=${bounds[1]})])]`;
        }
        if (arg.namespace && getNamespaceFullName(arg.namespace) === "TypeSpec" && py[arg.name]) return py[arg.name];
        break;
      }
    }
    this.report("template-argument", instance, {
      name: getTypeName(instance),
      reason: `argument '${safeTypeName(arg)}' has no Python type spelling in this profile; provide @friendlyName for this specialization`,
    });
  }

  // ---------------------------------------------------------------- types

  /** Schema for a type in a field / item position (no field-level metadata). */
  typeSchema(type: Type, ctx: RootContext, constraints?: Constraints): JsonObject {
    const s = this.typeSchemaInner(type, ctx, constraints);
    if (!this.origins.has(s)) this.origins.set(s, type);
    return s;
  }

  private typeSchemaInner(type: Type, ctx: RootContext, constraints?: Constraints): JsonObject {
    switch (type.kind) {
      case "Model":
        if (isArrayModelType(type) || isMapModel(type)) {
          return this.collectionSchema(type, ctx, constraints);
        }
        this.noConstraints(constraints, type);
        return this.modelRef(type, ctx);
      case "Scalar":
        return this.scalarSchema(type, constraints);
      case "Enum":
        this.noConstraints(constraints, type);
        return this.enumRef(type, ctx);
      case "EnumMember":
      case "String":
      case "Number":
      case "Boolean":
        this.noConstraints(constraints, type);
        return literalSchema([this.literalValue(type)]);
      case "Union":
        if (this.isRecursiveAlias(type)) {
          this.noConstraints(constraints, type);
          const ref = ctx.registry.defsRefFor(`${this.moduleOf(type)}.${type.name}:${this.idOf(type)}`);
          if (!ctx.inProgress.has(ref)) {
            ctx.inProgress.add(ref);
            ctx.registry.definitions.set(ref, this.unionSchema(type, [...type.variants.values()].map(v => v.type), ctx));
          }
          return { $ref: jsonRef(ref) };
        }
        return this.unionSchema(type, [...type.variants.values()].map((v) => v.type), ctx, constraints);
      case "Tuple":
        this.noConstraints(constraints, type);
        return this.tupleSchema(type, ctx);
      case "Intrinsic":
        if (type.name === "null") return { type: "null" };
        if (type.name === "unknown") return {};
        return this.unsupported(type, `intrinsic '${type.name}' has no value representation`);
      case "StringTemplate":
        if (type.stringValue !== undefined) return literalSchema([type.stringValue]);
        return this.unsupported(type, "string templates must be serializable to a literal");
      case "UnionVariant":
        return this.typeSchema(type.type, ctx, constraints);
      default:
        return this.unsupported(type, `type kind '${type.kind}' is not a data type`);
    }
  }

  private noConstraints(c: Constraints | undefined, type: Type): void {
    if (c && Object.values(c).some((v) => v !== undefined)) {
      this.unsupported(type, "constraints declared on this property do not apply to its type");
    }
  }

  private literalValue(type: Type): string | number | bigint | boolean {
    switch (type.kind) {
      case "String":
        return type.value;
      case "Boolean":
        return type.value;
      case "Number":
        return this.exactNumber(type.numericValue, type);
      case "EnumMember":
        return this.enumValue(type);
      default:
        return this.unsupported(type, "not a literal");
    }
  }

  private exactNumber(n: Numeric, site: Type): number | bigint {
    if (n.isInteger) return exactInteger(n.asBigInt()!);
    const v = n.asNumber();
    return v ?? this.unsupported(site, `numeric value ${n} exceeds the profile's binary64 precision`);
  }

  private enumValue(member: EnumMember): string | number | bigint {
    const wire = enumWireValue(this.program, member);
    return typeof wire === "string" ? wire : this.exactNumber(wire, member);
  }

  private collectionSchema(type: Model, ctx: RootContext, constraints?: Constraints): JsonObject {
    this.checkDecorators(type);
    const array = isArrayModelType(type);
    const bounds = this.constraintsOf(type);
    const body = (field?: Constraints): JsonObject => {
      const item = this.typeSchema(type.indexer!.value, ctx);
      if (!array) {
        this.noConstraints(field, type);
        return { additionalProperties: item, type: "object" };
      }
      const schema: JsonObject = { items: item, type: "array" };
      applyConstraints(schema, mergeConstraints(field, bounds), "array", this, type);
      return schema;
    };
    if (!this.isRecursiveAlias(type)) return body(constraints);

    // Pydantic names a recursive list or dict with TypeAliasType. Register it before visiting
    // the items, including when another collection or union leads back to this declaration.
    const core = this.coreRef(type);
    const define = (key: string, field?: Constraints): JsonObject => {
      const ref = ctx.registry.defsRefFor(key);
      if (!ctx.inProgress.has(ref)) {
        ctx.inProgress.add(ref);
        ctx.registry.definitions.set(ref, body(field));
      }
      return { $ref: jsonRef(ref) };
    };
    const base = define(core);
    if (!constraints || !Object.values(constraints).some(v => v !== undefined)) return base;
    if (!array) this.noConstraints(constraints, type);
    // Field bounds specialize the outer collection. Its recursive elements retain the base bounds.
    return define(`${core}_${constraints.minItems ?? ""}_${constraints.maxItems ?? ""}`, constraints);
  }

  private tupleSchema(type: Tuple, ctx: RootContext): JsonObject {
    const items = type.values.map((v) => this.typeSchema(v, ctx));
    return { maxItems: items.length, minItems: items.length, prefixItems: items, type: "array" };
  }

  // ---------------------------------------------------------------- unions

  // Named unions and collections that can reach themselves without crossing an object need
  // a Python TypeAliasType definition. Built-in list and dict instances stay inline.
  private isRecursiveAlias(alias: Union | Model): boolean {
    if (!alias.name || (alias.kind === "Model" && this.program.checker.isStdType(alias))) return false;
    const cached = this.recursiveAliases.get(alias);
    if (cached !== undefined) return cached;
    const seen = new Set<Type>();
    const reaches = (t: Type): boolean => {
      if (t === alias) return true;
      if (seen.has(t)) return false;
      seen.add(t);
      if (t.kind === "Union") return [...t.variants.values()].some(v => reaches(v.type));
      if (t.kind === "Tuple") return t.values.some(reaches);
      if (t.kind === "Model" && (isArrayModelType(t) || isMapModel(t))) return reaches(t.indexer!.value);
      return false;
    };
    const recursive = alias.kind === "Union"
      ? [...alias.variants.values()].some(v => reaches(v.type))
      : reaches(alias.indexer!.value);
    this.recursiveAliases.set(alias, recursive);
    return recursive;
  }

  private flattenUnion(types: Type[], out: Type[] = []): Type[] {
    for (const t of types) {
      if (t.kind === "Union" && !this.isRecursiveAlias(t) && !getDiscriminatedUnion(this.program, t)[0]) {
        this.checkUnion(t);
        this.flattenUnion([...t.variants.values()].map((v) => v.type), out);
      } else {
        out.push(t);
      }
    }
    return out;
  }

  private literalTag(type: Type): string | undefined {
    const tag = type.kind === "EnumMember" ? this.enumValue(type) : type.kind === "String" ? type.value : undefined;
    return typeof tag === "string" ? tag : undefined;
  }

  private checkUnion(u: Union): void {
    this.checkDecorators(u);
    for (const v of u.variants.values()) this.checkDecorators(v);
    if (u.name && getDoc(this.program, u)) {
      this.reportSoft("metadata-lost", u, { what: "Documentation of a union", name: u.name });
    }
  }

  private unionSchema(self: Union | undefined, variants: Type[], ctx: RootContext, constraints?: Constraints): JsonObject {
    if (self) {
      this.checkUnion(self);
      const [disc] = getDiscriminatedUnion(this.program, self);
      if (disc) {
        this.noConstraints(constraints, self);
        const branches: JsonObject[] = [];
        for (const [tag, variant] of disc.variants) {
          const { discriminatorPropertyName: key, envelopePropertyName: field, envelope } = disc.options;
          const hasTag = variant.kind === "Model" && this.collectProperties(variant).some(p =>
            resolveEncodedName(this.program, p, "application/json") === key && !p.optional && this.literalTag(p.type) === tag);
          if (envelope === "none" && hasTag) {
            branches.push(this.typeSchema(variant, ctx));
            continue;
          }
          const name = `${self.name ?? "Union"}_${tag}`;
          const ref = ctx.registry.defsRefFor(`${this.moduleOf(self)}.${name}:${this.idOf(self)}_${tag}`);
          if (!ctx.inProgress.has(ref)) {
            ctx.inProgress.add(ref);
            const properties = orderedObject();
            properties[key] = { const: tag, title: titleFromName(key), type: "string" };
            let required = [key];
            if (envelope === "object") {
              if (key === field) this.unsupported(self, "envelope and discriminator property names must differ");
              const payload = this.typeSchema(variant, ctx);
              if (this.fieldTitleShouldBeSet(variant)) payload.title = titleFromName(field);
              properties[field] = payload;
              required.push(field);
            } else {
              if (variant.kind !== "Model") this.unsupported(variant, "inline discriminator requires an object");
              const body = this.modelBody(variant, ctx);
              for (const [k,v] of Object.entries(body.properties as JsonObject)) if (k !== key) properties[k] = v;
              required = required.concat((body.required as string[] ?? []).filter(k => k !== key));
              ctx.registry.definitions.set(ref, { ...body, title: name, properties, required });
            }
            if (!ctx.registry.definitions.has(ref)) ctx.registry.definitions.set(ref, { type: "object", title: name, properties, required });
          }
          branches.push({ $ref: jsonRef(ref) });
        }
        if (disc.defaultVariant) {
          const fallback = disc.defaultVariant;
          const key = disc.options.discriminatorPropertyName;
          if (disc.options.envelope !== "none" || fallback.kind !== "Model") this.unsupported(self, "a fallback needs an inline object with a string discriminator");
          branches.push(this.fallbackRef(self, fallback, key, [...disc.variants.keys()], ctx));
        }
        return getUnionOfSchemas(branches);
      }
    }
    const flat = this.flattenUnion(variants).filter(t => !isNeverType(t));
    if (!flat.length) this.unsupported(self ?? variants[0], "a union without inhabitable variants has no value");
    const nonNull = flat.filter((t) => !isNullType(t));
    const hasNull = nonNull.length !== flat.length;
    if (nonNull.length === 0) return { type: "null" };

    let inner: JsonObject;
    const isLiteral = (t: Type) => t.kind === "String" || t.kind === "Number" || t.kind === "Boolean" || t.kind === "EnumMember";
    if (nonNull.length > 1 && constraints && Object.values(constraints).some((v) => v !== undefined)) {
      this.unsupported(self ?? nonNull[0], "constraints on a property whose type is a union of several types are ambiguous");
    }
    if (nonNull.every(isLiteral)) {
      inner = literalSchema(dedupeLiterals(nonNull.map((t) => this.literalValue(t))), this.options.mixedEnums);
      this.origins.set(inner, self ?? nonNull[0]);
    } else {
      // Literal variants are grouped into one `Literal[...]` at the position of the first literal.
      const members: (JsonObject | "literal")[] = [];
      const literals: (string | number | bigint | boolean)[] = [];
      for (const t of nonNull) {
        if (isLiteral(t)) {
          if (literals.length === 0) members.push("literal");
          literals.push(this.literalValue(t));
        } else {
          members.push(this.typeSchema(t, ctx, nonNull.length === 1 ? constraints : undefined));
        }
      }
      const schemas = members.map((m) => (m === "literal" ? literalSchema(dedupeLiterals(literals), this.options.mixedEnums) : m));
      inner = schemas.length === 1 ? schemas[0] : getUnionOfSchemas(schemas);
    }
    if (!hasNull) return inner;
    if (pyEquals(inner, { type: "null" })) return { type: "null" };
    const result = getUnionOfSchemas([inner, { type: "null" }]);
    if (self) this.origins.set(result, self);
    return result;
  }

  // ---------------------------------------------------------------- scalars

  private scalarSchema(scalar: Scalar, propConstraints?: Constraints): JsonObject {
    const chain: Scalar[] = [];
    for (let s: Scalar | undefined = scalar; s; s = s.baseScalar) {
      this.checkDecorators(s);
      chain.push(s);
    }
    // The nearest standard-library scalar determines the representation (float64 → float → numeric).
    const std = chain.find((s) => s.namespace && getNamespaceFullName(s.namespace) === "TypeSpec");
    if (!std) {
      return this.unsupported(scalar, "custom scalars must extend a TypeSpec standard scalar");
    }
    let constraints = propConstraints ? { ...propConstraints } : {};
    for (const s of chain) constraints = mergeConstraints(constraints, this.constraintsOf(s));

    const encoding = constraints.encoding;
    const base = std.name;
    let schema: JsonObject;
    let kind: "string" | "number" | "integer" | "other";
    if (this.options.scalarEncodings === "wire") {
      if (base === "bytes" && (!encoding || ["base64", "base64url"].includes(encoding))) {
        if (constraints.minLength !== undefined || constraints.maxLength !== undefined) this.unsupported(scalar, "byte lengths and encoded string lengths use different units");
        const url = encoding === "base64url";
        const alphabet = url ? "[A-Za-z0-9_-]" : "[A-Za-z0-9+/]";
        const pattern = `^(?:${alphabet}{4})*(?:${alphabet}[AQgw]${url ? "" : "=="}|${alphabet}{2}[AEIMQUYcgkosw048]${url ? "" : "="})?$`;
        if (constraints.pattern || constraints.format) this.unsupported(scalar, "base64 cannot replace an explicit text constraint");
        schema = { type: "string", pattern };
        applyConstraints(schema, constraints, "other", this, scalar);
        return schema;
      }
      if (base === "boolean" && encoding === "as-string") return literalSchema(["true", "false"]);
      if (["numeric", "decimal"].includes(base) && !encoding) {
        schema = { type: "number" };
        applyConstraints(schema, constraints, "number", this, scalar);
        return schema;
      }
    }
    switch (base) {
      case "string":
        schema = { type: "string" };
        kind = "string";
        break;
      case "boolean":
        schema = { type: "boolean" };
        kind = "other";
        break;
      case "integer":
        schema = { type: "integer" };
        kind = "integer";
        break;
      case "int8":
      case "int16":
      case "int32":
      case "int64":
      case "uint8":
      case "uint16":
      case "uint32":
      case "uint64":
      case "safeint": {
        schema = { type: "integer" };
        kind = "integer";
        const [lo, hi] = INTEGER_RANGES[base];
        constraints = mergeConstraints(constraints, { implied: { ge: lo, le: hi } });
        break;
      }
      case "float":
      case "float32":
      case "float64":
        schema = { type: "number" };
        kind = "number";
        break;
      case "utcDateTime":
      case "offsetDateTime":
        this.requireEncoding(scalar, encoding, ["rfc3339"], "an RFC 3339 string");
        schema = { format: "date-time", type: "string" };
        kind = "other";
        break;
      case "plainDate":
        schema = { format: "date", type: "string" };
        kind = "other";
        break;
      case "plainTime":
        schema = { format: "time", type: "string" };
        kind = "other";
        break;
      case "duration":
        this.requireEncoding(scalar, encoding, ["ISO8601"], "an ISO 8601 duration string");
        schema = { format: "duration", type: "string" };
        kind = "other";
        break;
      case "url":
        schema = { format: "uri", minLength: 1, type: "string" }; // pydantic.AnyUrl
        kind = "other";
        break;
      case "numeric":
      case "decimal":
      case "decimal128":
        return this.unsupported(
          scalar,
          "Pydantic's Decimal schema ('number' or any 'string') accepts strings that are not decimals; use float64 or a string scalar with @pattern",
        );
      case "bytes":
        return this.unsupported(scalar, "Pydantic serializes bytes as UTF-8 text by default, which differs from TypeSpec's base64 encoding");
      default:
        return this.unsupported(scalar, `standard scalar '${base}' has no Pydantic mapping`);
    }
    if (encoding && !["utcDateTime", "offsetDateTime", "duration"].includes(base)) {
      this.report("unsupported-encoding", scalar, { encoding, type: scalar.name, pydantic: "its default JSON form" });
    }
    applyConstraints(schema, constraints, kind, this, scalar);
    return schema;
  }

  private requireEncoding(scalar: Scalar, encoding: string | undefined, allowed: string[], pydantic: string) {
    if (encoding && !allowed.includes(encoding)) {
      this.report("unsupported-encoding", scalar, { encoding, type: scalar.name, pydantic });
    }
  }

  constraintsOf(t: Scalar | ModelProperty | Model): Constraints {
    const p = this.program;
    const num = (n: Numeric | undefined) => (n === undefined ? undefined : this.exactNumber(n, t));
    const enc = t.kind === "Model" ? undefined : getEncode(p, t);
    return {
      minLength: getMinLength(p, t),
      maxLength: getMaxLength(p, t),
      pattern: getPattern(p, t),
      format: getFormat(p, t),
      ge: num(getMinValueAsNumeric(p, t)),
      le: num(getMaxValueAsNumeric(p, t)),
      gt: num(getMinValueExclusiveAsNumeric(p, t)),
      lt: num(getMaxValueExclusiveAsNumeric(p, t)),
      minItems: getMinItems(p, t),
      maxItems: getMaxItems(p, t),
      encoding: enc && (enc.encoding ?? `as-${enc.type.name}`),
      description: t.kind === "Scalar" ? getDoc(p, t) : undefined,
    };
  }

  // ---------------------------------------------------------------- enums

  private enumRef(e: Enum, ctx: RootContext): JsonObject {
    const coreRef = this.coreRef(e);
    const defsRef = ctx.registry.defsRefFor(coreRef);
    if (!ctx.registry.definitions.has(defsRef)) {
      this.checkDecorators(e);
      const values: (string | number | bigint)[] = [];
      for (const m of e.members.values()) {
        this.checkDecorators(m);
        values.push(this.enumValue(m));
      }
      const def: JsonObject = { title: this.pythonClassName(e) };
      const doc = getDoc(this.program, e);
      if (doc) def.description = cleandoc(doc);
      const t = literalType(values);
      if (!t && values.length && this.options.mixedEnums === "typed-union") {
        Object.assign(def, literalSchema(values, "typed-union"));
      } else {
        def.enum = values;
        if (t) def.type = t;
      }
      this.origins.set(def, e);
      ctx.registry.definitions.set(defsRef, def);
    }
    const ref = { $ref: jsonRef(defsRef) };
    this.origins.set(ref, e);
    return ref;
  }

  // ---------------------------------------------------------------- models

  private fallbackRef(owner: Model | Union, model: Model, key: string, tags: string[], ctx: RootContext): JsonObject {
    const name = (owner.name ?? "Union") + "_Fallback";
    const ref = ctx.registry.defsRefFor(`${this.moduleOf(owner)}.${name}:${this.idOf(owner)}_fallback`);
    if (!ctx.inProgress.has(ref)) {
      ctx.inProgress.add(ref);
      const def = this.modelBody(model, ctx);
      const properties = def.properties as JsonObject;
      if (owner.kind === "Model" && !Object.hasOwn(properties, key) && !getProperty(owner, key)) {
        properties[key] = { type: "string", title: titleFromName(key) };
        def.required = [...(def.required as string[] ?? []), key];
      }
      const tag = properties[key];
      if (!isObject(tag) || tag.type !== "string" || tag.pattern !== undefined || !Array.isArray(def.required) || !def.required.includes(key)) {
        this.unsupported(owner, "the fallback needs a required string discriminator without a conflicting pattern");
      }
      tag.pattern = excludingTags(tags);
      def.title = name;
      ctx.registry.definitions.set(ref, def);
    }
    return { $ref: jsonRef(ref) };
  }

  modelRef(model: Model, ctx: RootContext): JsonObject {
    if (isTemplateDeclaration(model)) this.unsupported(model, "template declarations cannot be emitted; instantiate the template");
    if (isEmptyRecord(model)) {
      const ref = ctx.registry.defsRefFor("TypeSpec.EmptyRecord:record-never");
      ctx.registry.definitions.set(ref, { additionalProperties: false, properties: {}, title: "EmptyRecord", type: "object" });
      return { $ref: jsonRef(ref) };
    }
    const coreRef = this.coreRef(model);
    const defsRef = ctx.registry.defsRefFor(coreRef);
    if (!ctx.inProgress.has(defsRef) && !ctx.registry.definitions.has(defsRef)) {
      ctx.inProgress.add(defsRef);
      const disc = getDiscriminator(this.program, model);
      if (disc && model.derivedModels.length) {
        const [info, diagnostics] = getDiscriminatedUnionFromInheritance(this.program, model, disc);
        this.diagnostics.push(...diagnostics);
        const prop = getProperty(model, disc.propertyName);
        const key = prop ? resolveEncodedName(this.program, prop, "application/json") : disc.propertyName;
        const variants = [...info.variants.values()].map(m => this.modelRef(m, ctx));
        variants.push(this.fallbackRef(model, model, key, [...info.variants.keys()], ctx));
        ctx.registry.definitions.set(defsRef, getUnionOfSchemas(variants));
      } else {
        ctx.registry.definitions.set(defsRef, this.modelBody(model, ctx));
      }
    }
    const ref = { $ref: jsonRef(defsRef) };
    this.origins.set(ref, model);
    return ref;
  }

  private modelBody(model: Model, ctx: RootContext): JsonObject {
    this.checkDecorators(model);
    const props = this.collectProperties(model);
    const properties = orderedObject();
    const required: string[] = [];
    for (const prop of props) {
      const name = resolveEncodedName(this.program, prop, "application/json");
      if (this.options.visibility && !hasVisibility(this.program, prop, getLifecycleVisibilityEnum(this.program).members.get(this.options.visibility)!)) continue;
      const field = this.fieldSchema(prop, ctx);
      if (field === undefined) continue;
      if (Object.hasOwn(properties, name)) this.unsupported(prop, `duplicate JSON wire name ${name}`);
      properties[name] = field.schema;
      if (field.required) required.push(name);
    }
    const body: JsonObject = { type: "object", properties };
    if (required.length) body.required = required;

    // The nearest indexer in the inheritance chain decides, as Pydantic's inherited model_config does:
    // `...Record<T>` is extra="allow" with typed extras, `...Record<never>` is extra="forbid", which
    // Pydantic emits as `additionalProperties: false` in the model's own schema (sorted with the
    // other keywords, so it precedes `properties`). The SDK strict transformation keeps it in place.
    const extras = additionalPropertiesOf(model);
    if (extras) body.additionalProperties = isNeverType(extras) ? false : this.typeSchema(extras, ctx);

    const summary = getSummary(this.program, model);
    body.title = summary ?? this.pythonClassName(model);
    const doc = getDoc(this.program, model);
    if (doc) body.description = cleandoc(doc);
    this.origins.set(body, model);
    return body;
  }

  private collectProperties(model: Model): ModelProperty[] {
    // Pydantic subclasses list inherited fields first, in base-to-derived order.
    const chain: Model[] = [];
    for (let m: Model | undefined = model; m; m = m.baseModel) chain.unshift(m);
    const byName = new Map<string, ModelProperty>();
    for (const m of chain) {
      for (const p of m.properties.values()) byName.set(p.name, p);
    }
    return [...byName.values()];
  }

  private fieldSchema(prop: ModelProperty, ctx: RootContext): { schema: JsonObject; required: boolean } | undefined {
    this.checkDecorators(prop);
    if (!this.options.visibility && prop.decorators.some((d) => d.definition?.name === "@visibility" || d.definition?.name === "@invisible")) {
      this.reportSoft("visibility-ignored", prop, { name: prop.name });
    }
    const propConstraints = this.constraintsOf(prop);
    const { description: _ignored, ...constraints } = propConstraints;
    let type: Type = prop.type;
    const nullable = isNullable(type);
    let schema: JsonObject;
    let required = !prop.optional;
    let defaultValue: Json | undefined;

    if (prop.defaultValue) {
      if (!prop.optional) {
        this.report("unsupported-default", prop, {
          name: prop.name,
          reason: "a required property with a default value has no Pydantic equivalent (Pydantic fields with defaults are not required); declare it optional",
        });
      }
      defaultValue = this.serializeDefault(prop, prop.defaultValue);
    } else if (prop.optional) {
      if (nullable) {
        defaultValue = null;
      } else if (this.options.optionalProperties === "nullable") {
        defaultValue = null;
      } else {
        this.report("optional-property", prop, { name: prop.name });
      }
    }

    if (prop.optional && !prop.defaultValue && !nullable && this.options.optionalProperties === "nullable") {
      // `a?: T` → `a: T | None = None`
      const innerType = type;
      const inner = this.typeSchema(innerType, ctx, constraints);
      schema = getUnionOfSchemas([inner, { type: "null" }]);
      this.origins.set(schema, prop);
    } else {
      schema = { ...this.typeSchema(type, ctx, constraints) };
      this.origins.set(schema, prop);
    }

    // Field-level metadata (`Field(description=..., title=..., default=...)`).
    const doc = getDoc(this.program, prop);
    const scalarDoc = scalarDocOf(this.program, prop.type);
    const description = doc ?? scalarDoc;
    if (description) schema.description = cleandoc(description);
    const summary = getSummary(this.program, prop);
    if (summary) schema.title = summary;
    if (defaultValue !== undefined) {
      if (defaultValue !== null && this.options.rejectDefaults && this.options.defaultValues !== "omit") {
        this.report("default-value", prop, { name: prop.name, profile: this.options.profileName });
      }
      // @defaultFactory: Pydantic writes no `default` for a default_factory; the field stays optional.
      if ((defaultValue === null || this.options.defaultValues !== "omit") && !isDefaultFactory(this.program, prop)) schema.default = defaultValue;
      required = false;
    }
    if (!("title" in schema) && this.fieldTitleShouldBeSet(prop.type)) {
      schema.title = titleFromName(resolveEncodedName(this.program, prop, "application/json"));
    }
    schema = this.handleRefOverrides(schema, ctx);
    this.origins.set(schema, prop);
    return { schema, required };
  }

  /** `field_title_should_be_set`: false for models/enums (refs) possibly wrapped in nullable. */
  private fieldTitleShouldBeSet(type: Type): boolean {
    const isRef = (t: Type) =>
      (t.kind === "Model" && ((!isArrayModelType(t) && !isMapModel(t)) || this.isRecursiveAlias(t))) || t.kind === "Enum" || (t.kind === "Union" && this.isRecursiveAlias(t));
    if (isRef(type)) return false;
    if (type.kind === "Union") {
      const flat = this.flattenUnion([...type.variants.values()].map((v) => v.type));
      const nonNull = flat.filter((t) => !isNullType(t));
      if (nonNull.length === 1 && isRef(nonNull[0])) return false;
    }
    return true;
  }

  private handleRefOverrides(schema: JsonObject, ctx: RootContext): JsonObject {
    const ref = schema["$ref"];
    if (typeof ref !== "string") return schema;
    const out = { ...schema };
    const target = ctx.registry.definitions.get(ref.slice("#/$defs/".length));
    if (!target) return out;
    for (const [k, v] of Object.entries(out)) {
      if (k === "$ref") continue;
      if (k in target && pyEquals(target[k], v)) delete out[k];
    }
    return out;
  }

  private serializeDefault(prop: ModelProperty, value: Value): Json {
    try {
      const json = parseJson(defaultJSON(this.program, value, prop));
      if (json === undefined) throw new Error("value has no JSON representation");
      return json;
    } catch (e) {
      this.report("unsupported-default", prop, { name: prop.name, reason: (e as Error).message });
    }
  }
}

export class RootContext {
  readonly inProgress = new Set<string>();
  constructor(readonly registry: DefinitionRegistry) {}
}

// ------------------------------------------------------------------ helpers

export interface Constraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  ge?: number | bigint;
  le?: number | bigint;
  gt?: number | bigint;
  lt?: number | bigint;
  minItems?: number;
  maxItems?: number;
  encoding?: string;
  description?: string;
  /** Bounds implied by a sized integer type; only applied where no tighter bound is declared. */
  implied?: { ge: number | bigint; le: number | bigint };
  /** Conflicting patterns/formats collected along the scalar chain. */
  conflicts?: string[];
}

const INTEGER_RANGES: Record<string, [number | bigint, number | bigint]> = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  uint64: [0, 2n ** 64n - 1n],
  safeint: [-9007199254740991, 9007199254740991],
};

function cmp(a: number | bigint, b: number | bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Intersection of constraint sets (TypeSpec semantics: every declared constraint applies). */
export function mergeConstraints(a: Constraints | undefined, b: Constraints | undefined): Constraints {
  const out: Constraints = { ...(a ?? {}) };
  if (!b) return out;
  const maxOf = <T extends number | bigint>(x: T | undefined, y: T | undefined) => (x === undefined ? y : y === undefined ? x : cmp(x, y) >= 0 ? x : y);
  const minOf = <T extends number | bigint>(x: T | undefined, y: T | undefined) => (x === undefined ? y : y === undefined ? x : cmp(x, y) <= 0 ? x : y);
  out.minLength = maxOf(out.minLength, b.minLength);
  out.maxLength = minOf(out.maxLength, b.maxLength);
  out.minItems = maxOf(out.minItems, b.minItems);
  out.maxItems = minOf(out.maxItems, b.maxItems);
  out.ge = maxOf(out.ge, b.ge);
  out.gt = maxOf(out.gt, b.gt);
  out.le = minOf(out.le, b.le);
  out.lt = minOf(out.lt, b.lt);
  for (const key of ["pattern", "format", "encoding"] as const) {
    if (b[key] !== undefined) {
      if (out[key] !== undefined && out[key] !== b[key]) {
        out.conflicts = [...(out.conflicts ?? []), `${key} '${out[key]}' and '${b[key]}'`];
      } else {
        out[key] = b[key];
      }
    }
  }
  out.description ??= b.description;
  if (b.implied) out.implied = b.implied;
  return out;
}

function applyConstraints(
  schema: JsonObject,
  c: Constraints,
  kind: "string" | "number" | "integer" | "array" | "other",
  gen: PydanticSchemaGenerator,
  type: Type,
): void {
  const fail = (reason: string) => {
    (gen as any).unsupported(type, reason);
  };
  if (c.conflicts?.length) fail(`conflicting constraints cannot be expressed in one Pydantic field: ${c.conflicts.join("; ")}`);
  const stringish = kind === "string" || (kind === "other" && schema.type === "string");
  if ((c.minLength !== undefined || c.maxLength !== undefined) && !stringish) fail("length constraints require a string type");
  if (c.pattern !== undefined && !stringish) fail("@pattern requires a string type");
  if (c.format !== undefined && kind !== "string") fail("@format requires a string type without a predefined format");
  if ((c.minItems !== undefined || c.maxItems !== undefined) && kind !== "array") fail("item constraints require an array type");
  const numeric = kind === "number" || kind === "integer";
  if ([c.ge, c.le, c.gt, c.lt].some((v) => v !== undefined) && !numeric) fail("value constraints require a numeric type");

  if (c.minLength !== undefined) schema.minLength = c.minLength;
  if (c.maxLength !== undefined) schema.maxLength = c.maxLength;
  if (c.pattern !== undefined) schema.pattern = c.pattern;
  if (c.format !== undefined) schema.format = c.format;
  if (c.minItems !== undefined) schema.minItems = c.minItems;
  if (c.maxItems !== undefined) schema.maxItems = c.maxItems;
  if (numeric) {
    let { ge, le, gt, lt } = c;
    if (c.implied) {
      if (gt === undefined) ge = ge === undefined ? c.implied.ge : cmp(ge, c.implied.ge) >= 0 ? ge : c.implied.ge;
      else if (cmp(gt, c.implied.ge) < 0) ge = ge === undefined ? c.implied.ge : cmp(ge, c.implied.ge) >= 0 ? ge : c.implied.ge;
      if (lt === undefined) le = le === undefined ? c.implied.le : cmp(le, c.implied.le) <= 0 ? le : c.implied.le;
      else if (cmp(lt, c.implied.le) > 0) le = le === undefined ? c.implied.le : cmp(le, c.implied.le) <= 0 ? le : c.implied.le;
    }
    if (ge !== undefined && gt !== undefined) {
      if (cmp(gt, ge) >= 0) ge = undefined;
      else gt = undefined;
    }
    if (le !== undefined && lt !== undefined) {
      if (cmp(lt, le) <= 0) le = undefined;
      else lt = undefined;
    }
    if (ge !== undefined) schema.minimum = ge;
    if (le !== undefined) schema.maximum = le;
    if (gt !== undefined) schema.exclusiveMinimum = gt;
    if (lt !== undefined) schema.exclusiveMaximum = lt;
  }
}

type Literal = string | number | bigint | boolean;


/** `literal_schema`. */
function literalSchema(expected: Literal[], mixed?: GeneratorOptions["mixedEnums"]): JsonObject {
  if (mixed === "typed-union" && expected.length && !literalType(expected)) {
    const groups = new Map<string, Literal[]>();
    for (const value of expected) {
      const kind = literalType([value])!;
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind)!.push(value);
    }
    return { anyOf: [...groups.values()].map(values => literalSchema(values)) };
  }
  const result: JsonObject = {};
  if (expected.length === 1) result.const = expected[0];
  else result.enum = expected;
  const t = literalType(expected);
  if (t) result.type = t;
  return result;
}

function literalType(values: (string | number | bigint | boolean)[]): string | undefined {
  const kinds = new Set(values.map((v) => (typeof v === "string" ? "str" : typeof v === "boolean" ? "bool" : typeof v === "bigint" || Number.isInteger(v) ? "int" : "float")));
  if (kinds.size !== 1) return undefined;
  return { str: "string", int: "integer", float: "number", bool: "boolean" }[[...kinds][0]];
}

function dedupeLiterals(values: (string | number | bigint | boolean)[]): (string | number | bigint | boolean)[] {
  // Python's typing.Literal de-duplicates parameters while preserving order.
  const seen: (string | number | bigint | boolean)[] = [];
  for (const v of values) if (!seen.some((s) => s === v && typeof s === typeof v)) seen.push(v);
  return seen;
}

/** `get_union_of_schemas` with the default `any_of` union format → `get_flattened_anyof`. */
export function getUnionOfSchemas(schemas: JsonObject[]): JsonObject {
  const members: JsonObject[] = [];
  for (const s of schemas) {
    if (Object.keys(s).length === 1 && Array.isArray(s.anyOf)) members.push(...(s.anyOf as JsonObject[]));
    else members.push(s);
  }
  const map = new Map<string, JsonObject>();
  for (const m of members) map.set(hashKey(m), m);
  const deduped = [...map.values()];
  if (deduped.length === 1) return deduped[0];
  return { anyOf: deduped };
}


/** The string representation used inside typing.Literal and Pydantic generic names. */
function pythonStringRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t" || ch === "\r" || ch === "\n") out += { "\t": "\\t", "\r": "\\r", "\n": "\\n" }[ch];
    else if (ch !== " " && /[\p{C}\p{Z}]/u.test(ch)) {
      const cp = ch.codePointAt(0)!;
      const size = cp <= 255 ? 2 : cp <= 65535 ? 4 : 8;
      out += "\\" + ({ 2: "x", 4: "u", 8: "U" }[size]) + cp.toString(16).padStart(size, "0");
    } else out += ch;
  }
  return out + quote;
}

function isNullable(type: Type, seen = new Set<Type>()): boolean {
  if (type.kind !== "Union") return isNullType(type);
  if (seen.has(type)) return false;
  seen.add(type);
  return [...type.variants.values()].some((v) => isNullable(v.type, seen));
}

function scalarDocOf(program: Program, type: Type): string | undefined {
  if (type.kind === "Scalar") {
    for (let s: Scalar | undefined = type; s; s = s.baseScalar) {
      if (s.namespace && getNamespaceFullName(s.namespace) === "TypeSpec") return undefined;
      const d = getDoc(program, s);
      if (d) return d;
    }
  }
  if (type.kind === "Union") {
    const nonNull = [...type.variants.values()].map((v) => v.type).filter((t) => !isNullType(t));
    if (nonNull.length === 1) return scalarDocOf(program, nonNull[0]);
  }
  return undefined;
}

// At each prefix accept a different next code point, or stop if the prefix itself is
// allowed. A complete reserved word can only match after at least one additional character.
function excludingTags(tags: string[]): string {
  const escape = (ch: string) => ch.replace(/[\\^$.*+?()[\]{}|/-]/g, c => c === "-" ? "\\u002d" : "\\" + c);
  const suffix = "[\\s\\S]*";
  function build(words: string[][]): string {
    const children = new Map<string, string[][]>();
    for (const [first, ...rest] of words) {
      if (first === undefined) continue;
      if (!children.has(first)) children.set(first, []);
      children.get(first)!.push(rest);
    }
    if (!children.size) return "[\\s\\S]" + suffix;
    const cases = words.some(x => x.length === 0) ? [] : [""];
    cases.push("[^" + [...children.keys()].map(escape).join("") + "]" + suffix);
    for (const [ch, rest] of children) cases.push(escape(ch) + build(rest));
    return "(?:" + cases.join("|") + ")";
  }
  return "^" + build(tags.map(tag => [...tag])) + "$";
}

/** Python `inspect.cleandoc`. */
export function cleandoc(doc: string): string {
  const lines = doc.replace(/\t/g, "        ").split("\n");
  let margin = Infinity;
  for (const line of lines.slice(1)) {
    const content = line.trimStart();
    if (content.length) margin = Math.min(margin, line.length - content.length);
  }
  const out = [lines[0].trimStart(), ...lines.slice(1).map((l) => (margin === Infinity ? l : l.slice(margin)))];
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

function safeTypeName(t: Type): string {
  try {
    return getTypeName(t);
  } catch {
    return t.kind;
  }
}

export { isObject };
export type { EnumMember };

/**
 * The type of undeclared properties: the value of the nearest string-keyed indexer in the
 * inheritance chain (`never` for a closed model declared with `...Record<never>`).
 */
export function additionalPropertiesOf(model: Model): Type | undefined {
  for (let m: Model | undefined = model; m; m = m.baseModel) {
    if (m.indexer && !isArrayModelType(m)) return m.indexer.value;
  }
  return undefined;
}

function isEmptyRecord(m: Model): boolean {
  return m.name === "Record" && !!m.namespace && getNamespaceFullName(m.namespace) === "TypeSpec"
    && isRecordModelType(m) && isNeverType(m.indexer!.value) && !m.properties.size;
}

/**
 * A record used as a map (`dict[str, T]`): no properties, no base model. A property-less model
 * indexed by `never` is a closed (empty) model instead, since nothing can be stored in it.
 */
export function isMapModel(model: Model): boolean {
  return isRecordModelType(model) && model.properties.size === 0 && !model.baseModel && !isNeverType(model.indexer!.value);
}
