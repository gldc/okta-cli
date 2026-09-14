import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V1 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  expect(knownPath(`${GOV_V1}/risk-rule-assessments`)).toBe(true);
  expect(knownPath(`${GOV_V1}/risk-rules`)).toBe(true);
  expect(knownPath(`${GOV_V1}/risk-rules/r1`)).toBe(true);
  expect(knownPath(`${GOV_V1}/settings`)).toBe(true);
  expect(knownPath(`${GOV_V1}/settings/certification`)).toBe(true);
  expect(knownPath(`${GOV_V1}/settings/integrations`)).toBe(true);
  expect(knownPath(`${GOV_V1}/settings/integrations/i1`)).toBe(true);
});

describe("settings", () => {
  test("get: plain object, JSON default", async () => {
    const settings = { delegates: {}, governanceAI: {}, escalations: {}, integrations: { supported: [{ type: "SLACK" }] } };
    srv = startServer([{ method: "GET", path: `${GOV_V1}/settings`, body: settings }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "get"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(settings);
  });

  test("update: -s dotted assignment, PATCH", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/settings`, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "update", "-s", "escalations.accessRequests.endUserCanEscalate=true"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ escalations: { accessRequests: { endUserCanEscalate: "true" } } });
  });

  test("certification: plain object, JSON default", async () => {
    const cert = { integrations: { settings: [{ type: "SLACK", integrationId: "i1" }] } };
    srv = startServer([{ method: "GET", path: `${GOV_V1}/settings/certification`, body: cert }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "certification"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(cert);
  });

  test("certification-update: -s dotted assignment, PATCH", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V1}/settings/certification`, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "certification-update", "-s", "integrations.settings=[]"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
  });

  test("integrations: sends no query (declares none)", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/settings/integrations`, body: { data: [{ id: "i1", type: "SLACK", status: "CONNECTED" }] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "settings", "integrations"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({});
  });

  test("integration-add: --type builds {type}, 201", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/settings/integrations`, status: 201, body: { id: "i1", type: "SLACK", status: "IN_PROGRESS" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "integration-add", "--type", "SLACK"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "SLACK" });
  });

  test("integration-add: rejects a --type outside the choices", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "settings", "integration-add", "--type", "TEAMS"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("TEAMS");
  });

  test("integration-add: -b and --type together is rejected", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "settings", "integration-add", "-b", '{"type":"SLACK"}', "--type", "SLACK"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("Use either");
  });

  test("integration-delete: 204 -> string result", async () => {
    srv = startServer([{ method: "DELETE", path: `${GOV_V1}/settings/integrations/i1` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "settings", "integration-delete", "i1"], t.ctx);
    expect(t.out.at(-1)).toBe("integration i1 deleted\n");
  });
});

describe("risk-rules", () => {
  const rule = { id: "r1", name: "Segregate approve/pay", status: "ACTIVE", type: "SEPARATION_OF_DUTIES", description: "d" };

  test("list", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/risk-rules`, body: { data: [rule] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "risk-rules", "list"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V1}/risk-rules`);
  });

  test("get", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V1}/risk-rules/r1`, body: rule }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "get", "r1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("r1");
  });

  test("add passes body through", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/risk-rules`, status: 201, body: rule }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "add", "-s", "name=Segregate approve/pay", "-s", "type=SEPARATION_OF_DUTIES"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ name: "Segregate approve/pay", type: "SEPARATION_OF_DUTIES" });
  });

  test("replace: reinjects `id` (required by update-risk-rule-request) and drops read-only `status`", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/risk-rules/r1`, body: rule },
      { method: "PUT", path: `${GOV_V1}/risk-rules/r1`, body: { ...rule, name: "Renamed" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "replace", "r1", "-s", "name=Renamed"], t.ctx);
    const body = srv.calls.at(-1)!.body as any;
    expect(body.id).toBe("r1");
    expect(body.name).toBe("Renamed");
    expect(body.status).toBeUndefined();
  });

  test("delete", async () => {
    srv = startServer([
      { method: "GET", path: `${GOV_V1}/risk-rules/r1`, body: rule },
      { method: "DELETE", path: `${GOV_V1}/risk-rules/r1` },
    ]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "delete", "r1"], t.ctx);
    expect(t.out.at(-1)).toBe("risk rule r1 (Segregate approve/pay) deleted\n");
  });

  test("assess: single --resource sends resourceOrn", async () => {
    const conflict = { ruleId: "r1", ruleName: "Segregate approve/pay", type: "SEPARATION_OF_DUTIES", principalOrn: "orn:okta:directory:00o1:user:00u1", resourceOrn: "orn:okta:governance:00o1:collections:col1" };
    srv = startServer([{ method: "POST", path: `${GOV_V1}/risk-rule-assessments`, body: { data: [conflict] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "assess", "--principal", "orn:okta:directory:00o1:user:00u1", "--resource", "orn:okta:governance:00o1:collections:col1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ principalOrn: "orn:okta:directory:00o1:user:00u1", resourceOrn: "orn:okta:governance:00o1:collections:col1" });
  });

  test("assess: two or more --resource sends resourceOrnList", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V1}/risk-rule-assessments`, body: { data: [] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "risk-rules", "assess", "--principal", "orn:okta:directory:00o1:user:00u1", "--resource", "orn:a", "--resource", "orn:b"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ principalOrn: "orn:okta:directory:00o1:user:00u1", resourceOrnList: ["orn:a", "orn:b"] });
  });

  test("assess: without --principal or -b, rejected", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "risk-rules", "assess"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("Provide");
  });
});
