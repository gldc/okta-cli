import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V1, GOV_V2 } from "../src/commands/governance";
import { GOV_REQUEST_TYPES } from "../src/commands/governance-requests";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/request-types`)).toBe(true);
  expect(knownPath(`${GOV_V1}/request-types/rt1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/request-types/rt1/publish`)).toBe(true);
  expect(knownPath(`${GOV_V1}/request-types/rt1/un-publish`)).toBe(true);
  expect(knownPath(`${GOV_V1}/requests`)).toBe(true);
  expect(knownPath(`${GOV_V1}/requests/r1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/requests/r1/messages`)).toBe(true);
  expect(knownPath(`${GOV_V2}/requests`)).toBe(true);
  expect(knownPath(`${GOV_V2}/requests/r1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/requests/r1/messages`)).toBe(true);
  expect(knownPath(`${GOV_V2}/catalogs/default/entries`)).toBe(true);
  expect(knownPath(`${GOV_V2}/catalogs/default/entries/e1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/catalogs/default/entries/e1/users/u1/request-fields`)).toBe(true);
  expect(knownPath(`${GOV_V2}/catalogs/default/user/u1/entries`)).toBe(true);
});

describe("request-types", () => {
  const requestType = { id: "rt1", status: "DRAFT", name: "Salesforce access", description: "d", lastUpdated: "2026-09-01T00:00:00.000Z" };

  test("list: order-by, no limit query", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/request-types`, body: { data: [requestType] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "request-types", "list", "--order-by", "name asc", "--limit", "3"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V1}/request-types`);
    expect(srv.calls[0]!.query).toEqual({ orderBy: "name asc" });
  });

  test("get by id, add, delete; no replace command", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/request-types/rt1`, body: requestType },
      { method: "POST", path: `${GOV_V1}/request-types`, status: 201, body: requestType },
      { method: "DELETE", path: `${GOV_V1}/request-types/rt1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-types", "get", "rt1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("rt1");
    await runTest(["gov", "request-types", "add", "-s", "name=Salesforce access", "-s", "ownerId=00u1", "-s", "resourceSettings.type=GROUPS", "-s", "approvalSettings.type=EVERYONE"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    await runTest(["gov", "request-types", "delete", "rt1"], t.ctx);
    expect(t.out.at(-1)).toBe("request type rt1 (Salesforce access) deleted\n");
    expect(GOV_REQUEST_TYPES.replaceable).toBe(false);
  });

  test("publish hits /publish", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/request-types/rt1`, body: requestType },
      { method: "POST", path: `${GOV_V1}/request-types/rt1/publish`, body: { ...requestType, status: "PUBLISHED" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-types", "publish", "rt1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("PUBLISHED");
  });

  test("unpublish hits /un-publish (hyphenated path, not the command name)", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/request-types/rt1`, body: requestType },
      { method: "POST", path: `${GOV_V1}/request-types/rt1/un-publish`, body: requestType },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-types", "unpublish", "rt1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V1}/request-types/rt1/un-publish`);
  });
});

describe("requests (v2)", () => {
  const request = {
    id: "req1", status: "SUBMITTED", grantStatus: "PENDING", revocationStatus: null, created: "2026-09-01T00:00:00.000Z",
    resolved: null, requestedFor: { externalId: "00u1", type: "OKTA_USER" }, requested: { entryId: "cen1" },
  };

  test("list hits the v2 basePath, sends filter/orderBy, drops limit", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/requests`, body: { data: [request] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "requests", "list", "-f", 'status eq "SUBMITTED"', "--order-by", "created desc", "--limit", "5"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V2}/requests`);
    expect(srv.calls[0]!.query).toEqual({ filter: 'status eq "SUBMITTED"', orderBy: "created desc" });
  });

  test("get", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/requests/req1`, body: request }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "requests", "get", "req1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("req1");
  });

  test("add: 202 with a body is accepted", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/requests`, status: 202, body: request }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "requests", "add", "-s", "requested.entryId=cen1", "-s", "requestedFor.externalId=00u1", "-s", "requestedFor.type=OKTA_USER"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.body).toEqual({ requested: { entryId: "cen1" }, requestedFor: { externalId: "00u1", type: "OKTA_USER" } });
  });

  test("message: --message builds {message}", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/requests/req1/messages`, status: 201 }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "requests", "message", "req1", "--message", "please approve"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ message: "please approve" });
    expect(t.out.at(-1)).toBe("message posted to request req1\n");
  });

  test("message: -b and --message together are rejected", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "requests", "message", "req1", "--message", "x", "-b", "{}"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
});

describe("requests-v1", () => {
  const request = {
    id: "req1", requestStatus: "OPEN", type: "ACCESS_REQUEST", subject: "Can I have Salesforce?",
    requestTypeId: "rt1", created: "2026-09-01T00:00:00.000Z", resolved: null,
  };

  test("list hits the v1 basePath", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/requests`, body: { data: [request] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "requests-v1", "list"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V1}/requests`);
  });

  test("get", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/requests/req1`, body: request }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "requests-v1", "get", "req1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("req1");
  });

  test("add: 201", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/requests`, status: 201, body: request }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "requests-v1", "add", "-s", "requestTypeId=rt1", "-s", "subject=Can I have Salesforce?"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ requestTypeId: "rt1", subject: "Can I have Salesforce?" });
  });

  test("message posts to the v1 messages path", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/requests/req1/messages`, status: 201 }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "requests-v1", "message", "req1", "--message", "hi"], t.ctx);
    expect(srv.calls[0]!.path).toBe(`${GOV_V1}/requests/req1/messages`);
    expect(t.out.at(-1)).toBe("message posted to request req1\n");
  });
});

describe("catalog", () => {
  const entry = { id: "cen1", name: "Salesforce", label: "Application", parent: undefined, description: "d" };

  test("entries requires -f", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "catalog", "entries"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("entries sends filter and --match", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/catalogs/default/entries`, body: { data: [entry] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "catalog", "entries", "-f", "not(parent pr)", "--match", "sales"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.query).toEqual({ filter: "not(parent pr)", match: "sales" });
  });

  test("entry", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/catalogs/default/entries/cen1`, body: entry }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "catalog", "entry", "cen1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("cen1");
  });

  test("user-entries requires -f and hits the per-user path", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/catalogs/default/user/u1/entries`, body: { data: [entry] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "catalog", "user-entries", "u1"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
    expect(await runTest(["gov", "catalog", "user-entries", "u1", "-f", "not(parent pr)"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V2}/catalogs/default/user/u1/entries`);
    expect(srv.calls[0]!.query).toEqual({ filter: "not(parent pr)" });
  });

  test("request-fields lists data for an entry/user pair", async () => {
    const field = { id: "f1", label: "Justification", type: "TEXT", required: true, readOnly: false, value: undefined };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/catalogs/default/entries/cen1/users/u1/request-fields`, body: { data: [field], metadata: {} } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "catalog", "request-fields", "cen1", "u1"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe(`${GOV_V2}/catalogs/default/entries/cen1/users/u1/request-fields`);
  });
});
