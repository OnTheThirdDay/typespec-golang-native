/**
 * Server conformance against the official TypeSpec HTTP specs (@typespec/http-specs).
 *
 * For every spec: compile main.tsp, generate Go with typespec-go, then drive the generated
 * http.Handler with each scenario of the spec's mockapi.js. The scenarios are written from the
 * client's perspective (request sent → response expected); here the *server* must decode the
 * request, and an implementation of StrictServerInterface produced by this harness answers with
 * the scenario's expected response through the generated response variants, so that response
 * encoding is exercised as well.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { listScenarios } from "@typespec/spector";
import { compile, getNamespaceFullName, NodeHost, type Operation, type Program } from "@typespec/compiler";
import { getAllHttpServices, getHttpOperation, getServers } from "@typespec/http";
import { generateGo } from "../../src/emitter.js";
import type { ServerDescription } from "../../src/server.js";

export const SPECS_ROOT = join(import.meta.dirname, "../../../../node_modules/@typespec/http-specs");

export interface SpecResult {
  spec: string;
  status: "passed" | "failed" | "rejected" | "no-server";
  diagnostics: string[];
  scenarios: { name: string; status: "passed" | "failed" | "skipped"; detail?: string; reason?: string; adjustment?: string; replacement?: string; version?: string }[];
  output?: string;
}

export function listSpecs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === "main.tsp") out.push(relative(join(SPECS_ROOT, "specs"), dir).replace(/\\/g, "/"));
    }
  };
  walk(join(SPECS_ROOT, "specs"));
  return out.sort();
}

interface Scenario {
  sourceScenario?: string;
  operation?: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  reqBody?: string; // base64
  reqJSON: boolean;
  reqXML?: boolean;
  resp: { status: number; headers: Record<string, string>; contentType: string; body?: string; json: boolean; xml?: boolean };
  skip?: string;
  adjustment?: string;
  caseInsensitive?: boolean;
  fields?: Record<string, unknown>;
  compareInstants?: boolean;
  reqMultipart?: boolean;
  /** API version a versioned scenario targets (from `api-version:<v>` in its URI). */
  version?: string;
  /** Replacement scenario verifying contract-correct behaviour for a not-applicable upstream one. */
  replacement?: string;
}

// Expected handler arguments from the pinned TypeSpec and mock fixtures, independent of generated codecs.
const UTC_DATETIME_CASES = new Set([
  "Encode_Datetime_Property_default", "Encode_Datetime_Property_rfc3339", "Encode_Datetime_ResponseHeader_rfc3339",
  "Payload_Xml_ModelWithDatetimeValue_get", "Payload_Xml_ModelWithDatetimeValue_put",
]);

const colors = ["blue", "red", "green"];
export const EXPECTED_FIELDS: Record<string, Record<string, unknown>> = {
  Type_Model_Visibility_getModel: { QueryProp: 123 },
  Type_Model_Visibility_headModel: { QueryProp: 123 },
  Parameters_Path_normal: { Name: "foo" },
  Parameters_Path_optional_0: { Name: null },
  Parameters_Path_optional_1: { Name: "foo" },
  Parameters_Query_Constant_post: { QueryParam: "constantValue" },
  Parameters_Query_SpecialChar_dollarSign: { Filter: "status eq 'active'" },
  Parameters_CollectionFormat_Query_multi: { Colors: colors },
  Parameters_CollectionFormat_Query_csv: { Colors: colors },
  Parameters_CollectionFormat_Query_ssv: { Colors: colors },
  Parameters_CollectionFormat_Query_pipes: { Colors: colors },
  Parameters_CollectionFormat_Header_csv: { Colors: colors },
};

// These eleven mock query strings are decoded CSV expressions. The item boundaries below
// come from the pinned specification examples. All other strings and repeated values are data.
const csvQueries = new Map<string, [string, string[]]>([
  ["Parameters_CollectionFormat_Query_csv", ["colors", colors]],
  ["Encode_Bytes_Query_base64urlArray", ["value", ["dGVzdA", "dGVzdA"]]],
  ["Encode_Datetime_Query_unixTimestampArray", ["value", ["1686566864", "1686734256"]]],
  ["Encode_Duration_Query_int32SecondsArray", ["input", ["36", "47"]]],
  ["Encode_Duration_Query_int32MillisecondsArray", ["input", ["36000", "47000"]]],
]);
for (const operator of ["QueryExpansion", "QueryContinuation"]) {
  const prefix = `Routes_QueryParameters_${operator}_Standard_`;
  csvQueries.set(prefix + "array", ["param", ["a", "b"]]);
  csvQueries.set(prefix + "record", ["param", ["a", "1", "b", "2"]]);
  csvQueries.set(prefix + "model", ["param", ["field", "status", "value", "active"]]);
  EXPECTED_FIELDS[prefix + "array"] = { Param: ["a", "b"] };
  EXPECTED_FIELDS[prefix + "record"] = { Param: { a: 1, b: 2 } };
  EXPECTED_FIELDS[prefix + "model"] = { Param: { field: "status", value: "active" } };
}

const CONFIG = { baseUrl: "http://localhost:3000" };

/**
 * Replacement tests: the mock request's media type contradicts the media type main.tsp declares
 * (the Spector mock server does not check it). These scenarios are replayed with the declared
 * media type; test/go/conformance-replacements verifies that the contradicting media type is
 * rejected with 415.
 */
/**
 * Scenarios whose mock sends a non-canonical spelling of a value without letter case (the
 * boolean string encoding accepts "TRUE"/"FaLsE"; the server canonicalizes to "true"/"false").
 * Strings are compared case-insensitively for them.
 */
export const CASE_INSENSITIVE = new Set(["Encode_Boolean_Property_trueUpper", "Encode_Boolean_Property_falseMixed"]);

/**
 * Replacement scenarios: for upstream scenarios that do not apply to a server (or whose media
 * type contradicts main.tsp), verify the contract-correct server behaviour instead.
 */
function replacement(spec: string, of: string, method: string, url: string, contentType: string, body: string, status: number): Scenario {
  return {
    name: `Replacement_${of}`,
    method,
    url,
    headers: { "Content-Type": contentType },
    reqBody: Buffer.from(body).toString("base64"),
    reqJSON: false,
    resp: { status, headers: {}, contentType: "", json: false },
    replacement: of,
  };
}

export const REPLACEMENTS: Record<string, Scenario[]> = {
  "type/scalar": [
    replacement("type/scalar", "Type_Scalar_String_put", "PUT", "/type/scalar/string", "text/plain", `"test"`, 415),
    replacement("type/scalar", "Type_Scalar_Unknown_put", "PUT", "/type/scalar/unknown", "text/plain", `"test"`, 415),
  ],
  "type/enum/extensible": [
    replacement("type/enum/extensible", "Type_Enum_Extensible_String_putUnknownValue", "PUT", "/type/enum/extensible/string/unknown-value", "text/plain", `"Weekend"`, 415),
    replacement("type/enum/extensible", "Type_Enum_Extensible_String_putKnownValue", "PUT", "/type/enum/extensible/string/known-value", "text/plain", `"Monday"`, 415),
  ],
  "type/model/visibility": [
    replacement("type/model/visibility", "Type_Model_Visibility_putReadOnlyModel", "PUT", "/type/model/visibility/readonlyroundtrip", "", "", 415),
  ],
  "payload/content-negotiation": [
    { ...replacement("payload/content-negotiation", "Payload_ContentNegotiation_SameBody_2", "GET", "/content-negotiation/same-body", "", "", 406), headers: { accept: "wrongAccept" } },
    { ...replacement("payload/content-negotiation", "Payload_ContentNegotiation_DifferentBody_2", "GET", "/content-negotiation/different-body", "", "", 406), headers: { accept: "wrongAccept" } },
  ],
  "type/enum/fixed": [
    // closed enum: an undeclared value is rejected by the server (the mock answers 500 to test clients)
    replacement("type/enum/fixed", "Type_Enum_Fixed_String_putUnknownValue", "PUT", "/type/enum/fixed/string/unknown-value", "application/json", `"Weekend"`, 400),
  ],
  "payload/json-merge-patch": [
    replacement("payload/json-merge-patch", "Payload_JsonMergePatch_updateOptionalResource", "PATCH", "/json-merge-patch/update/resource/optional", "application/json", `{"description": null}`, 415),
    replacement("payload/json-merge-patch", "Payload_JsonMergePatch_updateResource", "PATCH", "/json-merge-patch/update/resource", "application/json", `{"description": null}`, 415),
  ],
  "versioning/returnTypeChangedFrom": [
    replacement("versioning/returnTypeChangedFrom", "Versioning_ReturnTypeChangedFrom_test", "POST", "/versioning/return-type-changed-from/api-version:v2/test", "text/plain", `"test"`, 415),
  ],
  "type/model/inheritance/single-discriminator": [
    replacement("type/model/inheritance/single-discriminator", "Type_Model_Inheritance_SingleDiscriminator_getMissingDiscriminator", "PUT", "/type/model/inheritance/single-discriminator/model", "application/json", `{"wingspan": 1}`, 400),
  ],
  "type/model/inheritance/nested-discriminator": [
    replacement("type/model/inheritance/nested-discriminator", "Type_Model_Inheritance_NestedDiscriminator_getMissingDiscriminator", "PUT", "/type/model/inheritance/nested-discriminator/model", "application/json", `{"age": 1}`, 400),
  ],
  "type/model/inheritance/enum-discriminator": [
    replacement("type/model/inheritance/enum-discriminator", "Type_Model_Inheritance_EnumDiscriminator_getExtensibleModelMissingDiscriminator", "PUT", "/type/model/inheritance/enum-discriminator/extensible-enum", "application/json", `{"weight": 10}`, 400),
    replacement("type/model/inheritance/enum-discriminator", "Type_Model_Inheritance_EnumDiscriminator_getFixedModelMissingDiscriminator", "PUT", "/type/model/inheritance/enum-discriminator/fixed-enum", "application/json", `{"length": 10}`, 400),
    replacement("type/model/inheritance/enum-discriminator", "Type_Model_Inheritance_EnumDiscriminator_getFixedModelWrongDiscriminator", "PUT", "/type/model/inheritance/enum-discriminator/fixed-enum", "application/json", `{"length": 10, "kind": "wrongKind"}`, 400),
  ],
};

export const CONTENT_TYPE_OVERRIDES: Record<string, string> = {
  Type_Scalar_String_put: "application/json",
  Type_Scalar_Unknown_put: "application/json",
  Type_Enum_Extensible_String_putKnownValue: "application/json",
  Type_Enum_Extensible_String_putUnknownValue: "application/json",
  Payload_JsonMergePatch_updateResource: "application/merge-patch+json",
  Payload_JsonMergePatch_updateOptionalResource: "application/merge-patch+json",
  Versioning_ReturnTypeChangedFrom_test: "application/json",
};

/**
 * Scenarios that do not apply to a server implementation, or whose mock request contradicts the
 * spec's main.tsp. Each entry is a reviewed decision; the generated server's behaviour for them
 * is the contract-correct one stated here.
 */
export const NOT_APPLICABLE: Record<string, string> = {
  Type_Enum_Fixed_String_putUnknownValue: "the mock sends an unknown closed-enum value and expects 500 to test clients; the request is invalid under the declared contract (400 replacement)",
  Payload_ContentNegotiation_SameBody_2: "the mock answers an unacceptable Accept with 400 and an error body the spec does not declare; the server answers 406 Not Acceptable (replacement)",
  Payload_ContentNegotiation_DifferentBody_2: "the mock answers an unacceptable Accept with 400 and an error body the spec does not declare; the server answers 406 Not Acceptable (replacement)",
  Payload_Pageable_ServerDrivenPagination_link_1: "request to the next-page link, a URL chosen by the server implementation rather than an operation of the spec",
  Payload_Pageable_ServerDrivenPagination_linkString_1: "request to the next-page link, a URL chosen by the server implementation rather than an operation of the spec",
  Payload_Pageable_ServerDrivenPagination_nestedLink_1: "request to the next-page link, a URL chosen by the server implementation rather than an operation of the spec",
  Payload_Pageable_ServerDrivenPagination_AlternateInitialVerb_post_1: "request to the next-page link, a URL chosen by the server implementation rather than an operation of the spec",
  Payload_Pageable_XmlPagination_listWithNextLink_1: "request to the next-page link, a URL chosen by the server implementation rather than an operation of the spec",
  Type_Model_Inheritance_EnumDiscriminator_getExtensibleModelMissingDiscriminator: "client-tolerance scenario: the mock response omits the required discriminator",
  Type_Model_Inheritance_EnumDiscriminator_getFixedModelMissingDiscriminator: "client-tolerance scenario: the mock response omits the required discriminator",
  Type_Model_Inheritance_EnumDiscriminator_getFixedModelWrongDiscriminator: "client-tolerance scenario: the mock response violates the closed enum discriminator",
  Type_Model_Inheritance_NestedDiscriminator_getMissingDiscriminator: "client-tolerance scenario: the mock response omits the required discriminator",
  Type_Model_Inheritance_SingleDiscriminator_getMissingDiscriminator: "client-tolerance scenario: the mock response omits the required discriminator",
};

function isXML(ct: string): boolean {
  const mt = ct.split(";")[0].trim().toLowerCase();
  return mt === "application/xml" || mt === "text/xml" || mt.endsWith("+xml");
}

function isJSON(ct: string): boolean {
  const mt = ct.split(";")[0].trim().toLowerCase();
  return mt === "application/json" || mt.endsWith("+json");
}

function serialize(raw: any): Buffer | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw);
  if (typeof raw.serialize === "function") {
    const s = raw.serialize(CONFIG);
    return Buffer.isBuffer(s) ? s : Buffer.from(String(s));
  }
  if (typeof raw === "function") return Buffer.from(String(raw(CONFIG)));
  return Buffer.from(JSON.stringify(raw));
}

function resolveValue(v: any): string {
  if (typeof v === "function") return String(v(CONFIG));
  if (v && typeof v.serialize === "function") return String(v.serialize(CONFIG));
  return String(v);
}

export function scenarioQuery(name: string, fields: Record<string, unknown>): string {
  const csv = csvQueries.get(name);
  if (csv && fields[csv[0]] !== csv[1].join(",")) throw new Error(`${name}: review the upstream query values`);
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (csv && key === csv[0]) {
      pairs.push(encodeURIComponent(key) + "=" + csv[1].map(encodeURIComponent).join(","));
    } else {
      for (const item of Array.isArray(value) ? value : [value]) {
        pairs.push(new URLSearchParams([[key, resolveValue(item)]]).toString());
      }
    }
  }
  return pairs.length ? "?" + pairs.join("&") : "";
}

async function loadScenarios(spec: string): Promise<Scenario[]> {
  const file = join(SPECS_ROOT, "dist", "specs", spec, "mockapi.js");
  if (!existsSync(file)) throw new Error(`Missing official mock API for ${spec}`);
  const mod = await NodeHost.getJsImport(file);
  const out: Scenario[] = [];
  for (const [name, sc] of Object.entries<any>(mod.Scenarios ?? {})) {
    for (const [i, api] of (sc.apis ?? []).entries() as IterableIterator<[number, any]>) {
      const s: Scenario = {
        sourceScenario: name,
        name: sc.apis.length > 1 ? `${name}_${i}` : name,
        method: String(api.method).toUpperCase(),
        url: "",
        headers: {},
        reqJSON: false,
        resp: { status: api.response?.status ?? 200, headers: {}, contentType: "", json: false },
      };
      // "by-key" scenarios pass when every listed key was hit; each API entry is still a concrete
      // request/response pair, so all of them are replayed.
      if (!["response-success", "status-code", "by-key"].includes(sc.passCondition)) throw new Error(`${name}: unreviewed pass condition ${sc.passCondition}`);
      if (NOT_APPLICABLE[name] ?? NOT_APPLICABLE[s.name]) s.skip = NOT_APPLICABLE[name] ?? NOT_APPLICABLE[s.name];
      if (CASE_INSENSITIVE.has(name)) s.caseInsensitive = true;
      const uri = String(api.uri).replace(/\\:/g, ":"); // express route escapes
      const version = /api-version:([^/]+)/.exec(uri)?.[1];
      if (version) s.version = version;
      s.url = uri + scenarioQuery(name, api.request?.query ?? {});
      for (const [k, v] of Object.entries<any>(api.request?.headers ?? {})) s.headers[k] = resolveValue(v);
      const body = api.request?.body;
      if (body) {
        if (body.kind === "multipart") {
          const { data, contentType } = await encodeMultipart(body);
          s.reqBody = data.toString("base64");
          s.headers["Content-Type"] = contentType;
          s.reqMultipart = true;
        } else {
          const b = serialize(body.rawContent);
          if (b) s.reqBody = b.toString("base64");
          const declared = Object.entries(s.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
          const ct = declared ?? body.contentType ?? (typeof body.rawContent === "object" && !Buffer.isBuffer(body.rawContent) ? "application/json" : undefined);
          if (ct && !declared) s.headers["Content-Type"] = ct;
          if (CONTENT_TYPE_OVERRIDES[name]) {
            for (const k of Object.keys(s.headers)) if (k.toLowerCase() === "content-type") delete s.headers[k];
            s.headers["Content-Type"] = CONTENT_TYPE_OVERRIDES[name];
            s.adjustment = `request media type corrected to ${CONTENT_TYPE_OVERRIDES[name]}`;
          }
          s.reqJSON = isJSON(CONTENT_TYPE_OVERRIDES[name] ?? ct ?? "");
          s.reqXML = isXML(ct ?? "");
        }
      }
      // This mock omits the required explicit JSON body. Its TypeSpec scenario prescribes {}.
      // The companion replacement sends the original empty request and checks rejection.
      if (s.name === "Type_Model_Visibility_putReadOnlyModel") {
        if (body || Object.keys(s.headers).length) throw new Error("review the corrected upstream visibility request");
        s.reqJSON = true;
        s.reqBody = Buffer.from("{}").toString("base64");
        s.adjustment = "required explicit JSON body supplied as {}";
        s.headers["Content-Type"] = "application/json";
      }
      const rb = api.response?.body;
      if (rb) {
        const b = serialize(rb.rawContent);
        if (b) s.resp.body = b.toString("base64");
        s.resp.contentType = rb.contentType ?? "";
        s.resp.json = isJSON(rb.contentType ?? "");
        s.resp.xml = isXML(rb.contentType ?? "");
        if (rb.kind === "multipart") throw new Error(`${name}: a multipart mock response needs a wire assertion`);
      }
      for (const [k, v] of Object.entries<any>(api.response?.headers ?? {})) s.resp.headers[k] = resolveValue(v);
      if (UTC_DATETIME_CASES.has(s.name)) s.compareInstants = true;
      s.fields = EXPECTED_FIELDS[s.name];
      out.push(s);
    }
  }
  for (const r of REPLACEMENTS[spec] ?? []) out.push(r);
  return out;
}

/** Encodes a spec-api multipart({parts, files}) body with the platform FormData encoder. */
async function encodeMultipart(body: any): Promise<{ data: Buffer; contentType: string }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries<any>(body.parts ?? {})) {
    // Non-file parts are single parts; arrays and objects are JSON (HttpPart<Address[]>).
    fd.append(k, typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (const f of body.files ?? []) {
    const blob = new Blob([f.buffer], f.mimetype ? { type: f.mimetype } : {});
    if (f.originalname) fd.append(f.fieldname, blob, f.originalname);
    else fd.append(f.fieldname, blob, "blob");
  }
  const req = new Request("http://localhost/", { method: "POST", body: fd });
  return { data: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get("content-type")! };
}

/** Associate the mock with its source operation independently of the Go router. Spector
 * groups a handful of endpoints under one scenario and has three non-matching mock names. */
function matchOperations(program: Program, scenarios: Scenario[], generated: ServerDescription): void {
  const definitions = new Map(listScenarios(program).map(s => [s.name, s]));
  const [services] = getAllHttpServices(program);
  for (const s of scenarios) {
    if (s.skip || s.replacement) continue;
    const key = s.sourceScenario!;
    let operations: Operation[];
    if (key === "Documentation_Lists_bulletPointsModel") {
      operations = services.flatMap(svc => svc.operations).map(o => o.operation).filter(o => o.name === "bulletPointsModel");
    } else {
      const group = key === "Versioning_Removed_modelV3_V2" || key === "Versioning_Removed_modelV3_V2preview" ? "Versioning_Removed_modelV3" : key;
      operations = (definitions.get(group)?.endpoints ?? []).map(e => e.target).filter(op => getHttpOperation(program, op)[0].verb.toUpperCase() === s.method);
      if (group === "Parameters_BodyOptionality_OptionalExplicit") operations = operations.filter(o => o.name === s.url.split("/").at(-1));
      if (group.startsWith("Payload_ContentNegotiation_")) {
        const want = ({ "image/png": "getAvatarAsPng", "image/jpeg": "getAvatarAsJpeg", "application/json": "getAvatarAsJson" } as Record<string, string>)[s.headers.accept];
        operations = operations.filter(o => o.name === want);
      }
    }
    const exact = generated.filter(o => operations.includes(o.operation));
    const candidates = exact.length ? exact : generated.filter(o => operations.some(op =>
      !!op.node && op.node === o.operation.node && op.interface?.name === o.operation.interface?.name &&
      getNamespaceFullName(op.namespace!) === getNamespaceFullName(o.operation.namespace!)));

    if (candidates.length !== 1) throw new Error(`${s.name}: expected one source operation, found ${candidates.map(o => o.goName).join(", ")}`);
    s.operation = candidates[0].goName;
  }
}

function conformanceGo(desc: ServerDescription): string {
  const methods = desc
    .map((o) => {
      const order = [...o.variants].sort((a, b) => rank(a.status) - rank(b.status));
      const cases = order
        .map((v) => {
          const cond =
            v.status.kind === "fixed" ? `exp.Status == ${v.status.code}` : v.status.kind === "range" ? `exp.Status >= ${v.status.min} && exp.Status <= ${v.status.max}` : "true";
          const ct = v.body ? ` && contentTypeMatches(exp.ContentType, []string{${v.body.contentTypes.map((c) => JSON.stringify(c)).join(", ")}})` : ` && len(exp.Body) == 0`;
          const stream = v.sse
            ? `\t\trecs := tsgo.ParseSSE(exp.Body)\n\t\tresp.Body = func(yield func(tsgo.SSE[${v.sse.elem}]) bool) {\n\t\t\tfor _, rec := range recs {\n\t\t\t\tev, err := ${v.sse.unmarshal}(rec.Event, rec.Data)\n\t\t\t\tif err != nil {\n\t\t\t\t\tpanic(err)\n\t\t\t\t}\n\t\t\t\tif !yield(tsgo.SSE[${v.sse.elem}]{Event: ev, ID: rec.ID, Retry: rec.Retry}) {\n\t\t\t\t\treturn\n\t\t\t\t}\n\t\t\t}\n\t\t}\n`
            : v.jsonl
              ? `\t\tlines := bytes.Split(bytes.TrimSpace(exp.Body), []byte("\\n"))\n\t\tresp.Body = func(yield func(${v.jsonl.elem}) bool) {\n\t\t\tfor _, l := range lines {\n\t\t\t\tvar x ${v.jsonl.elem}\n\t\t\t\tif err := json.Unmarshal(l, &x); err != nil {\n\t\t\t\t\tpanic(err)\n\t\t\t\t}\n\t\t\t\tif !yield(x) {\n\t\t\t\t\treturn\n\t\t\t\t}\n\t\t\t}\n\t\t}\n`
              : "";
          return `\tif ${cond}${ct} {\n\t\tvar resp ${v.name}\n\t\tif err := fill(&resp, exp); err != nil {\n\t\t\treturn nil, err\n\t\t}\n${stream}\t\treturn resp, nil\n\t}\n`;
        })
        .join("");
      const drain = o.requestStream
        ? `\tvar items []any\n\tfor v, err := range r.Body {\n\t\tif err != nil {\n\t\t\treturn nil, err\n\t\t}\n\t\titems = append(items, v)\n\t}\n\tstreamItems = items\n`
        : "";
      return `func (conf) ${o.goName}(ctx context.Context, r ${o.goName}RequestObject) (${o.goName}ResponseObject, error) {\n\tcalls++\n\tlastOperation = ${JSON.stringify(o.goName)}\n\tlastRequest = r\n${drain}\texp := current.Resp\n${cases}\treturn nil, fmt.Errorf("no response variant of ${o.goName} for status %d (%s)", exp.Status, exp.ContentType)\n}\n`;
    })
    .join("\n");
  return `package gen\n\n${CONFORMANCE_PRELUDE}\n${methods}`;
}

/** Path prefix of the service's @server URL (deployment configuration, applied by mounting). */
function serverBasePath(program: any, version?: string): string {
  const [services] = getAllHttpServices(program);
  for (const svc of services) {
    for (const srv of getServers(program, svc.namespace) ?? []) {
      let url: string = srv.url;
      for (const [name, p] of (srv.parameters ?? new Map()) as Map<string, any>) {
        const dv = p.defaultValue;
        const members = p.type?.kind === "Enum" ? [...p.type.members.values()] : [];
        const v = dv?.value ?? (p.type?.kind === "String" ? p.type.value : members.length ? (members.find((m: any) => (m.value ?? m.name) === version) ?? members.at(-1))?.value : undefined);
        if (v !== undefined && name !== "endpoint") url = url.replaceAll(`{${name}}`, String(v));
      }
      url = url.replace(/^\{endpoint\}/, "").replace(/^[a-z]+:\/\/[^/]*/, "");
      if (url && url !== "/" && !url.includes("{")) return url.replace(/\/$/, "");
    }
  }
  return "";
}

function rank(s: ServerDescription[number]["variants"][number]["status"]): number {
  return s.kind === "fixed" ? 0 : s.kind === "range" ? 1 : 2;
}

const CONFORMANCE_PRELUDE = `
import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"example.com/gen/tsgo"
)

type expectedResponse struct {
	Status      int               \`json:"status"\`
	Headers     map[string]string \`json:"headers"\`
	ContentType string            \`json:"contentType"\`
	Body        []byte            \`json:"body"\`
	JSON        bool              \`json:"json"\`
	XML         bool              \`json:"xml"\`
}

type scenario struct {
	Name    string            \`json:"name"\`
	Operation string          \`json:"operation"\`
	Method  string            \`json:"method"\`
	URL     string            \`json:"url"\`
	Headers map[string]string \`json:"headers"\`
	ReqBody []byte            \`json:"reqBody"\`
	ReqJSON bool              \`json:"reqJSON"\`
	ReqXML  bool              \`json:"reqXML"\`
	Fields  map[string]json.RawMessage \`json:"fields"\`
	ReqMP   bool              \`json:"reqMultipart"\`
	Resp    expectedResponse  \`json:"resp"\`
	Skip    string            \`json:"skip"\`
	Instant bool              \`json:"compareInstants"\`
	Fold    bool              \`json:"caseInsensitive"\`
}

var current scenario
var lastOperation string
var lastRequest any
var calls int

// streamItems holds the drained items of a streaming (JSON Lines) request body.
var streamItems []any

// declaredHeaders are the response headers of the variant selected by fill: only these are part
// of the operation's contract (mock responses may carry extra undeclared headers).
var declaredHeaders map[string]bool

type conf struct{}

func contentTypeMatches(ct string, allowed []string) bool {
	if ct == "" {
		return true
	}
	mt, _, _ := mime.ParseMediaType(ct)
	for _, a := range allowed {
		if strings.EqualFold(a, mt) || a == "*/*" || (strings.HasSuffix(a, "/*") && strings.HasPrefix(mt, strings.TrimSuffix(a, "*"))) {
			return true
		}
	}
	return false
}

func fill(dst any, exp expectedResponse) error {
	v := reflect.ValueOf(dst).Elem()
	declaredHeaders = map[string]bool{"content-type": true}
	for i := 0; i < v.NumField(); i++ {
		if tag := v.Type().Field(i).Tag.Get("tsp"); strings.HasPrefix(tag, "header,") {
			declaredHeaders[strings.ToLower(strings.TrimPrefix(tag, "header,"))] = true
		}
	}
	if f := v.FieldByName("StatusCode"); f.IsValid() {
		f.SetInt(int64(exp.Status))
	}
	if f := v.FieldByName("ContentType"); f.IsValid() {
		mt, _, _ := mime.ParseMediaType(exp.ContentType)
		f.SetString(mt)
	}
	if f := v.FieldByName("Body"); f.IsValid() && len(exp.Body) > 0 && f.Kind() != reflect.Func {
		target := f
		if f.Kind() == reflect.Pointer {
			f.Set(reflect.New(f.Type().Elem()))
			target = f.Elem()
		}
		switch {
		case target.Type() == reflect.TypeOf(tsgo.File{}):
			mt, _, _ := mime.ParseMediaType(exp.ContentType)
			target.Set(reflect.ValueOf(tsgo.File{ContentType: mt, Contents: exp.Body}))
		case exp.XML:
			n, err := tsgo.ParseXML(exp.Body)
			if err != nil {
				return err
			}
			x, ok := target.Addr().Interface().(interface{ FromXMLNode(*tsgo.XMLNode) error })
			if !ok {
				return fmt.Errorf("%s has no XML decoding", target.Type())
			}
			if err := x.FromXMLNode(n); err != nil {
				return fmt.Errorf("expected XML response body does not decode into %s: %w", target.Type(), err)
			}
		case !exp.JSON && target.Kind() == reflect.Slice && target.Type().Elem().Kind() == reflect.Uint8:
			target.SetBytes(exp.Body)
		case !exp.JSON && target.Kind() == reflect.String:
			target.SetString(string(exp.Body))
		default:
			if err := json.Unmarshal(exp.Body, target.Addr().Interface()); err != nil {
				return fmt.Errorf("expected response body does not decode into %s: %w", target.Type(), err)
			}
		}
	}
	for i := 0; i < v.NumField(); i++ {
		tag := v.Type().Field(i).Tag.Get("tsp")
		if !strings.HasPrefix(tag, "header,") {
			continue
		}
		name := strings.TrimPrefix(tag, "header,")
		val, ok := "", false
		for k, x := range exp.Headers {
			if strings.EqualFold(k, name) {
				val, ok = x, true
			}
		}
		if !ok {
			continue
		}
		if err := setText(v.Field(i), val); err != nil {
			return fmt.Errorf("header %s: %w", name, err)
		}
	}
	return nil
}

func setText(f reflect.Value, s string) error {
	if f.Kind() == reflect.Pointer {
		f.Set(reflect.New(f.Type().Elem()))
		f = f.Elem()
	}
	switch f.Type() {
	case reflect.TypeOf(time.Time{}):
		t, err := http.ParseTime(s)
		if err != nil {
			if t, err = time.Parse(time.RFC3339Nano, s); err != nil {
				n, err2 := strconv.ParseInt(s, 10, 64)
				if err2 != nil {
					return err
				}
				t = time.Unix(n, 0).UTC()
			}
		}
		f.Set(reflect.ValueOf(t))
		return nil
	case reflect.TypeOf(tsgo.Duration{}):
		d, err := tsgo.ParseDuration(s)
		if err != nil {
			return err
		}
		f.Set(reflect.ValueOf(d))
		return nil
	case reflect.TypeOf([]byte(nil)):
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return err
		}
		f.SetBytes(b)
		return nil
	}
	switch f.Kind() {
	case reflect.String:
		f.SetString(s)
	case reflect.Bool:
		b, err := strconv.ParseBool(s)
		if err != nil {
			return err
		}
		f.SetBool(b)
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return err
		}
		f.SetInt(n)
	case reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return err
		}
		f.SetUint(n)
	case reflect.Float32, reflect.Float64:
		n, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return err
		}
		f.SetFloat(n)
	case reflect.Slice:
		parts := strings.Split(s, ",")
		sl := reflect.MakeSlice(f.Type(), len(parts), len(parts))
		for i, p := range parts {
			if err := setText(sl.Index(i), strings.TrimSpace(p)); err != nil {
				return err
			}
		}
		f.Set(sl)
	default:
		return fmt.Errorf("cannot set %s from text", f.Type())
	}
	return nil
}

// equivalent compares JSON values: numbers by exact value, strings equal or denoting the same
// instant (RFC 3339) — the scenario's own coercedBodyEquals semantics.
func equivalent(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !equivalent(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !equivalent(x[i], y[i]) {
				return false
			}
		}
		return true
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		r1, ok1 := new(big.Rat).SetString(x.String())
		r2, ok2 := new(big.Rat).SetString(y.String())
		return ok1 && ok2 && r1.Cmp(r2) == 0
	case string:
		y, ok := b.(string)
		if !ok {
			return false
		}
		if x == y || (current.Fold && strings.EqualFold(x, y)) {
			return true
		}
		if !current.Instant { return false }
		t1, e1 := time.Parse(time.RFC3339Nano, x)
		t2, e2 := time.Parse(time.RFC3339Nano, y)
		return e1 == nil && e2 == nil && t1.Equal(t2)
	}
	return reflect.DeepEqual(a, b)
}

func xmlNodeEquivalent(a, b *tsgo.XMLNode) bool {
	if a.Name.Local != b.Name.Local || a.Name.Space != b.Name.Space || len(a.Attrs) != len(b.Attrs) || len(a.Children) != len(b.Children) {
		return false
	}
	for _, at := range a.Attrs {
		if v, ok := b.Attr(at.Name); !ok || !equivalent(v, at.Value) {
			return false
		}
	}
	ta, tb := a.Text, b.Text
	if len(a.Children) > 0 || strings.TrimSpace(ta) == "" && strings.TrimSpace(tb) == "" {
		ta, tb = strings.TrimSpace(ta), strings.TrimSpace(tb)
	}
	if !equivalent(ta, tb) {
		return false
	}
	for i := range a.Children {
		if !xmlNodeEquivalent(a.Children[i], b.Children[i]) {
			return false
		}
	}
	return true
}

func xmlEquivalent(a, b []byte) bool {
	x, err1 := tsgo.ParseXML(a)
	y, err2 := tsgo.ParseXML(b)
	return err1 == nil && err2 == nil && xmlNodeEquivalent(x, y)
}

func jsonEquivalent(a, b []byte) bool {
	if !json.Valid(a) || !json.Valid(b) { return false }
	parse := func(d []byte) (any, error) {
		dec := json.NewDecoder(bytes.NewReader(d))
		dec.UseNumber()
		var v any
		err := dec.Decode(&v)
		return v, err
	}
	x, err1 := parse(a)
	y, err2 := parse(b)
	return err1 == nil && err2 == nil && equivalent(x, y)
}

func headerEquivalent(got, want string) bool {
	if got == want {
		return true
	}
	return jsonEquivalent([]byte(strconv.Quote(got)), []byte(strconv.Quote(want)))
}

func bytesBody(v reflect.Value) ([]byte, bool) {
	if !v.IsValid() {
		return nil, false
	}
	b, ok := v.Interface().([]byte)
	return b, ok
}

type sentPart struct {
	filename, contentType string
	data                  []byte
}

// checkMultipart compares the decoded multipart body (fields tagged tsp:"part,<name>") with the
// parts that were sent.
func checkMultipart(t *testing.T, body reflect.Value, contentType string, raw []byte) {
	t.Helper()
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	mr := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	sent := map[string][]sentPart{}
	for {
		p, err := mr.NextPart()
		if err == io.EOF { break }
		if err != nil { t.Fatal(err) }
		b, err := io.ReadAll(p)
		if err != nil { t.Fatal(err) }
		sent[p.FormName()] = append(sent[p.FormName()], sentPart{p.FileName(), p.Header.Get("Content-Type"), b})
	}
	if body.Kind() == reflect.Pointer {
		body = body.Elem()
	}
	same := func(v reflect.Value, p sentPart) bool {
		if f, ok := v.Interface().(tsgo.File); ok {
			return bytes.Equal(f.Contents, p.data) && (p.filename == "" || p.filename == "blob" || f.Filename == p.filename) && (p.contentType == "" || f.ContentType == p.contentType)
		}
		if v.Kind() == reflect.String {
			return v.String() == string(p.data)
		}
		if b, ok := v.Interface().([]byte); ok {
			return bytes.Equal(b, p.data)
		}
		got, err := json.Marshal(v.Interface())
		return err == nil && jsonEquivalent(got, p.data)
	}
	for i := 0; i < body.NumField(); i++ {
		tag := body.Type().Field(i).Tag.Get("tsp")
		name, single := strings.CutPrefix(tag, "part,")
		repeated := false
		if !single {
			if name, repeated = strings.CutPrefix(tag, "parts,"); !repeated {
				continue
			}
		}
		f, parts := body.Field(i), sent[name]
		if f.Kind() == reflect.Pointer {
			if f.IsNil() != (len(parts) == 0) {
				t.Fatalf("part %s: presence mismatch (sent %d)", name, len(parts))
			}
			if f.IsNil() {
				continue
			}
			f = f.Elem()
		}
		if repeated {
			if f.Len() != len(parts) {
				t.Fatalf("part %s: decoded %d values, sent %d", name, f.Len(), len(parts))
			}
			for j := range parts {
				if !same(f.Index(j), parts[j]) {
					t.Fatalf("part %s[%d] decoded as %v", name, j, f.Index(j).Interface())
				}
			}
			continue
		}
		if len(parts) != 1 || !same(f, parts[0]) {
			t.Fatalf("part %s decoded as %v (sent %d parts)", name, f.Interface(), len(parts))
		}
	}
}

func fileBody(req any) (tsgo.File, bool) {
	if req == nil {
		return tsgo.File{}, false
	}
	b := reflect.ValueOf(req).FieldByName("Body")
	if !b.IsValid() {
		return tsgo.File{}, false
	}
	if b.Kind() == reflect.Pointer {
		if b.IsNil() {
			return tsgo.File{}, false
		}
		b = b.Elem()
	}
	f, ok := b.Interface().(tsgo.File)
	return f, ok
}

func TestScenarios(t *testing.T) {
	data, err := os.ReadFile("scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var scenarios []scenario
	if err := json.Unmarshal(data, &scenarios); err != nil {
		t.Fatal(err)
	}
	var h http.Handler = NewHandler(conf{}, ServerOptions{
		Authenticate:      func(ctx context.Context, r *http.Request, op tsgo.OperationInfo) (context.Context, error) { return ctx, nil },
		ValidateResponses: true,
		ResponseErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "response error: "+err.Error(), 500)
		},
	})
	if basePath != "" {
		inner := h
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := strings.TrimPrefix(r.URL.Path, basePath)
			if p == r.URL.Path {
				http.NotFound(w, r)
				return
			}
			if p == "" {
				p = "/"
			}
			r2 := r.Clone(r.Context())
			r2.URL.Path, r2.URL.RawPath = p, ""
			inner.ServeHTTP(w, r2)
		})
	}
	for _, sc := range scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			if sc.Skip != "" {
				t.Skip(sc.Skip)
			}
			current = sc
			lastOperation = ""
			calls = 0
			lastRequest = nil
			streamItems = nil
			declaredHeaders = map[string]bool{"content-type": true}
			req := httptest.NewRequest(sc.Method, sc.URL, bytes.NewReader(sc.ReqBody))
			for k, v := range sc.Headers {
				req.Header.Set(k, v)
			}
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != sc.Resp.Status {
				t.Fatalf("status %d, want %d: %s", rr.Code, sc.Resp.Status, rr.Body.String())
			}
			if sc.Operation != "" && (calls != 1 || lastOperation != sc.Operation) {
				t.Fatalf("handler %s called %d times, want one call to %s", lastOperation, calls, sc.Operation)
			}
			for name, want := range sc.Fields {
				if lastRequest == nil { t.Fatalf("missing request for field %s", name) }
				field := reflect.ValueOf(lastRequest).FieldByName(name)
				if !field.IsValid() { t.Fatalf("missing request field %s", name) }
				got, err := json.Marshal(field.Interface())
				if err != nil || !jsonEquivalent(got, want) { t.Fatalf("decoded %s = %s, want %s (%v)", name, got, want, err) }
			}
			if strings.HasPrefix(sc.Name, "Replacement_") && calls != 0 {
				t.Fatalf("invalid request reached handler %d times", calls)
			}
			if sc.Resp.ContentType != "" {
				got, _, err := mime.ParseMediaType(rr.Header().Get("Content-Type"))
				want, _, err2 := mime.ParseMediaType(sc.Resp.ContentType)
				if err != nil || err2 != nil || got != want {
					t.Fatalf("response Content-Type = %q, want %q", got, want)
				}
			}
			if sc.Resp.Status < 400 && len(sc.Resp.Body) == 0 && rr.Body.Len() != 0 {
				t.Fatalf("unexpected response body %q", rr.Body.Bytes())
			}
			if len(sc.Resp.Body) > 0 {
				if strings.HasPrefix(sc.Resp.ContentType, "application/jsonl") {
					got := bytes.Split(bytes.TrimSpace(rr.Body.Bytes()), []byte("\\n"))
					want := bytes.Split(bytes.TrimSpace(sc.Resp.Body), []byte("\\n"))
					if len(got) != len(want) {
						t.Fatalf("%d lines, want %d: %s", len(got), len(want), rr.Body.String())
					}
					for i := range got {
						if !jsonEquivalent(got[i], want[i]) {
							t.Fatalf("line %d = %s, want %s", i, got[i], want[i])
						}
					}
				} else if strings.HasPrefix(sc.Resp.ContentType, "text/event-stream") {
					got, want := tsgo.ParseSSE(rr.Body.Bytes()), tsgo.ParseSSE(sc.Resp.Body)
					if len(got) != len(want) {
						t.Fatalf("%d events, want %d:\\n%s", len(got), len(want), rr.Body.String())
					}
					for i := range got {
						g, w := got[i], want[i]
						dataOK := string(g.Data) == string(w.Data) || jsonEquivalent(g.Data, w.Data)
						idOK := (g.ID == nil) == (w.ID == nil) && (g.ID == nil || *g.ID == *w.ID)
						retryOK := (g.Retry == nil) == (w.Retry == nil) && (g.Retry == nil || *g.Retry == *w.Retry)
						if g.Event != w.Event || !dataOK || !idOK || !retryOK {
							t.Fatalf("event %d = %+v (%s), want %+v (%s)", i, g, g.Data, w, w.Data)
						}
					}
				} else if sc.Resp.XML {
					if !xmlEquivalent(rr.Body.Bytes(), sc.Resp.Body) {
						t.Fatalf("response body %s, want %s", rr.Body.String(), sc.Resp.Body)
					}
				} else if sc.Resp.JSON {
					if !jsonEquivalent(rr.Body.Bytes(), sc.Resp.Body) {
						t.Fatalf("response body %s, want %s", rr.Body.String(), sc.Resp.Body)
					}
				} else if !bytes.Equal(rr.Body.Bytes(), sc.Resp.Body) {
					t.Fatalf("response body %q, want %q", rr.Body.String(), sc.Resp.Body)
				}
			}
			for k, v := range sc.Resp.Headers {
				if !declaredHeaders[strings.ToLower(k)] {
					continue // not declared by the response: not part of the contract
				}
				if strings.EqualFold(k, "content-type") {
					got, _, _ := mime.ParseMediaType(rr.Header().Get(k))
					want, _, _ := mime.ParseMediaType(v)
					if got != want {
						t.Fatalf("response content type %q, want %q", rr.Header().Get(k), v)
					}
					continue
				}
				if got := rr.Header().Get(k); !headerEquivalent(got, v) {
					t.Fatalf("response header %s = %q, want %q", k, got, v)
				}
			}
			if sc.ReqMP && lastRequest != nil {
				checkMultipart(t, reflect.ValueOf(lastRequest).FieldByName("Body"), sc.Headers["Content-Type"], sc.ReqBody)
			} else if streamItems != nil {
				want := bytes.Split(bytes.TrimSpace(sc.ReqBody), []byte("\\n"))
				if len(streamItems) != len(want) {
					t.Fatalf("decoded %d stream items, sent %d", len(streamItems), len(want))
				}
				for i, it := range streamItems {
					got, err := json.Marshal(it)
					if err != nil || !jsonEquivalent(got, want[i]) {
						t.Fatalf("stream item %d re-encodes as %s, sent %s", i, got, want[i])
					}
				}
			} else if sc.ReqXML && len(sc.ReqBody) > 0 && lastRequest != nil {
				sent, err := tsgo.ParseXML(sc.ReqBody)
				if err != nil {
					t.Fatal(err)
				}
				body := reflect.ValueOf(lastRequest).FieldByName("Body")
				x, ok := body.Interface().(interface {
					ToXMLNode(tsgo.XMLName) (*tsgo.XMLNode, error)
				})
				if !ok {
					t.Fatalf("request body %s has no XML encoding", body.Type())
				}
				n, err := x.ToXMLNode(sent.Name)
				if err != nil {
					t.Fatal(err)
				}
				got, _ := tsgo.EncodeXML(n)
				if !xmlEquivalent(got, sc.ReqBody) {
					t.Fatalf("decoded XML request re-encodes as %s, sent %s", got, sc.ReqBody)
				}
			} else if f, ok := fileBody(lastRequest); ok {
				if !bytes.Equal(f.Contents, sc.ReqBody) {
					t.Fatalf("decoded file body %q, sent %q", f.Contents, sc.ReqBody)
				}
			} else if sc.ReqJSON && len(sc.ReqBody) > 0 && lastRequest != nil {
				body := reflect.ValueOf(lastRequest).FieldByName("Body")
				if b, ok := bytesBody(body); ok {
					// Bodies with an encoding (@encode(base64url) bytes): compare the decoded bytes.
					var sent string
					if err := json.Unmarshal(sc.ReqBody, &sent); err != nil {
						t.Fatal(err)
					}
					want, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(sent), "="))
					if err != nil || !bytes.Equal(b, want) {
						t.Fatalf("decoded bytes %q, sent %s", b, sc.ReqBody)
					}
				} else if body.IsValid() {
					got, err := json.Marshal(body.Interface())
					if err != nil {
						t.Fatalf("re-encoding the decoded request body: %v", err)
					}
					if !jsonEquivalent(got, sc.ReqBody) {
						t.Fatalf("decoded request body re-encodes as %s, sent %s", got, sc.ReqBody)
					}
				}
			}
		})
	}
}
`;

export async function runSpec(spec: string, tmpRoot: string): Promise<SpecResult> {
  const result: SpecResult = { spec, status: "rejected", diagnostics: [], scenarios: [] };
  const main = join(SPECS_ROOT, "specs", spec, "main.tsp");
  let program = await compile(NodeHost, main, { noEmit: true });
  if (program.diagnostics.some((d) => d.code === "union-extends-disabled")) {
    // The spec opts into an experimental compiler feature (users enable it in tspconfig.yaml).
    program = await compile(NodeHost, main, { noEmit: true, configFile: { features: ["union-extends"] } } as any);
  }
  const compilerErrors = program.diagnostics.filter((d) => d.severity === "error");
  if (compilerErrors.length) {
    result.diagnostics = compilerErrors.map((d) => `compiler ${d.code}: ${d.message}`);
    return result;
  }
  const scenarios = await loadScenarios(spec);
  // Versioned specs: each scenario runs against a server generated for its API version.
  const versions = [...new Set(scenarios.map((x) => x.version))];
  let ok = true;
  for (const version of versions) {
    const gen = await generateGo(program, { module: "example.com/gen", "emit-go-mod": true, ...(version ? { "api-version": version } : {}) });
    const errors = gen.diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      result.diagnostics = [...new Set(errors.map((d) => `${d.code}: ${d.message}`))];
      return result;
    }
    if (!gen.server?.length) {
      result.status = "no-server";
      return result;
    }
    const dir = join(tmpRoot, spec.replace(/\//g, "__") + (version ? `__${version}` : ""));
    rmSync(dir, { recursive: true, force: true });
    for (const [p, text] of gen.files) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const subset = scenarios.filter((x) => x.version === version);
    matchOperations(program, subset, gen.server);
    writeFileSync(join(dir, "scenarios.json"), JSON.stringify(subset, null, 1));
    writeFileSync(join(dir, "conformance_test.go"), conformanceGo(gen.server) + `\nconst basePath = ${JSON.stringify(serverBasePath(program, version))}\n`);
    let output = "";
    try {
      output = execFileSync("go", ["test", "-count=1", "-v", "-run", "TestScenarios", "."], { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, GOWORK: "off" } });
    } catch (e: any) {
      ok = false;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    result.output = (result.output ?? "") + output;
    for (const sc of subset) {
      const esc = sc.name.replace(/[^A-Za-z0-9_]/g, "_");
      const m = new RegExp(`--- (PASS|FAIL|SKIP): TestScenarios/${esc}\\b`).exec(output);
      const status = m ? ({ PASS: "passed", FAIL: "failed", SKIP: "skipped" } as const)[m[1] as "PASS"] : "failed";
      let detail: string | undefined;
      if (status === "failed") {
        const idx = output.indexOf(`TestScenarios/${esc}`);
        detail = idx >= 0 ? output.slice(idx, idx + 400).split("\n").slice(1, 3).join(" ").trim() : output.slice(0, 300);
      }
      result.scenarios.push({ name: sc.name, status, detail, reason: sc.skip, adjustment: sc.adjustment, replacement: sc.replacement, version: sc.version });
    }
  }
  result.status = ok && result.scenarios.every((s) => s.status !== "failed") ? "passed" : "failed";
  return result;
}
