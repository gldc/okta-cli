import { afterEach, describe, expect, test } from "bun:test";
import { IDPS } from "../src/commands/idps";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const idp = { id: "0oa1idp", status: "ACTIVE", type: "SAML2", name: "Corp SSO" };
const idpByIdRoute = { method: "GET" as const, path: "/api/v1/idps/0oa1idp", body: idp };

test("spec paths", () => {
  for (const p of [IDPS.path, `${IDPS.path}/x`, `${IDPS.path}/x/lifecycle/activate`, `${IDPS.path}/x/lifecycle/deactivate`, `${IDPS.path}/x/users`, `${IDPS.path}/x/users/y`, `${IDPS.path}/credentials/keys`]) {
    expect(knownPath(p), p).toBe(true);
  }
});

describe("idps list", () => {
  test("-t sends type query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/idps", body: [idp] }]);
    const t = testCtx(srv.url);
    await runTest(["idps", "list", "-t", "SAML2"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ type: "SAML2" });
  });
});

describe("idps link/unlink/keys", () => {
  test("link posts externalId to the idp/user path", async () => {
    srv = startServer([idpByIdRoute, { method: "POST", path: "/api/v1/idps/0oa1idp/users/00u00000000000000001", body: { id: "00u00000000000000001", externalId: "ext1" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["idps", "link", "0oa1idp", "-u", "bob@x.com", "-e", "ext1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/idps/0oa1idp/users/00u00000000000000001");
    expect(srv.calls.at(-1)!.body).toEqual({ externalId: "ext1" });
  });

  test("unlink deletes and reports user + idp names", async () => {
    srv = startServer([idpByIdRoute, { method: "DELETE", path: "/api/v1/idps/0oa1idp/users/00u00000000000000001" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["idps", "unlink", "0oa1idp", "-u", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe(`user ${users[0]!.id} (bob@x.com) unlinked from idp 0oa1idp (Corp SSO)\n`);
  });

  test("keys lists idp credential keys", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/idps/credentials/keys", body: [{ kid: "k1", kty: "RSA", use: "sig", created: "2026-01-01", expiresAt: "2027-01-01" }] }]);
    const t = testCtx(srv.url);
    await runTest(["idps", "keys", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/idps/credentials/keys");
    expect(JSON.parse(t.out.join(""))[0].kid).toBe("k1");
  });
});
