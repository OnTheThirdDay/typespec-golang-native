// Offline tests of the live acceptance script's classification (no network access).
import { describe, expect, it } from "vitest";
import { AcceptanceUnverified, SchemaRejected, exitCode, runAcceptance, submitFormat } from "../acceptance/openai-acceptance.mjs";
import { parseJson } from "../dist/src/json.js";

const format = parseJson('{"name":"Probe","schema":{"properties":{"2":{"const":9007199254740993},"1":{"type":"string"}}}}');
const reply = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("live acceptance classification", () => {
  it("sends exact generated tokens and property order", async () => {
    const result = await submitFormat(format, "unused", "model", async (_url, init) => {
      expect(init.body).toContain('"2":{"const":9007199254740993},"1"');
      return Response.json({ object: "response", status: "incomplete" });
    });
    expect(result).toBe("accepted");
  });

  it.each([
    [401, /authentication or permission/],
    [403, /authentication or permission/],
    [429, /rate limit/],
    [500, /server error/],
    [503, /server error/],
    [400, /HTTP 400/], // a request error that does not name the schema (e.g. unknown model)
    [200, /HTTP 200/], // an error body or unexpected shape on success
  ])("does not count HTTP %i as acceptance", async (status, why) => {
    const err = await submitFormat(format, "k", "m", reply({ error: { message: "service error" } }, status)).catch((e) => e);
    expect(err).toBeInstanceOf(AcceptanceUnverified);
    expect(err.message).toMatch(why);
  });

  it("does not count a failed or unknown response status as acceptance", async () => {
    for (const body of [{ object: "response", status: "failed" }, { object: "other", status: "completed" }, {}]) {
      await expect(submitFormat(format, "k", "m", reply(body))).rejects.toBeInstanceOf(AcceptanceUnverified);
    }
  });

  it("classifies network failures and non-JSON replies (e.g. a proxy error page) as unverified", async () => {
    await expect(submitFormat(format, "k", "m", async () => { throw new TypeError("fetch failed"); })).rejects.toThrow(/network failure/);
    await expect(submitFormat(format, "k", "m", reply("<html>502 Bad Gateway</html>", 502))).rejects.toThrow(/not JSON/);
  });

  it("records a schema rejection only when the API names the schema", async () => {
    const err = await submitFormat(format, "k", "m", reply({ error: { param: "text.format.schema", message: "invalid" } }, 400)).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaRejected);
    expect(err.message).toMatch(/schema rejected/);
  });

  it("aggregates outcomes and never reports success without acceptance", async () => {
    expect(exitCode(await runAcceptance({ key: undefined }))).toBe(2);
    const auth = await runAcceptance({ key: "k", send: reply({ error: { message: "bad key" } }, 401), log: () => {} });
    expect(auth.accepted).toEqual([]);
    expect(auth.unverified.length).toBeGreaterThan(0);
    expect(exitCode(auth)).toBe(2);
    const rejected = await runAcceptance({ key: "k", send: reply({ error: { param: "text.format.schema", message: "no" } }, 400), log: () => {} });
    expect(exitCode(rejected)).toBe(1);
    const ok = await runAcceptance({ key: "k", send: reply({ object: "response", status: "completed" }), log: () => {} });
    expect(ok.mismatched).toEqual([]);
    expect(ok.accepted.length).toBeGreaterThan(10);
    expect(exitCode(ok)).toBe(0);
  });
});
