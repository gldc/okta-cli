import { afterEach, describe, expect, test } from "bun:test";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";
import { knownPath } from "../src/okta/spec-paths";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const p of [
    "/apps/x/credentials/jwks", "/apps/x/credentials/jwks/y", "/apps/x/credentials/jwks/y/lifecycle/activate", "/apps/x/credentials/jwks/y/lifecycle/deactivate",
    "/apps/x/credentials/secrets", "/apps/x/credentials/secrets/y", "/apps/x/credentials/secrets/y/lifecycle/activate", "/apps/x/credentials/secrets/y/lifecycle/deactivate",
    "/apps/x/credentials/csrs", "/apps/x/credentials/csrs/y", "/apps/x/credentials/csrs/y/lifecycle/publish",
    "/apps/x/credentials/keys/y", "/apps/x/credentials/keys/y/clone",
    "/apps/x/federated-claims", "/apps/x/federated-claims/y",
    "/apps/x/group-push/mappings", "/apps/x/group-push/mappings/y",
    "/apps/x/connections/default", "/apps/x/connections/default/jwks", "/apps/x/connections/default/lifecycle/activate", "/apps/x/connections/default/lifecycle/deactivate",
    "/apps/x/cwo/connections", "/apps/x/cwo/connections/y",
    "/apps/x/interclient-allowed-apps", "/apps/x/interclient-allowed-apps/y", "/apps/x/interclient-target-apps",
    "/apps/x/logo", "/apps/x/policies/y", "/apps/x/features/y",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("apps-extra jwks", () => {
  test("list/add/get/delete/activate/deactivate", async () => {
    const jwk = { kid: "k1", status: "ACTIVE", kty: "RSA", created: "2024-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/jwks", body: [jwk] },
      { method: "POST", path: "/api/v1/apps/0oa2/credentials/jwks", body: jwk },
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/jwks/k1", body: jwk },
      { method: "DELETE", path: "/api/v1/apps/0oa2/credentials/jwks/k1" },
      { method: "POST", path: /^\/api\/v1\/apps\/0oa2\/credentials\/jwks\/k1\/lifecycle\/(activate|deactivate)$/, body: jwk },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "jwks", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("k1  ACTIVE  RSA  2024-01-01T00:00:00.000Z  \n");
    await runTest(["apps", "jwks-add", "slack", "-s", "kty=RSA"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/jwks"))!.body).toEqual({ kty: "RSA" });
    await runTest(["apps", "jwks-get", "slack", "k1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(jwk);
    await runTest(["apps", "jwks-delete", "slack", "k1"], t.ctx);
    expect(t.out.at(-1)).toBe("key k1 deleted from app 0oa2 (Slack)\n");
    await runTest(["apps", "jwks-activate", "slack", "k1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(jwk);
    await runTest(["apps", "jwks-deactivate", "slack", "k1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(jwk);
  });
});

describe("apps-extra secrets", () => {
  test("list/add/get/delete/activate/deactivate", async () => {
    const secret = { id: "s1", status: "ACTIVE", created: "2024-01-01T00:00:00.000Z", lastUpdated: "2024-01-01T00:00:00.000Z", secret_hash: "hash" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/secrets", body: [secret] },
      { method: "POST", path: "/api/v1/apps/0oa2/credentials/secrets", body: { ...secret, client_secret: "shh" } },
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/secrets/s1", body: secret },
      { method: "DELETE", path: "/api/v1/apps/0oa2/credentials/secrets/s1" },
      { method: "POST", path: /^\/api\/v1\/apps\/0oa2\/credentials\/secrets\/s1\/lifecycle\/(activate|deactivate)$/, body: secret },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "secrets", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("s1  ACTIVE  2024-01-01T00:00:00.000Z  2024-01-01T00:00:00.000Z  hash  \n");
    await runTest(["apps", "secret-add", "slack", "-j"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/secrets"))!.body).toBeUndefined();
    expect(JSON.parse(t.out.at(-1)!).client_secret).toBe("shh");
    await runTest(["apps", "secret-get", "slack", "s1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(secret);
    await runTest(["apps", "secret-delete", "slack", "s1"], t.ctx);
    expect(t.out.at(-1)).toBe("secret s1 deleted from app 0oa2 (Slack)\n");
    await runTest(["apps", "secret-activate", "slack", "s1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(secret);
    await runTest(["apps", "secret-deactivate", "slack", "s1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(secret);
  });

  test("secret-add with -b/-s sends the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/apps/0oa2/credentials/secrets", body: { id: "s2" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["apps", "secret-add", "slack", "-s", "client_secret=mine"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ client_secret: "mine" });
  });
});

describe("apps-extra csrs", () => {
  test("list/add/get/delete/publish", async () => {
    const csr = { id: "c1", created: "2024-01-01T00:00:00.000Z", kty: "RSA" };
    const key = { kid: "k9", kty: "RSA", created: "2024-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" };
    const f = `${import.meta.dir}/tmp-apps-extra-cert.pem`;
    await Bun.write(f, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
    let seenContentType = "";
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/csrs", body: [csr] },
      { method: "POST", path: "/api/v1/apps/0oa2/credentials/csrs", body: csr },
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/csrs/c1", body: csr },
      { method: "DELETE", path: "/api/v1/apps/0oa2/credentials/csrs/c1" },
      {
        method: "POST", path: "/api/v1/apps/0oa2/credentials/csrs/c1/lifecycle/publish",
        handler: (req) => { seenContentType = req.headers.get("content-type") ?? ""; return Response.json(key, { status: 201 }); },
      },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "csrs", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("c1  2024-01-01T00:00:00.000Z  RSA  \n");
    await runTest(["apps", "csr-add", "slack", "-s", "subject.commonName=SP"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/csrs"))!.body).toEqual({ subject: { commonName: "SP" } });
    await runTest(["apps", "csr-get", "slack", "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(csr);
    await runTest(["apps", "csr-delete", "slack", "c1"], t.ctx);
    expect(t.out.at(-1)).toBe("csr c1 revoked from app 0oa2 (Slack)\n");
    await runTest(["apps", "csr-publish", "slack", "c1", "--file", f, "-j"], t.ctx);
    expect(seenContentType).toBe("application/x-pem-file");
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
    await runTest(["apps", "csr-publish", "slack", "c1", "--file", f, "--format", "der"], t.ctx);
    expect(seenContentType).toBe("application/pkix-cert");
  });
});

describe("apps-extra key/key-clone", () => {
  test("key retrieves a key credential; key-clone resolves the target app", async () => {
    const key = { kid: "k1", kty: "RSA", created: "2024-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/credentials/keys/k1", body: key },
      { method: "POST", path: "/api/v1/apps/0oa2/credentials/keys/k1/clone", body: key },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "key", "slack", "k1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
    await runTest(["apps", "key-clone", "slack", "k1", "--target-app", "zoom", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ targetAid: "0oa1" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
  });
});

describe("apps-extra federated claims", () => {
  test("list/get/add/replace/delete", async () => {
    const claim = { id: "fc1", name: "role", expression: "appuser.role" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/federated-claims", body: [claim] },
      { method: "GET", path: "/api/v1/apps/0oa2/federated-claims/fc1", body: claim },
      { method: "POST", path: "/api/v1/apps/0oa2/federated-claims", body: claim },
      { method: "PUT", path: "/api/v1/apps/0oa2/federated-claims/fc1", body: claim },
      { method: "DELETE", path: "/api/v1/apps/0oa2/federated-claims/fc1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "federated-claims", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("fc1  role  appuser.role  \n");
    await runTest(["apps", "federated-claim", "slack", "fc1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(claim);
    await runTest(["apps", "federated-claim-add", "slack", "-s", "name=role", "-s", "expression=appuser.role"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ name: "role", expression: "appuser.role" });
    await runTest(["apps", "federated-claim-replace", "slack", "fc1", "-s", "name=role"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    await runTest(["apps", "federated-claim-delete", "slack", "fc1"], t.ctx);
    expect(t.out.at(-1)).toBe("federated claim fc1 deleted from app 0oa2 (Slack)\n");
  });
});

describe("apps-extra group push mappings", () => {
  test("list/get/add/update/delete", async () => {
    const mapping = { id: "m1", status: "ACTIVE", sourceGroupId: "00g1", targetGroupId: "00g9", lastPush: "2024-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/group-push/mappings", body: [mapping] },
      { method: "GET", path: "/api/v1/apps/0oa2/group-push/mappings/m1", body: mapping },
      { method: "POST", path: "/api/v1/apps/0oa2/group-push/mappings", body: mapping },
      { method: "PATCH", path: "/api/v1/apps/0oa2/group-push/mappings/m1", body: mapping },
      { method: "DELETE", path: "/api/v1/apps/0oa2/group-push/mappings/m1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "group-push-mappings", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("m1  ACTIVE  00g1  00g9  2024-01-01T00:00:00.000Z  \n");
    await runTest(["apps", "group-push-mapping", "slack", "m1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(mapping);
    await runTest(["apps", "group-push-mapping-add", "slack", "-s", "sourceGroupId=00g1", "-s", "targetGroupId=00g9"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ sourceGroupId: "00g1", targetGroupId: "00g9" });
    await runTest(["apps", "group-push-mapping-update", "slack", "m1", "-s", "status=INACTIVE"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
    await runTest(["apps", "group-push-mapping-delete", "slack", "m1", "--delete-target-group"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ deleteTargetGroup: "true" });
    expect(t.out.at(-1)).toBe("group push mapping m1 deleted from app 0oa2 (Slack)\n");
  });
});

describe("apps-extra connection", () => {
  test("get/set/jwks/activate/deactivate", async () => {
    const conn = { authScheme: "OAUTH2", status: "ENABLED" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/connections/default", body: conn },
      { method: "POST", path: "/api/v1/apps/0oa2/connections/default", body: conn },
      { method: "GET", path: "/api/v1/apps/0oa2/connections/default/jwks", body: { keys: [] } },
      { method: "POST", path: /^\/api\/v1\/apps\/0oa2\/connections\/default\/lifecycle\/(activate|deactivate)$/ },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "connection", "slack", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(conn);
    await runTest(["apps", "connection-set", "slack", "-s", "authScheme=OAUTH2"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/default"))!.body).toEqual({ authScheme: "OAUTH2" });
    await runTest(["apps", "connection-jwks", "slack", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ keys: [] });
    await runTest(["apps", "connection-activate", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("provisioning connection activated for app 0oa2 (Slack)\n");
    await runTest(["apps", "connection-deactivate", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("provisioning connection deactivated for app 0oa2 (Slack)\n");
  });
});

describe("apps-extra cwo connections", () => {
  test("list/get/add/update/delete", async () => {
    const conn = { id: "cwo1", status: "ACTIVE", requestingAppInstanceId: "0oa2", resourceAppInstanceId: "0oa1", created: "2024-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/cwo/connections", body: [conn] },
      { method: "GET", path: "/api/v1/apps/0oa2/cwo/connections/cwo1", body: conn },
      { method: "POST", path: "/api/v1/apps/0oa2/cwo/connections", body: conn },
      { method: "PATCH", path: "/api/v1/apps/0oa2/cwo/connections/cwo1", body: conn },
      { method: "DELETE", path: "/api/v1/apps/0oa2/cwo/connections/cwo1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "cwo-connections", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("cwo1  ACTIVE  0oa2  0oa1  2024-01-01T00:00:00.000Z  \n");
    await runTest(["apps", "cwo-connection", "slack", "cwo1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(conn);
    await runTest(["apps", "cwo-connection-add", "slack", "-s", "resourceAppInstanceId=0oa1"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ resourceAppInstanceId: "0oa1" });
    await runTest(["apps", "cwo-connection-update", "slack", "cwo1", "-s", "status=INACTIVE"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
    await runTest(["apps", "cwo-connection-delete", "slack", "cwo1"], t.ctx);
    expect(t.out.at(-1)).toBe("Cross App Access connection cwo1 deleted from app 0oa2 (Slack)\n");
  });
});

describe("apps-extra interclient", () => {
  test("allowed/allow/disallow/targets", async () => {
    const mapping = { id: "itm1", appInstanceId: "0oa2", trustedAppInstanceId: "0oa1", created: "2024-01-01T00:00:00.000Z" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/interclient-allowed-apps", body: ["0oa1"] },
      { method: "POST", path: "/api/v1/apps/0oa2/interclient-allowed-apps", body: mapping },
      { method: "DELETE", path: "/api/v1/apps/0oa2/interclient-allowed-apps/0oa1" },
      { method: "GET", path: "/api/v1/apps/0oa2/interclient-target-apps", body: ["0oa1"] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "interclient-allowed", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa1  \n");
    await runTest(["apps", "interclient-allow", "slack", "--target-app", "zoom", "-j"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ id: "0oa1" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual(mapping);
    await runTest(["apps", "interclient-disallow", "slack", "0oa1"], t.ctx);
    expect(t.out.at(-1)).toBe("interclient mapping to 0oa1 removed from app 0oa2 (Slack)\n");
    await runTest(["apps", "interclient-targets", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa1  \n");
  });
});

describe("apps-extra logo", () => {
  test("uploads a multipart file", async () => {
    const f = `${import.meta.dir}/tmp-apps-extra-logo.png`;
    await Bun.write(f, "logo-bytes");
    let seenField = "";
    srv = startServer([
      { method: "POST", path: "/api/v1/apps/0oa2/logo", handler: async (req) => { const form = await req.formData(); seenField = [...form.keys()][0] ?? ""; return new Response(null, { status: 201 }); } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "logo", "slack", "--file", f], t.ctx);
    expect(seenField).toBe("file");
    expect(t.out.at(-1)).toBe("logo updated\n");
  });
});

describe("apps-extra assign-policy", () => {
  test("resolves the policy and PUTs the assignment", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/policies/pol1", body: { id: "pol1", name: "My Policy", status: "ACTIVE", type: "ACCESS_POLICY", priority: 1 } },
      { method: "PUT", path: "/api/v1/apps/0oa2/policies/pol1" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "assign-policy", "slack", "--policy", "pol1"], t.ctx);
    expect(t.out.at(-1)).toBe("app 0oa2 (Slack) assigned to policy pol1 (My Policy)\n");
  });
});

describe("apps-extra feature", () => {
  test("get and set", async () => {
    const feature = { name: "PUSH_NEW_USERS", status: "ENABLED" };
    srv = startServer([
      { method: "GET", path: "/api/v1/apps/0oa2/features/PUSH_NEW_USERS", body: feature },
      { method: "PUT", path: "/api/v1/apps/0oa2/features/PUSH_NEW_USERS", body: feature },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "feature", "slack", "PUSH_NEW_USERS"], t.ctx);
    expect(t.out.at(-1)).toBe("PUSH_NEW_USERS  ENABLED  \n");
    await runTest(["apps", "feature-set", "slack", "PUSH_NEW_USERS", "-s", "capabilities.create.lifecycleCreate.status=ENABLED"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ capabilities: { create: { lifecycleCreate: { status: "ENABLED" } } } });
  });
});
