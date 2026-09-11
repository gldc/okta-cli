import { afterEach, describe, expect, test } from "bun:test";
import { OktaClient, parseNextLink, stripLinks } from "../src/okta/client";
import { CommunicationError, OktaApiError } from "../src/okta/errors";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());
const noSleep = async () => {};

describe("OktaClient", () => {
  test("sends SSWS auth and json headers, builds /api/v1 urls with query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users", body: [{ id: "u1", _links: { self: 1 } }] }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    let seenAuth = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => { seenAuth = req.headers.get("authorization") ?? ""; return Response.json([{ id: "u1", _links: {} }]); } });
    const rv = await c.get("/users", { limit: 2, search: 'status eq "ACTIVE"' });
    expect(seenAuth).toBe("SSWS tok");
    expect(srv.calls[0]!.query).toEqual({ limit: "2", search: 'status eq "ACTIVE"' });
    expect(rv).toEqual([{ id: "u1" }]);
  });

  test("getAll follows Link next, strips _links, stops on empty page", async () => {
    srv = startServer([]);
    srv.add({ method: "GET", path: "/api/v1/groups", handler: (_req, url) => {
      const after = url.searchParams.get("after");
      if (!after) return Response.json([{ id: "g1", _links: {} }], { headers: { Link: `<${srv.url}/api/v1/groups?after=x>; rel="next", <${srv.url}/api/v1/groups>; rel="self"` } });
      if (after === "x") return Response.json([{ id: "g2" }], { headers: { Link: `<${srv.url}/api/v1/groups?after=y>; rel="next"` } });
      return Response.json([]);
    } });
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    expect(await c.getAll("/groups")).toEqual([{ id: "g1" }, { id: "g2" }]);
    expect(srv.calls.length).toBe(3);
  });

  test("getAll honours max and listKey", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/domains", body: { domains: [{ id: 1 }, { id: 2 }, { id: 3 }] } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    expect(await c.getAll("/domains", { listKey: "domains", max: 2 })).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("retries on 429 using X-Rate-Limit-Reset", async () => {
    let hits = 0;
    const slept: number[] = [];
    srv = startServer([{ method: "GET", path: "/api/v1/x", handler: () => {
      hits++;
      if (hits === 1) return new Response("", { status: 429, headers: { "X-Rate-Limit-Reset": String(Math.floor(Date.now() / 1000) + 3) } });
      return Response.json({ ok: true });
    } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: async (ms) => { slept.push(ms); } });
    expect(await c.get("/x")).toEqual({ ok: true });
    expect(hits).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  test("4xx → OktaApiError with body; 5xx → CommunicationError; 204 → undefined", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/bad", status: 404, body: { errorCode: "E0000007", errorSummary: "Not found", errorCauses: [{ errorSummary: "c1" }] } },
      { method: "GET", path: "/api/v1/boom", status: 503, body: {} },
      { method: "PUT", path: "/api/v1/groups/g/users/u" },
    ]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    const err = await c.get("/users/bad").catch((e) => e);
    expect(err).toBeInstanceOf(OktaApiError);
    expect(err.errorCode).toBe("E0000007");
    expect(err.errorCauses).toEqual([{ errorSummary: "c1" }]);
    expect(err.status).toBe(404);
    await expect(c.get("/boom")).rejects.toBeInstanceOf(CommunicationError);
    expect(await c.json("PUT", "/groups/g/users/u")).toBeUndefined();
  });

  test("POST sends JSON body; basePath override; absolute url passthrough", async () => {
    srv = startServer([{ method: "POST", path: "/oauth2/v1/clients", body: { id: "c" } }, { method: "GET", path: "/abs", body: { abs: true } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    await c.json("POST", "/clients", { basePath: "/oauth2/v1", body: { a: 1 } });
    expect(srv.calls[0]!.body).toEqual({ a: 1 });
    expect(await c.get(`${srv.url}/abs`)).toEqual({ abs: true });
  });

  test("network failure → CommunicationError", async () => {
    const c = new OktaClient("http://127.0.0.1:9", "tok", { sleep: noSleep });
    await expect(c.get("/users")).rejects.toBeInstanceOf(CommunicationError);
  });
});

describe("helpers", () => {
  test("parseNextLink", () => {
    expect(parseNextLink('<https://a/x?after=1>; rel="next", <https://a/x>; rel="self"')).toBe("https://a/x?after=1");
    expect(parseNextLink('<https://a/x>; rel="self"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
  test("stripLinks", () => {
    expect(stripLinks([{ a: 1, _links: {} }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stripLinks({ a: 1, _links: {} })).toEqual({ a: 1 });
    expect(stripLinks("str")).toBe("str");
  });
});
