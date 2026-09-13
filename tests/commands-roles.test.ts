import { afterEach, describe, expect, test } from "bun:test";
import { roleAssignmentBody } from "../src/commands/roles";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("paths exist", () => {
  for (const p of [
    "/iam/roles", "/iam/assignees/users", "/iam/resource-sets", "/users/u/roles", "/users/u/roles/r", "/groups/g/roles", "/groups/g/roles/r",
    "/iam/governance/bundles", "/iam/governance/bundles/b1", "/iam/governance/bundles/b1/entitlements", "/iam/governance/bundles/b1/entitlements/e1/values",
    "/iam/governance/optIn", "/iam/governance/optOut",
    "/users/u/roles/r/targets/groups", "/users/u/roles/r/targets/groups/g1", "/users/u/roles/r/targets/catalog/apps",
    "/users/u/roles/r/targets/catalog/apps/a", "/users/u/roles/r/targets/catalog/apps/a/i", "/users/u/roles/r/targets",
    "/groups/g/roles/r/targets/groups", "/groups/g/roles/r/targets/groups/g2", "/groups/g/roles/r/targets/catalog/apps",
    "/groups/g/roles/r/targets/catalog/apps/a", "/groups/g/roles/r/targets/catalog/apps/a/i",
    "/users/u/roles/r/governance", "/users/u/roles/r/governance/gr1", "/users/u/roles/r/governance/gr1/resources",
    "/iam/resource-sets/rs1/bindings/r1", "/iam/resource-sets/rs1/bindings/r1/members", "/iam/resource-sets/rs1/bindings/r1/members/m1",
    "/iam/resource-sets/rs1/resources/res1",
  ]) expect(knownPath(p), p).toBe(true);
});

test("roleAssignmentBody", () => {
  expect(roleAssignmentBody({ type: "APP_ADMIN" })).toEqual({ type: "APP_ADMIN" });
  expect(roleAssignmentBody({ type: "CUSTOM", role: "cr1", resourceSet: "rs1" })).toEqual({ type: "CUSTOM", role: "cr1", "resource-set": "rs1" });
  expect(() => roleAssignmentBody({ type: "CUSTOM" })).toThrow("CUSTOM roles need --role and --resource-set");
});

describe("roles", () => {
  test("custom roles list unwraps, assignees, resource-sets", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/iam/roles", body: { roles: [{ id: "cr1", label: "Zebra", description: "d" }, { id: "cr2", label: "Alpha", description: "d" }] } },
      { method: "GET", path: "/api/v1/iam/assignees/users", body: { value: [{ id: "00u1", orgId: "o", status: "ACTIVE" }] } },
      { method: "GET", path: "/api/v1/iam/resource-sets", body: { "resource-sets": [{ id: "rs1", label: "All apps" }] } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["roles", "list", "--output-fields", "label"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Alpha  \nZebra  \n");
    expect(await runTest(["roles", "assignees", "--output-fields", "id"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("00u1  \n");
    expect(await runTest(["roles", "resource-sets", "--output-fields", "id"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("rs1  \n");
  });

  test("roles list follows body-only next link (no Link header)", async () => {
    srv = startServer([]);
    srv.add({ method: "GET", path: "/api/v1/iam/roles", handler: (_req, url) => {
      if (!url.searchParams.get("after")) {
        return Response.json({ roles: [{ id: "cr1", label: "Alpha", description: "d" }], _links: { next: { href: `${srv.url}/api/v1/iam/roles?after=x` } } });
      }
      return Response.json({ roles: [{ id: "cr2", label: "Zebra", description: "d" }] });
    } });
    const t = testCtx(srv.url);
    expect(await runTest(["roles", "list", "--output-fields", "label"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Alpha  \nZebra  \n");
    expect(srv.calls.length).toBe(2);
  });

  test("user and group role assignment", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles", body: [{ id: "ra1", type: "APP_ADMIN", label: "Application Administrator", status: "ACTIVE", assignmentType: "USER" }] },
      { method: "POST", path: "/api/v1/users/00u00000000000000001/roles", body: { id: "ra2", type: "READ_ONLY_ADMIN" } },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/roles/ra1" },
      { method: "GET", path: "/api/v1/groups/00g1/roles", body: [] },
      { method: "POST", path: "/api/v1/groups/00g1/roles", body: { id: "ra3", type: "CUSTOM" } },
      { method: "DELETE", path: "/api/v1/groups/00g1/roles/ra3" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "roles", "bob@x.com", "--output-fields", "id,type"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("ra1  APP_ADMIN  \n");
    expect(await runTest(["users", "assign-role", "bob@x.com", "-t", "READ_ONLY_ADMIN", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "READ_ONLY_ADMIN" });
    expect(await runTest(["users", "unassign-role", "bob@x.com", "ra1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("role assignment ra1 removed from user 00u00000000000000001 (bob@x.com)\n");
    expect(await runTest(["groups", "roles", "engineering"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("[]\n");
    expect(await runTest(["groups", "assign-role", "engineering", "-t", "CUSTOM", "--role", "cr1", "--resource-set", "rs1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "CUSTOM", role: "cr1", "resource-set": "rs1" });
    expect(await runTest(["groups", "unassign-role", "00g1", "ra3"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("role assignment ra3 removed from group 00g1 (Engineering)\n");
    expect(await runTest(["users", "assign-role", "bob@x.com", "-t", "NOT_A_ROLE"], t.ctx)).not.toBe(0);
  });

  test("user and group role targets: list, add/delete group target, add/delete app target", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/groups", body: [{ id: "00g1", profile: { name: "Engineering" } }] },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/catalog/apps", body: [{ name: "salesforce", label: "Salesforce" }] },
      { method: "PUT", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/groups/00g1" },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/groups/00g1" },
      { method: "PUT", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/catalog/apps/salesforce" },
      { method: "PUT", path: "/api/v1/users/00u00000000000000001/roles/ra1/targets/catalog/apps/salesforce/0oa1" },
      { method: "GET", path: "/api/v1/groups/00g1/roles/ra3/targets/groups", body: [] },
      { method: "GET", path: "/api/v1/groups/00g1/roles/ra3/targets/catalog/apps", body: [] },
      { method: "PUT", path: "/api/v1/groups/00g1/roles/ra3/targets/groups/00g3" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "role-targets", "bob@x.com", "ra1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ groups: [{ id: "00g1", profile: { name: "Engineering" } }], apps: [{ name: "salesforce", label: "Salesforce" }] });

    expect(await runTest(["users", "role-target-add", "bob@x.com", "ra1", "-g", "00g1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("group 00g1 (Engineering) added as a target of role assignment ra1 on user 00u00000000000000001\n");
    expect(await runTest(["users", "role-target-delete", "bob@x.com", "ra1", "-g", "00g1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("group 00g1 (Engineering) removed as a target of role assignment ra1 on user 00u00000000000000001\n");

    expect(await runTest(["users", "role-target-add", "bob@x.com", "ra1", "--app-name", "salesforce"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("app salesforce added as a target of role assignment ra1 on user 00u00000000000000001\n");
    expect(await runTest(["users", "role-target-add", "bob@x.com", "ra1", "--app-name", "salesforce", "--app-id", "0oa1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("app salesforce/0oa1 added as a target of role assignment ra1 on user 00u00000000000000001\n");

    expect(await runTest(["users", "role-target-add", "bob@x.com", "ra1"], t.ctx)).not.toBe(0);
    expect(await runTest(["users", "role-target-add", "bob@x.com", "ra1", "-g", "00g1", "--app-name", "salesforce"], t.ctx)).not.toBe(0);

    expect(await runTest(["groups", "role-targets", "engineering", "ra3", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ groups: [], apps: [] });
    expect(await runTest(["groups", "role-target-add", "engineering", "ra3", "-g", "sales"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("group 00g3 (Sales) added as a target of role assignment ra3 on group 00g1\n");
  });

  test("role-governance and role-targets-all", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/ra1/governance", body: { grants: [{ grantId: "gr1", bundleId: "b1", type: "ENTITLEMENT_BUNDLE" }] } },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/ra1/governance/gr1", body: { grantId: "gr1", bundleId: "b1", type: "ENTITLEMENT_BUNDLE" } },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/ra1/governance/gr1/resources", body: { resources: [{ label: "All apps", resource: "orn:okta:...:apps" }] } },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles/APP_ADMIN/targets", body: [{ assignmentType: "GROUP", orn: "orn:okta:directory:x:groups:00g1" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "role-governance", "bob@x.com", "ra1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).grants[0].grantId).toBe("gr1");
    expect(await runTest(["users", "role-governance", "bob@x.com", "ra1", "gr1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).bundleId).toBe("b1");
    expect(await runTest(["users", "role-governance", "bob@x.com", "ra1", "gr1", "--resources", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).resources[0].label).toBe("All apps");
    expect(await runTest(["users", "role-governance", "bob@x.com", "ra1", "--resources"], t.ctx)).not.toBe(0);

    expect(await runTest(["users", "role-targets-all", "bob@x.com", "APP_ADMIN", "--output-fields", "assignmentType,orn"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("GROUP  orn:okta:directory:x:groups:00g1  \n");
  });
});

describe("roles governance", () => {
  test("bundles list/get, entitlements, values, opt-in/out", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/iam/governance/bundles", body: { bundles: [{ id: "b1", name: "Bundle 1", description: "d" }] } },
      { method: "GET", path: "/api/v1/iam/governance/bundles/b1", body: { id: "b1", name: "Bundle 1", description: "d", status: "ACTIVE" } },
      { method: "GET", path: "/api/v1/iam/governance/bundles/b1/entitlements", body: { entitlements: [{ id: "e1", name: "Entitlement 1", role: "r1", description: "d" }] } },
      { method: "GET", path: "/api/v1/iam/governance/bundles/b1/entitlements/e1/values", body: { entitlementValues: [{ id: "v1", name: "Value 1", value: "orn:okta:..." }] } },
      { method: "POST", path: "/api/v1/iam/governance/optIn", body: { optedIn: true } },
      { method: "POST", path: "/api/v1/iam/governance/optOut", body: { optedIn: false } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["roles", "governance-bundles", "--output-fields", "id,name"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("b1  Bundle 1  \n");
    expect(await runTest(["roles", "governance-bundle", "b1", "--output-fields", "status"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("ACTIVE  \n");
    expect(await runTest(["roles", "governance-bundle-entitlements", "b1", "--output-fields", "id,role"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("e1  r1  \n");
    expect(await runTest(["roles", "governance-entitlement-values", "b1", "e1", "--output-fields", "id"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("v1  \n");
    expect(await runTest(["roles", "governance-opt-in", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/iam/governance/optIn");
    expect(await runTest(["roles", "governance-opt-out", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/iam/governance/optOut");
  });
});
