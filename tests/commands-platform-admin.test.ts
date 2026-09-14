import { afterEach, describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("paths exist in spec", () => {
  for (const p of [
    "/logs", "/api-tokens", "/api-tokens/current", "/api-tokens/x", "/org", "/org/contacts", "/org/contacts/BILLING", "/org/privacy/oktaSupport", "/org/privacy/oktaSupport/grant", "/org/privacy/oktaSupport/extend", "/org/privacy/oktaSupport/revoke",
    "/org/preferences", "/org/preferences/showEndUserFooter", "/org/preferences/hideEndUserFooter",
    "/org/orgSettings/thirdPartyAdminSetting", "/org/privacy/oktaCommunication", "/org/privacy/oktaCommunication/optIn", "/org/privacy/oktaCommunication/optOut",
    "/org/privacy/aerial", "/org/privacy/aerial/grant", "/org/privacy/aerial/revoke",
    "/org/privacy/oktaSupport/cases", "/org/privacy/oktaSupport/cases/1", "/org/email/bounces/remove-list",
    "/org/settings/autoAssignAdminAppSetting", "/org/settings/clientPrivilegesSetting",
    "/org/factors/yubikey_token/tokens", "/org/factors/yubikey_token/tokens/tok1",
  ]) expect(knownPath(p), p).toBe(true);
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
    await runTest(["logs", "list", "--since", "2026-01-01T00:00:00Z", "-f", 'eventType eq "user.session.start"', "--sort-order", "DESCENDING", "--page-size", "50", "--output-fields", "uuid"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ since: "2026-01-01T00:00:00Z", filter: 'eventType eq "user.session.start"', sortOrder: "DESCENDING", limit: "50" });
    expect(t.out.at(-1)).toBe("e1  \ne2  \n");
    expect(srv.calls.length).toBe(3);
    page = 0; srv.calls.length = 0;
    await runTest(["logs", "list", "-l", "1", "--output-fields", "uuid"], t.ctx);
    expect(srv.calls.at(-1)!.query.limit).toBe("1");
    expect(t.out.at(-1)).toBe("e1  \n");
    expect(srv.calls.length).toBe(1);
  });

  test("--page-size rejects values outside 1..1000, --limit rejects negatives", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["logs", "list", "--page-size", "0"], t.ctx)).toBe(1);
    expect(await runTest(["logs", "list", "--page-size", "1001"], t.ctx)).toBe(1);
    expect(await runTest(["logs", "list", "--limit", "-1"], t.ctx)).toBe(1);
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

  test("preferences/footer/third-party-admin/communication/aerial/support-cases/email-bounces/admin-app-assignment/client-privileges", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/org/preferences", body: { showEndUserFooter: true } },
      { method: "POST", path: "/api/v1/org/preferences/showEndUserFooter", body: { showEndUserFooter: true } },
      { method: "POST", path: "/api/v1/org/preferences/hideEndUserFooter", body: { showEndUserFooter: false } },
      { method: "GET", path: "/api/v1/org/orgSettings/thirdPartyAdminSetting", body: { thirdPartyAdmin: false } },
      { method: "POST", path: "/api/v1/org/orgSettings/thirdPartyAdminSetting", body: { thirdPartyAdmin: true } },
      { method: "GET", path: "/api/v1/org/privacy/oktaCommunication", body: { optOutEmailUsers: false } },
      { method: "POST", path: "/api/v1/org/privacy/oktaCommunication/optIn", body: { optOutEmailUsers: false } },
      { method: "POST", path: "/api/v1/org/privacy/oktaCommunication/optOut", body: { optOutEmailUsers: true } },
      { method: "GET", path: "/api/v1/org/privacy/aerial", body: { granted: false } },
      { method: "POST", path: "/api/v1/org/privacy/aerial/grant", body: { granted: true } },
      { method: "POST", path: "/api/v1/org/privacy/aerial/revoke", body: { granted: false } },
      { method: "GET", path: "/api/v1/org/privacy/oktaSupport/cases", body: { supportCases: [{ caseNumber: "1", subject: "help" }] } },
      { method: "PATCH", path: "/api/v1/org/privacy/oktaSupport/cases/1", body: { caseNumber: "1", subject: "help" } },
      { method: "POST", path: "/api/v1/org/email/bounces/remove-list", body: { errors: [] } },
      { method: "GET", path: "/api/v1/org/settings/autoAssignAdminAppSetting", body: { autoAssignAdminAppSetting: false } },
      { method: "POST", path: "/api/v1/org/settings/autoAssignAdminAppSetting", body: { autoAssignAdminAppSetting: true } },
      { method: "GET", path: "/api/v1/org/settings/clientPrivilegesSetting", body: { clientPrivilegesSetting: false } },
      { method: "PUT", path: "/api/v1/org/settings/clientPrivilegesSetting", body: { clientPrivilegesSetting: true } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["org", "preferences", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).showEndUserFooter).toBe(true);
    expect(await runTest(["org", "footer", "--show"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/preferences/showEndUserFooter");
    expect(await runTest(["org", "footer", "--hide"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/preferences/hideEndUserFooter");
    expect(await runTest(["org", "footer"], t.ctx)).not.toBe(0);
    expect(await runTest(["org", "third-party-admin", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).thirdPartyAdmin).toBe(false);
    expect(await runTest(["org", "third-party-admin-set", "--enabled"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ thirdPartyAdmin: true });
    expect(await runTest(["org", "communication", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).optOutEmailUsers).toBe(false);
    expect(await runTest(["org", "communication-opt-in"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/privacy/oktaCommunication/optIn");
    expect(await runTest(["org", "communication-opt-out"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/privacy/oktaCommunication/optOut");
    expect(await runTest(["org", "aerial", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).granted).toBe(false);
    expect(await runTest(["org", "aerial-grant", "-s", "accountId=acc1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ accountId: "acc1" });
    expect(await runTest(["org", "aerial-revoke"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/privacy/aerial/revoke");
    expect(await runTest(["org", "support-cases", "--output-fields", "caseNumber,subject"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("1  help  \n");
    expect(await runTest(["org", "support-case-set", "1", "-s", "impersonation.status=ENABLED"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ impersonation: { status: "ENABLED" } });
    expect(await runTest(["org", "email-bounces-remove", "-s", "emailAddresses=bob@x.com"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ emailAddresses: "bob@x.com" });
    expect(await runTest(["org", "admin-app-assignment", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).autoAssignAdminAppSetting).toBe(false);
    expect(await runTest(["org", "admin-app-assignment-set", "--enabled"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ autoAssignAdminAppSetting: true });
    expect(await runTest(["org", "client-privileges", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).clientPrivilegesSetting).toBe(false);
    expect(await runTest(["org", "client-privileges-set", "--enabled"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ clientPrivilegesSetting: true });
  });

  // Guards CHANGES.rst: the pinned spec's /api/v1/orgs has only POST createChildOrg, so there's
  // deliberately no `org children` list command - the changelog must not advertise one.
  test("children is not a registered command (no GET /orgs in the pinned spec)", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["org", "children"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("CHANGES.rst does not advertise the unimplemented `org children` command", async () => {
    const changes = await Bun.file(`${import.meta.dir}/../CHANGES.rst`).text();
    const line = changes.split("\n").find((l) => l.includes("admin-app-assignment/client-privileges"));
    expect(line).toBeDefined();
    expect(line).not.toContain("children");
  });

  test("yubikeys/yubikey/yubikeys-upload", async () => {
    const tok = { id: "ykt1", status: "ACTIVE", created: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", lastVerified: "2026-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/org/factors/yubikey_token/tokens", body: [tok] },
      { method: "GET", path: "/api/v1/org/factors/yubikey_token/tokens/ykt1", body: tok },
      { method: "POST", path: "/api/v1/org/factors/yubikey_token/tokens", body: tok },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["org", "yubikeys", "--sort-by", "created", "--sort-order", "DESC", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ sortBy: "created", sortOrder: "DESC" });
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("ykt1");
    expect(await runTest(["org", "yubikey", "ykt1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(tok);
    expect(await runTest(["org", "yubikeys-upload", "-s", "serialNumber=123", "-s", "publicId=pub", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ serialNumber: "123", publicId: "pub" });
  });
});
