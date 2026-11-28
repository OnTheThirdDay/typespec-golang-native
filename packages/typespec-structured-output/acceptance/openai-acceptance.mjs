// Opt-in live acceptance suite: submits every OpenAI-profile fixture schema (emitted by this
// package and checked to be identical to the committed SDK reference) to the Responses API.
// Run with: OPENAI_API_KEY=... npm run test:openai [-- model]. Sending schemas publishes their
// content (committed fixtures only) to OpenAI. Never part of `npm test`.
//
// Every submission has exactly one outcome:
//   accepted    the API started a response with the schema (status completed or incomplete)
//   rejected    the API rejected the schema itself (HTTP 400 naming the schema / text.format)
//   unverified  anything else: missing key, authentication or permission error, rate limit,
//               server or network failure, non-JSON reply, unexpected response shape. Nothing
//               is learned about the schema, so it is never counted as accepted.
// Exit code: 0 all accepted, 1 any rejection (or emitter/reference mismatch), 2 otherwise unverified.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitStructuredOutput } from "../dist/src/testing/index.js";
import { orderedDiff, parseJson, stringifyJson } from "../dist/src/json.js";

/** The API rejected the schema itself. */
export class SchemaRejected extends Error {}
/** The submission says nothing about the schema (auth, quota, infrastructure, protocol). */
export class AcceptanceUnverified extends Error {}

function classifyFailure(status, body) {
  const error = body?.error;
  const reason = error?.message ?? body?.status ?? "unexpected response";
  const where = `${error?.param ?? ""} ${error?.code ?? ""} ${reason}`;
  if (status === 401 || status === 403) return new AcceptanceUnverified(`acceptance unverified (authentication or permission, HTTP ${status}): ${reason}`);
  if (status === 429) return new AcceptanceUnverified(`acceptance unverified (rate limit or quota, HTTP 429): ${reason}`);
  if (status >= 500) return new AcceptanceUnverified(`acceptance unverified (server error, HTTP ${status}): ${reason}`);
  if (status === 400 && /schema|text\.format|response_format/i.test(where)) return new SchemaRejected(`schema rejected (400): ${reason}`);
  return new AcceptanceUnverified(`acceptance unverified (HTTP ${status}): ${reason}`);
}

/** Submits one Responses API `text.format`; returns "accepted" or throws one of the two errors. */
export async function submitFormat(format, key, model, send = fetch) {
  let response;
  try {
    response = await send("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      // stringifyJson keeps exact numeric tokens and declared property order.
      body: stringifyJson({ model, input: "Return an example.", max_output_tokens: 16, text: { format } }, 0),
    });
  } catch (err) {
    throw new AcceptanceUnverified(`acceptance unverified (network failure): ${err?.message ?? err}`);
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new AcceptanceUnverified(`acceptance unverified (HTTP ${response.status}, body is not JSON)`);
  }
  if (response.ok && !body?.error && body?.object === "response" && ["completed", "incomplete"].includes(body.status)) return "accepted";
  throw classifyFailure(response.status, body);
}

/** Emits every eligible fixture, checks it against the SDK reference, and submits it. */
export async function runAcceptance({ key, model = "gpt-4o-mini", send = fetch, fixtures = join(import.meta.dirname, "../test/fixtures"), log = console.log } = {}) {
  const summary = { accepted: [], rejected: [], unverified: [], mismatched: [] };
  if (!key) {
    summary.unverified.push("OPENAI_API_KEY is unset");
    return summary;
  }
  for (const name of readdirSync(fixtures).sort()) {
    const dir = join(fixtures, name);
    if (!existsSync(join(dir, "reference.json")) || existsSync(join(dir, "expected-diagnostics.json"))) continue;
    const options = existsSync(join(dir, "options.json")) ? JSON.parse(readFileSync(join(dir, "options.json"), "utf8")) : {};
    if (options["target-profile"] === "none") continue;
    const result = await emitStructuredOutput(readFileSync(join(dir, "main.tsp"), "utf8"), { ...options, "schema-mode": "strict", "output-format": "text-format" }, "acceptance-" + name);
    if (result.program.hasError()) {
      summary.mismatched.push(`${name}: ${result.diagnostics.map((d) => d.message).join("; ")}`);
      continue;
    }
    const reference = parseJson(readFileSync(join(dir, "reference.json"), "utf8")).roots;
    if (Object.keys(result.files).length !== Object.keys(reference).length) {
      summary.mismatched.push(`${name}: root count differs from the reference`);
      continue;
    }
    for (const [root, r] of Object.entries(reference)) {
      const id = `${name}/${root}`;
      const actual = result.files[`${root}.json`];
      if (!actual || orderedDiff(actual.schema, r.strict) || actual.name !== r.name) {
        summary.mismatched.push(`${id}: output differs from the SDK reference`);
        continue;
      }
      try {
        await submitFormat(actual, key, model, send); // one call covers the output and its identical reference
        summary.accepted.push(id);
        log(`accepted    ${id}`);
      } catch (err) {
        const bucket = err instanceof SchemaRejected ? summary.rejected : err instanceof AcceptanceUnverified ? summary.unverified : null;
        if (!bucket) throw err;
        bucket.push(`${id}: ${err.message}`);
        log(`${err instanceof SchemaRejected ? "REJECTED  " : "unverified"}  ${id}: ${err.message}`);
      }
    }
  }
  if (!summary.accepted.length && !summary.rejected.length && !summary.unverified.length && !summary.mismatched.length) {
    summary.mismatched.push("no eligible schemas");
  }
  return summary;
}

/** 0 when everything was accepted, 1 for rejections or mismatches, 2 when anything is unverified. */
export function exitCode(summary) {
  if (summary.rejected.length || summary.mismatched.length) return 1;
  if (summary.unverified.length) return 2;
  return 0;
}

async function main() {
  const summary = await runAcceptance({ key: process.env.OPENAI_API_KEY, model: process.argv[2] ?? "gpt-4o-mini" });
  for (const line of summary.mismatched) console.error(`MISMATCH    ${line}`);
  if (!process.env.OPENAI_API_KEY) console.error("OpenAI acceptance unverified: OPENAI_API_KEY is unset.");
  console.log(`accepted ${summary.accepted.length}, rejected ${summary.rejected.length}, unverified ${summary.unverified.length}, mismatched ${summary.mismatched.length}`);
  process.exitCode = exitCode(summary);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
