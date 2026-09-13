import { afterEach, describe, expect, test } from "bun:test";
import { AUTH_SERVERS } from "../src/commands/auth-servers";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };
const server = { id: "aus1", status: "ACTIVE", name: "default", audiences: ["api://default"], issuer: "https://example.okta.com/oauth2/aus1" };
const serverByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/authorizationServers\/aus1$/, body: server };
const notFoundOnce = (path: RegExp) => ({ method: "GET" as const, path, status: 404, body: notFound });

test("spec paths", () => {
  for (const p of [
    AUTH_SERVERS.path, `${AUTH_SERVERS.path}/x`, `${AUTH_SERVERS.path}/x/lifecycle/activate`, `${AUTH_SERVERS.path}/x/lifecycle/deactivate`,
    `${AUTH_SERVERS.path}/x/scopes`, `${AUTH_SERVERS.path}/x/scopes/y`,
    `${AUTH_SERVERS.path}/x/claims`, `${AUTH_SERVERS.path}/x/claims/y`,
    `${AUTH_SERVERS.path}/x/policies`, `${AUTH_SERVERS.path}/x/policies/y`,
    `${AUTH_SERVERS.path}/x/policies/y/lifecycle/activate`, `${AUTH_SERVERS.path}/x/policies/y/lifecycle/deactivate`,
    `${AUTH_SERVERS.path}/x/policies/y/rules`, `${AUTH_SERVERS.path}/x/policies/y/rules/z`,
    `${AUTH_SERVERS.path}/x/clients`, `${AUTH_SERVERS.path}/x/clients/y/tokens`, `${AUTH_SERVERS.path}/x/clients/y/tokens/z`,
    `${AUTH_SERVERS.path}/x/credentials/keys`, `${AUTH_SERVERS.path}/x/credentials/lifecycle/keyRotate`,
  ]) expect(knownPath(p), p).toBe(true);
});

describe("auth-servers scopes", () => {
  test("scopes lists a server's scopes", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/scopes", body: [{ id: "scp1", name: "okta.custom.read", displayName: "Read", default: false, consent: "IMPLICIT", system: false }] },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "scopes", "aus1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/scopes");
    expect(JSON.parse(t.out.join(""))[0].id).toBe("scp1");
  });

  test("scope-add posts the body", async () => {
    srv = startServer([serverByIdRoute, { method: "POST", path: "/api/v1/authorizationServers/aus1/scopes", body: { id: "scp2", name: "okta.custom.write" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "scope-add", "aus1", "-s", "name=okta.custom.write"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/scopes");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "okta.custom.write" });
  });

  test("scope-delete falls back to a unique name match and deletes by id", async () => {
    srv = startServer([
      serverByIdRoute,
      notFoundOnce(/^\/api\/v1\/authorizationServers\/aus1\/scopes\/[^/]+$/),
      { method: "GET", path: "/api/v1/authorizationServers/aus1/scopes", body: [{ id: "scp2", name: "okta.custom.write" }] },
      { method: "DELETE", path: "/api/v1/authorizationServers/aus1/scopes/scp2" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "scope-delete", "aus1", "custom.write"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/scopes/scp2");
    expect(t.out.at(-1)).toBe("scope scp2 (okta.custom.write) deleted from authorization server aus1\n");
  });
});

describe("auth-servers claims", () => {
  test("claims lists a server's claims", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/claims", body: [{ id: "cla1", name: "groups", claimType: "RESOURCE", valueType: "GROUPS", status: "ACTIVE", alwaysIncludeInToken: true }] },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "claims", "aus1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/claims");
    expect(JSON.parse(t.out.join(""))[0].name).toBe("groups");
  });

  test("claim-add posts the body", async () => {
    srv = startServer([serverByIdRoute, { method: "POST", path: "/api/v1/authorizationServers/aus1/claims", body: { id: "cla2", name: "custom" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "claim-add", "aus1", "-s", "name=custom", "-s", "claimType=RESOURCE"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/claims");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "custom", claimType: "RESOURCE" });
  });

  test("claim-delete falls back to a unique name match and deletes by id", async () => {
    srv = startServer([
      serverByIdRoute,
      notFoundOnce(/^\/api\/v1\/authorizationServers\/aus1\/claims\/[^/]+$/),
      { method: "GET", path: "/api/v1/authorizationServers/aus1/claims", body: [{ id: "cla2", name: "custom" }] },
      { method: "DELETE", path: "/api/v1/authorizationServers/aus1/claims/cla2" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "claim-delete", "aus1", "custom"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/claims/cla2");
    expect(t.out.at(-1)).toBe("claim cla2 (custom) deleted from authorization server aus1\n");
  });
});

describe("auth-servers policies", () => {
  test("policies lists sorted by priority", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies", body: [{ id: "asp2", status: "ACTIVE", priority: 2, name: "b" }, { id: "asp1", status: "ACTIVE", priority: 1, name: "a" }] },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "policies", "aus1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).map((p: any) => p.id)).toEqual(["asp1", "asp2"]);
  });

  test("policy-add posts the body", async () => {
    srv = startServer([serverByIdRoute, { method: "POST", path: "/api/v1/authorizationServers/aus1/policies", body: { id: "asp3", name: "New" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "policy-add", "aus1", "-s", "name=New"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "New" });
  });

  test("policy-delete falls back to a unique name match and deletes by id", async () => {
    srv = startServer([
      serverByIdRoute,
      notFoundOnce(/^\/api\/v1\/authorizationServers\/aus1\/policies\/[^/]+$/),
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies", body: [{ id: "asp1", name: "Default Policy" }] },
      { method: "DELETE", path: "/api/v1/authorizationServers/aus1/policies/asp1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "policy-delete", "aus1", "Default"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies/asp1");
    expect(t.out.at(-1)).toBe("policy asp1 (Default Policy) deleted from authorization server aus1\n");
  });

  test("policy-activate resolves by name and posts lifecycle/activate", async () => {
    srv = startServer([
      serverByIdRoute,
      notFoundOnce(/^\/api\/v1\/authorizationServers\/aus1\/policies\/[^/]+$/),
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies", body: [{ id: "asp1", name: "Default Policy" }] },
      { method: "POST", path: "/api/v1/authorizationServers/aus1/policies/asp1/lifecycle/activate", body: { id: "asp1", name: "Default Policy", status: "ACTIVE" } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "policy-activate", "aus1", "Default", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies/asp1/lifecycle/activate");
    expect(JSON.parse(t.out.join("")).status).toBe("ACTIVE");
  });

  test("policy-deactivate resolves by name and posts lifecycle/deactivate", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1", body: { id: "asp1", name: "Default Policy" } },
      { method: "POST", path: "/api/v1/authorizationServers/aus1/policies/asp1/lifecycle/deactivate" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "policy-deactivate", "aus1", "asp1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies/asp1/lifecycle/deactivate");
    expect(t.out.at(-1)).toBe("policy asp1 (Default Policy) deactivated\n");
  });
});

describe("auth-servers rules", () => {
  test("rules lists sorted by priority", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1", body: { id: "asp1", name: "Default Policy" } },
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1/rules", body: [{ id: "r2", priority: 2, name: "b" }, { id: "r1", priority: 1, name: "a" }] },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "rules", "aus1", "asp1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).map((r: any) => r.id)).toEqual(["r1", "r2"]);
  });

  test("rule-add posts the body under the resolved policy", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1", body: { id: "asp1", name: "Default Policy" } },
      { method: "POST", path: "/api/v1/authorizationServers/aus1/policies/asp1/rules", body: { id: "r3", name: "New" } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "rule-add", "aus1", "asp1", "-s", "name=New"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies/asp1/rules");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "New" });
  });

  test("rule-delete falls back to a unique name match and deletes by id", async () => {
    srv = startServer([
      serverByIdRoute,
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1", body: { id: "asp1", name: "Default Policy" } },
      notFoundOnce(/^\/api\/v1\/authorizationServers\/aus1\/policies\/asp1\/rules\/[^/]+$/),
      { method: "GET", path: "/api/v1/authorizationServers/aus1/policies/asp1/rules", body: [{ id: "r1", name: "catch-all" }] },
      { method: "DELETE", path: "/api/v1/authorizationServers/aus1/policies/asp1/rules/r1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "rule-delete", "aus1", "asp1", "catch"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/policies/asp1/rules/r1");
    expect(t.out.at(-1)).toBe("rule r1 (catch-all) deleted from policy asp1 on authorization server aus1\n");
  });
});

describe("auth-servers clients / tokens", () => {
  test("clients lists OAuth2 clients", async () => {
    srv = startServer([serverByIdRoute, { method: "GET", path: "/api/v1/authorizationServers/aus1/clients", body: [{ client_id: "cid1", client_name: "My App" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "clients", "aus1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/clients");
    expect(JSON.parse(t.out.join(""))[0].client_id).toBe("cid1");
  });

  test("tokens lists refresh tokens for a client", async () => {
    srv = startServer([serverByIdRoute, { method: "GET", path: "/api/v1/authorizationServers/aus1/clients/cid1/tokens", body: [{ id: "oar1", status: "ACTIVE", created: "2026-01-01T00:00:00.000Z", userId: "00u1", scopes: ["offline_access"] }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "tokens", "aus1", "cid1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/clients/cid1/tokens");
    expect(JSON.parse(t.out.join(""))[0].id).toBe("oar1");
  });

  test("tokens-revoke with no tokenId deletes all tokens for the client", async () => {
    srv = startServer([serverByIdRoute, { method: "DELETE", path: "/api/v1/authorizationServers/aus1/clients/cid1/tokens" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "tokens-revoke", "aus1", "cid1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/clients/cid1/tokens");
    expect(t.out.at(-1)).toBe("all tokens revoked for client cid1 on authorization server aus1\n");
  });

  test("tokens-revoke with a tokenId deletes just that token", async () => {
    srv = startServer([serverByIdRoute, { method: "DELETE", path: "/api/v1/authorizationServers/aus1/clients/cid1/tokens/oar1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "tokens-revoke", "aus1", "cid1", "oar1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/clients/cid1/tokens/oar1");
    expect(t.out.at(-1)).toBe("token oar1 revoked for client cid1 on authorization server aus1\n");
  });
});

describe("auth-servers keys", () => {
  test("keys lists the signing keys", async () => {
    srv = startServer([serverByIdRoute, { method: "GET", path: "/api/v1/authorizationServers/aus1/credentials/keys", body: [{ kid: "key1", status: "ACTIVE", use: "sig", alg: "RS256" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "keys", "aus1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/credentials/keys");
    expect(JSON.parse(t.out.join(""))[0].kid).toBe("key1");
  });

  test("rotate-keys posts { use: \"sig\" } by default", async () => {
    srv = startServer([serverByIdRoute, { method: "POST", path: "/api/v1/authorizationServers/aus1/credentials/lifecycle/keyRotate", body: [{ kid: "key2", status: "NEXT", use: "sig", alg: "RS256" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["auth-servers", "rotate-keys", "aus1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/authorizationServers/aus1/credentials/lifecycle/keyRotate");
    expect(srv.calls.at(-1)!.body).toEqual({ use: "sig" });
  });
});
