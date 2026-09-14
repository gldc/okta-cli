import { afterEach, expect, test } from "bun:test";
import { GOV_V1 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/principal-access`)).toBe(true);
  expect(knownPath(`${GOV_V1}/principal-entitlements`)).toBe(true);
  expect(knownPath(`${GOV_V1}/principal-entitlements/history`)).toBe(true);
  expect(knownPath(`${GOV_V1}/principal-entitlements-changes/x1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/principal-settings/p1`)).toBe(true);
});

test("principal-access get requires -f", async () => {
  srv = startServer([]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "principal-access", "get"], t.ctx)).not.toBe(0);
  expect(srv.calls.length).toBe(0);
});

test("principal-access get: filter query, plain-object JSON output by default", async () => {
  const access = {
    parentResourceOrn: "orn:okta:idp:00o1:apps:salesforce:0oa1", parent: { type: "APPLICATION" },
    targetPrincipalOrn: "orn:okta:directory:00o1:user:00u1", targetPrincipal: { type: "OKTA_USER" },
    expirationTime: "2027-01-01T00:00:00.000Z", timeZone: "UTC",
  };
  srv = startServer([{ method: "GET", path: `${GOV_V1}/principal-access`, body: access }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "principal-access", "get", "-f", 'targetPrincipalOrn eq "x"'], t.ctx)).toBe(0);
  expect(srv.calls[0]!.query).toEqual({ filter: 'targetPrincipalOrn eq "x"' });
  expect(JSON.parse(t.out.at(-1)!).parentResourceOrn).toBe(access.parentResourceOrn);
});

const entitlement = {
  id: "e1", name: "Role", externalValue: "role", dataType: "string", multiValue: false, required: true,
  parentResourceOrn: "orn:okta:idp:00o1:apps:salesforce:0oa1", targetPrincipalOrn: "orn:okta:directory:00o1:user:00u1",
};

test("principal-entitlements list requires -f", async () => {
  srv = startServer([]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "principal-entitlements", "list"], t.ctx)).not.toBe(0);
  expect(srv.calls.length).toBe(0);
});

test("principal-entitlements list: filter and limit (limit not sent as query)", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/principal-entitlements`, body: { data: [entitlement] } }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "principal-entitlements", "list", "-f", 'targetPrincipalOrn eq "x"', "--limit", "5"], t.ctx);
  expect(srv.calls[0]!.query).toEqual({ filter: 'targetPrincipalOrn eq "x"' });
  expect(t.out.at(-1)).toBe("e1  Role  role  string  false  true  orn:okta:idp:00o1:apps:salesforce:0oa1  orn:okta:directory:00o1:user:00u1  \n");
});

test("principal-entitlements history requires -f", async () => {
  srv = startServer([]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "principal-entitlements", "history"], t.ctx)).not.toBe(0);
  expect(srv.calls.length).toBe(0);
});

test("principal-entitlements history: array key is entitlementHistory, not data", async () => {
  const record = { startDate: "2026-01-01T00:00:00.000Z", endDate: null, lifecycle: "ACTIVE", entitlements: [] };
  srv = startServer([{ method: "GET", path: `${GOV_V1}/principal-entitlements/history`, body: { entitlementHistory: [record], _links: {} } }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "principal-entitlements", "history", "-f", 'targetPrincipalOrn eq "x"', "--include", "counts"], t.ctx);
  expect(srv.calls[0]!.query).toEqual({ filter: 'targetPrincipalOrn eq "x"', include: "counts" });
  expect(t.out.at(-1)).toBe("2026-01-01T00:00:00.000Z    ACTIVE  \n");
});

test("principal-entitlements changes: single object, JSON output by default", async () => {
  const change = { entitlementsChanged: [], resourceOrn: "orn:okta:resource:x", resource: {}, principalOrn: "orn:okta:directory:00o1:user:00u1", principal: {} };
  srv = startServer([{ method: "GET", path: `${GOV_V1}/principal-entitlements-changes/cmVwMWtOQ2NmQnhhRWVEbXcwZzI6cmVwOHBCVVRWVG9na2lYNWUwZzI`, body: change }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "principal-entitlements", "changes", "cmVwMWtOQ2NmQnhhRWVEbXcwZzI6cmVwOHBCVVRWVG9na2lYNWUwZzI"], t.ctx);
  expect(JSON.parse(t.out.at(-1)!).resourceOrn).toBe("orn:okta:resource:x");
});

test("principal-settings update: PATCH object body, JSON output by default", async () => {
  const updated = { delegates: { appointments: [{ delegate: { externalId: "00u2", type: "OKTA_USER" } }] } };
  srv = startServer([{ method: "PATCH", path: `${GOV_V1}/principal-settings/00u1`, body: updated }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "principal-settings", "update", "00u1", "-b", JSON.stringify(updated)], t.ctx);
  expect(srv.calls[0]!.method).toBe("PATCH");
  expect(srv.calls[0]!.path).toBe(`${GOV_V1}/principal-settings/00u1`);
  expect(srv.calls[0]!.body).toEqual(updated);
  expect(JSON.parse(t.out.at(-1)!).delegates).toEqual(updated.delegates);
});
