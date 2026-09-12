import { afterEach, describe, expect, test } from "bun:test";
import { POLICIES, POLICY_TYPES } from "../src/commands/policies";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };
const policy = { id: "pol1", status: "ACTIVE", type: "PASSWORD", priority: 1, name: "Default Policy" };
const policyByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/policies\/pol1$/, body: policy };

test("spec paths", () => {
  expect(knownPath(POLICIES.path)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/lifecycle/activate`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/lifecycle/deactivate`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/rules`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/rules/y`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/rules/y/lifecycle/activate`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/rules/y/lifecycle/deactivate`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/clone`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/app`)).toBe(true);
  expect(knownPath(`${POLICIES.path}/x/mappings`)).toBe(true);
});

test("POLICY_TYPES includes the documented types", () => {
  expect(POLICY_TYPES).toContain("PASSWORD");
  expect(POLICY_TYPES).toContain("ACCESS_POLICY");
});

describe("policies list", () => {
  test("without -t fails", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["policies", "list"], t.ctx)).not.toBe(0);
  });

  test("-t sends type query and sorts numerically by priority", async () => {
    srv = startServer([{
      method: "GET", path: "/api/v1/policies",
      body: [
        { id: "p3", status: "ACTIVE", type: "PASSWORD", priority: 10, name: "c" },
        { id: "p1", status: "ACTIVE", type: "PASSWORD", priority: 2, name: "a" },
        { id: "p2", status: "ACTIVE", type: "PASSWORD", priority: 1, name: "b" },
      ],
    }]);
    const t = testCtx(srv.url);
    await runTest(["policies", "list", "-t", "PASSWORD", "-j"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ type: "PASSWORD" });
    expect(JSON.parse(t.out.join("")).map((p: any) => p.id)).toEqual(["p2", "p1", "p3"]);
  });
});

describe("policies rules", () => {
  test("rules sorted by priority", async () => {
    srv = startServer([
      policyByIdRoute,
      {
        method: "GET", path: "/api/v1/policies/pol1/rules",
        body: [
          { id: "r2", status: "ACTIVE", type: "PASSWORD", priority: 5, name: "second" },
          { id: "r1", status: "ACTIVE", type: "PASSWORD", priority: 1, name: "first" },
        ],
      },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "rules", "pol1", "-j"], t.ctx);
    expect(JSON.parse(t.out.join("")).map((r: any) => r.id)).toEqual(["r1", "r2"]);
  });

  test("rule falls back to unique name substring match", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "GET", path: /^\/api\/v1\/policies\/pol1\/rules\/[^/]+$/, status: 404, body: notFound },
      {
        method: "GET", path: "/api/v1/policies/pol1/rules",
        body: [{ id: "r1", name: "catch-all", priority: 1 }, { id: "r2", name: "mfa-required", priority: 2 }],
      },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "rule", "pol1", "mfa", "-j"], t.ctx);
    expect(JSON.parse(t.out.join("")).id).toBe("r2");
  });

  test("rule-delete deletes and reports policy + rule", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "GET", path: "/api/v1/policies/pol1/rules/r1", body: { id: "r1", name: "catch-all" } },
      { method: "DELETE", path: "/api/v1/policies/pol1/rules/r1" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "rule-delete", "pol1", "r1"], t.ctx);
    expect(t.out.at(-1)).toBe("rule r1 (catch-all) deleted from policy pol1\n");
  });
});

describe("policies clone / apps / map", () => {
  test("clone posts to /clone", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "POST", path: "/api/v1/policies/pol1/clone", body: { id: "pol2", name: "Default Policy (clone)" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "clone", "pol1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/policies/pol1/clone");
    expect(JSON.parse(t.out.join("")).id).toBe("pol2");
  });

  test("apps lists policy apps", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "GET", path: "/api/v1/policies/pol1/app", body: [{ id: "0oa1", label: "App", status: "ACTIVE" }] },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "apps", "pol1", "-j"], t.ctx);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("0oa1");
  });

  test("mappings lists a policy's resource mappings", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "GET", path: "/api/v1/policies/pol1/mappings", body: [{ id: "m1", resourceType: "APP", resourceId: "0oa1" }] },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "mappings", "pol1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/policies/pol1/mappings");
    expect(JSON.parse(t.out.join(""))[0].id).toBe("m1");
  });

  test("map posts resourceType/resourceId body", async () => {
    srv = startServer([
      policyByIdRoute,
      { method: "POST", path: "/api/v1/policies/pol1/mappings", body: { id: "m1", resourceType: "APP", resourceId: "0oa1" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["policies", "map", "pol1", "--resource-type", "APP", "--resource-id", "0oa1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ resourceType: "APP", resourceId: "0oa1" });
  });
});
