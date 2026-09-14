import { afterEach, expect, test } from "bun:test";
import { GOV_V1 } from "../src/commands/governance";
import { GOV_CAMPAIGNS } from "../src/commands/governance-campaigns";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/campaigns`)).toBe(true);
  expect(knownPath(`${GOV_V1}/campaigns/c1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/campaigns/c1/end`)).toBe(true);
  expect(knownPath(`${GOV_V1}/campaigns/c1/launch`)).toBe(true);
  expect(knownPath(`${GOV_V1}/campaigns/c1/reviews/reassign`)).toBe(true);
  expect(knownPath(`${GOV_V1}/reviews`)).toBe(true);
  expect(knownPath(`${GOV_V1}/reviews/r1`)).toBe(true);
});

const campaign = {
  id: "c1", status: "ACTIVE", name: "Q3 review", scheduleType: "ONE_OFF",
  startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-09-30T00:00:00.000Z", reviewerType: "MANAGER",
};

test("campaigns list: order-by, no limit query, no defaults", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/campaigns`, body: { data: [campaign] } }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "campaigns", "list", "--order-by", "created desc", "--limit", "3"], t.ctx)).toBe(0);
  expect(srv.calls[0]!.path).toBe(`${GOV_V1}/campaigns`);
  expect(srv.calls[0]!.query).toEqual({ orderBy: "created desc" });
  expect(t.out.at(-1)).toBe("c1  ACTIVE  Q3 review  ONE_OFF  2026-07-01T00:00:00.000Z  2026-09-30T00:00:00.000Z  MANAGER  \n");
});

test("campaigns get by id", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "get", "c1", "-j"], t.ctx);
  expect(JSON.parse(t.out.at(-1)!).id).toBe("c1");
});

test("campaigns get by name substring", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/Q3`, status: 404, body: { errorSummary: "nf" } },
    { method: "GET", path: `${GOV_V1}/campaigns`, body: { data: [campaign] } },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "get", "Q3", "-j"], t.ctx);
  expect(JSON.parse(t.out.at(-1)!).id).toBe("c1");
});

test("campaigns add passes body through", async () => {
  srv = startServer([{ method: "POST", path: `${GOV_V1}/campaigns`, status: 201, body: campaign }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "add", "-s", "name=Q3 review"], t.ctx);
  expect(srv.calls[0]!.body).toEqual({ name: "Q3 review" });
});

test("campaigns has no replace command (no PUT/PATCH on /campaigns/{id})", () => {
  expect(GOV_CAMPAIGNS.replaceable).toBe(false);
});

test("campaigns delete", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "DELETE", path: `${GOV_V1}/campaigns/c1` },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "delete", "c1"], t.ctx);
  expect(t.out.at(-1)).toBe("campaign c1 (Q3 review) deleted\n");
});

test("campaigns launch: 202 empty body, string result", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "POST", path: `${GOV_V1}/campaigns/c1/launch`, status: 202 },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "launch", "c1"], t.ctx);
  expect(t.out.at(-1)).toBe("campaign c1 (Q3 review) launched\n");
  expect(srv.calls.at(-1)!.body).toBeUndefined();
});

test("campaigns end --skip-remediation sends the body; plain end sends none", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "POST", path: `${GOV_V1}/campaigns/c1/end`, status: 202 },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "end", "c1", "--skip-remediation"], t.ctx);
  expect(srv.calls.at(-1)!.body).toEqual({ skipRemediation: true });
  expect(t.out.at(-1)).toBe("campaign c1 (Q3 review) ended\n");

  srv.stop();
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "POST", path: `${GOV_V1}/campaigns/c1/end`, status: 202 },
  ]);
  const t2 = testCtx(srv.url);
  await runTest(["gov", "campaigns", "end", "c1"], t2.ctx);
  expect(srv.calls.at(-1)!.body).toBeUndefined();
});

const review = {
  id: "r1", campaignId: "c1", resourceId: "res1", decision: "APPROVED", decided: "2026-08-01T00:00:00.000Z",
  remediationStatus: "NOT_STARTED", reviewerType: "USER", principalProfile: { email: "alice@example.com" }, reviewerProfile: { email: "bob@example.com" },
};

test("campaigns reviews-reassign: body shape from flags, repeatable --review", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "POST", path: `${GOV_V1}/campaigns/c1/reviews/reassign`, body: { data: [review] } },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "reviews-reassign", "c1", "--reviewer", "00u1", "--review", "r1", "--review", "r2", "--note", "OOO", "--reviewer-level", "FIRST"], t.ctx);
  expect(srv.calls.at(-1)!.body).toEqual({ reviewerId: "00u1", reviewIds: ["r1", "r2"], note: "OOO", reviewerLevel: "FIRST" });
});

test("campaigns reviews-reassign: -b and flags together is rejected", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "campaigns", "reviews-reassign", "c1", "-b", "{}", "--reviewer", "00u1"], t.ctx)).not.toBe(0);
  expect(t.err.join("")).toContain("Use either -b or");
});

test("campaigns reviews-reassign: -b passes through verbatim", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "POST", path: `${GOV_V1}/campaigns/c1/reviews/reassign`, body: { data: [review] } },
  ]);
  const t = testCtx(srv.url);
  const body = { reviewerId: "00u1", reviewIds: ["r1"], note: "OOO" };
  await runTest(["gov", "campaigns", "reviews-reassign", "c1", "-b", JSON.stringify(body)], t.ctx);
  expect(srv.calls.at(-1)!.body).toEqual(body);
});

test("campaigns reviews <campaign>: composes campaignId filter with the user filter", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "GET", path: `${GOV_V1}/reviews`, body: { data: [review] } },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "reviews", "c1", "-f", 'decision eq "APPROVED"'], t.ctx);
  expect(srv.calls.at(-1)!.query).toEqual({ filter: '(decision eq "APPROVED") AND campaignId eq "c1"' });
});

test("campaigns reviews <campaign>: no user filter still prefills campaignId", async () => {
  srv = startServer([
    { method: "GET", path: `${GOV_V1}/campaigns/c1`, body: campaign },
    { method: "GET", path: `${GOV_V1}/reviews`, body: { data: [review] } },
  ]);
  const t = testCtx(srv.url);
  await runTest(["gov", "campaigns", "reviews", "c1"], t.ctx);
  expect(srv.calls.at(-1)!.query).toEqual({ filter: 'campaignId eq "c1"' });
});

test("standalone reviews list", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/reviews`, body: { data: [review] } }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "reviews", "list", "--limit", "5"], t.ctx)).toBe(0);
  expect(srv.calls[0]!.query).toEqual({});
  expect(t.out.at(-1)).toBe("r1  c1  res1  APPROVED  2026-08-01T00:00:00.000Z  NOT_STARTED  USER  alice@example.com  bob@example.com  \n");
});

test("standalone reviews get", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V1}/reviews/r1`, body: review }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "reviews", "get", "r1", "-j"], t.ctx);
  expect(JSON.parse(t.out.at(-1)!).id).toBe("r1");
});
