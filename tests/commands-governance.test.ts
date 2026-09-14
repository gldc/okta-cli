import { afterEach, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath("/governance/api/v1/operations/x")).toBe(true);
  expect(knownPath("/governance/api/v1/delegates")).toBe(true);
  expect(knownPath("/governance/api/v1/teams")).toBe(true);
});

test("governance group is registered under both `governance` and its `gov` alias", () => {
  const t = testCtx("http://unused");
  const program = buildProgram(t.ctx);
  const gov = program.commands.find((c) => c.name() === "governance");
  expect(gov).toBeDefined();
  expect(gov!.aliases()).toContain("gov");
});

test("operations get", async () => {
  const op = { id: "op1", type: "CAMPAIGN_LAUNCH", status: "COMPLETED", created: "2026-01-01T00:00:00.000Z", completed: "2026-01-01T00:00:05.000Z", timeElapsedInSeconds: 5 };
  srv = startServer([{ method: "GET", path: "/governance/api/v1/operations/op1", body: op }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "operations", "get", "op1"], t.ctx)).toBe(0);
  expect(t.out.at(-1)).toBe("op1  CAMPAIGN_LAUNCH  COMPLETED  2026-01-01T00:00:00.000Z  2026-01-01T00:00:05.000Z  5  \n");
});

test("delegates list: uses the governance basePath, listKey data, and dotted display fields", async () => {
  const delegate = {
    id: "d1",
    delegate: { externalId: "00u1", type: "OKTA_USER" },
    delegator: { externalId: "00u2", type: "OKTA_USER" },
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-02-01T00:00:00.000Z",
    note: "vacation coverage",
  };
  srv = startServer([{ method: "GET", path: "/governance/api/v1/delegates", body: { data: [delegate] } }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "delegates", "list"], t.ctx)).toBe(0);
  expect(srv.calls[0]!.path).toBe("/governance/api/v1/delegates");
  expect(t.out.at(-1)).toBe("d1  00u1  00u2  2026-01-01T00:00:00.000Z  2026-02-01T00:00:00.000Z  vacation coverage  \n");
});

test("teams list: uses the governance basePath and listKey data", async () => {
  const team = { id: "t1", name: "Salesforce admins", created: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-02T00:00:00.000Z" };
  srv = startServer([{ method: "GET", path: "/governance/api/v1/teams", body: { data: [team] } }]);
  const t = testCtx(srv.url);
  expect(await runTest(["gov", "teams", "list"], t.ctx)).toBe(0);
  expect(srv.calls[0]!.path).toBe("/governance/api/v1/teams");
  expect(t.out.at(-1)).toBe("t1  Salesforce admins  2026-01-01T00:00:00.000Z  2026-01-02T00:00:00.000Z  \n");
});
