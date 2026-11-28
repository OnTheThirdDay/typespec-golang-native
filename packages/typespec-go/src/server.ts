/**
 * Strict net/http server generation from the official @typespec/http operation model.
 *
 * The public shape follows oapi-codegen's strict-server mode (StrictServerInterface,
 * <Op>RequestObject, <Op>ResponseObject with Visit<Op>Response, StrictHandlerFunc /
 * StrictMiddlewareFunc, request/response error handlers); its structure is ported from
 * oapi-codegen pkg/codegen/templates/strict/*.tmpl at commit 977b0d44 (Apache-2.0, see
 * THIRD_PARTY_NOTICES.md) and extended. See docs/reuse-assessment.md.
 */
import { type Model, type ModelProperty, type Operation, type Program, type Type, getDoc, getEncode, isArrayModelType, resolveEncodedName } from "@typespec/compiler";
import {
  type HttpOperation,
  type HttpOperationResponse,
  type HttpOperationResponseContent,
  type HttpPayloadBody,
  type HttpService,
  type HttpAuthRef,
  type HttpOperationParameter,
  Visibility,
  resolveAuthentication,
  resolveRequestVisibility,
} from "@typespec/http";
import { defaultJSON } from "./values.js";
import { emitFieldChecks, emitValidateMethods } from "./declgen.js";
import { Code, docComment, goRawString, goString } from "./gowriter.js";
import { createDiagnostic } from "./lib.js";
import { type Constraints, type Decl, type Field, type GoModelGenerator, type GoType, arrayType, hasConstraints, isClosedModel, safeName } from "./model.js";
import { exportedName } from "./naming/index.js";
import { isXmlMediaType } from "./xml.js";
import type { SseStream } from "./sse.js";

class Unsupported extends Error {}

export type ServerDescription = {
  operation: Operation;
  goName: string;
  id: string;
  method: string;
  path: string;
  hasBody: boolean;
  requestStream: boolean;
  params: { location: string; wire: string; optional: boolean }[];
  literalQuery: boolean;
  requestContentTypes: string[];
  requestBodyRequired: boolean;
  bodyMedia: string[];
  variants: {
    name: string;
    status: { kind: "fixed"; code: number } | { kind: "range"; min: number; max: number } | { kind: "default" };
    body?: { media: string[]; contentTypes: string[]; optional: boolean; expr: string };
    sse?: { unmarshal: string; elem: string };
    jsonl?: { elem: string };
    headers: { goName: string; wire: string; optional: boolean }[];
  }[];
}[];

interface ParamField {
  goName: string;
  location: "path" | "query" | "header" | "cookie";
  wire: string;
  prop: ModelProperty;
  type: GoType;
  optional: boolean;
  isArray: boolean;
  elem?: GoType;
  style?: string;
  explode: boolean;
  allowReserved?: boolean;
  arrayEncoding?: string;
  segment?: number;
  rest?: boolean;
  /** Complex routes: the RFC 6570 expansion capturing this parameter. */
  expansion?: { op: string; explode: boolean; group: number };
  /** Records (map) and models in parameters. */
  shape: "value" | "array" | "record" | "model";
  constraints: Constraints;
  defaultJson?: string;
  /** The Content-Type header parameter: filled from content negotiation. */
  contentType?: boolean;
}

type BodyMedia = "json" | "text" | "binary" | "file" | "multipart" | "xml" | "sse" | "jsonl" | "form";

interface BodyInfo {
  type: GoType;
  optional: boolean;
  /** Only metadata or invisible properties remain in an implicit request body. */
  metadataOnly?: boolean;
  contentTypes: string[];
  media: Map<string, BodyMedia>;
  multipart?: MultipartPart[];
  multipartDecl?: string;
  closedParts?: boolean;
  /** Server-sent events stream (response bodies of SSEStream<Events>). */
  sse?: SseStream;
  /** JSON Lines stream element (JsonlStream<T> bodies). */
  jsonl?: GoType;
}

interface MultipartPart {
  name: string;
  goName: string;
  type: GoType;
  kind: "text" | "json" | "file" | "binary";
  optional: boolean;
  multi: boolean;
  contentTypes: string[];
}

interface ResponseVariant {
  name: string;
  status: { kind: "fixed"; code: number } | { kind: "range"; min: number; max: number } | { kind: "default" };
  headers: { goName: string; wire: string; prop: ModelProperty; type: GoType; optional: boolean; isArray: boolean; elem?: GoType; constraints: Constraints }[];
  body?: BodyInfo;
  doc?: string;
  /** Literal Content-Type header of a response without body (e.g. HEAD). */
  fixedContentType?: string;
}

interface RouteInfo {
  /** ServeMux pattern (without method). */
  mux: string;
  /** Route needs template matching beyond ServeMux wildcards. */
  complex: boolean;
  /** RE2 regular expression matching the escaped request path. */
  regex: string;
  /** Path variables: name → expansion. */
  expansions: Map<string, { op: string; explode: boolean; group: number }>;
  /** Literal query parameters written in the route (`?fixed=true`). */
  literalQuery: [string, string][];
  /** Number of literal characters (specificity for dispatch ordering). */
  literalLength: number;
}

interface OpModel {
  op: HttpOperation;
  goName: string;
  id: string;
  pattern: string;
  segments: string[];
  route: RouteInfo;
  /** Literal Accept header (content negotiation between @sharedRoute operations). */
  acceptLiteral?: string;
  params: ParamField[];
  body?: BodyInfo;
  variants: ResponseVariant[];
  security: string;
  doc?: string;
}

export class GoServerGenerator {
  readonly ops: OpModel[] = [];
  private readonly usedOpNames = new Set<string>();

  constructor(
    private readonly program: Program,
    private readonly g: GoModelGenerator,
  ) {}

  private unsupported(target: Type, reason: string): never {
    this.g.diagnostics.push(createDiagnostic({ code: "unsupported-http", target, format: { reason } }));
    throw new Unsupported();
  }

  /** Go identifiers the server code declares (reserved for model naming). */
  reservedNames(): Set<string> {
    const s = new Set(["StrictServerInterface", "NewHandler", "RegisterHandlers", "OperationInfos", "ServerOptions", "StrictHandlerFunc", "StrictMiddlewareFunc"]);
    for (const st of this.g.sse?.streams ?? []) s.add(`Unmarshal${st.stem}SSE`);
    for (const o of this.ops) {
      s.add(`${o.goName}RequestObject`);
      s.add(`${o.goName}ResponseObject`);
      for (const v of o.variants) {
        s.add(v.name);
        if (v.body?.multipartDecl) s.add(v.body.multipartDecl);
      }
      if (o.body?.multipartDecl) s.add(o.body.multipartDecl);
    }
    return s;
  }

  collect(service: HttpService): void {
    const used = this.usedOpNames;
    const auth = resolveAuthentication(service);
    for (const op of service.operations) {
      try {
        const m = this.operation(op, used, auth.operationsAuth.get(op.operation) ?? auth.defaultAuth);
        this.ops.push(m);
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
      }
    }
    this.checkRouteConflicts();
  }

  // ------------------------------------------------------------------ operation model

  private operation(op: HttpOperation, used: Set<string>, auth: { options: readonly { all: readonly HttpAuthRef[] }[] }): OpModel {
    const o = op.operation;
    this.g.checkDecorators(o as any);
    const container = op.container.kind === "Interface" ? op.container.name : "";
    let goName = (container ? exportedName(container) : "") + exportedName(o.name);
    if (op.container.kind !== "Interface" && op.container.namespace && used.has(goName)) goName = exportedName(op.container.name) + goName;
    while (used.has(goName)) goName += "_";
    used.add(goName);
    const id = container ? `${container}_${o.name}` : o.name;

    const route = this.route(op);
    const vis = resolveRequestVisibility(this.program, o, op.verb);
    const model: OpModel = {
      op,
      goName,
      id,
      pattern: `${op.verb.toUpperCase()} ${route.mux}`,
      segments: route.mux.split("/").slice(1),
      route,
      params: [],
      variants: [],
      security: this.security(auth),
      doc: getDoc(this.program, o),
    };
    const usedFields = new Set(["Body", "ContentType", "Validate", "ApplyDefaults"]);
    for (const p of op.parameters.parameters) {
      if (p.type === "header" && p.name.toLowerCase() === "content-type" && isSingleLiteral(p.param.type)) continue; // fixed by the body media types
      if (p.type === "header" && p.name.toLowerCase() === "accept" && p.param.type.kind === "String") {
        model.acceptLiteral = p.param.type.value; // content negotiation: checked by the dispatcher
        continue;
      }
      model.params.push(this.param(op, p, model, vis, usedFields));
    }
    if (op.parameters.body) model.body = this.body(op.parameters.body, vis, `${goName}RequestBody`, o, "request");
    for (const r of op.responses) this.responses(model, r);
    return model;
  }

  /**
   * Parses the operation's RFC 6570 URI template. Routes whose expressions are whole-segment
   * simple variables (and a final reserved `{+x}`) map to ServeMux wildcards directly; all others
   * register their literal prefix with a `{tail...}` wildcard and are matched by a compiled
   * template regex in a generated dispatcher.
   */
  private route(op: HttpOperation): RouteInfo {
    const tpl = op.uriTemplate.startsWith("/") ? op.uriTemplate : "/" + op.uriTemplate;
    // Split path and query: the query starts at `{?`, `{&` or a literal `?` outside expressions.
    let cut = tpl.length;
    let depth = 0;
    for (let i = 0; i < tpl.length; i++) {
      const c = tpl[i];
      if (c === "{") {
        if (tpl[i + 1] === "?" || tpl[i + 1] === "&") {
          cut = i;
          break;
        }
        depth++;
      } else if (c === "}") depth--;
      else if (c === "?" && depth === 0) {
        cut = i;
        break;
      }
    }
    const path = tpl.slice(0, cut);
    const literalQuery: [string, string][] = [];
    for (const lit of tpl.slice(cut).replace(/\{[^}]*\}/g, "&").split(/[?&]/)) {
      if (!lit) continue;
      const [k, v = ""] = lit.split("=");
      literalQuery.push([decodeURIComponent(k), decodeURIComponent(v)]);
    }
    type Tok = { lit: string } | { op: string; name: string; explode: boolean; namedMatrix: boolean };
    const tokens: Tok[] = [];
    let last = 0;
    for (const m of path.matchAll(/\{([+#./;?&]?)([^}]*)\}/g)) {
      if (m.index! > last) tokens.push({ lit: path.slice(last, m.index) });
      const vars = m[2].split(",");
      if (m[1] === "#") this.unsupported(op.operation, "fragment expansion {#x} is never sent to a server");
      for (const [i, variable] of vars.entries()) {
        const name = variable.replace(/(?:\*|:\d+)$/, "");
        const param = op.parameters.parameters.find(p => p.type === "path" && p.name === name)?.param;
        const prefix = /:(\d+)$/.exec(variable);
        if (prefix) {
          const limits = [param && this.g.constraintsOf(param).maxLength];
          for (let t = param?.type; t?.kind === "Scalar"; t = t.baseScalar!) limits.push(this.g.constraintsOf(t).maxLength);
          const max = Math.min(...limits.filter((x): x is number => x !== undefined));
          if (max > Number(prefix[1])) this.unsupported(op.operation, `URI template prefix modifier in ${m[0]} loses the suffix; constrain @maxLength to the prefix length`);
        }
        const namedMatrix = vars.length > 1 && m[1] === ";" && !(variable.endsWith("*") && param?.type.kind === "Model" && !isArrayModelType(param.type));
        if (vars.length > 1 && !namedMatrix && (param?.optional || param?.type.kind === "Model" || m[1] === "+" || m[1] === ".")) {
          this.unsupported(op.operation, `URI expression ${m[0]} cannot uniquely separate optional, composite or unescaped values`);
        }
        if (i && m[1] === "") tokens.push({ lit: "," });
        tokens.push({ op: m[1], name, explode: variable.endsWith("*"), namedMatrix });
      }
      last = m.index! + m[0].length;
    }
    if (last < path.length) tokens.push({ lit: path.slice(last) });

    const optional = (name: string) => op.parameters.parameters.some((p) => p.type === "path" && p.name === name && p.param.optional);
    const pathShape = (name: string) => {
      const p = op.parameters.parameters.find((x) => x.type === "path" && x.name === name);
      const t = p?.param.type;
      return t && t.kind === "Model" && !isArrayModelType(t) ? "object" : "other";
    };
    const isWholeSegment = (i: number) => {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      return (!prev || ("lit" in prev && prev.lit.endsWith("/"))) && (!next || ("lit" in next && next.lit.startsWith("/")));
    };
    let complex = /:\d+\}/.test(path);
    tokens.forEach((t, i) => {
      if ("lit" in t) return;
      const plain = !optional(t.name) && pathShape(t.name) !== "object" && isWholeSegment(i);
      const simple = plain && (t.op === "" || (t.op === "+" && i === tokens.length - 1));
      if (!simple) complex = true;
    });

    // Regex over the escaped path; literal text is compared as written in the template.
    let regex = "^";
    let group = 0;
    let literalLength = 0;
    const expansions = new Map<string, { op: string; explode: boolean; group: number }>();
    for (const [index, t] of tokens.entries()) {
      if ("lit" in t) {
        regex += escapeRe(t.lit);
        literalLength += t.lit.length;
        continue;
      }
      const opt = optional(t.name);
      const next = tokens[index + 1];
      const body = next && "lit" in next && next.lit === "," ? "[^,/?#]" :
        t.op === ";" && next && "op" in next && next.op === ";" ? "[^;/?#]" : t.op === "+" ? "[^?#]" : "[^/?#]";
      let g: string;
      switch (t.op) {
        case ";":
          if (t.namedMatrix) {
            const field = `;${escapeRe(t.name)}(?:=[^;/?#]*)?`;
            g = `((?:${field})${t.explode ? (opt ? "*" : "+") : (opt ? "?" : "")})`;
          } else {
            g = `((?:;${body}*)${opt ? "?" : ""})`;
          }
          break;
        case "":
        case "+":
          g = `(${body}${opt ? "*" : "+"})`;
          break;
        case "/":
          g = t.explode ? `((?:/${body}*)${opt ? "*" : "+"})` : `((?:/${body}*)${opt ? "?" : ""})`;
          break;
        default: {
          const pre = t.op === "." ? "\\." : ";";
          g = `((?:${pre}${body}*)${opt ? "?" : ""})`;
        }
      }
      regex += g;
      expansions.set(t.name, { op: t.op, explode: t.explode, group: ++group });
    }
    regex += "$";

    let mux: string;
    if (!complex) {
      let wildcard = 0;
      const segs = path
        .split("/")
        .slice(1)
        .map((seg) => {
          const m = /^\{(\+?)([^}]+)\}$/.exec(seg);
          if (!m) return seg;
          return m[1] === "+" ? `{p${wildcard++}...}` : `{p${wildcard++}}`;
        });
      mux = "/" + segs.join("/");
      if (mux.endsWith("/")) mux += "{$}";
    } else {
      const firstExpr = tokens.findIndex((t) => !("lit" in t));
      const prefix = tokens
        .slice(0, firstExpr)
        .map((t) => ("lit" in t ? t.lit : ""))
        .join("");
      mux = prefix.slice(0, prefix.lastIndexOf("/") + 1) + "{tail...}";
    }
    return { mux, complex, regex, expansions, literalQuery, literalLength };
  }

  private security(auth: { options: readonly { all: readonly HttpAuthRef[] }[] }): string {
    if (!auth.options.length) return "nil";
    const reqs = auth.options.map((opt) => {
      const schemes = opt.all.map((ref) => {
        const a: any = ref.auth;
        const fields = [`ID: ${goString(a.id)}`, `Type: ${goString(a.type)}`];
        if (a.type === "http") fields.push(`Scheme: ${goString(a.scheme)}`);
        if (a.type === "apiKey") fields.push(`In: ${goString(a.in)}`, `Name: ${goString(a.name)}`);
        if (ref.kind === "oauth2" && ref.scopes.length) fields.push(`Scopes: []string{${ref.scopes.map(goString).join(", ")}}`);
        return `{${fields.join(", ")}}`;
      });
      return `{${schemes.join(", ")}}`;
    });
    return `[]tsgo.SecurityRequirement{${reqs.join(", ")}}`;
  }

  private param(op: HttpOperation, p: HttpOperationParameter, model: OpModel, vis: number, used: Set<string>): ParamField {
    const prop = p.param;
    this.g.checkDecorators(prop);
    let goName = exportedName(prop.name);
    while (used.has(goName)) goName += "Param";
    used.add(goName);
    const ctx = { vis, hint: model.goName + goName, site: prop };
    const type = this.g.guard(() => this.g.paramScalar(prop, p.type, ctx), () => undefined as any as GoType);
    if (!type) throw new Unsupported();
    const isArray = type.cat === "array";
    const elem = isArray || type.cat === "map" ? type.elem : undefined;
    const shape: ParamField["shape"] = isArray ? "array" : type.cat === "map" ? "record" : type.decl?.kind === "model" ? "model" : "value";
    if (type.cat === "nullable") this.unsupported(prop, `nullable ${p.type} parameter '${p.name}' has no wire representation of null`);
    if (shape === "model") {
      if (p.type !== "query" && p.type !== "path") this.unsupported(prop, `model-typed ${p.type} parameters are not supported`);
      for (const f of type.decl!.fields ?? []) if (!f.never && !f.type.text && !f.sourceText) this.unsupported(prop, `${p.type} object parameter '${p.name}': property '${f.json}' has no text representation`);
      if (type.decl!.additional && !type.decl!.additional.text) this.unsupported(prop, `${p.type} object parameter '${p.name}': additional properties have no scalar text representation`);
    } else {
      const textOf = elem ? elem.text : type.text;
      if (!textOf) this.unsupported(prop, `${p.type} parameter '${p.name}' of type ${safeName(prop.type)} has no text representation (nested arrays are not supported in parameters)`);
    }
    if (shape === "record" && (p.type === "header" || p.type === "cookie")) this.unsupported(prop, `record-typed ${p.type} parameters are not supported`);
    if (this.g.orderedRecords && (shape === "record" || (shape === "model" && type.decl!.additional))) {
      this.unsupported(prop, `${p.type} parameter '${p.name}': records in parameters have no ordered representation (option ordered-records)`);
    }
    const f: ParamField = {
      goName,
      location: p.type,
      wire: p.name,
      prop,
      type,
      optional: prop.optional,
      isArray,
      elem,
      explode: !!(p as any).explode,
      shape,
      constraints: this.g.constraintsOf(prop),
    };
    if (p.type === "path") {
      f.style = (p as any).style as string;
      f.allowReserved = (p as any).allowReserved;
      const exp = model.route.expansions.get(p.name);
      if (!exp) this.unsupported(prop, `path parameter '${p.name}' does not appear in the route template`);
      if (shape === "model" && (exp.op === "+" || (exp.op === "." && exp.explode))) {
        this.unsupported(prop, `model path parameter '${p.name}': reserved or exploded label expansion does not uniquely delimit fields`);
      }
      if (model.route.complex) {
        f.expansion = exp;
      } else {
        if (shape !== "value" && shape !== "array") this.unsupported(prop, `${shape} path parameter '${p.name}' needs a template expansion`);
        const tplSegs = model.op.uriTemplate.replace(/\{[?&][^}]*\}.*$/, "").split("/").slice(1);
        const idx = tplSegs.findIndex((x) => x.replace(/^\{\+?/, "").replace(/\*?\}$/, "") === p.name);
        f.segment = idx;
        f.rest = tplSegs[idx]?.startsWith("{+");
      }
    }
    if (p.type === "query" && isArray) {
      const enc = getEncode(this.program, prop);
      const e = enc?.encoding?.replace(/^.*\./, "");
      if (e) {
        if (!["commaDelimited", "spaceDelimited", "pipeDelimited", "newlineDelimited"].includes(e)) this.unsupported(prop, `query array encoding '${e}' is not supported`);
        f.arrayEncoding = e;
        if (f.explode) this.unsupported(prop, `query array encoding '${e}' cannot be combined with explode`);
      }
    }
    if (p.type === "header" && p.name.toLowerCase() === "content-type") f.contentType = true;
    if (prop.defaultValue) {
      try {
        f.defaultJson = defaultJSON(this.program, prop.defaultValue, prop);
      } catch (err) {
        this.unsupported(prop, `invalid parameter default: ${String(err)}`);
      }
    }
    return f;
  }

  private body(b: HttpPayloadBody, vis: number, anonName: string, site: Type, dir: "request" | "response"): BodyInfo {
    const contentTypes = b.contentTypes.length ? [...b.contentTypes] : ["application/json"];
    const optional = !!(b.property?.optional);
    if (b.bodyKind === "file") {
      const media = new Map(contentTypes.map((c) => [c, "file" as BodyMedia]));
      return { type: { expr: "tsgo.File", codec: "", cat: "other", validate() {}, hasValidation: () => false, defaults() {}, hasDefaults: () => false }, optional, contentTypes, media };
    }
    if (b.bodyKind === "multipart") {
      const closedParts = (b.type.kind === "Model" && isClosedModel(b.type)) || this.g.unknownPolicy === "tsgo.RejectUnknown";
      // Tuple form ([HttpPart<T, #{name: "a"}>, ...]) is handled like the model form when every part is named.
      if (!contentTypes.every((c) => c === "multipart/form-data")) this.unsupported(site, `multipart media type ${contentTypes.join(", ")} is not supported (only multipart/form-data)`);
      const parts: MultipartPart[] = [];
      const usedNames = new Set<string>();
      const wireNames = new Set<string>();
      for (const part of b.parts) {
        if (!part.name) this.unsupported(site, "multipart parts must be named");
        if (wireNames.has(part.name)) this.unsupported(site, `duplicate multipart part name '${part.name}'`);
        wireNames.add(part.name);
        let goName = exportedName(part.name);
        while (usedNames.has(goName)) goName += "_";
        usedNames.add(goName);
        let kind: MultipartPart["kind"];
        let type: GoType;
        if (part.body.bodyKind === "file") {
          kind = "file";
          type = { expr: "tsgo.File", codec: "", cat: "other", validate() {}, hasValidation: () => false, defaults() {}, hasDefaults: () => false };
        } else {
          const t = this.payloadType(part.body.type, vis);
          type = this.g.typeRef(t, { vis, hint: anonName + goName, site });
          const cts = part.body.contentTypes;
          const isJson = cts.length === 0 ? !(type.expr === "string" || type.expr === "[]byte") : cts.some((c) => /json/i.test(c));
          kind = isJson ? "json" : type.expr === "string" ? "text" : type.expr === "[]byte" ? "binary" : "json";
        }
        if (part.headers.some(h => !["content-type", "content-disposition"].includes(h.options.name.toLowerCase()))) {
          this.unsupported(site, `custom MIME headers on part '${part.name}' require a typed header binding`);
        }
        parts.push({ name: part.name, goName, type, kind, optional: part.optional, multi: part.multi, contentTypes: [...part.body.contentTypes] });
      }
      return { type: { expr: anonName, codec: "", cat: "other", hasValidation: () => true, validate: (val, v, out) => { out.line(`${val}.ValidateWith(${v})`); }, hasDefaults: () => false, defaults() {} }, optional, contentTypes, media: new Map([["multipart/form-data", "multipart"]]), multipart: parts, multipartDecl: anonName, closedParts };
    }
    const streamElem = dir === "request" && b.property?.model ? this.g.sse?.streamOf(b.property.model) : undefined;
    if (streamElem) {
      if (!contentTypes.every(isJsonLines)) this.unsupported(site, `request stream media type ${contentTypes.join(", ")} is not supported (JSON Lines is)`);
      const elem = this.g.typeRef(streamElem, { vis, hint: anonName + "Item", site });
      return {
        type: { expr: `iter.Seq2[${elem.expr}, error]`, codec: "", cat: "other", validate() {}, hasValidation: () => false, defaults() {}, hasDefaults: () => false },
        optional,
        contentTypes,
        media: new Map(contentTypes.map((x) => [x, "jsonl" as BodyMedia])),
        jsonl: elem,
      };
    }
    const declared = this.payloadType(b.type, vis);
    // application/merge-patch+json request bodies are RFC 7396 patch documents.
    const mergePatch = dir === "request" && contentTypes.every((c) => /^application\/merge-patch\+json$/i.test(c));
    // An explicit body property may carry an encoding (e.g. `@body @encode(base64url) data: bytes`).
    const type =
      b.property && b.property.type === b.type && getEncode(this.program, b.property)
        ? this.g.propertyType(b.property, { vis, hint: anonName, site })
        : this.g.typeRef(declared, { vis, hint: anonName, site, mergePatch });
    const media = new Map<string, BodyMedia>();
    for (const c of contentTypes) {
      const lc = c.toLowerCase();
      if (lc === "application/json" || lc.endsWith("+json")) media.set(c, "json");
      else if (lc === "application/x-www-form-urlencoded" && type.decl?.kind === "model") {
        for (const f of type.decl.fields ?? []) {
          const t = f.type.cat === "array" ? f.type.elem! : f.type;
          if (!f.never && !t.text) this.unsupported(f.prop, `form field '${f.json}' has no text representation`);
        }
        const add = type.decl.additional;
        if (add && this.g.orderedRecords) this.unsupported(site, "form additional properties have no ordered representation (option ordered-records)");
        if (add && !(add.cat === "array" ? add.elem! : add).text) this.unsupported(site, "form additional properties require a scalar text representation");
        const names = (type.decl.fields ?? []).map(f => resolveEncodedName(this.program, f.prop, lc));
        if (new Set(names).size !== names.length) this.unsupported(site, "duplicate form field name after applying @encodedName");
        media.set(c, "form");
      }
      else if (isXmlMediaType(lc) && type.decl?.kind === "model") {
        if (!this.g.xml!.mark(type, site)) throw new Unsupported();
        media.set(c, "xml");
      }
      else if ((type.expr === "string" || (lc.startsWith("text/") && type.text)) && !/xml|form-urlencoded|multipart/.test(lc)) media.set(c, "text"); // raw text (e.g. text/plain, application/jsonl)
      else if (type.expr === "[]byte" && !/xml|form-urlencoded/.test(lc)) media.set(c, "binary");
      else this.unsupported(site, `${dir} media type '${c}' with body ${safeName(b.type)} is not supported (JSON, text/* strings and binary bytes are)`);
    }
    const metadataOnly = dir === "request" && !b.isExplicit && declared.kind === "Model" && [...allProps(declared)].length > 0
      && type.decl?.kind === "model" && type.decl.fields?.length === 0 && !type.decl.additional;
    return { type, optional, contentTypes, media, metadataOnly };
  }

  /**
   * The HTTP library pre-filters implicit bodies into anonymous spreads of the declared model.
   * Map such a spread back to the declared model, so the visibility variant (e.g. WidgetRead)
   * is shared with explicit bodies instead of producing a structurally identical anonymous type.
   */
  private payloadType(t: Type, vis: number): Type {
    if (t.kind !== "Model" || t.name || isArrayModelType(t)) return t;
    const src = t.sourceModels ?? [];
    if (src.length !== 1 || src[0].usage !== "spread" || !src[0].model.name) return t;
    const m = src[0].model;
    const expected = [...allProps(m)].filter((p) => this.g.metadata.isPayloadProperty(p, vis)).map((p) => p.name);
    const actual = [...t.properties.keys()];
    if (expected.length === actual.length && expected.every((n, i) => n === actual[i])) return m;
    return t;
  }

  private responses(model: OpModel, r: HttpOperationResponse): void {
    const status: ResponseVariant["status"] =
      r.statusCodes === "*" ? { kind: "default" } : typeof r.statusCodes === "number" ? { kind: "fixed", code: r.statusCodes } : { kind: "range", min: r.statusCodes.start, max: r.statusCodes.end };
    if ((status.kind === "fixed" && (status.code < 200 || status.code > 599)) ||
        (status.kind === "range" && (status.max < 200 || status.min > 599))) {
      this.unsupported(model.op.operation, "a strict response must have a final HTTP status in 200–599");
    }
    const tag =
      status.kind === "default" ? "Default" : status.kind === "fixed" ? String(status.code) : status.max - status.min === 99 && status.min % 100 === 0 ? `${status.min / 100}XX` : `${status.min}To${status.max}`;
    r.responses.forEach((c: HttpOperationResponseContent, i: number) => {
      const events = this.g.sse?.streamOf(r.type);
      let body: BodyInfo | undefined;
      if (events && c.body && !c.body.contentTypes.some((x) => /^text\/event-stream$/i.test(x))) {
        if (!c.body.contentTypes.every(isJsonLines)) this.unsupported(model.op.operation, `stream media type ${c.body.contentTypes.join(", ")} is not supported (text/event-stream and JSON Lines are)`);
        const elem = this.g.typeRef(events, { vis: Visibility.Read, hint: `${model.goName}${tag}Item`, site: model.op.operation });
        body = {
          type: { expr: `iter.Seq[${elem.expr}]`, codec: "", cat: "other", validate() {}, hasValidation: () => false, defaults() {}, hasDefaults: () => false },
          optional: false,
          contentTypes: [...c.body.contentTypes],
          media: new Map(c.body.contentTypes.map((x) => [x, "jsonl" as BodyMedia])),
          jsonl: elem,
        };
      } else if (events && c.body) {
        const stream = this.g.sse!.stream(events, model.op.operation, Visibility.Read);
        if (!stream) throw new Unsupported();
        const elem = stream.elem.expr;
        body = {
          type: { expr: `iter.Seq[tsgo.SSE[${elem}]]`, codec: "", cat: "other", validate() {}, hasValidation: () => false, defaults() {}, hasDefaults: () => false },
          optional: false,
          contentTypes: ["text/event-stream"],
          media: new Map([["text/event-stream", "sse"]]),
          sse: stream,
        };
      } else {
        body = c.body ? this.body(c.body, Visibility.Read, `${model.goName}${tag}ResponseBody`, model.op.operation, "response") : undefined;
      }
      const kinds = body ? [...new Set(body.media.values())] : [];
      const bodyTag = kinds.length === 1 ? { json: "JSON", text: "Text", binary: "Binary", file: "File", multipart: "Multipart", xml: "XML", sse: "Stream", jsonl: "Stream", form: "Form" }[kinds[0]] : kinds.length ? "Body" : "";
      let name = `${model.goName}${tag}${bodyTag}Response`;
      if (model.variants.some((v) => v.name === name)) name = `${model.goName}${tag}${bodyTag}${i + 1}Response`;
      const used = new Set(["Body", "StatusCode", "ContentType"]);
      const headers: ResponseVariant["headers"] = [];
      let fixedContentType: string | undefined;
      for (const [wire, prop] of Object.entries(c.headers ?? {})) {
        if (wire.toLowerCase() === "content-type") {
          // Derived from the body media type; without a body a literal value is sent as-is.
          if (!body && prop.type.kind === "String") {
            fixedContentType = prop.type.value;
            continue;
          }
          if (body) continue;
          // Without a body (e.g. HEAD) a declared Content-Type is an ordinary header.
        }
        let goName = exportedName(prop.name);
        while (used.has(goName)) goName += "Header";
        used.add(goName);
        const type = this.g.paramScalar(prop, "header", { vis: Visibility.Read, hint: name + goName, site: prop });
        const isArray = type.cat === "array";
        if (!(isArray ? type.elem!.text : type.text)) this.unsupported(prop, `response header '${wire}' has no text representation`);
        headers.push({ goName, wire, prop, type, optional: prop.optional, isArray, elem: type.elem, constraints: this.g.constraintsOf(prop) });
      }
      model.variants.push({ name, status, headers, body, doc: r.description, fixedContentType });
    });
  }

  /** Operations sharing a ServeMux pattern are dispatched by their template regex. */
  /** Go types written by responses: bodies, stream items and events, multipart parts. */
  responseTypes(): GoType[] {
    const out: GoType[] = [];
    for (const o of this.ops) {
      for (const v of o.variants) {
        const b = v.body;
        if (!b) continue;
        if ([...b.media.values()].includes("json")) out.push(b.type);
        if (b.jsonl) out.push(b.jsonl);
        for (const k of b.sse?.kinds ?? []) {
          if (!/^text\//i.test(k.contentType)) out.push(k.data?.at(-1)?.type ?? k.type);
        }
        for (const p of b.multipart ?? []) if (p.kind === "json") out.push(p.type);
      }
    }
    return out;
  }

  private routeGroups(): { pattern: string; ops: OpModel[]; dispatch: boolean }[] {
    const groups = new Map<string, OpModel[]>();
    for (const o of this.ops) {
      const list = groups.get(o.pattern) ?? [];
      list.push(o);
      groups.set(o.pattern, list);
    }
    return [...groups.entries()].map(([pattern, ops]) => {
      const sorted = [...ops].sort((a, b) => b.route.literalLength - a.route.literalLength);
      const dispatch = sorted.length > 1 || sorted[0].route.complex || sorted[0].route.literalQuery.length > 0;
      return { pattern, ops: sorted, dispatch };
    });
  }

  private checkRouteConflicts(): void {
    const groups = this.routeGroups();
    for (const g of groups) {
      for (let i = 0; i < g.ops.length; i++) {
        for (let j = i + 1; j < g.ops.length; j++) {
          const a = g.ops[i];
          const b = g.ops[j];
          const sameNegotiation = a.acceptLiteral === b.acceptLiteral && JSON.stringify(a.body?.contentTypes) === JSON.stringify(b.body?.contentTypes);
          if (a.route.regex === b.route.regex && JSON.stringify(a.route.literalQuery) === JSON.stringify(b.route.literalQuery) && sameNegotiation) {
            this.g.diagnostics.push(
              createDiagnostic({
                code: "unsupported-http",
                target: b.op.operation,
                format: { reason: `route of ${b.id} is identical to the route of ${a.id}; shared routes need a dispatch rule (see @sharedRoute support)` },
              }),
            );
          }
        }
      }
    }
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const [ma, pa] = groups[i].pattern.split(" ");
        const [mb, pb] = groups[j].pattern.split(" ");
        if (ma !== mb) continue;
        if (ambiguous(pa, pb)) {
          this.g.diagnostics.push(
            createDiagnostic({
              code: "unsupported-http",
              target: groups[j].ops[0].op.operation,
              format: { reason: `routes '${groups[i].pattern}' and '${groups[j].pattern}' overlap and neither is more specific; net/http.ServeMux rejects them` },
            }),
          );
        }
      }
    }
  }

  /** Operation/response metadata for tooling and conformance tests. */
  describe(names: (expr: string) => string): ServerDescription {
    return this.ops.map((o) => ({
      operation: o.op.operation,
      goName: o.goName,
      id: o.id,
      method: o.op.verb.toUpperCase(),
      path: o.op.path,
      hasBody: !!o.body,
      requestStream: !!o.body?.jsonl,
      params: o.params.map((p) => ({ location: p.location, wire: p.wire, optional: p.optional })),
      literalQuery: o.route.literalQuery.length > 0,
      requestContentTypes: o.body?.contentTypes ?? [],
      requestBodyRequired: !!o.body && !o.body.optional && !o.body.metadataOnly,
      bodyMedia: o.body ? [...o.body.media.values()] : [],
      variants: o.variants.map((v) => ({
        name: v.name,
        status: v.status,
        body: v.body ? { media: [...v.body.media.values()], contentTypes: v.body.contentTypes, optional: v.body.optional, expr: names(v.body.type.expr) } : undefined,
        sse: v.body?.sse ? { unmarshal: this.g.sse!.unmarshalName(v.body.sse), elem: names(v.body.sse.elem.expr) } : undefined,
        jsonl: v.body?.jsonl ? { elem: names(v.body.jsonl.expr) } : undefined,
        headers: v.headers.map((h) => ({ goName: h.goName, wire: h.wire, optional: h.optional })),
      })),
    }));
  }

  // ------------------------------------------------------------------ code

  emit(out: Code): void {
    if (!this.ops.length) return;
    this.emitInterface(out);
    for (const o of this.ops) {
      this.emitRequest(o, out);
      this.emitResponses(o, out);
    }
    this.emitHandler(out);
  }

  private emitInterface(out: Code): void {
    out.raw(docComment("StrictServerInterface is implemented by the application; each method receives a decoded,\ndefaulted and validated request and returns one of the operation's response variants."));
    out.open("type StrictServerInterface interface {");
    for (const o of this.ops) {
      const desc = `${o.goName} handles ${o.op.verb.toUpperCase()} ${o.op.path}.` + (o.doc ? `\n\n${o.doc}` : "");
      out.raw(docComment(desc));
      out.line(`${o.goName}(ctx context.Context, request ${o.goName}RequestObject) (${o.goName}ResponseObject, error)`);
    }
    out.close();
    out.line();
    out.raw(docComment("StrictHandlerFunc is the type-erased operation handler seen by middleware."));
    out.line("type StrictHandlerFunc = tsgo.StrictHandlerFunc");
    out.line();
    out.raw(docComment("StrictMiddlewareFunc wraps operation handlers."));
    out.line("type StrictMiddlewareFunc = tsgo.StrictMiddlewareFunc");
    out.line();
    out.raw(docComment("ServerOptions configures NewHandler and RegisterHandlers."));
    out.line("type ServerOptions = tsgo.ServerOptions");
    out.line();
    out.raw(docComment("OperationInfos returns the description of every operation."));
    out.open("func OperationInfos() []tsgo.OperationInfo {");
    out.line(`return []tsgo.OperationInfo{${this.ops.map((o) => `operation${o.goName}()`).join(", ")}}`);
    out.close();
    out.line();
    for (const o of this.ops) {
      out.raw(docComment(`operation${o.goName} describes ${o.id}.`));
      out.open(`func operation${o.goName}() tsgo.OperationInfo {`);
      out.line(`return tsgo.OperationInfo{ID: ${goString(o.id)}, Method: ${goString(o.op.verb.toUpperCase())}, Path: ${goString(o.op.path)}, Security: ${o.security}}`);
      out.close();
      out.line();
    }
  }

  private emitRequest(o: OpModel, out: Code): void {
    const N = `${o.goName}RequestObject`;
    out.raw(docComment(`${N} is the decoded request of ${o.id}.`));
    out.open(`type ${N} struct {`);
    for (const p of o.params) {
      const doc = getDoc(this.program, p.prop);
      out.raw(docComment(`${doc ? doc + "\n\n" : ""}${p.goName} is the ${p.location} parameter ${goString(p.wire)} (${p.optional ? "optional; nil when absent" : "required"}).`));
      out.line(`${p.goName} ${p.optional ? "*" : ""}${p.type.expr} ${goRawString("tsp:" + goString(p.location + "," + p.wire))}`);
    }
    if (o.body) {
      const multi = o.body.contentTypes.length > 1 && !o.params.some((p) => p.contentType);
      if (multi) {
        out.raw(docComment(`ContentType is the negotiated request media type (one of ${o.body.contentTypes.join(", ")}).`));
        out.line("ContentType string");
      }
      out.raw(docComment(`Body is the request body (${o.body.optional ? "optional; nil when absent" : "required"}).`));
      out.line(`Body ${o.body.optional ? "*" : ""}${this.bodyExpr(o.body)} \`tsp:"body"\``);
    }
    out.close();
    out.line();
    if (o.body?.multipart) this.emitMultipartStruct(o.body, out);

    const checks = new Code();
    for (const p of o.params) {
      emitFieldChecks(this.g, { type: p.type, optional: p.optional, constraints: p.constraints, prop: p.prop }, `r.${p.goName}`, `v.At(${goString(p.location + ":" + p.wire)})`, checks);
    }
    if (o.body) {
      emitFieldChecks(this.g, { type: o.body.type, optional: o.body.optional, constraints: { patterns: [] }, prop: o.op.operation }, "r.Body", `v.At("body")`, checks);
    }
    emitValidateMethods(N, "r", "Validate checks the parameter and body constraints.", checks.toString(), out);

    out.raw(docComment("ApplyDefaults applies parameter and body defaults."));
    out.open(`func (r *${N}) ApplyDefaults() {`);
    for (const p of o.params) {
      if (p.defaultJson !== undefined && p.optional) {
        out.open(`if r.${p.goName} == nil {`).line(`r.${p.goName} = tsgo.Ptr(tsgo.MustDecode(${p.type.codec}, ${goRawString(p.defaultJson)}))`).close();
      }
    }
    if (o.body && !o.body.multipart && o.body.type.hasDefaults()) {
      if (o.body.optional) {
        const b = new Code();
        o.body.type.defaults("(*r.Body)", b);
        out.open("if r.Body != nil {").raw(b.toString()).close();
      } else o.body.type.defaults("r.Body", out);
    }
    out.close();
    out.line();
  }

  private bodyExpr(b: BodyInfo): string {
    return b.multipart ? b.multipartDecl! : b.type.expr;
  }

  private emitMultipartStruct(b: BodyInfo, out: Code): void {
    const N = b.multipartDecl!;
    out.raw(docComment(`${N} holds the parts of a multipart/form-data body.`));
    out.open(`type ${N} struct {`);
    for (const p of b.multipart!) {
      out.raw(docComment(`${p.goName} is the part ${goString(p.name)} (${p.optional ? "optional" : "required"}${p.multi ? ", repeated" : ""}).`));
      const t = p.multi ? `[]${p.type.expr}` : p.type.expr;
      out.line(`${p.goName} ${p.optional && !p.multi ? "*" : ""}${t} ${goRawString("tsp:" + goString((p.multi ? "parts," : "part,") + p.name))}`);
    }
    out.close();
    out.line();
    const checks = new Code();
    for (const p of b.multipart!) {
      if (p.multi && !p.optional) checks.open(`if len(m.${p.goName}) == 0 {`).line(`v.At(${goString(p.name)}).Add("required", "at least one part is required")`).close();
      const t = p.multi ? arrayType(p.type) : p.type;
      emitFieldChecks(this.g, { type: t, optional: p.optional && !p.multi, constraints: { patterns: [] }, prop: undefined }, `m.${p.goName}`, `v.At(${goString(p.name)})`, checks);
    }
    emitValidateMethods(N, "m", "Validate validates the parts.", checks.toString(), out);
  }

  private emitResponses(o: OpModel, out: Code): void {
    const I = `${o.goName}ResponseObject`;
    out.raw(docComment(`${I} is implemented only by the response variants of ${o.id}:\n${o.variants.map((v) => v.name).join(", ")}.`));
    out.open(`type ${I} interface {`);
    out.line(`Visit${o.goName}Response(w http.ResponseWriter) error`);
    out.line(`validate${o.goName}Response() error`);
    out.close();
    out.line();
    for (const v of o.variants) this.emitVariant(o, v, out);
  }

  private emitStatusCheck(o: OpModel, v: ResponseVariant, out: Code): void {
    const s = v.status;
    if (s.kind === "fixed") return;
    const min = s.kind === "range" ? Math.max(200, s.min) : 200;
    const max = s.kind === "range" ? Math.min(599, s.max) : 599;
    out.open(`if response.StatusCode < ${min} || response.StatusCode > ${max} {`)
      .line(`return fmt.Errorf("status code %d outside ${min}-${max}", response.StatusCode)`).close();
    if (s.kind === "default") {
      const reserved = new Set(o.variants.flatMap(({ status }) => status.kind === "fixed" ? [`response.StatusCode == ${status.code}`]
        : status.kind === "range" ? [`(response.StatusCode >= ${status.min} && response.StatusCode <= ${status.max})`] : []));
      if (reserved.size) out.open(`if ${[...reserved].join(" || ")} {`).line('return fmt.Errorf("status code %d has an explicit response variant", response.StatusCode)').close();
    }
  }

  private emitResponseHeaders(v: ResponseVariant, out: Code): void {
    if (!v.headers.length) return;
    out.line("w = tsgo.DeferHeaders(w)");
    for (const h of v.headers) {
      const val = h.optional ? `(*response.${h.goName})` : `response.${h.goName}`;
      const format = h.isArray ? `tsgo.FormatHeaderArray(${val}, ${h.elem!.text})` : `${h.type.text}.Format(${val})`;
      out.open(h.optional ? `if response.${h.goName} != nil {` : "{");
      out.line(`s, err := ${format}`);
      out.open("if err != nil {").line(`return fmt.Errorf("header %s: %w", ${goString(h.wire)}, err)`).close();
      out.open(`if err := tsgo.SetResponseHeader(w.Header(), ${goString(h.wire)}, s); err != nil {`).line("return err").close();
      out.close();
    }
  }

  private emitVariant(o: OpModel, v: ResponseVariant, out: Code): void {
    if (v.body?.multipart) this.emitMultipartStruct(v.body, out);
    const statusText = v.status.kind === "fixed" ? `status ${v.status.code}` : v.status.kind === "range" ? `a status in ${v.status.min}-${v.status.max}` : "any other status";
    out.raw(docComment(`${v.name} is the ${o.id} response with ${statusText}.${v.doc ? `\n\n${v.doc}` : ""}`));
    out.open(`type ${v.name} struct {`);
    if (v.status.kind !== "fixed") {
      out.raw(docComment("StatusCode is the HTTP status to send."));
      out.line("StatusCode int");
    }
    if (v.body && v.body.contentTypes.length > 1) {
      out.raw(docComment(`ContentType selects the media type (one of ${v.body.contentTypes.join(", ")}); empty means the first.`));
      out.line("ContentType string");
    }
    if (v.body) {
      out.raw(docComment("Body is the response body."));
      out.line(`Body ${v.body.optional ? "*" : ""}${v.body.type.expr}`);
    }
    for (const h of v.headers) {
      out.raw(docComment(`${h.goName} is the response header ${goString(h.wire)} (${h.optional ? "optional" : "required"}).`));
      out.line(`${h.goName} ${h.optional ? "*" : ""}${h.type.expr} ${goRawString("tsp:" + goString("header," + h.wire))}`);
    }
    out.close();
    out.line();

    const status = v.status.kind === "fixed" ? String(v.status.code) : "response.StatusCode";
    if (v.body?.sse || v.body?.jsonl) {
      out.raw(docComment(`Visit${o.goName}Response streams the body (${v.body.sse ? "text/event-stream" : "JSON Lines"}), flushing after each item.`));
      out.open(`func (response ${v.name}) Visit${o.goName}Response(w http.ResponseWriter) error {`).line("return response.visitStream(w, nil, false)").close();
      out.line();
      out.raw(docComment("visitStream streams the events; it stops when the request context is cancelled."));
      out.open(`func (response ${v.name}) visitStream(w http.ResponseWriter, r *http.Request, validate bool) error {`);
      this.emitStatusCheck(o, v, out);
      this.emitResponseHeaders(v, out);
      const elem = v.body.sse?.elem ?? v.body.jsonl!;
      const checks = new Code();
      elem.validate("item", "v", checks);
      const callback = v.body.sse ? this.g.sse!.marshalName(v.body.sse) : this.g.responseCodec(elem);
      out.line(`encoder := ${callback}`);
      out.open("if validate {");
      out.line(`encode := ${v.body.sse ? "encoder" : "encoder.Encode"}`);
      out.open(`${v.body.sse ? "encoder" : "encoder.Encode"} = func(item ${elem.expr}) (${v.body.sse ? "string, " : ""}[]byte, error) {`);
      out.line("v := tsgo.NewValidator()");
      out.raw(checks.toString());
      out.open("if err := v.Err(); err != nil {").line(`return ${v.body.sse ? '"", ' : ""}nil, err`).close();
      out.line("return encode(item)");
      out.close();
      if (v.body.sse) out.line(`return tsgo.WriteValidatedSSE(w, r, ${status}, response.Body, encoder)`);
      out.close();
      if (v.body.sse) out.line(`return tsgo.WriteSSE(w, r, ${status}, response.Body, encoder)`);
      else out.line(`return tsgo.WriteJSONL(w, r, ${status}, ${goString(v.body.contentTypes[0])}, response.Body, encoder)`);
      out.close();
      out.line();
      out.open(`func (response ${v.name}) validate${o.goName}Response() error {`);
      out.line("v := tsgo.NewValidator()");
      if (v.status.kind === "range") out.line(`tsgo.CheckStatus(v, response.StatusCode, ${v.status.min}, ${v.status.max})`);
      for (const h of v.headers) {
        emitFieldChecks(this.g, { type: h.type, optional: h.optional, constraints: h.constraints, prop: h.prop }, `response.${h.goName}`, `v.At(${goString("header:" + h.wire)})`, out);
      }
      out.line("return v.Err()");
      out.close();
      out.line();
      return;
    }
    out.raw(docComment(`Visit${o.goName}Response writes the response.`));
    out.open(`func (response ${v.name}) Visit${o.goName}Response(w http.ResponseWriter) error {`);
    this.emitStatusCheck(o, v, out);
    let ctExpr = "";
    if (v.body && v.body.media.values().next().value !== "file") {
      const cts = v.body.contentTypes;
      if (cts.length > 1) {
        out.line(`ct := response.ContentType`);
        out.open(`if ct == "" {`).line(`ct = ${goString(cts[0])}`).close();
        out.open(`if matched, err := tsgo.MatchContentType(ct, []string{${cts.map(goString).join(", ")}}); err != nil {`).line("return err").mid("} else {").line("ct = matched").close();
        ctExpr = "ct";
      } else ctExpr = goString(cts[0]);
      const bodyVal = v.body.optional ? "(*response.Body)" : "response.Body";
      const kinds = new Set(v.body.media.values());
      out.line("var body []byte");
      if (v.body.multipart) {
        ctExpr = "multipartContentType";
        out.line("var multipartContentType string");
      }
      const enc = (target: string) => {
        const body = v.body!;
        if (body.multipart) return this.encodeMultipart(body, bodyVal);
        if (kinds.size === 1) return this.encodeBody([...kinds][0], body.type, bodyVal, target);
        const code = new Code();
        code.open(`switch ${ctExpr} {`);
        for (const kind of kinds) {
          const types = [...body.media].filter(([,k]) => k === kind).map(([ct]) => goString(ct));
          code.line(`case ${types.join(", ")}:`);
          code.lines_(this.encodeBody(kind, body.type, bodyVal, target).map(l => "\t" + l));
        }
        code.close();
        return code.toString().trimEnd().split("\n");
      };
      if (v.body.optional) {
        out.open("if response.Body != nil {");
        out.lines_(enc("body"));
        out.close();
      } else {
        out.lines_(enc("body"));
      }
    }
    this.emitResponseHeaders(v, out);
    if (!v.body && v.fixedContentType) out.line(`w.Header().Set("Content-Type", ${goString(v.fixedContentType)})`);
    if (v.body && v.body.media.values().next().value === "file") {
      const f = v.body.optional ? "(*response.Body)" : "response.Body";
      if (v.body.optional) {
        out.open("if response.Body == nil {").line(`w.WriteHeader(${status})`).line("return nil").close();
      }
      out.line(`return tsgo.WriteFile(w, ${status}, ${f}, []string{${v.body.contentTypes.map(goString).join(", ")}})`);
    } else if (v.body) {
      if (v.body.optional) {
        out.line(`ctOut := ""`);
        out.open("if body != nil {").line(`ctOut = ${ctExpr}`).close();
        out.line(`return tsgo.WriteBody(w, ${status}, ctOut, body)`);
      } else {
        out.line(`return tsgo.WriteBody(w, ${status}, ${ctExpr}, body)`);
      }
    } else {
      out.line(`w.WriteHeader(${status})`);
      out.line("return nil");
    }
    out.close();
    out.line();

    out.open(`func (response ${v.name}) validate${o.goName}Response() error {`);
    out.line("v := tsgo.NewValidator()");
    if (v.status.kind === "range") out.line(`tsgo.CheckStatus(v, response.StatusCode, ${v.status.min}, ${v.status.max})`);
    if (v.body && v.body.media.values().next().value !== "file") {
      emitFieldChecks(this.g, { type: v.body.type, optional: v.body.optional, constraints: { patterns: [] }, prop: o.op.operation }, "response.Body", `v.At("body")`, out);
    }
    for (const h of v.headers) {
      emitFieldChecks(this.g, { type: h.type, optional: h.optional, constraints: h.constraints, prop: h.prop }, `response.${h.goName}`, `v.At(${goString("header:" + h.wire)})`, out);
    }
    out.line("return v.Err()");
    out.close();
    out.line();
  }

  private encodeMultipart(body: BodyInfo, val: string): string[] {
    const code = new Code();
    code.line("var parts []tsgo.FormPart");
    for (const part of body.multipart!) {
      const field = `${val}.${part.goName}`;
      const ct = part.contentTypes[0] ?? ({file:"application/octet-stream", binary:"application/octet-stream", text:"text/plain", json:"application/json"}[part.kind]);
      if (part.multi) code.open(`for _, item := range ${field} {`);
      else if (part.optional) code.open(`if ${field} != nil {`).line(`item := *${field}`);
      else code.open("{").line(`item := ${field}`);
      if (part.kind === "file") {
        code.open('if item.ContentType == "" {').line(`item.ContentType = ${goString(ct === "*/*" ? "application/octet-stream" : ct)}`).close();
        code.line(`parts = append(parts, tsgo.FormPart{Name: ${goString(part.name)}, File: item})`);
      } else {
        if (part.kind === "json") {
          code.line(`data, err := ${this.g.responseCodec(part.type)}.Encode(item)`);
          code.open("if err != nil {").line("return err").close();
        } else code.line("data := []byte(item)");
        code.line(`parts = append(parts, tsgo.FormPart{Name: ${goString(part.name)}, File: tsgo.File{ContentType: ${goString(ct)}, Contents: data}})`);
      }
      code.close();
    }
    code.line("var err error");
    code.line("body, multipartContentType, err = tsgo.EncodeMultipart(parts)");
    code.open("if err != nil {").line("return err").close();
    return code.toString().trimEnd().split("\n");
  }

  private encodeBody(kind: BodyMedia, t: GoType, val: string, target: string): string[] {
    switch (kind) {
      case "json":
        return [`b, err := ${this.g.responseCodec(t)}.Encode(${val})`, "if err != nil {", "\treturn err", "}", `${target} = b`];
      case "xml":
        return [
          `n, err := ${this.g.xml!.encodeCall(t.decl!, val, this.g.xml!.rootName(t.decl!))}`,
          "if err != nil {",
          "	return err",
          "}",
          "b, err := tsgo.EncodeXML(n)",
          "if err != nil {",
          "	return err",
          "}",
          `${target} = b`,
        ];
      case "form": {
        const code = new Code();
        code.line("form := url.Values{}");
        for (const f of t.decl!.fields ?? []) {
          if (f.never) continue;
          const key = goString(resolveEncodedName(this.program, f.prop, "application/x-www-form-urlencoded"));
          const field = `${val}.${f.goName}`;
          const item = f.type.elem ?? f.type;
          if (f.optional) code.open(`if ${field} != nil {`);
          if (f.type.cat === "array") code.open(`for _, item := range ${f.optional ? "*" : ""}${field} {`);
          else code.open("{").line(`item := ${f.literal ? `${f.type.expr}(${f.literal.value})` : (f.optional ? "*" : "") + field}`);
          code.line(`s, err := ${item.text}.Format(item)`);
          code.open("if err != nil {").line("return err").close();
          code.line(`form.Add(${key}, s)`);
          code.close();
          if (f.optional) code.close();
        }
        const additional = t.decl!.additional;
        if (additional) {
          const names = [...(t.decl!.fields ?? []).map(f => f.prop), ...(t.decl!.ignored ?? [])]
            .map(p => goString(resolveEncodedName(this.program, p, "application/x-www-form-urlencoded"))).join(", ");
          code.open(`for _, k := range tsgo.SortedKeys(${val}.AdditionalProperties) {`);
          if (names) code.open("switch k {").line(`case ${names}:`).line('\treturn fmt.Errorf("additional property %q collides with a form field", k)').close();
          if (additional.cat === "array") code.open(`for _, item := range ${val}.AdditionalProperties[k] {`);
          else code.line(`item := ${val}.AdditionalProperties[k]`);
          code.line(`s, err := ${(additional.elem ?? additional).text}.Format(item)`);
          code.open("if err != nil {").line("return err").close();
          code.line("form.Add(k, s)");
          if (additional.cat === "array") code.close();
          code.close();
        }
        code.line(`${target} = []byte(form.Encode())`);
        return code.toString().trimEnd().split("\n");
      }
      case "text":
        return [`s, err := ${t.text}.Format(${val})`, "if err != nil {", "\treturn err", "}", `${target} = []byte(s)`];
      case "binary":
        return [`${target} = ${val}`];
      default:
        return [];
    }
  }

  private emitHandler(out: Code): void {
    out.raw(docComment("NewHandler returns an http.Handler (an http.ServeMux) serving every operation."));
    out.open("func NewHandler(ssi StrictServerInterface, opts ServerOptions) http.Handler {");
    out.line("mux := http.NewServeMux()");
    out.line("RegisterHandlers(mux, ssi, opts)");
    out.line("return mux");
    out.close();
    out.line();
    out.raw(docComment("RegisterHandlers registers every operation on mux using Go 1.22+ method and wildcard patterns."));
    out.open("func RegisterHandlers(mux *http.ServeMux, ssi StrictServerInterface, opts ServerOptions) {");
    out.line("h := &strictHandler{ssi: ssi, opts: opts.Resolve()}");
    const groups = this.routeGroups();
    groups.forEach((g, i) => {
      out.line(`mux.HandleFunc(${goString(g.pattern)}, h.${g.dispatch ? `dispatch${i}` : `handle${g.ops[0].goName}`})`);
    });
    out.close();
    out.line();
    const complex = this.ops.filter((o) => groups.some((g) => g.dispatch && g.ops.includes(o)));
    if (complex.length) {
      out.open("var (");
      for (const o of complex) {
        out.raw(docComment(`route${o.goName} matches the escaped path of ${o.op.uriTemplate}.`));
        out.line(`route${o.goName} = regexp.MustCompile(${goRawString(o.route.regex)})`);
      }
      out.close(")");
      out.line();
    }
    groups.forEach((g, i) => {
      if (!g.dispatch) return;
      out.raw(docComment(`dispatch${i} selects the operation for ${g.pattern} by URI template (most literal text first).`));
      out.open(`func (h *strictHandler) dispatch${i}(w http.ResponseWriter, r *http.Request) {`);
      out.line("p := r.URL.EscapedPath()");
      if (g.ops.some((o) => o.route.literalQuery.length)) out.line("q, queryErr := url.ParseQuery(r.URL.RawQuery)").open("if queryErr != nil {").line('h.opts.RequestErrorHandler(w, r, tsgo.ParamError("query", "", queryErr))').line("return").close();
      out.open("switch {");
      for (const o of g.ops) {
        const conds = [`route${o.goName}.MatchString(p)`, ...o.route.literalQuery.map(([k, v]) => `tsgo.RequireLiteralQuery(q, ${goString(k)}, ${goString(v)})`)];
        // @sharedRoute: operations with the same route are told apart by Accept / Content-Type.
        if (g.ops.some((x) => x !== o && x.route.regex === o.route.regex)) {
          if (o.acceptLiteral) {
            const q = `tsgo.AcceptQuality(r.Header.Get("Accept"), ${goString(o.acceptLiteral)})`;
            conds.push(`${q} > 0`);
            for (const other of g.ops.filter(x => x !== o && x.route.regex === o.route.regex && x.acceptLiteral && JSON.stringify(o.route.literalQuery) === JSON.stringify(x.route.literalQuery))) {
              const weight = `tsgo.AcceptQuality(r.Header.Get("Accept"), ${goString(other.acceptLiteral!)})`;
              const ct = other.body ? `!tsgo.ContentTypeIs(r, ${other.body.contentTypes.map(goString).join(", ")}) || ` : "";
              conds.push(`(${ct}${q} >= ${weight})`);
            }
          }
          if (o.body) conds.push(`tsgo.ContentTypeIs(r, ${o.body.contentTypes.map(goString).join(", ")})`);
        }
        out.line(`case ${conds.join(" && ")}:`);
        out.line(`\th.handle${o.goName}(w, r)`);
      }
      out.line("default:");
      const shared = g.ops.filter((x) => g.ops.some((y) => y !== x && y.route.regex === x.route.regex));
      if (shared.length) {
        // The route exists but no @sharedRoute operation accepts the request: 406 / 415.
        const accepts = shared.map((x) => x.acceptLiteral).filter((x): x is string => !!x);
        const cts = [...new Set(shared.flatMap((x) => x.body?.contentTypes ?? []))];
        out.line(`\tif ${[...new Set(shared.map((x) => `route${x.goName}.MatchString(p)`))].join(" || ")} {`);
        out.line(`\t\th.opts.RequestErrorHandler(w, r, tsgo.NegotiationError(r, []string{${accepts.map(goString).join(", ")}}, []string{${cts.map(goString).join(", ")}}))`);
        out.line("\t\treturn");
        out.line("\t}");
      }
      out.line("\thttp.NotFound(w, r)");
      out.close();
      out.close();
      out.line();
    });
    out.open("type strictHandler struct {");
    out.raw(docComment("ssi is the application implementation."));
    out.line("ssi StrictServerInterface");
    out.raw(docComment("opts are the resolved options."));
    out.line("opts tsgo.ServerOptions");
    out.close();
    out.line();
    out.raw(docComment("authenticate runs the authentication hook for operations with security requirements."));
    out.open("func (h *strictHandler) authenticate(w http.ResponseWriter, r *http.Request, op tsgo.OperationInfo) (context.Context, bool) {");
    out.line("ctx := r.Context()");
    out.open("if len(op.Security) == 0 {").line("return ctx, true").close();
    out.open("if h.opts.Authenticate == nil {");
    out.open("if op.AllowsAnonymous() {").line("return ctx, true").close();
    out.line(`h.opts.RequestErrorHandler(w, r, tsgo.Unauthenticated(errors.New("authentication required but no authenticator is configured")))`);
    out.line("return nil, false");
    out.close();
    out.line("ctx, err := h.opts.Authenticate(ctx, r, op)");
    out.open("if err != nil {");
    out.line("h.opts.RequestErrorHandler(w, r, h.opts.AuthenticationError(err))");
    out.line("return nil, false");
    out.close();
    out.line("return ctx, true");
    out.close();
    out.line();
    for (const o of this.ops) this.emitOpHandler(o, out);
  }

  private emitOpHandler(o: OpModel, out: Code): void {
    const R = `${o.goName}RequestObject`;
    out.open(`func (h *strictHandler) handle${o.goName}(w http.ResponseWriter, r *http.Request) {`);
    out.line(`op := operation${o.goName}()`);
    out.line("ctx, ok := h.authenticate(w, r, op)");
    out.open("if !ok {").line("return").close();
    out.line("tsgo.LimitBody(w, r, h.opts.MaxRequestBodyBytes)");
    out.line(`var request ${R}`);
    // ServerOptions.CollectErrors: every parameter and the body are decoded, then the values
    // that decoded are validated; otherwise the first failure is reported.
    out.line("var failures tsgo.RequestFailures");
    if (o.params.some((p) => p.location === "path" && p.expansion)) {
      out.line(`m := route${o.goName}.FindStringSubmatch(r.URL.EscapedPath())`);
      out.open("if m == nil {").line("http.NotFound(w, r)").line("return").close();
    }
    if (o.params.some((p) => p.location === "path" && !p.expansion)) out.line("segs := tsgo.RawPathSegments(r)");
    if (o.params.some(p => p.location === "query")) {
      out.line("q, queryErr := url.ParseQuery(r.URL.RawQuery)");
      out.open("if queryErr != nil {");
      out.line('err := tsgo.ParamError("query", "", tsgo.FormatError("URL query", queryErr))');
      out.open('if failures.Stop(err, "query:", h.opts.CollectErrors) {').line("h.opts.RequestErrorHandler(w, r, err)").line("return").close();
      out.close().line("_ = q");
    }
    let negotiated = "";
    if (o.body) {
      out.line(`ct, contentErr := tsgo.RequestContentType(r, []string{${o.body.contentTypes.map(goString).join(", ")}}, ${!!(o.body.optional || o.body.metadataOnly)})`);
      negotiated = "ct";
      out.open('if contentErr != nil && failures.Stop(contentErr, "body", h.opts.CollectErrors) {').line("h.opts.RequestErrorHandler(w, r, contentErr)").line("return").close();
      out.line("_ = ct");
    }
    for (const p of o.params) {
      const guard = p.location === "query" ? "queryErr" : p.contentType && o.body ? "contentErr" : undefined;
      if (guard) out.open(`if ${guard} != nil {`).line(`failures.Skip(${goString(p.location + ":" + p.wire)})`).mid("} else {");
      this.emitParamBinding(o, p, negotiated, out);
      if (guard) out.close();
    }
    if (o.body) {
      // The JSONL cursor is lazy. A recorded transport failure returns before it can be consumed.
      if (!o.body.jsonl) out.open("if contentErr == nil {");
      this.emitBodyDecoding(o, out);
      if (!o.body.jsonl) out.close();
    }
    out.line("request.ApplyDefaults()");
    out.open("if failures.Failed() {").line("h.opts.RequestErrorHandler(w, r, failures.Err(request.ValidateWith))").line("return").close();
    out.open("if err := request.Validate(); err != nil {").line("h.opts.RequestErrorHandler(w, r, tsgo.ValidationRequestError(err))").line("return").close();
    out.open("handler := func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {");
    out.line(`return h.ssi.${o.goName}(ctx, request.(${R}))`);
    out.close();
    out.open("for i := len(h.opts.Middlewares) - 1; i >= 0; i-- {").line("handler = h.opts.Middlewares[i](handler, op)").close();
    out.line("response, err := handler(ctx, w, r, request)");
    if (o.body?.jsonl) out.open("if inputErr := finishRequest(); inputErr != nil {").line("h.opts.RequestErrorHandler(w, r, inputErr)").line("return").close();
    out.open("if err != nil {").line("h.opts.ResponseErrorHandler(w, r, err)").line("return").close();
    out.line(`res, ok := response.(${o.goName}ResponseObject)`);
    out.open("if !ok || tsgo.NilResponse(res) {").line(`h.opts.ResponseErrorHandler(w, r, fmt.Errorf("${o.goName}: unexpected response %T", response))`).line("return").close();
    out.open("if h.opts.ValidateResponses {");
    out.open(`if err := res.validate${o.goName}Response(); err != nil {`).line(`h.opts.ResponseErrorHandler(w, r, fmt.Errorf("${o.goName}: invalid response: %w", err))`).line("return").close();
    out.close();
    if (o.variants.some((v) => v.body?.sse || v.body?.jsonl)) {
      out.line("if s, ok := res.(interface {");
      out.line("	visitStream(w http.ResponseWriter, r *http.Request, validate bool) error");
      out.open("}); ok {");
      out.open("if err := s.visitStream(w, r, h.opts.ValidateResponses); err != nil {");
      out.line("tsgo.ResponseFailed(w, r, err, h.opts.ResponseErrorHandler)");
      out.close();
      out.line("return");
      out.close();
    }
    out.open(`if err := res.Visit${o.goName}Response(w); err != nil {`).line("tsgo.ResponseFailed(w, r, err, h.opts.ResponseErrorHandler)").close();
    out.close();
    out.line();
  }

  /**
   * Binds one parameter in a function literal returning its failure: the handler stops on it
   * (fail-fast), or records it and goes on (CollectErrors; the parameter is then not validated).
   */
  private emitParamBinding(o: OpModel, p: ParamField, negotiated: string, out: Code): void {
    const body = new Code();
    this.emitParamBindingBody(o, p, negotiated, body);
    out.open("if err := func() error {").raw(body.toString()).line("return nil");
    out.mid(`}(); err != nil && failures.Stop(err, ${goString(p.location + ":" + p.wire)}, h.opts.CollectErrors) {`);
    out.line("h.opts.RequestErrorHandler(w, r, err)").line("return");
    out.close();
  }

  private emitParamBindingBody(o: OpModel, p: ParamField, negotiated: string, out: Code): void {
    const loc = goString(p.location);
    const wire = goString(p.wire);
    const fail = (err: string) => [`return tsgo.ParamError(${loc}, ${wire}, ${err})`];
    const text = p.elem ? p.elem.text! : p.type.text!;
    // The address of a decoded value; a named array (`model Tags is string[]`) is converted first.
    const ref = (v: string) => (p.type.decl?.kind === "array" ? `tsgo.Ptr(${p.type.expr}(${v}))` : `&${v}`);
    const assign = (v: string) => (p.optional ? `request.${p.goName} = ${ref(v)}` : `request.${p.goName} = ${v}`);
    if (p.location === "path" && p.expansion) {
      const e = p.expansion;
      const args = `m[${e.group}], ${goString(e.op)}, ${wire}, ${e.explode}`;
      out.open("{");
      out.open(`if m[${e.group}] == "" {`);
      if (p.optional) out.line("// absent optional path parameter");
      else out.lines_(fail(`tsgo.RequiredError("required parameter is missing")`));
      out.mid("} else {");
      if (p.shape === "model") {
        out.line(`vals, err := tsgo.ParseExpansionObject(${args})`);
        out.open("if err != nil {").lines_(fail("err")).close();
        out.line(`var v ${p.type.expr}`);
        this.emitTextFields(p.type.decl!, prop => resolveEncodedName(this.program, prop, "application/json"), fail, out);
      } else {
        const fn = p.shape === "array" ? "ParseExpansionArray" : p.shape === "record" ? "ParseExpansionRecord" : "ParseExpansionValue";
        out.line(`v, err := tsgo.${fn}(${args}, ${text})`);
        out.open("if err != nil {").lines_(fail("err")).close();
      }
      out.line(assign("v"));
      out.close();
      out.close();
      return;
    }
    if (p.location === "query" && (p.shape === "record" || p.shape === "model")) {
      // Exploded records/models own every query parameter not declared elsewhere (including the
      // literal parameters written in the route).
      const others = [...o.params.filter((x) => x.location === "query" && x !== p).map((x) => x.wire), ...o.route.literalQuery.map(([k]) => k)].map((x) => goString(x));
      const exclude = `[]string{${others.join(", ")}}`;
      out.open("{");
      if (p.shape === "record") {
        out.line(p.explode ? `v, present, err := tsgo.QueryRecord(q, ${wire}, true, ${exclude}, ${text})` : `v, present, err := tsgo.DecodeQueryRecord(r.URL.RawQuery, ${wire}, ${text})`);
        out.open("if err != nil {").lines_(fail("err")).close();
      } else {
        out.line(`vals, present, err := tsgo.QueryObject(r.URL.RawQuery, q, ${wire}, ${p.explode}, ${exclude})`);
        out.open("if err != nil {").lines_(fail("err")).close();
        out.line(`var v ${p.type.expr}`);
        out.open("if present {");
        this.emitTextFields(p.type.decl!, prop => resolveEncodedName(this.program, prop, "application/json"), fail, out);
        out.close();
      }
      if (p.optional) out.open("if present {").line(`request.${p.goName} = ${ref("v")}`).close();
      else {
        out.open("if !present {").lines_(fail(`tsgo.RequiredError("required parameter is missing")`)).close();
        out.line(`request.${p.goName} = v`);
      }
      out.close();
      return;
    }
    if (p.contentType && negotiated) {
      out.open("{");
      out.line(`v, err := ${text}.Parse(${negotiated})`);
      out.open("if err != nil {").lines_(fail("err")).close();
      out.line(p.optional ? `request.${p.goName} = ${ref("v")}` : `request.${p.goName} = v`);
      out.close();
      return;
    }
    if (p.location === "path") {
      const seg = `tsgo.PathSegment(segs, ${p.segment}, ${p.rest ? "true" : "false"})`;
      out.open("{");
      if (p.isArray) out.line(`v, err := tsgo.DecodePathArray(${seg}, ${wire}, ${goString(p.style ?? "simple")}, ${p.explode}, ${text})`);
      else if (p.rest || p.allowReserved) out.line(`v, err := tsgo.DecodePathReserved(${seg}, ${text})`);
      else out.line(`v, err := tsgo.DecodePathValue(${seg}, ${wire}, ${goString(p.style ?? "simple")}, ${p.explode}, ${text})`);
      out.open("if err != nil {").lines_(fail("err")).close();
      out.line(`request.${p.goName} = v`);
      out.close();
      return;
    }
    let call: string;
    if (p.location === "query" && p.isArray && !p.explode && !p.arrayEncoding) call = `tsgo.DecodeQueryList(r.URL.RawQuery, ${wire}, ${text})`;
    else if (p.location === "query") call = p.isArray ? `tsgo.DecodeQueryArray(q, ${wire}, ${goString(p.arrayEncoding ?? "")}, ${p.explode}, ${text})` : `tsgo.DecodeQueryValue(q, ${wire}, ${text})`;
    else if (p.location === "header") call = p.isArray ? `tsgo.DecodeHeaderArray(r.Header, ${wire}, ${text})` : `tsgo.DecodeHeaderValue(r.Header, ${wire}, ${text})`;
    else {
      call = p.isArray ? `tsgo.DecodeCookieArray(r, ${wire}, ${text})` : `tsgo.DecodeCookieValue(r, ${wire}, ${text})`;
    }
    out.open("{");
    out.line(`v, present, err := ${call}`);
    out.open("if err != nil {").lines_(fail("err")).close();
    if (p.optional) {
      out.open("if present {").line(`request.${p.goName} = ${ref("v")}`).close();
    } else {
      out.open("if !present {").lines_(fail(`tsgo.RequiredError("required parameter is missing")`)).close();
      out.line(`request.${p.goName} = v`);
    }
    out.close();
  }

  /** Bind the flat property table of a form body or object-valued path or query parameter. */
  private emitTextFields(d: Decl, nameOf: (p: ModelProperty) => string, fail: (err: string) => string[], out: Code): void {
    const fields = d.fields ?? [];
    const names = [...fields.map(f => nameOf(f.prop)), ...(d.ignored ?? []).map(nameOf)].map(goString).join(", ");
    const never = fields.filter(f => f.never).map(f => goString(nameOf(f.prop))).join(", ");
    const closed = !!d.closed || (!d.additional && this.g.unknownPolicy === "tsgo.RejectUnknown");
    if (closed || never) {
      out.open(`if err := tsgo.CheckObjectKeys(vals, ${closed}, []string{${names}}, []string{${never}}); err != nil {`).lines_(fail("err")).close();
    }
    const decode = (t: GoType, name: string) => t.cat === "array"
      ? `tsgo.DecodeQueryArray(vals, ${name}, "", true, ${t.elem!.text})`
      : `tsgo.DecodeQueryValue(vals, ${name}, ${t.text})`;
    for (const f of fields) {
      if (f.never) continue;
      const name = goString(nameOf(f.prop));
      out.open("{");
      const binding = f.sourceText ? `tsgo.DecodeQueryValue(vals, ${name}, ${f.sourceText})` : decode(f.type, name);
      out.line(`x, present, err := ${binding}`);
      out.open("if err != nil {").lines_(fail(`tsgo.WithPath(${name}, err)`)).close();
      if (f.optional) out.open("if present {").line(`v.${f.goName} = ${f.sourceText ? "tsgo.Ptr(tsgo.Value(x))" : "&x"}`).close();
      else {
        out.open("if !present {").lines_(fail(`tsgo.WithPath(${name}, tsgo.RequiredError("required property is missing"))`)).close();
        out.line(f.literal ? "_ = x" : `v.${f.goName} = x`);
      }
      out.close();
    }
    if (d.additional) {
      out.open("for _, key := range tsgo.SortedKeys(vals) {");
      if (names) out.open("switch key {").line(`case ${names}:`).line("\tcontinue").close();
      out.line(`x, _, err := ${decode(d.additional, "key")}`);
      out.open("if err != nil {").lines_(fail("tsgo.WithPath(key, err)")).close();
      out.open("if v.AdditionalProperties == nil {").line(`v.AdditionalProperties = make(map[string]${d.additional.expr})`).close();
      out.line("v.AdditionalProperties[key] = x").close();
    }
  }

  /**
   * Decodes the body in a function literal returning its failure (see emitParamBinding). A JSON
   * body keeps what decoded (tsgo.DecodedBodyError): only the failed positions are not validated.
   */
  private emitBodyDecoding(o: OpModel, out: Code): void {
    const b = o.body!;
    if (b.jsonl) return this.emitBodyDecodingBody(o, out); // a stream: nothing is decoded before the handler
    const body = new Code();
    this.emitBodyDecodingBody(o, body);
    out.open("if err := func() error {").raw(body.toString()).line("return nil");
    out.mid(`}(); err != nil && failures.Stop(err, "body", h.opts.CollectErrors) {`);
    out.line("h.opts.RequestErrorHandler(w, r, err)").line("return");
    out.close();
  }

  private emitBodyDecodingBody(o: OpModel, out: Code): void {
    const b = o.body!;
    const fail = ["return err"];
    const multi = b.contentTypes.length > 1 && !o.params.some((p) => p.contentType);
    if (multi) out.line("request.ContentType = ct");
    if (b.multipart) {
      out.open("{");
      if (b.optional) out.open(`if ct != "" {`);
      out.line("parts, err := tsgo.ReadMultipart(r)");
      out.open("if err != nil {").lines_(fail).close();
      if (b.closedParts) {
        const names = b.multipart.map(p => goString(p.name)).join(", ");
        out.open(`if err := tsgo.CheckObjectKeys(parts, true, []string{${names}}, nil); err != nil {`)
          .line("return tsgo.BodyError(err)").close();
      }
      out.line(`var body ${b.multipartDecl}`);
      for (const p of b.multipart) this.emitPartDecoding(p, out);
      out.line(b.optional ? "request.Body = &body" : "request.Body = body");
      if (b.optional) out.close();
      out.close();
      return;
    }
    if (b.jsonl) {
      const e = b.jsonl;
      const prep = new Code();
      e.defaults("(*v)", prep);
      if (e.hasValidation()) {
        prep.line("vv := tsgo.NewValidator()");
        e.validate("(*v)", "vv", prep);
        prep.line("return vv.Err()");
      } else prep.line("return nil");
      out.open(`stream, finishRequest := tsgo.RequestJSONL(r.Body, ${e.codec}, func(v *${e.expr}) error {`).raw(prep.toString()).close("})");
      if (b.optional) out.open(`if ct != "" {`).line("request.Body = &stream").close();
      else out.line("request.Body = stream");
      return;
    }
    out.open("{");
    out.line("data, err := tsgo.ReadBody(r)");
    out.open("if err != nil {").lines_(fail).close();
    if (b.optional || b.metadataOnly) out.open(`if ct != "" {`);
    const kinds = new Set(b.media.values());
    const assign = (val: string) => (b.optional ? `request.Body = &${val}` : `request.Body = ${val}`);
    const decodeKind = (k: BodyMedia, o2: Code) => {
      if (k === "json" || k === "xml") {
        o2.open("if len(data) == 0 {").line(`return tsgo.BodyError(tsgo.RequiredError("request body is required"))`).close();
      }
      switch (k) {
        case "json":
          o2.line(`v, err := ${b.type.codec}.Decode(data)`);
          o2.line(assign("v")); // on failure, the part that decoded
          o2.open("if err != nil {").line("return tsgo.DecodedBodyError(err)").close();
          break;
        case "form": {
          // application/x-www-form-urlencoded: fields by (form) name, arrays as repeated keys.
          o2.line("vals, err := url.ParseQuery(string(data))");
          o2.open("if err != nil {").line("return tsgo.BodyError(err)").close();
          o2.line(`var v ${b.type.expr}`);
          this.emitTextFields(b.type.decl!, p => resolveEncodedName(this.program, p, "application/x-www-form-urlencoded"),
            err => [`return tsgo.BodyError(${err})`], o2);
          o2.line(assign("v"));
          break;
        }
        case "xml":
          o2.line("root, err := tsgo.ParseXML(data)");
          o2.open("if err == nil {").line(`err = tsgo.RequireXMLRoot(root, ${this.g.xml!.rootName(b.type.decl!)})`).close();
          o2.line(`var v ${b.type.expr}`);
          o2.open("if err == nil {").line(`err = ${this.g.xml!.decodeCall(b.type.decl!, "v", "root")}`).close();
          o2.open("if err != nil {").line("return tsgo.BodyError(err)").close();
          o2.line(assign("v"));
          break;
        case "text":
          o2.line("text, err := tsgo.TextBody(data)");
          o2.open("if err != nil {").lines_(fail).close();
          o2.line(`v, err := tsgo.ParseText(${b.type.text}, text)`);
          o2.open("if err != nil {").line("return tsgo.BodyError(err)").close();
          o2.line(assign("v"));
          break;
        case "binary":
          o2.line(assign("data"));
          break;
        case "file":
          o2.line("v := tsgo.FileFromRequest(r, data)");
          o2.line(assign("v"));
          break;
      }
    };
    if (kinds.size === 1) {
      out.open("{");
      decodeKind([...kinds][0], out);
      out.close();
    } else {
      out.open("switch ct {");
      for (const kind of kinds) {
        const types = [...b.media].filter(([,k]) => k === kind).map(([ct]) => goString(ct));
        out.line(`case ${types.join(", ")}:`);
        const branch = new Code();
        decodeKind(kind, branch);
        out.raw(indent(branch.toString()));
      }
      out.close();
    }
    if (b.optional || b.metadataOnly) out.close();
    out.close();
  }

  private emitPartDecoding(p: MultipartPart, out: Code): void {
    const name = goString(p.name);
    const fail = (e: string) => [`return tsgo.BodyError(tsgo.WithPath(${name}, ${e}))`];
    const decode = (src: string, dst: string, o2: Code) => {
      switch (p.kind) {
        case "file":
          o2.line(`${dst} = tsgo.PartFile(${src})`);
          return;
        case "text":
          o2.line(`s, err := tsgo.PartText(${src})`);
          o2.open("if err != nil {").lines_(fail("err")).close();
          o2.line(`${dst} = s`);
          return;
        case "binary":
          o2.line(`${dst} = ${src}.Data`);
          return;
        case "json":
          o2.line(`x, err := ${p.type.codec}.Decode(${src}.Data)`);
          o2.open("if err != nil {").lines_(fail("err")).close();
          o2.line(`${dst} = x`);
      }
    };
    out.open("{");
    out.line(`ps := parts[${name}]`);
    if (!p.optional) out.open("if len(ps) == 0 {").lines_(fail(`tsgo.RequiredError("required part is missing")`)).close();
    if (p.multi) {
      out.open("for _, part := range ps {");
      out.line(`var item ${p.type.expr}`);
      decode("part", "item", out);
      out.line(`body.${p.goName} = append(body.${p.goName}, item)`);
      out.close();
    } else {
      out.open("if len(ps) > 1 {").lines_(fail(`errors.New("part must not be repeated")`)).close();
      out.open("if len(ps) == 1 {");
      out.line(`var item ${p.type.expr}`);
      decode("ps[0]", "item", out);
      out.line(p.optional ? `body.${p.goName} = &item` : `body.${p.goName} = item`);
      out.close();
    }
    out.close();
  }
}

function isJsonLines(ct: string): boolean {
  return /^application\/(jsonl|x-ndjson|ndjson|x-jsonlines|jsonlines)$/i.test(ct);
}

function isSingleLiteral(t: Type): boolean {
  return t.kind === "String" || t.kind === "Number" || t.kind === "Boolean" || t.kind === "EnumMember";
}

function indent(s: string): string {
  return s
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => (l ? "\t" + l : l))
    .join("\n");
}

function* allProps(m: Model): Iterable<ModelProperty> {
  const chain: Model[] = [];
  for (let b: Model | undefined = m; b; b = b.baseModel) chain.unshift(b);
  const seen = new Map<string, ModelProperty>();
  for (const b of chain) for (const p of b.properties.values()) seen.set(p.name, p);
  yield* seen.values();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Two ServeMux patterns overlap without one being more specific (ServeMux would panic). */
function ambiguous(a: string, b: string): boolean {
  const sa = a.split("/").slice(1);
  const sb = b.split("/").slice(1);
  const isWild = (s: string) => /^\{p\d+\}$/.test(s);
  const isRest = (s: string) => /^\{p\d+\.\.\.\}$/.test(s);
  const restA = sa.length > 0 && isRest(sa[sa.length - 1]);
  const restB = sb.length > 0 && isRest(sb[sb.length - 1]);
  if (!restA && !restB && sa.length !== sb.length) return false;
  let aMore = false;
  let bMore = false;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined || y === undefined) {
      if ((x === undefined && !restA) || (y === undefined && !restB)) return false;
      if (x === undefined) aMore = true;
      else bMore = true;
      continue;
    }
    const xw = isWild(x) || isRest(x);
    const yw = isWild(y) || isRest(y);
    if (!xw && !yw) {
      if (x !== y) return false;
    } else if (!xw && yw) aMore = true;
    else if (xw && !yw) bMore = true;
    else if (isRest(x) && !isRest(y)) bMore = true;
    else if (!isRest(x) && isRest(y)) aMore = true;
  }
  return aMore && bMore;
}

export type { Operation };
