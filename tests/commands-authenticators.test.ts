import { afterEach, describe, expect, test } from "bun:test";
import { AUTHENTICATORS } from "../src/commands/authenticators";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const auth = { id: "aut1", status: "ACTIVE", type: "app", key: "okta_verify", name: "Okta Verify" };

test("spec paths", () => {
  for (const p of [
    AUTHENTICATORS.path, `${AUTHENTICATORS.path}/x`, `${AUTHENTICATORS.path}/x/lifecycle/activate`, `${AUTHENTICATORS.path}/x/lifecycle/deactivate`,
    `${AUTHENTICATORS.path}/x/methods`, `${AUTHENTICATORS.path}/x/methods/push`,
    `${AUTHENTICATORS.path}/x/methods/push/lifecycle/activate`, `${AUTHENTICATORS.path}/x/methods/push/lifecycle/deactivate`,
    `${AUTHENTICATORS.path}/x/methods/webauthn/verify-rp-id-domain`,
    `${AUTHENTICATORS.path}/x/aaguids`, `${AUTHENTICATORS.path}/x/aaguids/y`,
    "/sessions/x", "/sessions/x/lifecycle/refresh",
    "/users/x/factors", "/users/x/factors/catalog", "/users/x/factors/y",
    "/users/x/lifecycle/reset_factors", "/users/x/lifecycle/unsuspend", "/users/x/blocks", "/users/x/sessions", "/users/x/idps",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("authenticators", () => {
  test("methods lists an authenticator's methods", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/authenticators/aut1", body: auth },
      { method: "GET", path: "/api/v1/authenticators/aut1/methods", body: [{ type: "push", status: "ACTIVE" }] },
    ]);
    const t = testCtx(srv.url);
    await runTest(["authenticators", "methods", "aut1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authenticators/aut1/methods");
    expect(JSON.parse(t.out.join(""))[0].type).toBe("push");
  });

  test("method-activate posts to the method's lifecycle path", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/authenticators/aut1", body: auth },
      { method: "POST", path: "/api/v1/authenticators/aut1/methods/push/lifecycle/activate", body: { type: "push", status: "ACTIVE" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["authenticators", "method-activate", "aut1", "push"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authenticators/aut1/methods/push/lifecycle/activate");
  });
});

describe("authenticators methods get/set", () => {
  test("method retrieves; method-set replaces", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/authenticators/aut1", body: auth },
      { method: "GET", path: "/api/v1/authenticators/aut1/methods/push", body: { type: "push", status: "ACTIVE" } },
      { method: "PUT", path: "/api/v1/authenticators/aut1/methods/push", body: { type: "push", status: "INACTIVE" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["authenticators", "method", "aut1", "push", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("ACTIVE");
    await runTest(["authenticators", "method-set", "aut1", "push", "-s", "status=INACTIVE", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.body).toEqual({ status: "INACTIVE" });
  });
});

describe("authenticators aaguids", () => {
  const aaguid = { aaguid: "abc-123", name: "Custom Key" };

  test("aaguids/aaguid/aaguid-add/aaguid-replace/aaguid-update/aaguid-delete", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/authenticators/aut1", body: auth },
      { method: "GET", path: "/api/v1/authenticators/aut1/aaguids", body: [aaguid] },
      { method: "GET", path: "/api/v1/authenticators/aut1/aaguids/abc-123", body: aaguid },
      { method: "POST", path: "/api/v1/authenticators/aut1/aaguids", body: aaguid },
      { method: "PUT", path: "/api/v1/authenticators/aut1/aaguids/abc-123", body: aaguid },
      { method: "PATCH", path: "/api/v1/authenticators/aut1/aaguids/abc-123", body: aaguid },
      { method: "DELETE", path: "/api/v1/authenticators/aut1/aaguids/abc-123" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["authenticators", "aaguids", "aut1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].aaguid).toBe("abc-123");
    await runTest(["authenticators", "aaguid", "aut1", "abc-123", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(aaguid);
    await runTest(["authenticators", "aaguid-add", "aut1", "-s", "name=Custom Key"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Custom Key" });
    await runTest(["authenticators", "aaguid-replace", "aut1", "abc-123", "-s", "name=Custom Key"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    await runTest(["authenticators", "aaguid-update", "aut1", "abc-123", "-s", "name=Renamed"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
    await runTest(["authenticators", "aaguid-delete", "aut1", "abc-123"], t.ctx);
    expect(t.out.at(-1)).toBe("AAGUID abc-123 deleted from authenticator aut1 (Okta Verify)\n");
  });
});

describe("authenticators verify-rp-id", () => {
  test("posts to verify-rp-id-domain with the default webauthn method", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/authenticators/aut1", body: auth },
      { method: "POST", path: "/api/v1/authenticators/aut1/methods/webauthn/verify-rp-id-domain" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["authenticators", "verify-rp-id", "aut1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authenticators/aut1/methods/webauthn/verify-rp-id-domain");
    expect(t.out.at(-1)).toBe("rp id domain verified for authenticator aut1 (Okta Verify) method webauthn\n");
  });
});

describe("sessions", () => {
  test("revoke deletes the session and reports its id", async () => {
    srv = startServer([{ method: "DELETE", path: "/api/v1/sessions/sess1" }]);
    const t = testCtx(srv.url);
    await runTest(["sessions", "revoke", "sess1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/sessions/sess1");
    expect(t.out.at(-1)).toBe("session sess1 revoked\n");
  });
});

describe("users factors/sessions/idps", () => {
  test("factor-delete sends removeRecoveryEnrollment and reports id + login", async () => {
    srv = startServer([{ method: "DELETE", path: "/api/v1/users/00u00000000000000001/factors/fac1" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor-delete", "bob@x.com", "fac1", "--remove-recovery-enrollment"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ removeRecoveryEnrollment: "true" });
    expect(t.out.at(-1)).toBe(`factor fac1 removed from user ${users[0]!.id} (bob@x.com)\n`);
  });

  test("sessions-revoke sends oauthTokens and reports id + login", async () => {
    srv = startServer([{ method: "DELETE", path: "/api/v1/users/00u00000000000000001/sessions" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "sessions-revoke", "bob@x.com", "--oauth-tokens"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ oauthTokens: "true" });
    expect(t.out.at(-1)).toBe(`sessions revoked for user ${users[0]!.id} (bob@x.com)\n`);
  });

  test("unsuspend posts to the lifecycle path with the raw argument", async () => {
    srv = startServer([{ method: "POST", path: /^\/api\/v1\/users\/[^/]+\/lifecycle\/unsuspend$/, body: { id: "00u1" } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "unsuspend", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.path).toEndWith("/lifecycle/unsuspend");
  });
});
