import { afterEach, describe, expect, test } from "bun:test";
import { CUSTOM_ROLES } from "../src/commands/roles";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const p of [
    "/groups/g/owners", "/groups/g/owners/o",
    "/apps/a/grants", "/apps/a/grants/gr1", "/apps/a/tokens", "/apps/a/tokens/t1",
    "/apps/a/credentials/keys", "/apps/a/credentials/keys/generate", "/apps/a/features", "/apps/a/sso/saml/metadata",
    "/users/u/clients", "/users/u/grants", "/users/u/grants/gr1", "/users/u/clients/c1/grants",
    "/users/u/subscriptions", "/users/u/subscriptions/USER_LOCKED_OUT", "/users/u/subscriptions/USER_LOCKED_OUT/subscribe", "/users/u/subscriptions/USER_LOCKED_OUT/unsubscribe",
    `${CUSTOM_ROLES.path}/r/permissions`, `${CUSTOM_ROLES.path}/r/permissions/okta.users.read`,
    "/roles/SUPER_ADMIN/subscriptions", "/roles/SUPER_ADMIN/subscriptions/USER_LOCKED_OUT", "/roles/SUPER_ADMIN/subscriptions/USER_LOCKED_OUT/subscribe", "/roles/SUPER_ADMIN/subscriptions/USER_LOCKED_OUT/unsubscribe",
    "/iam/resource-sets/rs1/bindings", "/iam/resource-sets/rs1/resources",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("groups owners", () => {
  test("owners lists, owner-add resolves user (default) or group (--type GROUP), owner-delete deletes", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/groups/00g1/owners", body: [{ id: "00u1", type: "USER", originType: "OKTA_DIRECTORY", displayName: "Bob", resolved: true }] },
      { method: "POST", path: "/api/v1/groups/00g1/owners", body: { id: "00u00000000000000001", type: "USER" } },
      { method: "DELETE", path: "/api/v1/groups/00g1/owners/00u1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "owners", "00g1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("00u1");

    await runTest(["groups", "owner-add", "00g1", "-u", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/groups/00g1/owners");
    expect(srv.calls.at(-1)!.body).toEqual({ id: "00u00000000000000001", type: "USER" });

    await runTest(["groups", "owner-delete", "00g1", "00u1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/groups/00g1/owners/00u1");
    expect(t.out.at(-1)).toBe("owner 00u1 removed from group 00g1 (Engineering)\n");
  });

  test("owner-add --type GROUP resolves the owner via group lookup", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/groups/00g1/owners", body: { id: "00g3", type: "GROUP" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["groups", "owner-add", "00g1", "-u", "00g3", "--type", "GROUP"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ id: "00g3", type: "GROUP" });
  });
});

describe("apps grants / tokens / keys / features / saml-metadata", () => {
  test("grants lists, grant-add posts scopeId+issuer, grant-delete deletes", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa1/grants", body: [{ id: "oag1", status: "ACTIVE", scopeId: "okta.users.read", issuer: "https://x.okta.com", created: "2026-01-01T00:00:00.000Z" }] },
      { method: "POST", path: "/api/v1/apps/0oa1/grants", body: { id: "oag2", status: "ACTIVE", scopeId: "okta.users.read", issuer: "https://x.okta.com" } },
      { method: "DELETE", path: "/api/v1/apps/0oa1/grants/oag1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "grants", "0oa1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("oag1");

    await runTest(["apps", "grant-add", "0oa1", "--scope", "okta.users.read", "--issuer", "https://x.okta.com"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ scopeId: "okta.users.read", issuer: "https://x.okta.com" });

    await runTest(["apps", "grant-delete", "0oa1", "oag1"], t.ctx);
    expect(t.out.at(-1)).toBe("grant oag1 revoked from app 0oa1 (Zoom)\n");
  });

  test("tokens lists, tokens-revoke with/without tokenId", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa1/tokens", body: [{ id: "oar1", status: "ACTIVE", created: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", userId: "00u1", scopes: ["offline_access"] }] },
      { method: "DELETE", path: "/api/v1/apps/0oa1/tokens" },
      { method: "DELETE", path: "/api/v1/apps/0oa1/tokens/oar1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "tokens", "0oa1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("oar1");

    await runTest(["apps", "tokens-revoke", "0oa1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/apps/0oa1/tokens");
    expect(t.out.at(-1)).toBe("all tokens revoked from app 0oa1 (Zoom)\n");

    await runTest(["apps", "tokens-revoke", "0oa1", "oar1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/apps/0oa1/tokens/oar1");
    expect(t.out.at(-1)).toBe("token oar1 revoked from app 0oa1 (Zoom)\n");
  });

  test("keys lists, generate-key posts validityYears query", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa1/credentials/keys", body: [{ kid: "k1", use: "sig", created: "2026-01-01T00:00:00.000Z", expiresAt: "2028-01-01T00:00:00.000Z" }] },
      { method: "POST", path: "/api/v1/apps/0oa1/credentials/keys/generate", body: { kid: "k2", use: "sig" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "keys", "0oa1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].kid).toBe("k1");

    await runTest(["apps", "generate-key", "0oa1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/apps/0oa1/credentials/keys/generate");
    expect(srv.calls.at(-1)!.query).toEqual({ validityYears: "2" });

    await runTest(["apps", "generate-key", "0oa1", "--validity-years", "5"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ validityYears: "5" });
  });

  test("features lists name/status", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/apps/0oa1/features", body: [{ name: "USER_PROVISIONING", status: "ENABLED" }] }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["apps", "features", "0oa1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].name).toBe("USER_PROVISIONING");
  });

  test("saml-metadata requires --kid and prints the raw XML text", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa1/sso/saml/metadata", handler: () => new Response("<EntityDescriptor/>", { headers: { "Content-Type": "text/xml" } }) },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "saml-metadata", "0oa1", "--kid", "k1"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ kid: "k1" });
    expect(t.out.at(-1)).toBe("<EntityDescriptor/>\n");
  });
});

describe("users clients / grants / subscriptions", () => {
  test("clients lists a user's OAuth2 clients", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users/00u00000000000000001/clients", body: [{ client_id: "c1", client_name: "My App", client_uri: "https://x" }] }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "clients", "bob@x.com", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].client_id).toBe("c1");
  });

  test("grants lists all, or scoped to --client", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/grants", body: [{ id: "oag1", status: "ACTIVE", scopeId: "okta.users.read", clientId: "c1", issuer: "https://x", created: "2026-01-01T00:00:00.000Z" }] },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/clients/c1/grants", body: [{ id: "oag1", status: "ACTIVE", scopeId: "okta.users.read", clientId: "c1", issuer: "https://x", created: "2026-01-01T00:00:00.000Z" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "grants", "bob@x.com", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/users/00u00000000000000001/grants");
    await runTest(["users", "grants", "bob@x.com", "--client", "c1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/users/00u00000000000000001/clients/c1/grants");
  });

  test("grants-revoke: all, one by id, all for a client, and rejects combining --client with an id", async () => {
    srv = startServer([
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/grants" },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/grants/oag1" },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/clients/c1/grants" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "grants-revoke", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe("all grants revoked from user 00u00000000000000001 (bob@x.com)\n");

    await runTest(["users", "grants-revoke", "bob@x.com", "oag1"], t.ctx);
    expect(t.out.at(-1)).toBe("grant oag1 revoked from user 00u00000000000000001 (bob@x.com)\n");

    await runTest(["users", "grants-revoke", "bob@x.com", "--client", "c1"], t.ctx);
    expect(t.out.at(-1)).toBe("all grants revoked for client c1 from user 00u00000000000000001 (bob@x.com)\n");

    expect(await runTest(["users", "grants-revoke", "bob@x.com", "oag1", "--client", "c1"], t.ctx)).not.toBe(0);
  });

  test("subscriptions lists, subscribe/unsubscribe post to the right path", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/subscriptions", body: [{ notificationType: "USER_LOCKED_OUT", status: "subscribed", channels: ["email"] }] },
      { method: "POST", path: "/api/v1/users/00u00000000000000001/subscriptions/USER_LOCKED_OUT/subscribe" },
      { method: "POST", path: "/api/v1/users/00u00000000000000001/subscriptions/USER_LOCKED_OUT/unsubscribe" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "subscriptions", "bob@x.com", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].notificationType).toBe("USER_LOCKED_OUT");

    await runTest(["users", "subscribe", "bob@x.com", "USER_LOCKED_OUT"], t.ctx);
    expect(t.out.at(-1)).toBe("user 00u00000000000000001 (bob@x.com) subscribed to USER_LOCKED_OUT\n");

    await runTest(["users", "unsubscribe", "bob@x.com", "USER_LOCKED_OUT"], t.ctx);
    expect(t.out.at(-1)).toBe("user 00u00000000000000001 (bob@x.com) unsubscribed from USER_LOCKED_OUT\n");
  });
});

describe("roles permissions / subscriptions / resource-sets", () => {
  const roleByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/iam\/roles\/cr1$/, body: { id: "cr1", label: "Zebra" } };

  test("permissions lists, permission-add posts conditions, permission-delete deletes", async () => {
    srv = startServer([
      roleByIdRoute,
      { method: "GET", path: "/api/v1/iam/roles/cr1/permissions", body: { permissions: [{ label: "okta.users.read", created: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z" }] } },
      { method: "POST", path: "/api/v1/iam/roles/cr1/permissions/okta.users.read", status: 204 },
      { method: "DELETE", path: "/api/v1/iam/roles/cr1/permissions/okta.users.read", status: 204 },
    ]);
    const t = testCtx(srv.url);
    await runTest(["roles", "permissions", "cr1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].label).toBe("okta.users.read");

    await runTest(["roles", "permission-add", "cr1", "okta.users.read"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/iam/roles/cr1/permissions/okta.users.read");
    expect(t.out.at(-1)).toBe("permission okta.users.read added to custom role cr1 (Zebra)\n");

    await runTest(["roles", "permission-delete", "cr1", "okta.users.read"], t.ctx);
    expect(t.out.at(-1)).toBe("permission okta.users.read deleted from custom role cr1 (Zebra)\n");
  });

  test("permission-add sends -s conditions as the body", async () => {
    srv = startServer([roleByIdRoute, { method: "POST", path: "/api/v1/iam/roles/cr1/permissions/okta.users.read", status: 204 }]);
    const t = testCtx(srv.url);
    await runTest(["roles", "permission-add", "cr1", "okta.users.read", "-s", "conditions.include.a=b"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ conditions: { include: { a: "b" } } });
  });

  test("subscriptions lists, subscribe/unsubscribe by role type", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/roles/SUPER_ADMIN/subscriptions", body: [{ notificationType: "USER_LOCKED_OUT", status: "unsubscribed", channels: ["email"] }] },
      { method: "POST", path: "/api/v1/roles/SUPER_ADMIN/subscriptions/USER_LOCKED_OUT/subscribe", status: 200 },
      { method: "POST", path: "/api/v1/roles/SUPER_ADMIN/subscriptions/USER_LOCKED_OUT/unsubscribe", status: 200 },
    ]);
    const t = testCtx(srv.url);
    await runTest(["roles", "subscriptions", "SUPER_ADMIN", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].notificationType).toBe("USER_LOCKED_OUT");

    await runTest(["roles", "subscribe", "SUPER_ADMIN", "USER_LOCKED_OUT"], t.ctx);
    expect(t.out.at(-1)).toBe("role SUPER_ADMIN subscribed to USER_LOCKED_OUT\n");

    await runTest(["roles", "unsubscribe", "SUPER_ADMIN", "USER_LOCKED_OUT"], t.ctx);
    expect(t.out.at(-1)).toBe("role SUPER_ADMIN unsubscribed from USER_LOCKED_OUT\n");
  });

  test("resource-set-bindings and resource-set-resources list by resource set id", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/iam/resource-sets/rs1/bindings", body: { roles: [{ id: "cr1" }] } },
      { method: "GET", path: "/api/v1/iam/resource-sets/rs1/resources", body: { resources: [{ id: "res1", orn: "orn:okta:apps:00000000000000000000:apps:0oa1", created: "2026-01-01T00:00:00.000Z" }] } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["roles", "resource-set-bindings", "rs1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("cr1");

    await runTest(["roles", "resource-set-resources", "rs1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("res1");
  });
});
