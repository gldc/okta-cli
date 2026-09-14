import { afterEach, expect, test } from "bun:test";
import { GOV_V2 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V2}/tasks`)).toBe(true);
  expect(knownPath(`${GOV_V2}/tasks/t1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/tasks/t1/resolve`)).toBe(true);
});

const task = {
  id: "t1",
  status: "OPEN",
  type: "APPROVAL",
  label: "Approve access to Salesforce",
  requestId: "r1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  assignees: [{ externalId: "00u1", type: "OKTA_USER" }],
};

test("tasks list", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V2}/tasks`, body: { data: [task] } }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "tasks", "list", "-f", 'status eq "OPEN"', "--order-by", "createdAt asc", "--limit", "5"], t.ctx)).toBe(0);
  expect(srv.calls.at(-1)!.query).toEqual({ filter: 'status eq "OPEN"', orderBy: "createdAt asc" });
});

test("tasks get", async () => {
  srv = startServer([{ method: "GET", path: `${GOV_V2}/tasks/t1`, body: { ...task, isEscalated: false, isDelegated: false } }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "tasks", "get", "t1", "-j"], t.ctx);
  expect(JSON.parse(t.out.at(-1)!).id).toBe("t1");
});

test("tasks update: -b required body (assignees is an array of objects, -s alone can't build it)", async () => {
  srv = startServer([{ method: "PATCH", path: `${GOV_V2}/tasks/t1`, body: task }]);
  const t = testCtx(srv.url);
  const body = { assignees: [{ externalId: "00u2", type: "OKTA_USER" }] };
  await runTest(["gov", "tasks", "update", "t1", "-b", JSON.stringify(body)], t.ctx);
  expect(srv.calls.at(-1)!.body).toEqual(body);
});

test("tasks update: without -b, rejected", async () => {
  const t = testCtx("http://unused");
  expect(await runTest(["gov", "tasks", "update", "t1", "-s", "assignees=00u2"], t.ctx)).not.toBe(0);
  expect(t.err.join("")).toContain("-b");
});

test("tasks resolve", async () => {
  srv = startServer([{ method: "POST", path: `${GOV_V2}/tasks/t1/resolve`, body: task }]);
  const t = testCtx(srv.url);
  await runTest(["gov", "tasks", "resolve", "t1", "--value", "approved"], t.ctx);
  expect(srv.calls.at(-1)!.body).toEqual({ value: "approved" });
});
