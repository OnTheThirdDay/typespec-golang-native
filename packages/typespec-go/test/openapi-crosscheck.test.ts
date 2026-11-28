/**
 * Cross-check of the generated server against the official @typespec/openapi3 documents for
 * every @typespec/http-specs spec: operations (method + path template), parameters (name,
 * location, required) and response status codes must agree wherever OpenAPI can express them.
 * OpenAPI is only a reference here; the Go generator never consumes it.
 */
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { getOpenAPI3 } from "@typespec/openapi3";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateGo } from "../src/emitter.js";
import { SPECS_ROOT, listSpecs } from "./http-specs/harness.js";

const norm = (p: string) => p.replace(/\{[+./;]?([^}*]+)\*?\}/g, "{$1}").replace(/\?.*$/, "").replace(/\/$/, "") || "/";

const outcomes: Record<string, string> = {};

/**
 * Specs on which the reference emitter itself crashes. A crash is never counted as agreement:
 * the reference is computed from a copy of the spec with a minimal, documented source edit that
 * avoids the upstream bug, and the edit is undone when comparing. A crash on any other spec, a
 * different crash, or a workaround that is no longer needed fails the test.
 */
const REFERENCE_WORKAROUNDS: Record<string, { crash: RegExp; reason: string; edits: [string, string][]; aliases: Record<string, string> }> = {
  "special-words": {
    crash: /Cannot read properties of undefined \(reading '0'\)/,
    reason:
      "@typespec/openapi3 1.18.0 looks up parameter examples with examples.parameters[name] on a plain object; for the query parameter 'constructor' this yields Object.prototype.constructor and the emitter crashes",
    edits: [["withConstructor(@query constructor: string)", 'withConstructor(@query("openapi3_workaround_constructor") constructor: string)']],
    aliases: { openapi3_workaround_constructor: "constructor" },
  },
};

async function referenceProgram(spec: string, w: (typeof REFERENCE_WORKAROUNDS)[string]) {
  const src = join(SPECS_ROOT, "specs", spec);
  const dir = join(import.meta.dirname, ".tmp", "openapi-reference", spec);
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, { recursive: true });
  let text = readFileSync(join(dir, "main.tsp"), "utf8");
  for (const [from, to] of w.edits) {
    expect(text.split(from).length - 1, `workaround edit must apply exactly once: ${from}`).toBe(1);
    text = text.replace(from, to);
  }
  writeFileSync(join(dir, "main.tsp"), text);
  const program = await compile(NodeHost, join(dir, "main.tsp"), { noEmit: true });
  expect(program.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return program;
}

describe("OpenAPI 3 cross-check", () => {
  afterAll(() => {
    // Recorded evidence covers complete runs only: a filtered run (-t) must not truncate it.
    if (Object.keys(outcomes).length !== listSpecs().length) return;
    writeFileSync(join(import.meta.dirname, "http-specs", "openapi-crosscheck.json"), JSON.stringify(outcomes, Object.keys(outcomes).sort(), 2) + "\n");
  });
  for (const spec of listSpecs()) {
    it(spec, async () => {
      let program = await compile(NodeHost, join(SPECS_ROOT, "specs", spec, "main.tsp"), { noEmit: true });
      if (program.diagnostics.some((d) => d.code === "union-extends-disabled")) {
        program = await compile(NodeHost, join(SPECS_ROOT, "specs", spec, "main.tsp"), { noEmit: true, configFile: { features: ["union-extends"] } } as any);
      }
      const gen = await generateGo(program, { module: "example.com/gen" });
      expect(gen.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
      const workaround = REFERENCE_WORKAROUNDS[spec];
      let records: any[];
      let note = "";
      try {
        records = await getOpenAPI3(program);
      } catch (e) {
        if (!workaround) throw new Error(`@typespec/openapi3 failed on ${spec}; no reference to compare with: ${(e as Error).message}`);
        expect((e as Error).message).toMatch(workaround.crash);
        records = await getOpenAPI3(await referenceProgram(spec, workaround));
        note = ` (reference computed with a documented workaround: ${workaround.reason})`;
      }
      expect(note !== "" || !workaround, `the ${spec} workaround is no longer needed: remove it`).toBe(true);
      const unalias = (name: string) => workaround && Object.hasOwn(workaround.aliases, name) ? workaround.aliases[name] : name;
      const docs = records.flatMap((r: any) => (r.versioned ? [r.versions.at(-1).document] : [r.document]));
      const oaOps = new Map<string, any>();
      for (const doc of docs) {
        for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
          for (const m of ["get", "put", "post", "patch", "delete", "head", "options", "trace"]) {
            if (item[m]) oaOps.set(`${m.toUpperCase()} ${norm(path)}`, { ...item[m], doc, parameters: [...(item.parameters ?? []), ...(item[m].parameters ?? [])] });
          }
        }
      }
      const resolve = (doc: any, p: any) => (p.$ref ? p.$ref.split("/").slice(1).reduce((o: any, k: string) => o?.[k], doc) : p);
      const goOps = new Map<string, NonNullable<typeof gen.server>[number][]>();
      for (const o of gen.server ?? []) {
        const k = `${o.method} ${norm(o.path)}`;
        goOps.set(k, [...(goOps.get(k) ?? []), o]);
      }
      // Every OpenAPI operation exists in Go; Go-only operations must be routes OpenAPI cannot
      // express (literal query text in the route, e.g. `/x?fixed=true{&p}`).
      expect([...oaOps.keys()].filter((k) => !goOps.has(k)), "operations missing from the Go server").toEqual([]);
      const goOnly = [...goOps.keys()].filter((k) => !oaOps.has(k));
      for (const k of goOnly) expect(goOps.get(k)!.every((o) => o.literalQuery), `${k} is missing from OpenAPI without being inexpressible`).toBe(true);
      const metadataOnly = spec === "type/model/visibility" ? new Set(["HEAD /type/model/visibility", "GET /type/model/visibility"]) : new Set<string>();
      const differences: string[] = [];
      for (const [key, ops] of goOps) {
        const oa = oaOps.get(key);
        if (!oa) continue;
        // parameters (Accept/Content-Type are media negotiation, not request object fields)
        const oaParams = oa.parameters
          .map((p: any) => resolve(oa.doc, p))
          .filter((p: any) => !(p.in === "header" && ["accept", "content-type"].includes(p.name.toLowerCase())))
          .map((p: any) => `${p.in}:${unalias(p.name)}:${p.required ? "required" : "optional"}`)
          .sort();
        const goParams = [...new Set(ops.flatMap((o) => o.params.filter((p) => !(p.location === "header" && ["accept", "content-type"].includes(p.wire.toLowerCase()))).map((p) => `${p.location}:${p.wire}:${p.optional ? "optional" : "required"}`)))].sort();
        expect(goParams, key).toEqual(oaParams);
        const media = (xs: string[]) => [...new Set(xs.map(x => x.toLowerCase()))].sort();
        const requestBody = oa.requestBody && resolve(oa.doc, oa.requestBody);
        expect(media(ops.flatMap(o => o.requestContentTypes)), key + " request media").toEqual(media(Object.keys(requestBody?.content ?? {})));
        if (metadataOnly.has(key)) {
          // The pinned GET/HEAD @bodyRoot fixtures explicitly prescribe a query and no body.
          // OpenAPI marks the empty projected model required. Make this disagreement observable.
          expect(requestBody?.required, key).toBe(true);
          expect(ops.every(o => !o.requestBodyRequired), key).toBe(true);
          differences.push(key);
        } else if (requestBody) {
          expect(ops.every(o => o.requestBodyRequired), key + " required request body").toBe(requestBody.required === true);
        }
        // status codes
        const goStatus = [...new Set(ops.flatMap((o) => o.variants.map((v) => (v.status.kind === "fixed" ? String(v.status.code) : v.status.kind === "default" ? "default" : `${Math.floor(v.status.min / 100)}XX` /* OpenAPI only has whole classes */))))].sort();
        expect(goStatus, key).toEqual(Object.keys(oa.responses ?? {}).sort());
        for (const [status, raw] of Object.entries(oa.responses ?? {})) {
          const response = resolve(oa.doc, raw);
          const variants = ops.flatMap(o => o.variants).filter(v => v.status.kind === "fixed" ? String(v.status.code) === status : v.status.kind === "default" ? status === "default" : status === `${Math.floor(v.status.min / 100)}XX`);
          expect(media(variants.flatMap(v => v.body?.contentTypes ?? [])), key + " " + status + " response media").toEqual(media(Object.keys(response.content ?? {})));
          expect(media(variants.flatMap(v => v.headers.map(h => h.wire))), key + " " + status + " response headers").toEqual(media(Object.keys(response.headers ?? {})));
        }
      }
      expect(differences.sort()).toEqual([...metadataOnly].sort());
      outcomes[spec] = differences.length ? `required-body disagreement for metadata-only ${differences.join(", ")}; other compared fields agree`
        : (goOnly.length ? `agrees; ${goOnly.length} operation(s) with literal route query text are not expressible in OpenAPI` : "agrees") + note;
    });
  }
});
