/** Go code for declarations collected by GoModelGenerator. */
import { getNamespaceFullName, resolveEncodedName, type Type } from "@typespec/compiler";
import { Code, declRef, docComment, goRawString, goString } from "./gowriter.js";
import { arrayType, type Decl, type Field, type GoModelGenerator, type GoType, hasConstraints } from "./model.js";

/** Assigns final Go names: colliding names are namespace-qualified, then numbered. */
export function assignNames(decls: Decl[], reserved: Set<string>): { renamed: { decl: Decl; from: string }[] } {
  const renamed: { decl: Decl; from: string }[] = [];
  const groups = new Map<string, Decl[]>();
  for (const d of decls) {
    const list = groups.get(d.baseName) ?? [];
    list.push(d);
    groups.set(d.baseName, list);
  }
  const taken = new Set(reserved);
  function identifiers(d: Decl, name: string): string[] {
    if (d.kind === "enum") return [name, ...(d.enumValues ?? []).map(v => name + v.name)];
    if (d.kind === "union" || d.kind === "poly") {
      const variants = [...(d.variants ?? []), ...(d.fallback ? [d.fallback] : [])];
      return [name, name + "Kind", ...variants.flatMap(v => [name + "Kind" + v.name, "New" + name + v.name])];
    }
    return [name];
  }
  const available = (d: Decl, name: string) => identifiers(d, name).every(symbol => !taken.has(symbol));
  const claim = (d: Decl, name: string) => {
    for (const symbol of identifiers(d, name)) taken.add(symbol);
    d.name = name;
  };
  // Preserve the public API of enum/union owners when a standalone model also claims a
  // constant or constructor name. Qualify the colliding model as in namespace collisions.
  const sorted = [...groups.entries()].sort(([a, as], [b, bs]) =>
    Number(identifiers(bs[0], b).length > 1) - Number(identifiers(as[0], a).length > 1) || (a < b ? -1 : a > b ? 1 : 0));
  // First pass: unique, non-reserved names keep their base name.
  const pending: Decl[] = [];
  for (const [name, list] of sorted) {
    if (list.length === 1 && available(list[0], name)) {
      claim(list[0], name);
    } else {
      pending.push(...list);
    }
  }
  pending.sort((a, b) => fqn(a).localeCompare(fqn(b)) || a.id - b.id);
  for (const d of pending) {
    let name = d.qualifiers.join("") + d.baseName;
    if (name === d.baseName && reserved.has(name)) name = d.baseName + "Model";
    let n = name;
    for (let i = 2; !available(d, n); i++) n = `${name}${i}`;
    claim(d, n);
    if (n !== d.baseName) renamed.push({ decl: d, from: d.baseName });
  }
  return { renamed };
}

function fqn(d: Decl): string {
  const t = d.source as any;
  return `${t.namespace ? getNamespaceFullName(t.namespace) : ""}.${d.baseName}`;
}

/**
 * Application-defined validation (option validation-hooks): ValidateWith calls the value's
 * ValidateExtension after the generated checks. It runs after decoding, on values that decoded
 * completely and outside union variant selection (Validator.RunExtensions), and can only add errors.
 */
function emitValidationHook(g: GoModelGenerator, recv: string, out: Code): void {
  if (!g.validationHooks) return;
  out.open(`if ext, ok := any(&${recv}).(tsgo.ValidationExtension); ok && v.RunExtensions() {`).line("ext.ValidateExtension(v)").close();
}

/**
 * Validate (on a new validator) and ValidateWith (at the position of a given validator, used for
 * nested values and for partially decoded values) of a generated type; body uses `v`.
 */
export function emitValidateMethods(N: string, recv: string, doc: string, body: string, out: Code): void {
  out.raw(docComment(doc));
  out.open(`func (${recv} ${N}) Validate() error {`).line("v := tsgo.NewValidator()").line(`${recv}.ValidateWith(v)`).line("return v.Err()").close();
  out.line();
  out.raw(docComment("ValidateWith records the violations Validate reports at the position of v (tsgo.ValidatableWith)."));
  out.open(`func (${recv} ${N}) ValidateWith(v *tsgo.Validator) {`).raw(body).close();
  out.line();
}

/** Fixpoint for hasDefaults / hasValidation / nullUnset across the declaration graph. */
export function computeFlags(decls: Decl[], nullUnsetResponses = false, validationHooks = false): void {
  for (const d of decls) {
    d.hasDefaults = false;
    // With validation hooks every model, union and custom scalar is validated (its hook may add errors).
    d.hasValidation = d.kind === "union" || d.kind === "poly" || (d.kind === "enum" && !d.enumOpen) || (validationHooks && hookable(d));
    d.nullUnset = false;
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      const defaults = declHasDefaults(d);
      const validation = declHasValidation(d) || (validationHooks && hookable(d));
      const nullUnset = nullUnsetResponses && declNullUnset(d);
      if (defaults !== d.hasDefaults || validation !== d.hasValidation || nullUnset !== d.nullUnset) {
        d.hasDefaults = defaults;
        d.hasValidation = validation;
        d.nullUnset = nullUnset;
        changed = true;
      }
    }
  }
}

/** Declarations whose ValidateWith calls the application's ValidateExtension (validation-hooks). */
function hookable(d: Decl): boolean {
  return d.kind === "model" || d.kind === "scalar" || d.kind === "array";
}

/** The response encoding differs: an optional nullable property here or in a nested value. */
function declNullUnset(d: Decl): boolean {
  const differs = (t?: GoType) => !!t?.rcodec?.();
  switch (d.kind) {
    case "model":
      return (d.fields ?? []).some((f) => !f.never && !f.literal && (f.nullInResponse || differs(f.type))) || differs(d.additional);
    case "union":
    case "poly":
      return (d.variants ?? []).some((v) => differs(v.type)) || differs(d.fallback?.type);
    case "tuple":
      return (d.tupleItems ?? []).some(differs);
    case "array":
      return differs(d.arrayElem);
  }
  return false;
}

/** Codec of t in an encoding method: the response codec in MarshalResponseJSON. */
function codecFor(t: GoType, response: boolean): string {
  return (response && t.rcodec?.()) || t.codec;
}

/** The response encoding method of a declaration with nullUnset (unexported, used by the server). */
function responseMethodDoc(): string {
  return docComment("MarshalResponseJSON encodes the value as a server response body: the unset optional nullable\nproperties selected by response-unset-nullable (here and in nested values) are written as null.");
}

function declHasDefaults(d: Decl): boolean {
  switch (d.kind) {
    case "model":
      return (d.fields ?? []).some((f) => !f.never && (f.defaultJson !== undefined || (!f.literal && f.type.hasDefaults()))) || !!d.additional?.hasDefaults();
    case "union":
    case "poly":
      return (d.variants ?? []).some((v) => v.type.hasDefaults()) || !!d.fallback?.type.hasDefaults();
    case "tuple":
      return (d.tupleItems ?? []).some((t) => t.hasDefaults());
    case "array":
      return !!d.arrayElem?.hasDefaults();
  }
  return false;
}

function declHasValidation(d: Decl): boolean {
  switch (d.kind) {
    case "model":
      return (d.fields ?? []).some((f) => !f.literal && !f.never && (hasConstraints(f.constraints) || f.type.hasValidation())) || !!d.additional;
    case "union":
    case "poly":
      return true;
    case "enum":
      return !d.enumOpen || !!d.enumBase?.hasValidation();
    case "scalar":
      return hasConstraints(d.scalarConstraints!) || !!d.scalarBase?.hasValidation();
    case "tuple":
      return (d.tupleItems ?? []).some((t) => t.hasValidation());
    case "array":
      return hasConstraints(d.arrayConstraints!) || !!d.arrayElem?.hasValidation();
  }
  return false;
}

// ------------------------------------------------------------------------------------------ emit

/**
 * Emits a declaration. `canonical` leaves out what depends on the use within one program (XML
 * methods) and the methods added for other packages (text marshaling): the cross-package
 * fingerprint of a declaration is computed from that output.
 */
export function emitDecl(g: GoModelGenerator, d: Decl, out: Code, canonical = false): void {
  switch (d.kind) {
    case "model":
      emitModel(g, d, out);
      if (!canonical) g.xml?.emit(d, out);
      return;
    case "enum":
      emitEnum(d, out);
      break;
    case "union":
      return d.discriminator ? emitDiscriminatedUnion(g, d, out) : emitUnion(g, d, out);
    case "poly":
      return emitDiscriminatedUnion(g, d, out);
    case "scalar":
      emitScalar(g, d, out);
      break;
    case "tuple":
      return emitTuple(g, d, out);
    case "array":
      return emitArray(g, d, out);
  }
  // Text form for other packages (parameters of an imported enum or scalar): the standard
  // encoding.TextMarshaler methods over the package-private text functions.
  if (!canonical && g.exportContract && (d.kind === "enum" ? d.enumBase?.text : d.scalarBase?.text)) {
    const N = declRef(d.id);
    out.raw(docComment("MarshalText implements encoding.TextMarshaler (text form of HTTP parameters)."));
    out.open(`func (x ${N}) MarshalText() ([]byte, error) {`).line("s, err := x.formatText()").line("return []byte(s), err").close();
    out.line();
    out.raw(docComment("UnmarshalText implements encoding.TextUnmarshaler (text form of HTTP parameters)."));
    out.open(`func (x *${N}) UnmarshalText(b []byte) error {`).line(`v, err := parse${N}Text(string(b))`);
    out.open("if err != nil {").line("return err").close();
    out.line("*x = v").line("return nil").close();
    out.line();
  }
}

function origin(d: Decl): string {
  const t = d.source as Type & { name?: string; namespace?: any };
  const ns = t.namespace ? getNamespaceFullName(t.namespace) : "";
  const kind = { model: "model", enum: "enum", union: "union", scalar: "scalar", tuple: "tuple", poly: "model", array: "model" }[d.kind];
  return t.name ? `TypeSpec ${kind} ${ns ? ns + "." : ""}${t.name}` : `an anonymous TypeSpec ${kind}`;
}

function typeDoc(d: Decl, fallback: string): string {
  const N = declRef(d.id);
  return docComment(d.doc ? `${N} ${lowerFirst(d.doc)}` : `${N} ${fallback}`);
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------------- models

function fieldGoType(f: Field): string {
  return f.optional ? `*${f.type.expr}` : f.type.expr;
}

function emitModel(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const fields = d.fields ?? [];
  const literals = fields.filter((f) => f.literal);
  out.raw(typeDoc(d, `is generated from ${origin(d)}.`));
  if (literals.length) {
    out.raw(docComment(`
Constant properties (always written, checked when decoding, no Go field): ${literals.map((f) => `${f.json} = ${f.literal!.display}`).join(", ")}.`));
  }
  const nevers = fields.filter((f) => f.never);
  if (nevers.length) out.raw(docComment(`
Properties of type never (must be absent): ${nevers.map((f) => f.json).join(", ")}.`));
  if (d.closed) out.raw(docComment(`
Closed model (...Record<never>): undeclared properties are rejected when decoding.`));
  if (d.ignored?.length) out.raw(docComment(`
Properties excluded by visibility (accepted and discarded when decoding): ${[...new Set(d.ignored.map((p) => resolveEncodedName(g.program, p, "application/json")))].join(", ")}.`));
  out.open(`type ${N} struct {`);
  for (const f of fields) {
    if (f.literal || f.never) continue;
    const state = f.optional ? "optional; nil when absent" : "required";
    const lines = f.doc ? `${f.doc}\n\nJSON: ${goString(f.json)}, ${state}.` : `${f.goName} is JSON property ${goString(f.json)} (${state}).`;
    out.raw(docComment(lines));
    out.line(`${f.goName} ${fieldGoType(f)}`);
  }
  if (d.additional) {
    out.raw(docComment("AdditionalProperties holds properties not declared by the model."));
    out.line(g.orderedRecords ? `AdditionalProperties tsgo.OrderedMap[${d.additional.expr}]` : `AdditionalProperties map[string]${d.additional.expr}`);
  }
  out.close();
  out.line();

  // MarshalJSON (and, for responses that write unset nullable properties as null, MarshalResponseJSON)
  for (const response of d.nullUnset ? [false, true] : [false]) {
    out.raw(response ? responseMethodDoc() : docComment("MarshalJSON implements json.Marshaler."));
    out.open(`func (m ${N}) ${response ? "MarshalResponseJSON" : "MarshalJSON"}() ([]byte, error) {`);
    out.line(g.escaping === "tsgo.EscapeDefault" ? "w := tsgo.NewObjectWriter()" : `w := tsgo.NewObjectWriterEscaping(${g.escaping})`);
    for (const f of fields) {
      if (f.never) continue;
      const codec = codecFor(f.type, response);
      if (f.literal) out.line(`tsgo.WriteField(w, ${goString(f.json)}, ${f.type.expr}(${f.literal.value}), ${f.literal.codec})`);
      else if (response && f.nullInResponse) out.line(`tsgo.WriteOptionalOrNull(w, ${goString(f.json)}, m.${f.goName}, ${codec})`);
      else if (f.optional) out.line(`tsgo.WriteOptionalField(w, ${goString(f.json)}, m.${f.goName}, ${codec})`);
      else out.line(`tsgo.WriteField(w, ${goString(f.json)}, m.${f.goName}, ${codec})`);
    }
    if (d.additional) {
      const names = fields.map((f) => goString(f.json)).join(", ");
      out.line(`tsgo.${g.orderedRecords ? "WriteAdditionalOrdered" : "WriteAdditional"}(w, m.AdditionalProperties, ${codecFor(d.additional, response)}${names ? ", " + names : ""})`);
    }
    out.line("return w.Finish()");
    out.close();
    out.line();
  }

  // UnmarshalJSON
  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler. It checks JSON types, required properties,\nnullability and literal values; constraints are checked by Validate."));
  out.open(`func (m *${N}) UnmarshalJSON(data []byte) error {`);
  out.line("r, err := tsgo.NewObjectReader(data)");
  out.open("if err != nil {").line("return err").close();
  out.line(`var out ${N}`);
  for (const f of fields) {
    if (f.never) out.line(`tsgo.ReadNever(r, ${goString(f.json)})`);
    else if (f.literal) out.line(`tsgo.ReadLiteral(r, ${goString(f.json)}, ${f.literal.codec})`);
    else if (f.optional) out.line(`tsgo.ReadOptional(r, ${goString(f.json)}, &out.${f.goName}, ${f.type.codec})`);
    else out.line(`tsgo.ReadRequired(r, ${goString(f.json)}, &out.${f.goName}, ${f.type.codec})`);
  }
  if (d.ignored?.length) {
    const names = [...new Set(d.ignored.map((p) => resolveEncodedName(g.program, p, "application/json")))];
    out.line(`r.Ignore(${names.map(goString).join(", ")}) // excluded by visibility: accepted and discarded`);
  }
  if (d.additional) out.line(`tsgo.${g.orderedRecords ? "ReadAdditionalOrdered" : "ReadAdditional"}(r, &out.AdditionalProperties, ${d.additional.codec})`);
  // On failure the properties that decoded are kept (tsgo.Partial): *m is left unchanged.
  out.open(`if err := r.Finish(${d.closed ? "tsgo.RejectUnknown" : g.unknownPolicy}); err != nil {`).line("return tsgo.WithPartial(err, out)").close();
  out.line("*m = out");
  out.line("return nil");
  out.close();
  out.line();

  // Validate
  const checks = new Code();
  for (const f of fields) {
    if (f.literal || f.never) continue;
    emitFieldChecks(g, f, `m.${f.goName}`, `v.At(${goString(f.json)})`, checks);
  }
  const additionalChecks = new Code();
  d.additional?.validate("e", "v.At(k)", additionalChecks);
  // Nothing to check (no declared names, unvalidated values): no loop, whose variables would be unused.
  if (d.additional && (fields.length || additionalChecks.toString().trim())) {
    const body = additionalChecks;
    const declared = fields.map((f) => goString(f.json));
    checks.open(`for k, e := range m.AdditionalProperties${g.orderedRecords ? ".All()" : ""} {`);
    if (declared.length) {
      checks.open(`switch k {`);
      checks.line(`case ${declared.join(", ")}:`);
      checks.line(`\tv.At(k).Add("additionalProperties", "additional property collides with a declared property")`);
      checks.close();
    }
    checks.raw(body.toString());
    checks.line("_ = e");
    checks.close();
  }
  emitValidationHook(g, "m", checks);
  emitValidateMethods(N, "m", "Validate checks the declared constraints of the value and of nested values.", checks.toString(), out);

  // ApplyDefaults
  out.raw(docComment("ApplyDefaults sets absent optional properties that declare a default value, recursively."));
  out.open(`func (m *${N}) ApplyDefaults() {`);
  for (const f of fields) {
    if (f.literal || f.never) continue;
    if (f.defaultJson !== undefined) {
      out.open(`if m.${f.goName} == nil {`);
      out.line(`m.${f.goName} = tsgo.Ptr(tsgo.MustDecode(${f.type.codec}, ${goRawString(f.defaultJson)}))`);
      out.close();
    }
    if (f.type.hasDefaults()) {
      if (f.optional) {
        const body = new Code();
        f.type.defaults(`(*m.${f.goName})`, body);
        out.open(`if m.${f.goName} != nil {`).raw(body.toString()).close();
      } else {
        f.type.defaults(`m.${f.goName}`, out);
      }
    }
  }
  if (d.additional?.hasDefaults()) {
    out.open(`for k, e := range m.AdditionalProperties${g.orderedRecords ? ".All()" : ""} {`);
    d.additional.defaults("e", out);
    out.line(g.orderedRecords ? "m.AdditionalProperties.Set(k, e)" : "m.AdditionalProperties[k] = e");
    out.close();
  }
  out.close();
  out.line();
}

/** Property constraints plus type validation for a (possibly optional/nullable) field value. */
export function emitFieldChecks(g: GoModelGenerator, f: { type: GoType; optional: boolean; constraints: any; prop: any }, val: string, v: string, out: Code): void {
  const inner = new Code();
  const valueChecks = (t: GoType, x: string, o: Code) => {
    if (t.cat === "nullable") {
      const b = new Code();
      valueChecks(t.elem!, "x", b);
      if (b.toString().trim()) o.open(`if x, ok := ${x}.Get(); ok {`).raw(b.toString()).close();
      return;
    }
    g.emitConstraintChecks(t, f.constraints, x, v, o, f.prop);
    t.validate(x, v, o);
  };
  valueChecks(f.type, f.optional ? `(*${val})` : val, inner);
  if (!inner.toString().trim()) return;
  if (f.optional) out.open(`if ${val} != nil {`).raw(inner.toString()).close();
  else out.raw(inner.toString());
}

// ---------------------------------------------------------------------------------- enums

function emitEnum(d: Decl, out: Code): void {
  const N = declRef(d.id);
  const base = d.enumBase!;
  const values = d.enumValues!;
  const lit = (v: string | number | bigint | boolean) => (typeof v === "string" ? goString(v) : String(v));
  out.raw(typeDoc(d, `is generated from ${origin(d)}${d.enumOpen ? " (open: other values are accepted)" : ""}.`));
  out.line(`type ${N} ${base.expr}`);
  out.line();
  if (values.length) {
    out.open("const (");
    for (const v of values) {
      out.raw(docComment(v.doc ? `${N}${v.name} ${lowerFirst(v.doc)}` : `${N}${v.name} is the value ${lit(v.value)}.`));
      out.line(`${N}${v.name} ${N} = ${lit(v.value)}`);
    }
    out.close(")");
    out.line();
  }
  // Allowed values of decoding errors: the wire values (distinct, in declaration order).
  const wireMembers = [...new Set(values.map((v) => lit(v.value)))].map(v => `${base.expr}(${v})`);
  const allowedList = wireMembers.join(", ");
  const allowed = allowedList ? ", " + allowedList : "";

  out.raw(docComment(`Valid reports whether e is one of the declared values.`));
  out.open(`func (e ${N}) Valid() bool {`);
  if (d.enumOpen) out.line("return true");
  else if (!values.length) out.line("return false");
  else {
    out.open("switch e {");
    out.line(`case ${values.filter((v, i) => values.findIndex(x => x.value === v.value) === i).map(v => N + v.name).join(", ")}:`);
    out.line("\treturn true");
    out.close();
    out.line("return false");
  }
  out.close();
  out.line();

  out.raw(docComment("MarshalJSON implements json.Marshaler."));
  out.open(`func (e ${N}) MarshalJSON() ([]byte, error) {`);
  if (!d.enumOpen) out.open("if !e.Valid() {").line(`return nil, fmt.Errorf("%v is not a valid ${N}", ${base.expr}(e))`).close();
  out.line(`return ${base.codec}.Encode(${base.expr}(e))`);
  out.close();
  out.line();

  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler; undeclared values are rejected unless the enum is open."));
  out.open(`func (e *${N}) UnmarshalJSON(data []byte) error {`);
  out.line(`x, err := ${base.codec}.Decode(data)`);
  out.open("if err != nil {").line("return err").close();
  if (!d.enumOpen && base.num === "float64") {
    out.open(`if !tsgo.SameNumberText(strings.TrimSpace(string(data)), fmt.Sprint(x)) {`).line(`return &tsgo.DecodeError{Err: &tsgo.DecodeProblem{Kind: tsgo.ProblemEnum, Allowed: []any{${allowedList}}, Message: fmt.Sprintf("number %s differs from the declared enum value", data)}}`).close();
  }
  out.open(`if !${N}(x).Valid() {`).line(`return &tsgo.DecodeError{Err: tsgo.EnumError(x${allowed})}`).close();
  out.line(`*e = ${N}(x)`);
  out.line("return nil");
  out.close();
  out.line();

  const checks = new Code();
  if (!d.enumOpen) checks.line(`tsgo.OneOf(v, ${base.expr}(e)${allowed})`);
  base.validate(`${base.expr}(e)`, "v", checks);
  emitValidateMethods(N, "e", "Validate checks enum membership.", checks.toString(), out);

  if (base.text) {
    out.open(`func (e ${N}) formatText() (string, error) {`);
    if (!d.enumOpen) out.open("if !e.Valid() {").line(`return "", fmt.Errorf("%v is not a valid ${N}", ${base.expr}(e))`).close();
    out.line(`return ${base.text}.Format(${base.expr}(e))`);
    out.close();
    out.line();
    out.open(`func parse${N}Text(s string) (${N}, error) {`);
    out.line(`x, err := ${base.text}.Parse(s)`);
    out.open("if err != nil {").line(`return ${zeroOf(N, base)}, err`).close();
    if (!d.enumOpen && base.num === "float64") {
      out.open("if !tsgo.SameNumberText(s, fmt.Sprint(x)) {").line(`return ${zeroOf(N, base)}, &tsgo.DecodeProblem{Kind: tsgo.ProblemEnum, Allowed: []any{${allowedList}}, Message: fmt.Sprintf("number %s differs from the declared enum value", s)}`).close();
    }
    out.open(`if !${N}(x).Valid() {`).line(`return ${zeroOf(N, base)}, tsgo.EnumError(x${allowed})`).close();
    out.line(`return ${N}(x), nil`);
    out.close();
    out.line();
  }
}

function zeroOf(N: string, base: GoType): string {
  return `${N}(${base.expr === "string" ? '""' : base.expr === "bool" ? "false" : "0"})`;
}

// ---------------------------------------------------------------------------------- unions

function emitUnionCommon(g: GoModelGenerator, d: Decl, out: Code, extraVariants: { name: string; type: GoType }[]): void {
  const N = declRef(d.id);
  const variants = [...(d.variants ?? []), ...extraVariants];
  out.open(`type ${N} struct {`);
  out.line("u tsgo.UnionValue");
  out.close();
  out.line();
  out.raw(docComment(`${N}Kind identifies the variant held by a ${N}. The zero value means "unset".`));
  out.line(`type ${N}Kind int`);
  out.line();
  out.open("const (");
  variants.forEach((v, i) => {
    out.raw(docComment(`${N}Kind${v.name} is the ${v.name} variant (${v.type.expr}).`));
    out.line(`${N}Kind${v.name} ${N}Kind = ${i + 1}`);
  });
  out.close(")");
  out.line();
  variants.forEach((v, i) => {
    out.raw(docComment(`New${N}${v.name} returns a ${N} holding the ${v.name} variant.`));
    out.open(`func New${N}${v.name}(v ${v.type.expr}) ${N} {`).line(`return ${N}{u: tsgo.UnionValue{Kind: ${i + 1}, Value: v}}`).close();
    out.line();
    out.raw(docComment(`As${v.name} returns the ${v.name} variant and true, or false if another variant is held.`));
    out.open(`func (x ${N}) As${v.name}() (${v.type.expr}, bool) {`);
    out.open(`if x.u.Kind != ${i + 1} {`).line(`var zero ${v.type.expr}`).line("return zero, false").close();
    out.line(`return x.u.Value.(${v.type.expr}), true`);
    out.close();
    out.line();
  });
  out.raw(docComment("Kind returns the variant held by x."));
  out.open(`func (x ${N}) Kind() ${N}Kind {`).line(`return ${N}Kind(x.u.Kind)`).close();
  out.line();

  // Enveloped variants are validated at the envelope property, where their values are.
  const at = d.discriminator?.envelope === "object" ? `v.At(${goString(d.discriminator.envelopeProperty)})` : "v";
  const checks = new Code();
  checks.open("switch x.u.Kind {");
  variants.forEach((vr, i) => {
    const body = new Code();
    vr.type.validate("val", at, body);
    if (d.discriminator?.envelope === "none") {
      const field = vr.type.decl?.fields?.find(f => f.json === d.discriminator!.property);
      if (vr === d.fallback || i >= (d.variants?.length ?? 0) || (field && !field.literal)) {
        body.open("if _, err := x.MarshalJSON(); err != nil {").line('v.Add("discriminator", "%s", err.Error())').close();
      }
    }
    if (!body.toString().trim()) return;
    checks.line(`case ${i + 1}:`);
    if (/\bval\b/.test(body.toString())) checks.line(`\tval := x.u.Value.(${vr.type.expr})`);
    for (const l of body.toString().replace(/\n$/, "").split("\n")) checks.line("\t" + l);
  });
  checks.line("case 0:");
  checks.line(`\tv.Add("union", "no variant of ${N} is set")`);
  checks.close();
  emitValidationHook(g, "x", checks);
  emitValidateMethods(N, "x", "Validate checks that a variant is set and validates it.", checks.toString(), out);

  out.raw(docComment("ApplyDefaults applies defaults to the held variant."));
  out.open(`func (x *${N}) ApplyDefaults() {`);
  const withDefaults = variants.map((vr, i) => ({ vr, i })).filter(({ vr }) => vr.type.hasDefaults());
  if (withDefaults.length) {
    out.open("switch x.u.Kind {");
    for (const { vr, i } of withDefaults) {
      out.line(`case ${i + 1}:`);
      out.line(`\tval := x.u.Value.(${vr.type.expr})`);
      const body = new Code();
      vr.type.defaults("val", body);
      for (const l of body.toString().replace(/\n$/, "").split("\n")) out.line("\t" + l);
      out.line("\tx.u.Value = val");
    }
    out.close();
  }
  out.close();
  out.line();
}

function emitUnion(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const variants = d.variants!;
  out.raw(typeDoc(d, `is generated from ${origin(d)}. It holds exactly one variant.`));
  out.raw(docComment(`\nJSON decoding tries the variants in declaration order (${variants.map((v) => v.name).join(", ")}). It selects\nthe first variant that decodes, validates and accounts for every property of an object; failing\nthat, the first that decodes and validates; failing that, the first that decodes (Validate then\nreports its constraint violations). If none decodes, the error reports the variants whose\nconstant properties the value matches (tsgo.VariantError, tsgo.UnionError).`));
  emitUnionCommon(g, d, out, []);

  for (const response of d.nullUnset ? [false, true] : [false]) {
    out.raw(response ? responseMethodDoc() : docComment("MarshalJSON implements json.Marshaler."));
    out.open(`func (x ${N}) ${response ? "MarshalResponseJSON" : "MarshalJSON"}() ([]byte, error) {`);
    out.open("switch x.u.Kind {");
    variants.forEach((v, i) => {
      out.line(`case ${i + 1}:`);
      out.line(`\treturn ${codecFor(v.type, response)}.Encode(x.u.Value.(${v.type.expr}))`);
    });
    out.close();
    out.line("return nil, tsgo.ErrUnsetUnion");
    out.close();
    out.line();
  }

  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler (first matching variant in declaration order)."));
  out.open(`func (x *${N}) UnmarshalJSON(data []byte) error {`);
  out.open("return tsgo.DecodeUnion(data, []tsgo.UnionVariant{");
  for (const v of variants) {
    const kinds = v.type.kinds ? `[]tsgo.JSONKind{${v.type.kinds.join(", ")}}` : "nil";
    // Declared constants identify the intended variant in error reports (never in selection).
    const consts = v.type.decl?.kind === "model" ? (v.type.decl.fields ?? []).filter((f) => f.literal) : [];
    const constList = consts.length ? ` Consts: []tsgo.UnionConst{${consts.map((f) => `{Property: ${goString(f.json)}, Value: ${goString(f.literal!.display)}}`).join(", ")}},` : "";
    out.open(`{Name: ${goString(v.name)}, Kinds: ${kinds},${constList} Try: func(b []byte) (func(), bool, error) {`);
    out.line(`val, err := ${v.type.codec}.Decode(b)`);
    // The partially decoded variant is kept if this variant is the one reported.
    out.open("if err != nil {").line(`return nil, false, tsgo.WithPartial(err, New${N}${v.name}(val))`).close();
    out.line(`encoded, err := ${v.type.codec}.Encode(val)`);
    out.open("if err != nil {").line("return nil, false, err").close();
    // exact: the variant represents the whole input, nested properties and number values included.
    out.line("exact := tsgo.EquivalentJSON(b, encoded)");
    // Always multi-line: gofmt expands a one-line function literal once it is long.
    out.open("commit := func() {").line(`*x = New${N}${v.name}(val)`).close();
    if (v.type.hasValidation()) {
      // Selection checks the declared constraints only: application checks never select a variant.
      out.line("v := tsgo.NewConstraintValidator()");
      v.type.validate("val", "v", out);
      out.open("if err := v.Err(); err != nil {").line(`return commit, exact, err`).close();
    }
    out.line(`return commit, exact, nil`);
    out.close("}},");
  }
  out.close("})");
  out.close();
  out.line();
}

function variantDeclaresProperty(t: GoType, prop: string): boolean {
  const d = t.decl;
  if (!d) return false;
  if (d.kind === "model") return (d.fields ?? []).some((f) => f.json === prop);
  if (d.kind === "poly") return true;
  return false;
}

function emitDiscriminatedUnion(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const disc = d.discriminator!;
  const variants = d.variants!;
  const base = d.fallback?.type;
  const baseVariant = d.fallback ? [{ name: d.fallback.name, type: d.fallback.type }] : [];
  out.raw(typeDoc(d, `is generated from ${origin(d)}. It holds exactly one variant.`));
  out.raw(
    docComment(
      `\nThe variant is selected by the ${goString(disc.property)} property${disc.envelope === "object" ? ` and the value is wrapped in ${goString(disc.envelopeProperty)}` : ""}.` +
        (base ? `\nObjects with an undeclared discriminator value decode into the ${d.fallback!.name} variant.` : ""),
    ),
  );
  emitUnionCommon(g, d, out, baseVariant);
  const all = [...variants.map((v) => ({ ...v })), ...baseVariant.map((b) => ({ ...b, tag: undefined as string | undefined }))];

  for (const response of d.nullUnset ? [false, true] : [false]) {
    out.raw(response ? responseMethodDoc() : docComment("MarshalJSON implements json.Marshaler."));
    out.open(`func (x ${N}) ${response ? "MarshalResponseJSON" : "MarshalJSON"}() ([]byte, error) {`);
    out.open("switch x.u.Kind {");
    all.forEach((v, i) => {
      out.line(`case ${i + 1}:`);
      out.line(`\tb, err := ${codecFor(v.type, response)}.Encode(x.u.Value.(${v.type.expr}))`);
      out.line("\tif err != nil {");
      out.line("\t\treturn nil, err");
      out.line("\t}");
      if (v.tag === undefined) {
        out.line(`\ttag, err := tsgo.ReadDiscriminator(b, ${goString(disc.property)})`);
        out.line("\tif err != nil {");
        out.line("\t\treturn nil, err");
        out.line("\t}");
        if (variants.length) {
          out.line(`\tif ${variants.map(v => `tag == ${goString(v.tag!)}`).join(" || ")} {`);
          out.line('\t\treturn nil, fmt.Errorf("discriminator %q identifies a named variant", tag)');
          out.line("\t}");
        } else out.line("\t_ = tag");
        out.line("\treturn b, nil");
      } else if (disc.envelope === "object") {
        out.line(g.escaping === "tsgo.EscapeDefault" ? "\tw := tsgo.NewObjectWriter()" : `\tw := tsgo.NewObjectWriterEscaping(${g.escaping})`);
        out.line(`\ttsgo.WriteField(w, ${goString(disc.property)}, ${goString(v.tag)}, ${g.stringCodec})`);
        out.line(`\tw.WriteRaw(${goString(disc.envelopeProperty)}, b)`);
        out.line("\treturn w.Finish()");
      } else if (variantDeclaresProperty(v.type, disc.property)) {
        if (!v.type.decl?.fields?.find(f => f.json === disc.property)?.literal) {
          out.line(`\ttag, err := tsgo.ReadDiscriminator(b, ${goString(disc.property)})`);
          out.line(`\tif err != nil || tag != ${goString(v.tag)} {`);
          out.line(`\t\treturn nil, fmt.Errorf("expected discriminator %s, got %q", ${goString(v.tag)}, tag)`);
          out.line("\t}");
        }
        out.line("\treturn b, nil");
      } else {
        out.line(g.escaping === "tsgo.EscapeDefault" ? `\treturn tsgo.InjectProperty(b, ${goString(disc.property)}, ${goString(v.tag)})` : `\treturn tsgo.InjectPropertyEscaping(b, ${goString(disc.property)}, ${goString(v.tag)}, ${g.escaping})`);
      }
    });
    out.close();
    out.line("return nil, tsgo.ErrUnsetUnion");
    out.close();
    out.line();
  }

  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler using the discriminator."));
  out.open(`func (x *${N}) UnmarshalJSON(data []byte) error {`);
  out.line(`tag, err := tsgo.ReadDiscriminator(data, ${goString(disc.property)})`);
  out.open("if err != nil {").line("return err").close();
  if (disc.envelope === "object") {
    out.line("r, err := tsgo.NewObjectReader(data)");
    out.open("if err != nil {").line("return err").close();
    out.line(`r.Raw(${goString(disc.property)})`);
    out.line(`payload := tsgo.ReadRawRequired(r, ${goString(disc.envelopeProperty)})`);
    out.open(`if err := r.Finish(${g.unknownPolicy}); err != nil {`).line("return err").close();
  }
  out.open("switch tag {");
  variants.forEach((v, i) => {
    out.line(`case ${goString(v.tag!)}:`);
    let src = "data";
    if (disc.envelope === "object") src = "payload";
    else if (!variantDeclaresProperty(v.type, disc.property)) {
      out.line(`\tstripped, err := tsgo.StripProperty(data, ${goString(disc.property)})`);
      out.line("\tif err != nil {");
      out.line("\t\treturn err");
      out.line("\t}");
      src = "stripped";
    }
    out.line(`\tval, err := ${v.type.codec}.Decode(${src})`);
    out.line("\tif err != nil {");
    // The variant is identified: its failures are attributed to it and its decoded part kept.
    const failure = disc.envelope === "object" ? `tsgo.WithPath(${goString(disc.envelopeProperty)}, err)` : "err";
    out.line(`\t\treturn tsgo.WithPartial(tsgo.InTaggedVariant(${goString(v.name)}, ${failure}), ${N}{u: tsgo.UnionValue{Kind: ${i + 1}, Value: val}})`);
    out.line("\t}");
    out.line(`\t*x = ${N}{u: tsgo.UnionValue{Kind: ${i + 1}, Value: val}}`);
    out.line("\treturn nil");
  });
  out.close();
  if (base) {
    out.line(`val, err := ${base.codec}.Decode(data)`);
    out.open("if err != nil {").line(`return tsgo.WithPartial(tsgo.InTaggedVariant(${goString(d.fallback!.name)}, err), ${N}{u: tsgo.UnionValue{Kind: ${variants.length + 1}, Value: val}})`).close();
    out.line(`*x = ${N}{u: tsgo.UnionValue{Kind: ${variants.length + 1}, Value: val}}`);
    out.line("return nil");
  } else {
    out.line(`return tsgo.WithPath(${goString(disc.property)}, &tsgo.DecodeError{Err: tsgo.DiscriminatorError(tag${variants.map((v) => ", " + goString(v.tag!)).join("")})})`);
  }
  out.close();
  out.line();
}

// ---------------------------------------------------------------------------------- scalars & tuples

function emitScalar(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const base = d.scalarBase!;
  out.raw(typeDoc(d, `is generated from ${origin(d)}.`));
  out.line(`type ${N} ${base.expr}`);
  out.line();
  out.raw(docComment("MarshalJSON implements json.Marshaler."));
  out.open(`func (s ${N}) MarshalJSON() ([]byte, error) {`).line(`return ${base.codec}.Encode(${base.expr}(s))`).close();
  out.line();
  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler."));
  out.open(`func (s *${N}) UnmarshalJSON(data []byte) error {`);
  out.line(`x, err := ${base.codec}.Decode(data)`);
  out.open("if err != nil {").line("return err").close();
  out.line(`*s = ${N}(x)`);
  out.line("return nil");
  out.close();
  out.line();
  const checks = new Code();
  g.emitConstraintChecks(base, d.scalarConstraints!, `${base.expr}(s)`, "v", checks, d.source);
  base.validate(`${base.expr}(s)`, "v", checks);
  emitValidationHook(g, "s", checks);
  emitValidateMethods(N, "s", "Validate checks the constraints declared on the scalar and its base scalars.", checks.toString(), out);
  if (base.text) {
    out.open(`func (s ${N}) formatText() (string, error) {`).line(`return ${base.text}.Format(${base.expr}(s))`).close();
    out.line();
    out.open(`func parse${N}Text(s string) (${N}, error) {`);
    out.line(`x, err := ${base.text}.Parse(s)`);
    out.line(`return ${N}(x), err`);
    out.close();
    out.line();
  }
}

function emitTuple(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const items = d.tupleItems!;
  out.raw(typeDoc(d, `is generated from ${origin(d)}; it is encoded as a JSON array of ${items.length} element${items.length === 1 ? "" : "s"}.`));
  out.open(`type ${N} struct {`);
  items.forEach((t, i) => {
    out.raw(docComment(`Item${i} is element ${i}.`));
    out.line(`Item${i} ${t.expr}`);
  });
  out.close();
  out.line();
  for (const response of d.nullUnset ? [false, true] : [false]) {
    out.raw(response ? responseMethodDoc() : docComment("MarshalJSON implements json.Marshaler."));
    out.open(`func (t ${N}) ${response ? "MarshalResponseJSON" : "MarshalJSON"}() ([]byte, error) {`);
    items.forEach((t, i) => {
      out.line(`b${i}, err := ${codecFor(t, response)}.Encode(t.Item${i})`);
      out.open("if err != nil {").line("return nil, err").close();
    });
    out.line(`return tsgo.EncodeTuple(${items.map((_, i) => `b${i}`).join(", ")}), nil`);
    out.close();
    out.line();
  }
  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler."));
  out.open(`func (t *${N}) UnmarshalJSON(data []byte) error {`);
  // A zero-element tuple (`[]`, e.g. the default scopes of TypeSpec.Http.OAuth2Auth) has no element to bind.
  out.line(`${items.length ? "raw" : "_"}, err := tsgo.DecodeTuple(data, ${items.length})`);
  out.open("if err != nil {").line("return err").close();
  out.line(`var out ${N}`);
  if (items.length) {
    // Every failing element is reported; the elements that decoded are kept (tsgo.Partial).
    out.line("var errs []error");
    items.forEach((t, i) => out.line(`tsgo.DecodeItem(raw, ${i}, &out.Item${i}, ${t.codec}, &errs)`));
    out.open("if err := tsgo.ItemsError(errs); err != nil {").line("return tsgo.WithPartial(err, out)").close();
  }
  out.line("*t = out");
  out.line("return nil");
  out.close();
  out.line();
  const checks = new Code();
  items.forEach((t, i) => t.validate(`t.Item${i}`, `v.At(${i})`, checks));
  emitValidateMethods(N, "t", "Validate validates the elements.", checks.toString(), out);
  out.raw(docComment("ApplyDefaults applies defaults to the elements."));
  out.open(`func (t *${N}) ApplyDefaults() {`);
  items.forEach((t, i) => t.defaults(`t.Item${i}`, out));
  out.close();
  out.line();
}

function emitArray(g: GoModelGenerator, d: Decl, out: Code): void {
  const N = declRef(d.id);
  const elem = d.arrayElem!;
  const slice = arrayType(elem);
  out.raw(typeDoc(d, `is generated from ${origin(d)}: a JSON array.`));
  out.line(`type ${N} ${slice.expr}`);
  out.line();
  for (const response of d.nullUnset ? [false, true] : [false]) {
    out.raw(response ? responseMethodDoc() : docComment("MarshalJSON implements json.Marshaler (a nil slice is written as [])."));
    out.open(`func (a ${N}) ${response ? "MarshalResponseJSON" : "MarshalJSON"}() ([]byte, error) {`).line(`return ${codecFor(slice, response)}.Encode(${slice.expr}(a))`).close();
    out.line();
  }
  out.raw(docComment("UnmarshalJSON implements json.Unmarshaler (JSON null is rejected)."));
  out.open(`func (a *${N}) UnmarshalJSON(data []byte) error {`);
  out.line(`x, err := ${slice.codec}.Decode(data)`);
  // The items that decoded are kept (tsgo.Partial).
  out.open("if err != nil {").line(`return tsgo.WithPartial(err, ${N}(x))`).close();
  out.line(`*a = ${N}(x)`);
  out.line("return nil");
  out.close();
  out.line();
  const checks = new Code();
  g.emitConstraintChecks(slice, d.arrayConstraints!, "a", "v", checks, d.source);
  slice.validate("a", "v", checks);
  emitValidationHook(g, "a", checks);
  emitValidateMethods(N, "a", "Validate checks the item constraints declared on the array model and validates the items.", checks.toString(), out);
  out.raw(docComment("ApplyDefaults applies defaults to the items."));
  out.open(`func (a *${N}) ApplyDefaults() {`);
  slice.defaults("(*a)", out);
  out.close();
  out.line();
}

/** Package variables of the conversion codecs (name → resolved initializer). */
export function emitConversions(conversions: [string, string][], out: Code): void {
  if (!conversions.length) return;
  out.open("var (");
  for (const [name, init] of conversions) {
    out.raw(docComment(`${name} converts a custom scalar from and to its encoded base type.`));
    out.raw(`${name} = ${init}`);
  }
  out.close(")");
  out.line();
}

export function emitPatterns(g: GoModelGenerator, out: Code, used: (name: string) => boolean = () => true): void {
  const patterns = [...g.patterns].filter(([name]) => used(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (patterns.length === 0) return;
  out.open("var (");
  for (const [name, p] of patterns) {
    out.raw(docComment(`${name} is the RE2 translation of a TypeSpec @pattern.`));
    out.line(`${name} = tsgo.CompilePattern(${goString(g.patternSources.get(name)!)}, ${goRawString(p)})`);
  }
  out.close(")");
  out.line();
}
