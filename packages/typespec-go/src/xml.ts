/**
 * XML payloads following the @typespec/xml serialization rules:
 *  - model element: the property name (nested) or the model's XML name (root, array items);
 *  - scalar properties: child elements; @attribute → attribute; @unwrapped scalar → text content;
 *  - arrays: wrapped by default (`<colors><string>…</string></colors>`, items named after the
 *    item type's XML name); @unwrapped → repeated elements named after the property;
 *  - records: `<metadata><key>value</key>…</metadata>`;
 *  - @ns → namespaced names (declarations hoisted to the root element).
 * Shapes without an XML mapping (unions, nullable, tuples, unknown) are rejected.
 */
import { type Model, type ModelProperty, type Program, type Type, getNamespaceFullName, resolveEncodedName } from "@typespec/compiler";
import { Code, declRef, docComment, goString } from "./gowriter.js";
import { createDiagnostic } from "./lib.js";
import type { Decl, Field, GoModelGenerator, GoType } from "./model.js";

type XmlLib = typeof import("@typespec/xml");

export class XmlSupport {
  readonly marked = new Set<Decl>();
  constructor(
    private readonly program: Program,
    private readonly g: GoModelGenerator,
    private readonly lib: XmlLib | undefined,
  ) {}

  private fail(target: Type, reason: string): false {
    this.g.diagnostics.push(createDiagnostic({ code: "unsupported-http", target, format: { reason: `XML: ${reason}` } }));
    return false;
  }

  private nameExpr(local: string, target?: Type): string {
    const ns = target && this.lib ? (this.lib.getNs(this.program, target as any) as { namespace: string; prefix: string } | undefined) : undefined;
    if (ns) return `tsgo.XMLName{Space: ${goString(ns.namespace)}, Prefix: ${goString(ns.prefix)}, Local: ${goString(local)}}`;
    return `tsgo.XMLName{Local: ${goString(local)}}`;
  }

  /** XML name of a type used as an array item / root element. */
  typeName(t: GoType): string {
    const src = t.decl?.source;
    if (src && (src.kind === "Model" || src.kind === "Scalar" || src.kind === "Enum")) {
      return this.nameExpr(resolveEncodedName(this.program, src as any, "application/xml") || (src as any).name, src);
    }
    const std: Record<string, string> = { string: "string", bool: "boolean", int8: "int8", int16: "int16", int32: "int32", int64: "int64", uint8: "uint8", uint16: "uint16", uint32: "uint32", uint64: "uint64", float32: "float32", float64: "float64" };
    return this.nameExpr(std[t.expr] ?? t.expr.replace(/^tsgo\./, "").toLowerCase());
  }

  rootName(d: Decl): string {
    const m = d.source as Model;
    return this.nameExpr(resolveEncodedName(this.program, m, "application/xml") || m.name, m);
  }

  /** Marks the model declarations reachable from an XML payload; false if not representable. */
  mark(t: GoType, site: Type): boolean {
    if (!this.lib) return this.fail(site, "the @typespec/xml library is required for XML payloads");
    if (t.decl?.kind === "model") {
      if (this.marked.has(t.decl)) return true;
      this.marked.add(t.decl);
      if (t.decl.additional) return this.fail(t.decl.source, "additional properties have no XML mapping");
      for (const f of t.decl.fields ?? []) if (!f.never && !this.markField(f)) return false;
      return true;
    }
    if (t.text) return true;
    return this.fail(site, `type ${t.expr} has no XML representation`);
  }

  private markField(f: Field): boolean {
    const t = f.type;
    if (this.lib!.isAttribute(this.program, f.prop) && !t.text) return this.fail(f.prop, "@attribute properties must be scalars");
    if (t.cat === "nullable") return this.fail(f.prop, "nullable properties have no XML representation");
    if (t.cat === "array") {
      const e = t.elem!;
      if (e.cat === "array" || e.cat === "map" || e.cat === "nullable") return this.fail(f.prop, "nested collections have no XML mapping");
      return this.mark(e, f.prop);
    }
    if (t.cat === "map") {
      if (t.elem!.decl?.kind === "model") return this.mark(t.elem!, f.prop);
      if (!t.elem!.text) return this.fail(f.prop, "records in XML require scalar or model values");
      return true;
    }
    return this.mark(t, f.prop);
  }

  encodeCall(d: Decl, value: string, name: string): string {
    return d.external ? `encodeExternalXML${d.id}(${value}, ${name})` : `${value}.ToXMLNode(${name})`;
  }

  decodeCall(d: Decl, value: string, node: string): string {
    return d.external ? `decodeExternalXML${d.id}(&${value}, ${node})` : `${value}.FromXMLNode(${node})`;
  }

  emit(d: Decl, out: Code): void {
    if (!this.marked.has(d)) return;
    const N = declRef(d.id);
    const lib = this.lib!;
    const fields = (d.fields ?? []).filter((f) => !f.never);
    out.raw(docComment(`ToXMLNode converts the value to an XML element named name (@typespec/xml rules).`));
    out.open(d.external ? `func encodeExternalXML${d.id}(m ${N}, name tsgo.XMLName) (*tsgo.XMLNode, error) {` : `func (m ${N}) ToXMLNode(name tsgo.XMLName) (*tsgo.XMLNode, error) {`);
    out.line("n := tsgo.NewXMLNode(name)");
    for (const f of fields) {
      const prop = f.prop as ModelProperty;
      const local = resolveEncodedName(this.program, prop, "application/xml");
      const name = this.nameExpr(local, prop);
      const val = f.literal ? `${f.type.expr}(${f.literal.value})` : f.optional ? `(*m.${f.goName})` : `m.${f.goName}`;
      const body = new Code();
      const fmt = (v: string, t: GoType, o: Code) => {
        o.line(`s, err := ${t.text}.Format(${v})`);
        o.open("if err != nil {").line(`return nil, fmt.Errorf("%s: %w", ${goString(local)}, err)`).close();
      };
      const attr = lib.isAttribute(this.program, prop);
      const unwrapped = lib.isUnwrapped(this.program, prop);
      if (attr) {
        fmt(val, f.type, body);
        body.line(`n.SetAttr(${name}, s)`);
      } else if (f.type.cat === "array") {
        const e = f.type.elem!;
        const target = unwrapped ? "n" : "w";
        if (!unwrapped) body.line(`w := tsgo.NewXMLNode(${name})`);
        body.open(`for _, e := range ${val} {`);
        if (e.decl?.kind === "model") {
          body.line(`c, err := ${this.encodeCall(e.decl, "e", unwrapped ? name : this.typeName(e))}`);
          body.open("if err != nil {").line("return nil, err").close();
          body.line(`${target}.Add(c)`);
        } else {
          fmt("e", e, body);
          body.line(`${target}.AddText(${unwrapped ? name : this.typeName(e)}, s)`);
        }
        body.close();
        if (!unwrapped) body.line("n.Add(w)");
      } else if (f.type.cat === "map") {
        body.line(`w := tsgo.NewXMLNode(${name})`);
        const e = f.type.elem!;
        const entry = f.type.ordered ? "entry" : `${val}[k]`;
        body.open(f.type.ordered ? `for k, entry := range ${val}.All() {` : `for _, k := range tsgo.SortedKeys(${val}) {`);
        if (e.decl?.kind === "model") {
          body.line(`child, err := ${this.encodeCall(e.decl, entry, "tsgo.XMLName{Local: k}")}`);
          body.open("if err != nil {").line(`return nil, tsgo.XMLPath(${goString(local)}, tsgo.WithPath(k, err))`).close();
          body.line("w.Add(child)");
        } else {
          fmt(entry, e, body);
          body.line("w.AddText(tsgo.XMLName{Local: k}, s)");
        }
        body.close();
        body.line("n.Add(w)");
      } else if (f.type.decl?.kind === "model") {
        body.line(`c, err := ${this.encodeCall(f.type.decl, val, name)}`);
        body.open("if err != nil {").line("return nil, err").close();
        body.line("n.Add(c)");
      } else if (unwrapped) {
        fmt(val, f.type, body);
        body.line("n.Text = s");
      } else {
        fmt(val, f.type, body);
        body.line(`n.AddText(${name}, s)`);
      }
      if (f.optional && !f.literal) out.open(`if m.${f.goName} != nil {`).raw(body.toString()).close();
      else out.open("{").raw(body.toString()).close();
    }
    out.line("return n, nil");
    out.close();
    out.line();

    out.raw(docComment("FromXMLNode decodes the value from an XML element (@typespec/xml rules)."));
    out.open(d.external ? `func decodeExternalXML${d.id}(m *${N}, n *tsgo.XMLNode) error {` : `func (m *${N}) FromXMLNode(n *tsgo.XMLNode) error {`);
    const xmlName = (p: ModelProperty) => this.nameExpr(resolveEncodedName(this.program, p, "application/xml"), p);
    const isAttr = (p: ModelProperty) => lib.isAttribute(this.program, p);
    if (d.closed || this.g.unknownPolicy === "tsgo.RejectUnknown") {
      const allowed = [...fields.map(f => f.prop), ...(d.ignored ?? [])];
      const text = allowed.filter(p => !isAttr(p) && lib.isUnwrapped(this.program, p) && p.type.kind !== "Model");
      const elems = allowed.filter(p => !isAttr(p) && !text.includes(p)).map(xmlName);
      const attrs = allowed.filter(isAttr).map(xmlName);
      out.open(`if err := n.CheckContent([]tsgo.XMLName{${elems.join(", ")}}, []tsgo.XMLName{${attrs.join(", ")}}, ${!!text.length}); err != nil {`)
        .line("return err").close();
    } else {
      for (const f of (d.fields ?? []).filter(f => f.never)) {
        const name = xmlName(f.prop);
        out.open(isAttr(f.prop) ? `if _, ok := n.Attr(${name}); ok {` : `if len(n.ChildrenNamed(${name})) > 0 {`)
          .line(`return tsgo.XMLPath(${goString(resolveEncodedName(this.program, f.prop, "application/xml"))}, errors.New("property of type never must be absent"))`).close();
      }
    }
    out.line(`var out ${N}`);
    for (const f of fields) {
      const prop = f.prop as ModelProperty;
      const local = resolveEncodedName(this.program, prop, "application/xml");
      const name = this.nameExpr(local, prop);
      const path = goString(local);
      const set = (v: string) => (f.literal ? "_ = " + v : f.optional ? `out.${f.goName} = &${v}` : `out.${f.goName} = ${v}`);
      const parse = (src: string, t: GoType, o: Code, dst: string) => {
        o.line(`${dst}, err := ${t.text}.Parse(${src})`);
        o.open("if err != nil {").line(`return tsgo.XMLPath(${path}, err)`).close();
      };
      const missing = f.optional ? [] : [`return tsgo.XMLPath(${path}, errors.New("required element is missing"))`];
      const attr = lib.isAttribute(this.program, prop);
      const unwrapped = lib.isUnwrapped(this.program, prop);
      out.open("{");
      if (attr) {
        out.line(`s, ok := n.Attr(${name})`);
        out.open("if ok {");
        parse("s", f.type, out, "v");
        out.line(set("v"));
        if (missing.length) out.mid("} else {").lines_([`return tsgo.XMLPath(${path}, errors.New("required attribute is missing"))`]);
        out.close();
      } else if (f.type.cat === "array") {
        const e = f.type.elem!;
        out.line(`v := ${f.type.expr}{}`);
        if (!unwrapped) {
          out.line(`w, err := n.Child(${name})`);
          out.open("if err != nil {").line("return err").close();
          out.open("if w != nil {");
          out.open(`if err := w.CheckContent([]tsgo.XMLName{${this.typeName(e)}}, nil, false); err != nil {`).line(`return tsgo.XMLPath(${path}, err)`).close();
        }
        const items = unwrapped ? `n.ChildrenNamed(${name})` : `w.ChildrenNamed(${this.typeName(e)})`;
        out.open(`for i, c := range ${items} {`);
        if (e.decl?.kind === "model") {
          out.line(`var x ${e.expr}`);
          out.open(`if err := ${this.decodeCall(e.decl, "x", "c")}; err != nil {`).line(`return tsgo.XMLPath(${path}, tsgo.WithPath(i, err))`).close();
        } else {
          out.open("if err := c.CheckContent(nil, nil, true); err != nil {").line(`return tsgo.XMLPath(${path}, tsgo.WithPath(i, err))`).close();
          out.line(`x, err := ${e.text}.Parse(c.Text)`);
          out.open("if err != nil {").line(`return tsgo.XMLPath(${path}, tsgo.WithPath(i, err))`).close();
        }
        out.line("v = append(v, x)");
        out.close();
        if (!unwrapped) {
          out.line(set("v"));
          if (missing.length) out.mid("} else {").lines_(missing);
          out.close();
        } else {
          // An unwrapped array is absent when it has no element; required ones are then empty.
          if (f.optional) out.open("if len(v) > 0 {").line(set("v")).close();
          else out.line(set("v"));
        }
      } else if (f.type.cat === "map") {
        out.line(`w, err := n.Child(${name})`);
        out.open("if err != nil {").line("return err").close();
        out.open("if w != nil {");
        out.open("if err := w.CheckRecordContent(); err != nil {").line(`return tsgo.XMLPath(${path}, err)`).close();
        out.line(`v := ${f.type.expr}{}`);
        out.open("for _, c := range w.ElementChildren() {");
        const lookup = f.type.ordered ? "v.Get(c.Name.Local)" : "v[c.Name.Local]";
        out.open(`if _, exists := ${lookup}; exists || c.Name.Space != "" {`).line(`return tsgo.XMLPath(${path}, fmt.Errorf("ambiguous record key %q", c.Name.Local))`).close();
        const e = f.type.elem!;
        const entryError = `return tsgo.XMLPath(${path}, tsgo.WithPath(c.Name.Local, err))`;
        if (e.decl?.kind === "model") {
          out.line(`var x ${e.expr}`);
          out.open(`if err := ${this.decodeCall(e.decl, "x", "c")}; err != nil {`).line(entryError).close();
        } else {
          out.open("if err := c.CheckContent(nil, nil, true); err != nil {").line(entryError).close();
          out.line(`x, err := ${e.text}.Parse(c.Text)`);
          out.open("if err != nil {").line(entryError).close();
        }
        out.line(f.type.ordered ? "v.Set(c.Name.Local, x)" : "v[c.Name.Local] = x");
        out.close();
        out.line(set("v"));
        if (missing.length) out.mid("} else {").lines_(missing);
        out.close();
      } else if (f.type.decl?.kind === "model") {
        out.line(`c, err := n.Child(${name})`);
        out.open("if err != nil {").line("return err").close();
        out.open("if c != nil {");
        out.line(`var v ${f.type.expr}`);
        out.open(`if err := ${this.decodeCall(f.type.decl, "v", "c")}; err != nil {`).line(`return tsgo.XMLPath(${path}, err)`).close();
        out.line(set("v"));
        if (missing.length) out.mid("} else {").lines_(missing);
        out.close();
      } else if (unwrapped) {
        parse("n.Text", f.type, out, "v");
        out.line(set("v"));
      } else {
        out.line(`c, err := n.Child(${name})`);
        out.open("if err != nil {").line("return err").close();
        out.open("if c != nil {");
        out.open("if err := c.CheckContent(nil, nil, true); err != nil {").line(`return tsgo.XMLPath(${path}, err)`).close();
        parse("c.Text", f.type, out, "v");
        out.line(set("v"));
        if (missing.length) out.mid("} else {").lines_(missing);
        out.close();
      }
      out.close();
    }
    out.line("*m = out");
    out.line("return nil");
    out.close();
    out.line();
  }
}

export function isXmlMediaType(ct: string): boolean {
  const mt = ct.toLowerCase();
  return mt === "application/xml" || mt === "text/xml" || mt.endsWith("+xml");
}

export { getNamespaceFullName };
