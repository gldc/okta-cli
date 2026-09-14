import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V1 } from "../src/commands/governance";
import { GOV_LABELS } from "../src/commands/governance-labels";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/labels`)).toBe(true);
  expect(knownPath(`${GOV_V1}/labels/l1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/resource-labels`)).toBe(true);
  expect(knownPath(`${GOV_V1}/resource-labels/assign`)).toBe(true);
  expect(knownPath(`${GOV_V1}/resource-labels/unassign`)).toBe(true);
  expect(knownPath(`${GOV_V1}/resource-owners`)).toBe(true);
  expect(knownPath(`${GOV_V1}/resource-owners/catalog/resources`)).toBe(true);
});

describe("labels", () => {
  const label = { labelId: "l1", name: "Sensitivity", values: [{ labelValueId: "v1", name: "High" }] };

  test("list sends no limit even with -f (endpoint rejects limit)", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/labels`, body: { data: [label] } }]);
    const t = testCtx(srv.url);
    // no --limit option should even be registered on this resource's list command
    expect(await runTest(["gov", "labels", "list", "--limit", "5"], t.ctx)).not.toBe(0);
    srv.calls.length = 0;
    expect(await runTest(["gov", "labels", "list", "-f", 'values.name sw "H"'], t.ctx)).toBe(0);
    expect(srv.calls[0]!.query).toEqual({ filter: 'values.name sw "H"' });
  });

  test("get/add/delete (no replace: PATCH only)", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/labels/l1`, body: label },
      { method: "POST", path: `${GOV_V1}/labels`, status: 201, body: label },
      { method: "DELETE", path: `${GOV_V1}/labels/l1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "labels", "get", "l1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).labelId).toBe("l1");
    await runTest(["gov", "labels", "add", "-s", "name=Sensitivity"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "Sensitivity" });
    await runTest(["gov", "labels", "delete", "l1"], t.ctx);
    expect(t.out.at(-1)).toBe("label l1 (Sensitivity) deleted\n");
    expect(GOV_LABELS.replaceable).toBe(false);
  });

  test("update: LABEL-CATEGORY --op/--path/--value triple defaults refType", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/labels/l1`, body: label },
      { method: "PATCH", path: `${GOV_V1}/labels/l1`, body: label },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "labels", "update", "l1", "--op", "REPLACE", "--path", "/name", "--value", "Confidential"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual([{ op: "REPLACE", path: "/name", value: "Confidential", refType: "LABEL-CATEGORY" }]);
  });

  test("update: -b passes an array through verbatim", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/labels/l1`, body: label },
      { method: "PATCH", path: `${GOV_V1}/labels/l1`, body: label },
    ]);
    const t = testCtx(srv.url);
    const body = [{ op: "ADD", path: "/values/-", value: { name: "Low" }, refType: "LABEL-VALUE" }];
    await runTest(["gov", "labels", "update", "l1", "-b", JSON.stringify(body)], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual(body);
  });

  test("update: resolves a name (not just an id) via resourceGet, like get/delete", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/labels/Sensitivity`, status: 404, body: { errorSummary: "nf" } },
      { method: "GET", path: `${GOV_V1}/labels`, body: { data: [label] } },
      { method: "PATCH", path: `${GOV_V1}/labels/l1`, body: label },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "labels", "update", "Sensitivity", "--op", "REPLACE", "--path", "/name", "--value", "Confidential"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V1}/labels/l1`);
    expect(srv.calls.at(-1)!.body).toEqual([{ op: "REPLACE", path: "/name", value: "Confidential", refType: "LABEL-CATEGORY" }]);
  });

  test("update: --ref-type LABEL-VALUE without -b is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "labels", "update", "l1", "--op", "ADD", "--path", "/values/-", "--ref-type", "LABEL-VALUE"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
});

describe("resource-labels", () => {
  const resourceLabel = { orn: "orn:okta:idp:00o1:apps:oidc_client:app1", profile: { id: "app1", name: "My App" }, labels: [] };

  test("list requires -f", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-labels", "list"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("list sends filter, drops limit from query", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/resource-labels`, body: { data: [resourceLabel] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-labels", "list", "-f", 'orn eq "orn:okta:idp:00o1:apps:oidc_client:app1"', "--limit", "5"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'orn eq "orn:okta:idp:00o1:apps:oidc_client:app1"' });
  });

  test("assign: repeatable --resource/--label-value build the body", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/resource-labels/assign`, body: { data: [resourceLabel] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-labels", "assign", "--resource", "orn:a", "--resource", "orn:b", "--label-value", "v1"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ resourceOrns: ["orn:a", "orn:b"], labelValueIds: ["v1"] });
  });

  test("assign: without -b or both flags is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-labels", "assign", "--resource", "orn:a"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("assign: -b lacking resourceOrns/labelValueIds throws a clear ExitError, not a TypeError", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-labels", "assign", "-b", "{}"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("ERROR:");
    expect(t.err.join("")).not.toContain("TypeError");
    expect(srv.calls.length).toBe(0);
  });

  test("unassign: -b lacking resourceOrns/labelValueIds throws a clear ExitError, not a TypeError", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-labels", "unassign", "-b", '{"resourceOrns":["orn:a"]}'], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("ERROR:");
    expect(t.err.join("")).not.toContain("TypeError");
    expect(srv.calls.length).toBe(0);
  });

  test("unassign: builds body, reports count", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/resource-labels/unassign` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-labels", "unassign", "--resource", "orn:a", "--resource", "orn:b", "--label-value", "v1"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ resourceOrns: ["orn:a", "orn:b"], labelValueIds: ["v1"] });
    expect(t.out.at(-1)).toBe("labels unassigned from 2 resource(s)\n");
  });
});

describe("resource-owners", () => {
  const owner = { parentResourceOrn: "orn:okta:idp:00o1:apps:sf:app1", resource: { orn: "orn:okta:resource:x", type: "entitlement-values" }, principals: [] };

  test("list requires -f", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-owners", "list"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("list sends filter and optional --include", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/resource-owners`, body: { data: [owner] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-owners", "list", "-f", 'parentResourceOrn eq "x"', "--include", "parent_resource_owner"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'parentResourceOrn eq "x"', include: "parent_resource_owner" });
  });

  test("set: POST body via -b, response unwrapped from envelope", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/resource-owners`, body: { data: [owner] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-owners", "set", "-b", '{"resourceOrns":["orn:a"],"principalOrns":["orn:p1"]}', "-j"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ resourceOrns: ["orn:a"], principalOrns: ["orn:p1"] });
    expect(JSON.parse(t.out.at(-1)!)).toEqual([owner]);
  });

  test("remove: --resource/--principal build the wrapped op array", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/resource-owners` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-owners", "remove", "--resource", "orn:a", "--principal", "orn:p1", "--principal", "orn:p2"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({
      resourceOrn: "orn:a",
      data: [
        { op: "REMOVE", path: "/principalOrn", value: "orn:p1" },
        { op: "REMOVE", path: "/principalOrn", value: "orn:p2" },
      ],
    });
  });

  test("remove: more than 5 --principal values is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    const principals = ["p1", "p2", "p3", "p4", "p5", "p6"].flatMap((p) => ["--principal", p]);
    expect(await runTest(["gov", "resource-owners", "remove", "--resource", "orn:a", ...principals], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("remove: without -b or --resource/--principal is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-owners", "remove"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("remove: -b lacking resourceOrn throws a clear ExitError instead of printing \"undefined\"", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/resource-owners` }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-owners", "remove", "-b", '{"data":[]}'], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("ERROR:");
    expect(t.out.join("")).not.toContain("undefined");
    expect(srv.calls.length).toBe(0);
  });

  test("catalog-resources requires -f", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "resource-owners", "catalog-resources"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("catalog-resources sends filter", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/resource-owners/catalog/resources`, body: { parentResourceOrn: "x", data: [] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "resource-owners", "catalog-resources", "-f", 'parentResourceOrn eq "x"'], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'parentResourceOrn eq "x"' });
  });
});
