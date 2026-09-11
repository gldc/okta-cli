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
