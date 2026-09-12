import { afterEach, describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("paths exist in spec", () => {
  for (const p of ["/logs", "/api-tokens", "/api-tokens/current", "/api-tokens/x", "/org", "/org/contacts", "/org/contacts/BILLING", "/org/privacy/oktaSupport", "/org/privacy/oktaSupport/grant", "/org/privacy/oktaSupport/extend", "/org/privacy/oktaSupport/revoke"]) expect(knownPath(p), p).toBe(true);
});

describe("logs", () => {
  test("list passes params and stops on empty page / max", async () => {
    let page = 0;
    srv = startServer([{ method: "GET", path: "/api/v1/logs", handler: (_r, url) => {
      page++;
      const body = page <= 2 ? [{ uuid: `e${page}`, published: "p", eventType: "user.session.start", outcome: { result: "SUCCESS" }, actor: { alternateId: "a" }, client: { ipAddress: "1.1.1.1" }, displayMessage: "m" }] : [];
      return Response.json(body, { headers: { Link: `<${url.origin}/api/v1/logs?after=${page}>; rel="next"` } });
    } }]);
    const t = testCtx(srv.url);
    await runTest(["logs", "list", "--since", "2026-01-01T00:00:00Z", "-f", 'eventType eq "user.session.start"', "--sort-order", "DESCENDING", "-l", "50", "--output-fields", "uuid"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ since: "2026-01-01T00:00:00Z", filter: 'eventType eq "user.session.start"', sortOrder: "DESCENDING", limit: "50" });
    expect(t.out.at(-1)).toBe("e1  \ne2  \n");
    expect(srv.calls.length).toBe(3);
    page = 0; srv.calls.length = 0;
    await runTest(["logs", "list", "--max", "1", "--output-fields", "uuid"], t.ctx);
    expect(t.out.at(-1)).toBe("e1  \n");
    expect(srv.calls.length).toBe(1);
  });

  test("--limit rejects values outside 1..1000", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["logs", "list", "--limit", "0"], t.ctx)).toBe(1);
    expect(await runTest(["logs", "list", "--limit", "1001"], t.ctx)).toBe(1);
  });
});

describe("tokens", () => {
  test("list/get/revoke/revoke-current", async () => {
    const toks = [{ id: "t1", name: "ci", userId: "u", created: "c", expiresAt: "e", tokenWindow: "P30D" }];
    srv = startServer([
      { method: "GET", path: "/api/v1/api-tokens", body: toks },
      { method: "GET", path: "/api/v1/api-tokens/t1", body: toks[0] },
      { method: "GET", path: /^\/api\/v1\/api-tokens\/.+/, status: 404, body: { errorSummary: "nf" } },
      { method: "DELETE", path: /^\/api\/v1\/api-tokens\/.+/ },
    ]);
    const t = testCtx(srv.url);
    await runTest(["tokens", "list", "--output-fields", "id,name"], t.ctx);
    expect(t.out.at(-1)).toBe("t1  ci  \n");
    await runTest(["tokens", "revoke", "ci"], t.ctx);
    expect(t.out.at(-1)).toBe("API token t1 (ci) revoked\n");
    await runTest(["tokens", "revoke-current"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/api-tokens/current");
    expect(t.out.at(-1)).toBe("current API token revoked\n");
  });
});

describe("org", () => {
  test("get/update/contacts/set-contact/support", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/org", body: { id: "o", companyName: "Acme", subdomain: "acme", status: "ACTIVE", website: "w" } },
      { method: "POST", path: "/api/v1/org", body: { id: "o", companyName: "Acme2" } },
      { method: "GET", path: "/api/v1/org/contacts", body: [{ contactType: "BILLING" }, { contactType: "TECHNICAL" }] },
      { method: "GET", path: "/api/v1/org/contacts/BILLING", body: { userId: "00u00000000000000001" } },
      { method: "PUT", path: "/api/v1/org/contacts/TECHNICAL", body: { userId: "00u00000000000000002" } },
      { method: "GET", path: "/api/v1/org/privacy/oktaSupport", body: { support: "DISABLED", expiration: null } },
      { method: "POST", path: /^\/api\/v1\/org\/privacy\/oktaSupport\/(grant|extend|revoke)$/, body: { support: "ENABLED", expiration: "x" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["org", "get", "--output-fields", "companyName"], t.ctx);
    expect(t.out.at(-1)).toBe("Acme  \n");
    await runTest(["org", "update", "-s", "companyName=Acme2", "-s", "website=https://acme.example"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ companyName: "Acme2", website: "https://acme.example" });
    await runTest(["org", "contacts"], t.ctx);
    expect(t.out.at(-1)).toBe("BILLING    \nTECHNICAL  \n");
    await runTest(["org", "contact", "BILLING", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).userId).toBe("00u00000000000000001");
    await runTest(["org", "set-contact", "TECHNICAL", "-u", "alice@x.com", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ userId: "00u00000000000000002" });
    await runTest(["org", "support"], t.ctx);
    expect(t.out.at(-1)).toBe("DISABLED    \n");
    await runTest(["org", "support-grant", "--output-fields", "support"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/privacy/oktaSupport/grant");
    expect(t.out.at(-1)).toBe("ENABLED  \n");
  });
});
