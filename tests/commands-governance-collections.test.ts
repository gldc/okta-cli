import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V1 } from "../src/commands/governance";
import { GOV_COLLECTIONS } from "../src/commands/governance-collections";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/collections`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/assignments`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1/assignments`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1/assignments/a1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1/catalog/users`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1/resources`)).toBe(true);
  expect(knownPath(`${GOV_V1}/collections/c1/resources/r1`)).toBe(true);
});

describe("collections", () => {
  const collection = { id: "c1", name: "Sales apps", description: "d", orn: "orn:okta:governance:00o1:collections:c1" };

  test("list/get/add/replace/delete", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections`, body: { data: [collection] } },
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "POST", path: `${GOV_V1}/collections`, status: 201, body: collection },
      { method: "PUT", path: `${GOV_V1}/collections/c1`, body: { ...collection, name: "Renamed" } },
      { method: "DELETE", path: `${GOV_V1}/collections/c1` },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "collections", "list"], t.ctx)).toBe(0);
    await runTest(["gov", "collections", "get", "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("c1");
    await runTest(["gov", "collections", "add", "-s", "name=Sales apps"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "Sales apps" });
    await runTest(["gov", "collections", "replace", "c1", "-s", "name=Renamed"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    await runTest(["gov", "collections", "delete", "c1"], t.ctx);
    expect(t.out.at(-1)).toBe("collection c1 (Sales apps) deleted\n");
  });

  test("list supports --include counts", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/collections`, body: { data: [collection] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "list", "--include", "counts"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ include: "counts" });
  });

  test("assignments-all: no collection argument, org-wide path", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/collections/assignments`, body: { data: [] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "collections", "assignments-all", "-f", 'principal sw "j"'], t.ctx)).toBe(0);
    expect(srv.calls[0]!.query).toEqual({ filter: 'principal sw "j"' });
  });

  test("assignments <collection>: resolves collection then lists its assignments", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "GET", path: `${GOV_V1}/collections/c1/assignments`, body: { data: [] } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "collections", "assignments", "c1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V1}/collections/c1/assignments`);
  });

  test("assignment-add: -s wraps a single object in an array", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "POST", path: `${GOV_V1}/collections/c1/assignments`, status: 201, body: [{ id: "a1", principal: { externalId: "u1" } }] },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "assignment-add", "c1", "-s", "principal.externalId=u1", "-s", "principal.type=OKTA_USER"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual([{ principal: { externalId: "u1", type: "OKTA_USER" } }]);
  });

  test("assignment-add: -b passes an array through verbatim", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "POST", path: `${GOV_V1}/collections/c1/assignments`, status: 201, body: [] },
    ]);
    const t = testCtx(srv.url);
    const body = [{ principal: { externalId: "u1", type: "OKTA_USER" } }, { principal: { externalId: "u2", type: "OKTA_USER" } }];
    await runTest(["gov", "collections", "assignment-add", "c1", "-b", JSON.stringify(body)], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual(body);
  });

  test("assignment-add: -b with a non-array body is rejected", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/collections/c1`, body: collection }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "collections", "assignment-add", "c1", "-b", "{}"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("must be a JSON array");
  });

  test("assignment-update: --op/--path/--value triple builds a single-element array (no refType)", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "PATCH", path: `${GOV_V1}/collections/c1/assignments/a1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "assignment-update", "c1", "a1", "--op", "REPLACE", "--path", "/timeZone", "--value", "UTC"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual([{ op: "REPLACE", path: "/timeZone", value: "UTC" }]);
    expect(t.out.at(-1)).toBe("assignment a1 updated\n");
  });

  test("assignment-delete", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "DELETE", path: `${GOV_V1}/collections/c1/assignments/a1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "assignment-delete", "c1", "a1"], t.ctx);
    expect(t.out.at(-1)).toBe("assignment a1 deleted\n");
  });

  test("catalog-users: filter only, no --limit option, uses getAll", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "GET", path: `${GOV_V1}/collections/c1/catalog/users`, body: { data: [{ id: "u1", email: "a@x.com" }] } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "collections", "catalog-users", "c1", "-f", 'email sw "a"'], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ filter: 'email sw "a"' });
    expect(await runTest(["gov", "collections", "catalog-users", "c1", "--limit", "1"], t.ctx)).not.toBe(0);
  });

  test("resources: --include repeatable, sent as two repeated params (not comma-joined - Okta 400s on that live)", async () => {
    let includeValues: string[] = [];
    srv = startServer([{ method: "GET", path: `${GOV_V1}/collections/c1`, body: collection }]);
    srv.add({ method: "GET", path: `${GOV_V1}/collections/c1/resources`, handler: (_req, url) => { includeValues = url.searchParams.getAll("include"); return Response.json({ data: [] }); } });
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "resources", "c1", "--include", "entitlements", "--include", "entitlementValueCount"], t.ctx);
    expect(includeValues).toEqual(["entitlements", "entitlementValueCount"]);
  });

  test("resource-add: -s wraps a single object in an array, response unwrapped from envelope", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "POST", path: `${GOV_V1}/collections/c1/resources`, body: { data: [{ resourceId: "r1", resourceOrn: "orn:okta:idp:x:apps:sf:app1" }] } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "resource-add", "c1", "-s", "resourceOrn=orn:okta:idp:x:apps:sf:app1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual([{ resourceOrn: "orn:okta:idp:x:apps:sf:app1" }]);
    expect(JSON.parse(t.out.at(-1)!)).toEqual([{ resourceId: "r1", resourceOrn: "orn:okta:idp:x:apps:sf:app1" }]);
  });

  test("resource / resource-replace / resource-delete", async () => {
    const resource = { resourceId: "r1", resourceOrn: "orn:okta:idp:x:apps:sf:app1", resourceProfile: { name: "Salesforce" } };
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/collections/c1`, body: collection },
      { method: "GET", path: `${GOV_V1}/collections/c1/resources/r1`, body: resource },
      { method: "PUT", path: `${GOV_V1}/collections/c1/resources/r1`, body: resource },
      { method: "DELETE", path: `${GOV_V1}/collections/c1/resources/r1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "collections", "resource", "c1", "r1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).resourceId).toBe("r1");
    await runTest(["gov", "collections", "resource-replace", "c1", "r1", "-s", "entitlements=[]"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    const putBody = srv.calls.at(-1)!.body as any;
    expect(putBody.resourceId).toBeUndefined();
    expect(putBody.resourceOrn).toBeUndefined();
    await runTest(["gov", "collections", "resource-delete", "c1", "r1"], t.ctx);
    expect(t.out.at(-1)).toContain("removed");
  });
});

test("GOV_COLLECTIONS is a governance-basePath spec", () => {
  expect(GOV_COLLECTIONS.basePath).toBe(GOV_V1);
});
