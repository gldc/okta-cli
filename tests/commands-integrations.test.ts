import { afterEach, describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const p of [
    "/privileged-access/api/v1/service-accounts", "/privileged-access/api/v1/service-accounts/x",
    "/privileged-access/api/v1/okta-service-accounts", "/privileged-access/api/v1/okta-service-accounts/x",
    "/integrations/api/v1/api-services", "/integrations/api/v1/api-services/x",
    "/integrations/api/v1/api-services/x/credentials/secrets", "/integrations/api/v1/api-services/x/credentials/secrets/y",
    "/integrations/api/v1/api-services/x/credentials/secrets/y/lifecycle/activate",
    "/integrations/api/v1/api-services/x/credentials/secrets/y/lifecycle/deactivate",
    "/.well-known/okta-organization", "/.well-known/webauthn", "/.well-known/ssf-configuration",
    "/.well-known/app-authenticator-configuration", "/.well-known/apple-app-site-association", "/.well-known/assetlinks.json",
    "/okta-personal-settings/api/v1/edit-feature", "/okta-personal-settings/api/v1/export-blocklists",
    "/webauthn-registration/api/v1/enroll", "/webauthn-registration/api/v1/activate",
    "/webauthn-registration/api/v1/initiate-fulfillment-request", "/webauthn-registration/api/v1/send-pin",
    "/webauthn-registration/api/v1/users/x/enrollments", "/webauthn-registration/api/v1/users/x/enrollments/y",
    "/webauthn-registration/api/v1/users/x/enrollments/y/mark-error",
  ]) expect(knownPath(p), p).toBe(true);
});

const userByLoginRoute = { method: "GET" as const, path: "/api/v1/users/jdoe", status: 404, body: {} };
const userSearchRoute = { method: "GET" as const, path: "/api/v1/users", body: [{ id: "u1", profile: { login: "jdoe@example.com" } }] };

describe("pam service-accounts", () => {
  test("list passes --match", async () => {
    srv = startServer([{ method: "GET", path: "/privileged-access/api/v1/service-accounts", body: [{ id: "sa1", name: "svc", ownerGroupIds: ["g1"], status: "NO_ISSUES" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "service-accounts", "list", "--match", "svc", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query.match).toBe("svc");
    expect(JSON.parse(t.out.join(""))[0].id).toBe("sa1");
  });

  test("get retrieves by id", async () => {
    srv = startServer([{ method: "GET", path: "/privileged-access/api/v1/service-accounts/sa1", body: { id: "sa1", name: "svc" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "service-accounts", "get", "sa1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).name).toBe("svc");
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/privileged-access/api/v1/service-accounts", body: { id: "sa1", name: "svc" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "service-accounts", "add", "-s", "name=svc"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "svc" });
  });

  test("update patches the body", async () => {
    srv = startServer([{ method: "PATCH", path: "/privileged-access/api/v1/service-accounts/sa1", body: { id: "sa1", name: "svc2" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "service-accounts", "update", "sa1", "-s", "name=svc2"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "svc2" });
  });

  test("delete deletes by id", async () => {
    srv = startServer([{ method: "DELETE", path: "/privileged-access/api/v1/service-accounts/sa1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "service-accounts", "delete", "sa1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(t.out.at(-1)).toBe("app service account sa1 deleted\n");
  });
});

describe("pam okta-service-accounts", () => {
  test("list returns accounts", async () => {
    srv = startServer([{ method: "GET", path: "/privileged-access/api/v1/okta-service-accounts", body: [{ id: "osa1", name: "ad-admin" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "okta-service-accounts", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("osa1");
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/privileged-access/api/v1/okta-service-accounts", body: { id: "osa1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "okta-service-accounts", "add", "-s", "name=ad-admin", "-s", "oktaUserId=00u1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "ad-admin", oktaUserId: "00u1" });
  });

  test("delete deletes by id", async () => {
    srv = startServer([{ method: "DELETE", path: "/privileged-access/api/v1/okta-service-accounts/osa1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["pam", "okta-service-accounts", "delete", "osa1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Okta managed user account osa1 deleted\n");
  });
});

describe("oin api-services", () => {
  test("api-services lists instances", async () => {
    srv = startServer([{ method: "GET", path: "/integrations/api/v1/api-services", body: [{ id: "0oa1", name: "My App", type: "my_app" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-services", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("0oa1");
  });

  test("api-service retrieves by id", async () => {
    srv = startServer([{ method: "GET", path: "/integrations/api/v1/api-services/0oa1", body: { id: "0oa1", name: "My App" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service", "0oa1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).name).toBe("My App");
  });

  test("api-service-secrets lists secrets", async () => {
    srv = startServer([{ method: "GET", path: "/integrations/api/v1/api-services/0oa1/credentials/secrets", body: [{ id: "ocs1", status: "ACTIVE", created: "2026-01-01T00:00:00.000Z", secret_hash: "abc" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service-secrets", "0oa1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("ocs1");
  });

  test("api-service-secret-add posts with no body", async () => {
    srv = startServer([{ method: "POST", path: "/integrations/api/v1/api-services/0oa1/credentials/secrets", body: { id: "ocs2", status: "ACTIVE" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service-secret-add", "0oa1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(JSON.parse(t.out.join("")).id).toBe("ocs2");
  });

  test("api-service-secret-add default output does not drop the one-time client_secret", async () => {
    srv = startServer([{ method: "POST", path: "/integrations/api/v1/api-services/0oa1/credentials/secrets", body: { id: "ocs2", status: "ACTIVE", created: "2026-01-01T00:00:00.000Z", client_secret: "top-secret-value" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service-secret-add", "0oa1"], t.ctx)).toBe(0);
    expect(t.out.join("")).toContain("top-secret-value");
  });

  test("api-service-secret-activate posts lifecycle/activate", async () => {
    srv = startServer([{ method: "POST", path: "/integrations/api/v1/api-services/0oa1/credentials/secrets/ocs1/lifecycle/activate", body: { id: "ocs1", status: "ACTIVE" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service-secret-activate", "0oa1", "ocs1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/integrations/api/v1/api-services/0oa1/credentials/secrets/ocs1/lifecycle/activate");
  });

  test("api-service-secret-delete deletes the secret", async () => {
    srv = startServer([{ method: "DELETE", path: "/integrations/api/v1/api-services/0oa1/credentials/secrets/ocs1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["oin", "api-service-secret-delete", "0oa1", "ocs1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("client secret ocs1 deleted from API service integration instance 0oa1\n");
  });
});

describe("well-known", () => {
  test("okta-organization prints the org metadata", async () => {
    srv = startServer([{ method: "GET", path: "/.well-known/okta-organization", body: { id: "00o1", pipeline: "idx" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["well-known", "okta-organization"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).id).toBe("00o1");
  });

  test("assetlinks hits the .json well-known path", async () => {
    srv = startServer([{ method: "GET", path: "/.well-known/assetlinks.json", body: [{ relation: ["delegate_permission/common.handle_all_urls"] }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["well-known", "assetlinks"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].relation[0]).toBe("delegate_permission/common.handle_all_urls");
  });
});

describe("personal-settings", () => {
  test("edit-feature PUTs the body", async () => {
    srv = startServer([{ method: "PUT", path: "/okta-personal-settings/api/v1/edit-feature" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["personal-settings", "edit-feature", "-s", "enableExportApps=true"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.body).toEqual({ enableExportApps: "true" });
    expect(t.out.at(-1)).toBe("Okta Personal admin settings updated\n");
  });

  test("export-blocklist lists blocked domains", async () => {
    srv = startServer([{ method: "GET", path: "/okta-personal-settings/api/v1/export-blocklists", body: { domains: ["example.com"] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["personal-settings", "export-blocklist"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).domains).toEqual(["example.com"]);
  });

  test("export-blocklist-set PUTs the replacement list", async () => {
    srv = startServer([{ method: "PUT", path: "/okta-personal-settings/api/v1/export-blocklists" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["personal-settings", "export-blocklist-set", "-b", '{"domains":["example.com"]}'], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ domains: ["example.com"] });
    expect(t.out.at(-1)).toBe("blocked email domains replaced\n");
  });
});

describe("webauthn-registration", () => {
  test("users webauthn-enrollments resolves the user and lists enrollments", async () => {
    srv = startServer([
      userByLoginRoute, userSearchRoute,
      { method: "GET", path: "/webauthn-registration/api/v1/users/u1/enrollments", body: [{ id: "wae1", factorType: "webauthn", status: "ACTIVE", vendorName: "YUBICO" }] },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "webauthn-enrollments", "jdoe", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("wae1");
  });

  test("users webauthn-enrollment-error posts mark-error with no body", async () => {
    srv = startServer([
      userByLoginRoute, userSearchRoute,
      { method: "POST", path: "/webauthn-registration/api/v1/users/u1/enrollments/wae1/mark-error" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "webauthn-enrollment-error", "jdoe", "wae1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toBeUndefined();
    expect(t.out.at(-1)).toBe("WebAuthn preregistration factor wae1 marked as errored for user u1\n");
  });

  test("webauthn-preregistration enroll posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/webauthn-registration/api/v1/enroll", body: { userId: "u1", fulfillmentProvider: "yubico" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["webauthn-preregistration", "enroll", "-s", "userId=u1", "-s", "fulfillmentProvider=yubico", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).userId).toBe("u1");
  });

  test("webauthn-preregistration send-pin posts with no content response", async () => {
    srv = startServer([{ method: "POST", path: "/webauthn-registration/api/v1/send-pin" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["webauthn-preregistration", "send-pin", "-s", "authenticatorEnrollmentId=wae1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("PIN sent\n");
  });
});
