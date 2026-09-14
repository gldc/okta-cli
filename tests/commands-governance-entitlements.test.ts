import { afterEach, describe, expect, test } from "bun:test";
import { GOV_GRANTS } from "../src/commands/governance-entitlements";
import { GOV_V1 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/entitlements`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlements/values`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlements/e1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlements/e1/values`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlements/e1/values/v1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlement-bundles`)).toBe(true);
  expect(knownPath(`${GOV_V1}/entitlement-bundles/b1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/grants`)).toBe(true);
  expect(knownPath(`${GOV_V1}/grants/g1`)).toBe(true);
});

describe("entitlements", () => {
  const entitlement = {
    id: "e1", name: "Salesforce role", externalValue: "role", dataType: "string", multiValue: false, required: true,
    parentResourceOrn: "orn:okta:idp:00o1:apps:salesforce:0oa1",
  };

  test("list requires -f, sends filter (not limit) as query, no default filter", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "list"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("list with -f hits the governance basePath, sends filter, drops limit from query", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements`, body: { data: [entitlement] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "list", "-f", 'parentResourceOrn eq "x"', "--limit", "5"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V1}/entitlements`);
    expect(srv.calls[0]!.query).toEqual({ filter: 'parentResourceOrn eq "x"' });
    expect(t.out.at(-1)).toBe("e1  Salesforce role  role  string  false  true  orn:okta:idp:00o1:apps:salesforce:0oa1  \n");
  });

  test("get by id", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements/e1`, body: entitlement }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "get", "e1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("e1");
  });

  test("get by name substring fails: filterRequired specs cannot fall back to a filterless list", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements/Salesforce`, status: 404, body: { errorSummary: "nf" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "get", "Salesforce"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("must be given by id");
    expect(srv.calls.length).toBe(1);
  });

  test("add passes body through", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/entitlements`, status: 201, body: entitlement }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "add", "-s", "name=Salesforce role", "-s", "externalValue=role", "-s", "multiValue=false", "-s", "dataType=string"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ name: "Salesforce role", externalValue: "role", multiValue: "false", dataType: "string" });
  });

  test("replace: GET then PUT merge; beforeReplace re-adds id (entitlement-updatable requires it)", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/entitlements/e1`, body: entitlement },
      { method: "PUT", path: `${GOV_V1}/entitlements/e1`, body: { ...entitlement, name: "Renamed" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "replace", "e1", "-s", "name=Renamed"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V1}/entitlements/e1`);
    expect((srv.calls.at(-1)!.body as any).name).toBe("Renamed");
    expect((srv.calls.at(-1)!.body as any).id).toBe("e1");
  });

  test("delete", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/entitlements/e1`, body: entitlement },
      { method: "DELETE", path: `${GOV_V1}/entitlements/e1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "delete", "e1"], t.ctx);
    expect(t.out.at(-1)).toBe("entitlement e1 (Salesforce role) deleted\n");
  });

  test("patch: --op/--path/--value triple builds a single-element ENTITLEMENT array", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/entitlements/e1`, body: entitlement }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "patch", "e1", "--op", "REPLACE", "--path", "/name", "--value", "x"], t.ctx);
    expect(srv.calls[0]!.body).toEqual([{ op: "REPLACE", path: "/name", value: "x", refType: "ENTITLEMENT" }]);
  });

  test("patch: -b passes an array through verbatim", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/entitlements/e1`, body: entitlement }]);
    const t = testCtx(srv.url);
    const body = [{ op: "ADD", path: "/values/-", value: { name: "n", externalValue: "v" }, refType: "ENTITLEMENT-VALUE" }];
    await runTest(["gov", "entitlements", "patch", "e1", "-b", JSON.stringify(body)], t.ctx);
    expect(srv.calls[0]!.body).toEqual(body);
  });

  test("patch: -b with a non-array body is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "patch", "e1", "-b", "{}"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("must be a JSON array");
    expect(srv.calls.length).toBe(0);
  });

  test("patch: --ref-type ENTITLEMENT-VALUE without -b is rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "patch", "e1", "--op", "ADD", "--path", "/values/-", "--ref-type", "ENTITLEMENT-VALUE"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  const value = { id: "v1", name: "Admin", externalValue: "admin", entitlementId: "e1", parentResourceOrn: entitlement.parentResourceOrn };

  test("values-all requires -f", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "values-all"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("values-all sends filter and order-by", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements/values`, body: { data: [value] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "values-all", "-f", 'name eq "Admin"', "--order-by", "name asc"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'name eq "Admin"', orderBy: "name asc" });
    expect(t.out.at(-1)).toBe("v1  Admin  admin  e1  orn:okta:idp:00o1:apps:salesforce:0oa1  \n");
  });

  test("values <entitlementId> filter is optional", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements/e1/values`, body: { data: [value] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlements", "values", "e1"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.query).toEqual({});
  });

  test("value <entitlementId> <valueId>", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlements/e1/values/v1`, body: value }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlements", "value", "e1", "v1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("v1");
  });
});

describe("entitlement-bundles", () => {
  const bundle = { id: "b1", name: "Sales bundle", status: "ACTIVE", targetResourceOrn: "orn:okta:resource:x", target: { type: "APP", externalId: "0oa1" }, description: "d" };

  test("list has no required filter, supports --include full_entitlements", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/entitlement-bundles`, body: { data: [bundle] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "entitlement-bundles", "list", "--include", "full_entitlements"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.query).toEqual({ include: "full_entitlements" });
  });

  test("get/add/replace/delete", async () => {
    srv = startServer([
      // a plain GET omits entitlements; only ?include=full_entitlements returns them
      { method: "GET", path: `${GOV_V1}/entitlement-bundles/b1`, handler: (_req, url) => Response.json(url.searchParams.get("include") === "full_entitlements"
        ? { ...bundle, entitlements: [{ id: "e1", name: "Role", values: [{ id: "v1", name: "admin", created: "x" }] }] }
        : bundle) },
      { method: "POST", path: `${GOV_V1}/entitlement-bundles`, status: 201, body: bundle },
      { method: "PUT", path: `${GOV_V1}/entitlement-bundles/b1`, body: bundle },
      { method: "DELETE", path: `${GOV_V1}/entitlement-bundles/b1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlement-bundles", "get", "b1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("b1");
    await runTest(["gov", "entitlement-bundles", "add", "-s", "name=Sales bundle"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "Sales bundle" });
    await runTest(["gov", "entitlement-bundles", "replace", "b1", "-s", "description=updated"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    // beforeReplace re-adds id/targetResourceOrn/target: entitlement-bundle-updatable requires
    // all three, and they'd otherwise be stripped (id) or never merged in (targetResourceOrn,
    // target aren't part of the -s/-b diff) by the default replace merge.
    const putBody = srv.calls.at(-1)!.body as any;
    expect(putBody.id).toBe("b1");
    expect(putBody.targetResourceOrn).toBe("orn:okta:resource:x");
    expect(putBody.target).toEqual({ type: "APP", externalId: "0oa1" });
    // a plain GET omits entitlements; the hook re-fetches with include=full_entitlements and
    // reduces to the writable { id, values: [{ id }] } shape
    expect(srv.calls.at(-2)!.query).toEqual({ include: "full_entitlements" });
    expect(putBody.entitlements).toEqual([{ id: "e1", values: [{ id: "v1" }] }]);
    await runTest(["gov", "entitlement-bundles", "delete", "b1"], t.ctx);
    expect(t.out.at(-1)).toBe("entitlement bundle b1 (Sales bundle) deleted\n");
  });
});

describe("grants", () => {
  const grant = {
    id: "g1", status: "ACTIVE", grantType: "ENTITLEMENT-BUNDLE", action: "ALLOW",
    targetPrincipalOrn: "orn:okta:directory:00o1:user:00u1", targetResourceOrn: "orn:okta:resource:x", entitlementBundleId: "b1",
  };

  test("list requires -f; --include full_entitlements --include metadata sends two repeated include params (not comma-joined - Okta 400s on that live)", async () => {
    srv = startServer([]);
    let includeValues: string[] = [];
    srv.add({ method: "GET", path: `${GOV_V1}/grants`, handler: (_req, url) => { includeValues = url.searchParams.getAll("include"); return Response.json({ data: [grant] }); } });
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "grants", "list", "-f", 'targetResourceOrn eq "x"', "--include", "full_entitlements", "--include", "metadata"], t.ctx)).toBe(0);
    expect(includeValues).toEqual(["full_entitlements", "metadata"]);
    expect(srv.calls[0]!.query.filter).toBe('targetResourceOrn eq "x"');
  });

  test("list without -f exits non-zero", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "grants", "list"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  // entitlementBundleId only exists on ENTITLEMENT-BUNDLE grants; live, every CUSTOM/ENTITLEMENT
  // grant's row printed "WARNING: field entitlementBundleId either never filled or
  // non-existant." with it in the default columns.
  test("default table columns drop entitlementBundleId (blank/warning for CUSTOM and ENTITLEMENT grants live)", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/grants`, body: { data: [grant] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "grants", "list", "-f", 'targetResourceOrn eq "x"'], t.ctx);
    expect(t.out.at(-1)).toBe("g1  ACTIVE  ENTITLEMENT-BUNDLE  ALLOW  orn:okta:directory:00o1:user:00u1  orn:okta:resource:x  \n");
    expect(GOV_GRANTS.defaultFields).not.toContain("entitlementBundleId");
  });

  test("get, add, replace (no delete: grants are not deletable)", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/grants/g1`, body: grant },
      { method: "POST", path: `${GOV_V1}/grants`, status: 201, body: grant },
      { method: "PUT", path: `${GOV_V1}/grants/g1`, body: grant },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "grants", "get", "g1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("g1");
    await runTest(["gov", "grants", "add", "-s", "grantType=ENTITLEMENT-BUNDLE", "-s", "entitlementBundleId=b1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ grantType: "ENTITLEMENT-BUNDLE", entitlementBundleId: "b1" });
    await runTest(["gov", "grants", "replace", "g1", "-s", "action=DENY"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(GOV_GRANTS.deletable).toBe(false);
  });

  test("patch injects the positional grantId when the body omits id", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/grants/g1`, body: grant }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "grants", "patch", "g1", "-s", "scheduleSettings.expirationDate=2027-01-01T00:00:00.000Z"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ id: "g1", scheduleSettings: { expirationDate: "2027-01-01T00:00:00.000Z" } });
  });

  test("patch keeps an explicit body id", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/grants/g1`, body: grant }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "grants", "patch", "g1", "-b", '{"id":"g1","scheduleSettings":{"expirationDate":"2027-01-01T00:00:00.000Z"}}'], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ id: "g1", scheduleSettings: { expirationDate: "2027-01-01T00:00:00.000Z" } });
  });
});

test("entitlements list pagination follows _links.next.href", async () => {
  srv = startServer([]);
  srv.add({
    method: "GET", path: `${GOV_V1}/entitlements`,
    handler: (_req, url) => {
      if (!url.searchParams.get("after")) {
        return Response.json({ data: [{ id: "e1", name: "A" }], _links: { next: { href: `${srv.url}${GOV_V1}/entitlements?after=x&filter=${encodeURIComponent('name eq "x"')}` } } });
      }
      return Response.json({ data: [{ id: "e2", name: "B" }] });
    },
  });
  const t = testCtx(srv.url);
  await runTest(["gov", "entitlements", "list", "-f", 'name eq "x"', "--output-fields", "id"], t.ctx);
  expect(t.out.at(-1)).toBe("e1  \ne2  \n");
});
