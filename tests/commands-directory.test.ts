import { afterEach, describe, expect, test } from "bun:test";
import { UI_SCHEMAS } from "../src/commands/directory";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const p of [
    "/agentPools", "/agentPools/p1/updates", "/agentPools/p1/updates/settings", "/agentPools/p1/updates/u1",
    "/agentPools/p1/updates/u1/activate", "/agentPools/p1/updates/u1/deactivate", "/agentPools/p1/updates/u1/pause",
    "/agentPools/p1/updates/u1/resume", "/agentPools/p1/updates/u1/retry", "/agentPools/p1/updates/u1/stop",
    "/identity-sources/s1/sessions", "/identity-sources/s1/sessions/sess1", "/identity-sources/s1/sessions/sess1/start-import",
    "/identity-sources/s1/sessions/sess1/bulk-upsert", "/identity-sources/s1/sessions/sess1/bulk-delete",
    "/identity-sources/s1/sessions/sess1/bulk-groups-upsert", "/identity-sources/s1/sessions/sess1/bulk-groups-delete",
    "/identity-sources/s1/sessions/sess1/bulk-group-memberships-upsert", "/identity-sources/s1/sessions/sess1/bulk-group-memberships-delete",
    "/identity-sources/s1/users/ext1", "/identity-sources/s1/groups/g1", "/identity-sources/s1/groups/g1/membership",
    "/identity-sources/s1/groups", "/identity-sources/s1/groups/g1/membership/ext1",
    UI_SCHEMAS.path, `${UI_SCHEMAS.path}/x`,
    "/first-party-app-settings/admin-console",
    "/directories/a1/groups/modify", "/directories/a1/groups/g1/query", "/directories/a1/groups/g1/query/r1",
  ]) expect(knownPath(p), p).toBe(true);
  for (const p of [
    "/oauth2/v1/clients/c1/roles", "/oauth2/v1/clients/c1/roles/ra1", "/oauth2/v1/clients/c1/roles/ra1/targets/groups", "/oauth2/v1/clients/c1/roles/ra1/targets/groups/00g1",
    "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps", "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps/salesforce", "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps/salesforce/0oa1",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("agent-pools", () => {
  test("list transforms agents to agentCount and passes query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/agentPools", body: [{ id: "p1", name: "region1", type: "AD", agents: [{}, {}] }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["agent-pools", "list", "--pool-type", "AD", "--limit-per-pool-type", "5", "--output-fields", "id,name,agentCount"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ poolType: "AD", limitPerPoolType: "5" });
    expect(t.out.at(-1)).toBe("p1  region1  2  \n");
  });

  test("updates/update/update-add/update-replace/update-delete", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/agentPools/p1/updates", body: [{ id: "u1", name: "upd1", status: "SCHEDULED", enabled: true }] },
      { method: "GET", path: "/api/v1/agentPools/p1/updates/u1", body: { id: "u1", name: "upd1", status: "SCHEDULED" } },
      { method: "POST", path: "/api/v1/agentPools/p1/updates", body: { id: "u2", name: "new" } },
      { method: "POST", path: "/api/v1/agentPools/p1/updates/u1", body: { id: "u1", name: "renamed" } },
      { method: "DELETE", path: "/api/v1/agentPools/p1/updates/u1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["agent-pools", "updates", "p1", "--output-fields", "id,status"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("u1  SCHEDULED  \n");
    expect(await runTest(["agent-pools", "update", "p1", "u1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("u1");
    expect(await runTest(["agent-pools", "update-add", "p1", "-s", "name=new", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "new" });
    expect(await runTest(["agent-pools", "update-replace", "p1", "u1", "-s", "name=renamed", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/agentPools/p1/updates/u1");
    expect(await runTest(["agent-pools", "update-delete", "p1", "u1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("agent pool update u1 deleted from pool p1\n");
  });

  test("update lifecycle verbs post to /updates/{id}/{verb}", async () => {
    srv = startServer([
      { method: "POST", path: /^\/api\/v1\/agentPools\/p1\/updates\/u1\/(activate|deactivate|pause|resume|retry|stop)$/, body: { id: "u1", status: "OK" } },
    ]);
    const t = testCtx(srv.url);
    for (const verb of ["activate", "deactivate", "pause", "resume", "retry", "stop"]) {
      expect(await runTest(["agent-pools", `update-${verb}`, "p1", "u1", "-j"], t.ctx)).toBe(0);
      expect(srv.calls.at(-1)!.path).toBe(`/api/v1/agentPools/p1/updates/u1/${verb}`);
    }
  });

  test("update-settings / update-settings-set (POST)", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/agentPools/p1/updates/settings", body: { poolId: "p1", agentType: "AD" } },
      { method: "POST", path: "/api/v1/agentPools/p1/updates/settings", body: { poolId: "p1", agentType: "AD", continueOnError: true } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["agent-pools", "update-settings", "p1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).poolId).toBe("p1");
    expect(await runTest(["agent-pools", "update-settings-set", "p1", "-s", "continueOnError=true", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.body).toEqual({ continueOnError: "true" });
  });
});

describe("identity-sources", () => {
  test("sessions/session/session-add/session-delete/start-import", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/identity-sources/s1/sessions", body: [{ id: "sess1", identitySourceId: "s1", status: "CREATED", importType: "INCREMENTAL", created: "c" }] },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions", body: { id: "sess2", identitySourceId: "s1", status: "CREATED" } },
      { method: "GET", path: "/api/v1/identity-sources/s1/sessions/sess1", body: { id: "sess1", identitySourceId: "s1", status: "CREATED" } },
      { method: "DELETE", path: "/api/v1/identity-sources/s1/sessions/sess1" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/start-import" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["identity-sources", "sessions", "s1", "--output-fields", "id,status"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("sess1  CREATED  \n");
    expect(await runTest(["identity-sources", "session-add", "s1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("sess2");
    expect(await runTest(["identity-sources", "session", "s1", "sess1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("CREATED");
    expect(await runTest(["identity-sources", "session-delete", "s1", "sess1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("identity source session sess1 deleted\n");
    expect(await runTest(["identity-sources", "start-import", "s1", "sess1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("import started for identity source s1 session sess1\n");
  });

  test("bulk-* commands post to the wire path with the body", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-upsert" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-delete" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-groups-upsert" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-groups-delete" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-group-memberships-upsert" },
      { method: "POST", path: "/api/v1/identity-sources/s1/sessions/sess1/bulk-group-memberships-delete" },
    ]);
    const t = testCtx(srv.url);
    for (const [cmd, wire] of [
      ["bulk-upsert", "bulk-upsert"], ["bulk-delete", "bulk-delete"],
      ["bulk-groups-upsert", "bulk-groups-upsert"], ["bulk-groups-delete", "bulk-groups-delete"],
      ["bulk-memberships-upsert", "bulk-group-memberships-upsert"], ["bulk-memberships-delete", "bulk-group-memberships-delete"],
    ] as const) {
      expect(await runTest(["identity-sources", cmd, "s1", "sess1", "-s", "x=1"], t.ctx)).toBe(0);
      expect(srv.calls.at(-1)!.path).toBe(`/api/v1/identity-sources/s1/sessions/sess1/${wire}`);
      expect(srv.calls.at(-1)!.body).toEqual({ x: "1" });
      expect(t.out.at(-1)).toBe(`${cmd} uploaded for identity source s1 session sess1\n`);
    }
  });

  test("user/group/group-members", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/identity-sources/s1/users/ext1", body: { id: "00u1", externalId: "ext1", profile: { userName: "bob", email: "bob@x.com" } } },
      { method: "GET", path: "/api/v1/identity-sources/s1/groups/g1", body: { id: "00g1", externalId: "g1", profile: { profile: { displayName: "Engineering" } } } },
      { method: "GET", path: "/api/v1/identity-sources/s1/groups/g1/membership", body: { memberExternalIds: ["ext1", "ext2"] } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["identity-sources", "user", "s1", "ext1", "--output-fields", "externalId,profile.userName"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("ext1  bob  \n");
    expect(await runTest(["identity-sources", "group", "s1", "g1", "--output-fields", "externalId,profile.profile.displayName"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("g1  Engineering  \n");
    expect(await runTest(["identity-sources", "group-members", "s1", "g1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("ext1  \next2  \n");
  });

  test("group-add posts the body; group-member-delete deletes a member", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/identity-sources/s1/groups", body: { id: "00g1", externalId: "g1" } },
      { method: "DELETE", path: "/api/v1/identity-sources/s1/groups/g1/membership/ext1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["identity-sources", "group-add", "s1", "-s", "externalId=g1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ externalId: "g1" });
    expect(await runTest(["identity-sources", "group-member-delete", "s1", "g1", "ext1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("member ext1 removed from identity source s1 group g1\n");
  });
});

describe("oauth-clients", () => {
  test("roles/assign-role/unassign-role/role-targets/role-target-add/role-target-delete", async () => {
    srv = startServer([
      { method: "GET", path: "/oauth2/v1/clients/c1/roles", body: [{ id: "ra1", type: "APP_ADMIN", label: "App Administrator", status: "ACTIVE", assignmentType: "USER" }] },
      { method: "POST", path: "/oauth2/v1/clients/c1/roles", body: { id: "ra2", type: "READ_ONLY_ADMIN" } },
      { method: "DELETE", path: "/oauth2/v1/clients/c1/roles/ra1" },
      { method: "GET", path: "/oauth2/v1/clients/c1/roles/ra1/targets/groups", body: [{ id: "00g1", profile: { name: "Engineering" } }] },
      { method: "GET", path: "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps", body: [{ name: "salesforce", label: "Salesforce" }] },
      { method: "PUT", path: "/oauth2/v1/clients/c1/roles/ra1/targets/groups/00g1" },
      { method: "DELETE", path: "/oauth2/v1/clients/c1/roles/ra1/targets/groups/00g1" },
      { method: "PUT", path: "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps/salesforce" },
      { method: "DELETE", path: "/oauth2/v1/clients/c1/roles/ra1/targets/catalog/apps/salesforce" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["oauth-clients", "roles", "c1", "--output-fields", "id,type"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("ra1  APP_ADMIN  \n");
    expect(await runTest(["oauth-clients", "assign-role", "c1", "-t", "READ_ONLY_ADMIN", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "READ_ONLY_ADMIN" });
    expect(await runTest(["oauth-clients", "unassign-role", "c1", "ra1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("role assignment ra1 removed from OAuth 2.0 client c1\n");
    expect(await runTest(["oauth-clients", "role-targets", "c1", "ra1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ groups: [{ id: "00g1", profile: { name: "Engineering" } }], apps: [{ name: "salesforce", label: "Salesforce" }] });
    expect(await runTest(["oauth-clients", "role-target-add", "c1", "ra1", "-g", "00g1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("group 00g1 (Engineering) added as a target of role assignment ra1 on client c1\n");
    expect(await runTest(["oauth-clients", "role-target-delete", "c1", "ra1", "-g", "00g1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("group 00g1 (Engineering) removed as a target of role assignment ra1 on client c1\n");
    expect(await runTest(["oauth-clients", "role-target-add", "c1", "ra1", "--app-name", "salesforce"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("app salesforce added as a target of role assignment ra1 on client c1\n");
    expect(await runTest(["oauth-clients", "role-target-delete", "c1", "ra1", "--app-name", "salesforce"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("app salesforce removed as a target of role assignment ra1 on client c1\n");
    expect(await runTest(["oauth-clients", "role-target-add", "c1", "ra1"], t.ctx)).not.toBe(0);
    expect(await runTest(["oauth-clients", "role-target-add", "c1", "ra1", "-g", "00g1", "--app-name", "salesforce"], t.ctx)).not.toBe(0);
  });
});

describe("ui-schemas", () => {
  test("list/get/add/replace/delete", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/meta/uischemas", body: [{ id: "uis1", uiSchema: { type: "form", label: "Enroll" }, created: "c" }] },
      { method: "GET", path: "/api/v1/meta/uischemas/uis1", body: { id: "uis1", uiSchema: { type: "form", label: "Enroll" } } },
      { method: "POST", path: "/api/v1/meta/uischemas", body: { id: "uis2" } },
      { method: "PUT", path: "/api/v1/meta/uischemas/uis1", body: { id: "uis1" } },
      { method: "DELETE", path: "/api/v1/meta/uischemas/uis1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["ui-schemas", "list", "--output-fields", "id,uiSchema.type"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("uis1  form  \n");
    expect(await runTest(["ui-schemas", "get", "uis1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("uis1");
    expect(await runTest(["ui-schemas", "add", "-s", "uiSchema.label=Enroll", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ uiSchema: { label: "Enroll" } });
    expect(await runTest(["ui-schemas", "replace", "uis1", "-s", "uiSchema.label=Enroll", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(await runTest(["ui-schemas", "delete", "uis1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("UI schema uis1 (uis1) deleted\n");
  });
});

describe("first-party-app", () => {
  test("get/set", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/first-party-app-settings/admin-console", body: { settings: {} } },
      { method: "PUT", path: "/api/v1/first-party-app-settings/admin-console", body: { settings: { x: 1 } } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["first-party-app", "get", "admin-console", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).settings).toEqual({});
    expect(await runTest(["first-party-app", "set", "admin-console", "-s", "settings.x=1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });
});

describe("directories", () => {
  test("groups-modify/group-query/group-query-result", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/directories/a1/groups/modify" },
      { method: "POST", path: "/api/v1/directories/a1/groups/g1/query", body: { resultId: "r1" } },
      { method: "GET", path: "/api/v1/directories/a1/groups/g1/query/r1", body: { id: "g1", profile: {} } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["directories", "groups-modify", "a1", "-s", "action=ADD"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ action: "ADD" });
    expect(await runTest(["directories", "group-query", "a1", "g1", "-s", "attributes=member", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).resultId).toBe("r1");
    expect(await runTest(["directories", "group-query-result", "a1", "g1", "r1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("g1");
  });
});
