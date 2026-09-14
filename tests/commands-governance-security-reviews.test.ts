import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V2 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const RID = "sar1";
const AID = "acc1";
const TID = "tgt1";

test("spec paths", () => {
  expect(knownPath(`${GOV_V2}/security-access-reviews`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/stats`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/accesses`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/accesses/${AID}/sub-accesses`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/actions`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/anomalies`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/summary`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/actions`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/comment`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/history`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/principal`)).toBe(true);
  expect(knownPath(`${GOV_V2}/security-access-reviews/${RID}/summary`)).toBe(true);
});

const review = { id: RID, status: "ACTIVE", name: "Q3 review", endTime: "2026-09-30T00:00:00.000Z", created: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z" };

describe("security-access-reviews", () => {
  test("list", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews`, body: { data: [review] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "list", "-f", 'status eq "ACTIVE"', "--order-by", "created desc", "--limit", "5"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ filter: 'status eq "ACTIVE"', orderBy: "created desc" });
  });

  test("add: -b/-s, 202 async", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews`, status: 202, body: review }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "add", "-s", "principalId=00u1", "-s", "name=Q3 review"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ principalId: "00u1", name: "Q3 review" });
  });

  test("stats: plain object, table fields", async () => {
    const stats = { activeCount: 1, pendingCount: 2, errorCount: 0, closedCount: 3 };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/stats`, body: stats }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "stats", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(stats);
  });

  test("get", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}`, body: review }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "get", RID, "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe(RID);
  });

  test("update: -s dotted assignment, PATCH", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V2}/security-access-reviews/${RID}`, body: review }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "update", RID, "-s", "endTime=2026-10-15T00:00:00.000Z"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ endTime: "2026-10-15T00:00:00.000Z" });
  });

  test("accesses", async () => {
    const item = { id: AID, type: "APPLICATION", name: "Salesforce", resourceId: "0oa1", severity: "HIGH", remediationStatus: "NONE" };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/accesses`, body: { data: [item] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "accesses", RID, "--order-by", "severity desc"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ orderBy: "severity desc" });
  });

  test("sub-accesses", async () => {
    const item = { id: "sub1", type: "ENTITLEMENT_VALUE", name: "Admin", resourceId: "0oa1", severity: "LOW", remediationStatus: "NONE" };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/accesses/${AID}/sub-accesses`, body: { data: [item] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "sub-accesses", RID, AID], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/security-access-reviews/${RID}/accesses/${AID}/sub-accesses`);
  });

  test("access-action: body key is `type`, 202 no body", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/actions`, status: 202 }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "access-action", RID, TID, "--type", "REVOKE_ACCESS"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "REVOKE_ACCESS" });
  });

  test("access-action: rejects a value outside the choices", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "security-access-reviews", "access-action", RID, TID, "--type", "BOGUS"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("BOGUS");
  });

  test("anomalies", async () => {
    const anomaly = { type: "SOD_CONFLICT", severity: "HIGH", subtext: { message: "conflicts with X" } };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/anomalies`, body: { data: [anomaly] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "anomalies", RID, TID], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/anomalies`);
  });

  test("access-summary: POST, ai-message response", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews/${RID}/accesses/${TID}/summary`, body: { message: "looks fine" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "access-summary", RID, TID, "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).message).toBe("looks fine");
  });

  test("summary: POST, ai-message response", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews/${RID}/summary`, body: { message: "review-level summary" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "summary", RID, "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).message).toBe("review-level summary");
  });

  test("actions: GET, plural, lists possible actions", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/actions`, body: { data: [{ actionType: "CLOSE_REVIEW" }] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "actions", RID], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("GET");
  });

  test("action: POST, singular, body key is `actionType` (not `type`)", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews/${RID}/actions`, status: 202 }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "action", RID, "--type", "CLOSE_REVIEW"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ actionType: "CLOSE_REVIEW" });
  });

  test("comment: POST, 204 -> string result", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/security-access-reviews/${RID}/comment` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "comment", RID, "--comment", "looks good"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ comment: "looks good" });
    expect(t.out.at(-1)).toBe(`comment added to review ${RID}\n`);
  });

  test("history: sends no filter/orderBy (declares only after/limit)", async () => {
    const item = { id: "h1", timestamp: "2026-01-01T00:00:00.000Z", systemGenerated: true, message: "review created", principalProfile: { email: "a@x.com" } };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/history`, body: { data: [item] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "security-access-reviews", "history", RID, "--limit", "5"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({});
  });

  test("principal: plain object", async () => {
    const principal = { id: "00u1", email: "a@x.com", login: "a@x.com", status: "ACTIVE", type: "OKTA_USER", department: "Eng", manager: "b@x.com", role: "IC" };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/security-access-reviews/${RID}/principal`, body: principal }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "security-access-reviews", "principal", RID, "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(principal);
  });
});
