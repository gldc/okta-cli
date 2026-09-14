import { afterEach, describe, expect, test } from "bun:test";
import { GOV_V2 } from "../src/commands/governance";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const RID = "0oa1b2c3d4e5f6g7h8i9";
const ORN = "orn:okta:idp:00ofsdghasfhas54wewe:apps:salesforce:0oafxqCAJWWGELFTYASJ";
const ENCODED_ORN = encodeURIComponent(ORN);

test("spec paths", () => {
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-conditions`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-conditions/c1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-conditions/c1/activate`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-conditions/c1/deactivate`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-sequences`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-sequences/s1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/request-sequences/s1`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${RID}/request-settings`)).toBe(true);
  expect(knownPath(`${GOV_V2}/request-settings`)).toBe(true);
  expect(knownPath(`${GOV_V2}/resources/${ENCODED_ORN}/entitlement-settings`)).toBe(true);
  expect(knownPath(`${GOV_V2}/revoke-principal-access`)).toBe(true);
});

describe("request-conditions", () => {
  const condition = { id: "c1", status: "INACTIVE", priority: 1, name: "Sales access", description: "d", approvalSequenceId: "seq1" };

  test("list <resourceId>: no --filter option (spec declares none on listResourceRequestConditionsV2)", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${RID}/request-conditions`, body: { data: [condition] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "request-conditions", "list", RID, "-f", "x"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("unknown option");
    expect(await runTest(["gov", "request-conditions", "list", RID], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/resources/${RID}/request-conditions`);
  });

  test("get <resourceId> <conditionId>", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${RID}/request-conditions/c1`, body: condition }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "get", RID, "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("c1");
  });

  test("add <resourceId> -b/-s: POST, 201", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/resources/${RID}/request-conditions`, status: 201, body: condition }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "add", RID, "-s", "name=Sales access", "-s", "approvalSequenceId=seq1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "Sales access", approvalSequenceId: "seq1" });
  });

  test("update <resourceId> <conditionId>: plain object body, no op triple", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V2}/resources/${RID}/request-conditions/c1`, body: condition }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "update", RID, "c1", "-s", "priority=2"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ priority: "2" });
  });

  test("delete <resourceId> <conditionId>: 204 -> string result", async () => {
    srv = startServer([{ method: "DELETE", path: `${GOV_V2}/resources/${RID}/request-conditions/c1` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "delete", RID, "c1"], t.ctx);
    expect(t.out.at(-1)).toBe("request condition c1 deleted\n");
  });

  test("activate <resourceId> <conditionId>", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/resources/${RID}/request-conditions/c1/activate`, body: { ...condition, status: "ACTIVE" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "activate", RID, "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("ACTIVE");
  });

  test("deactivate <resourceId> <conditionId>", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/resources/${RID}/request-conditions/c1/deactivate`, body: { ...condition, status: "INACTIVE" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-conditions", "deactivate", RID, "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("INACTIVE");
  });
});

describe("request-sequences", () => {
  const sequence = { id: "s1", name: "Manager then security", description: "d", compatibleResourceTypes: ["APP"] };

  test("list <resourceId>: default columns drop the multi-paragraph description (id, name, compatibleResourceTypes only - it wrecks table layout)", async () => {
    const multiParagraph = { ...sequence, description: "Para one.\n\nPara two, much longer, goes on for a while." };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${RID}/request-sequences`, body: { data: [multiParagraph] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["gov", "request-sequences", "list", RID], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/resources/${RID}/request-sequences`);
    expect(t.out.at(-1)).toBe('s1  Manager then security  ["APP"]  \n');
  });

  test("get <resourceId> <sequenceId>", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${RID}/request-sequences/s1`, body: sequence }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-sequences", "get", RID, "s1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("s1");
  });

  test("delete <sequenceId>: asymmetric, not resource-scoped", async () => {
    srv = startServer([{ method: "DELETE", path: `${GOV_V2}/request-sequences/s1` }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-sequences", "delete", "s1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/request-sequences/s1`);
    expect(t.out.at(-1)).toBe("request sequence s1 deleted\n");
  });
});

describe("request-settings", () => {
  test("get <resourceId>: plain object, JSON default", async () => {
    const settings = { validAccessScopeSettings: {}, validRequesterSettings: {}, validAccessDurationSettings: {} };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${RID}/request-settings`, body: settings }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-settings", "get", RID], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(settings);
  });

  test("update <resourceId>: -s dotted assignment, PATCH", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V2}/resources/${RID}/request-settings`, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-settings", "update", RID, "-s", "riskSettings.defaultSetting.type=ALLOWED_WITH_NO_OVERRIDES"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ riskSettings: { defaultSetting: { type: "ALLOWED_WITH_NO_OVERRIDES" } } });
  });

  test("org-get: plain object, JSON default", async () => {
    const settings = { subprocessorsAcknowledged: true, provisioningStatus: "PROVISIONED", requestExperiences: ["OKTA_ADMIN_CONSOLE"], longTimePastProvisioned: false };
    srv = startServer([{ method: "GET", path: `${GOV_V2}/request-settings`, body: settings }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-settings", "org-get"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(settings);
  });

  test("org-update: -s dotted assignment, PATCH", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V2}/request-settings`, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "request-settings", "org-update", "-s", "subprocessorsAcknowledged=true"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ subprocessorsAcknowledged: "true" });
  });
});

describe("entitlement-settings", () => {
  test("get <resourceOrn>: encodeURIComponent's the ORN", async () => {
    srv = startServer([{ method: "GET", path: `${GOV_V2}/resources/${ENCODED_ORN}/entitlement-settings`, body: { status: "OPTED_IN" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlement-settings", "get", ORN, "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe(`${GOV_V2}/resources/${ENCODED_ORN}/entitlement-settings`);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ status: "OPTED_IN" });
  });

  test("set <resourceOrn> --status: PATCH body {status}, 202", async () => {
    srv = startServer([{ method: "PATCH", path: `${GOV_V2}/resources/${ENCODED_ORN}/entitlement-settings`, status: 202, body: { status: "OPTING_OUT" } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "entitlement-settings", "set", ORN, "--status", "OPTED_OUT"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ status: "OPTED_OUT" });
  });

  test("set <resourceOrn> --status: rejects a value outside the choices", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "entitlement-settings", "set", ORN, "--status", "BOGUS"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("BOGUS");
  });
});

describe("revoke-principal-access", () => {
  const principalOrn = "orn:okta:directory:00o1a2b3c4d5e6f7g8h9:user:00u1a2b3c4d5e6f7g8h1";

  test("--principal and repeated --revoke build the body", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/revoke-principal-access`, body: { data: [{ _links: {} }] } }]);
    const t = testCtx(srv.url);
    await runTest(["gov", "revoke-principal-access", "--principal", principalOrn, "--revoke", ORN, "--revoke", "orn:okta:governance:00o1:collections:col1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ principalOrn, revokeOrns: [ORN, "orn:okta:governance:00o1:collections:col1"] });
  });

  test("-b passes the body through verbatim", async () => {
    srv = startServer([{ method: "POST", path: `${GOV_V2}/revoke-principal-access`, body: { data: [] } }]);
    const t = testCtx(srv.url);
    const body = { principalOrn, revokeOrns: [ORN] };
    await runTest(["gov", "revoke-principal-access", "-b", JSON.stringify(body)], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual(body);
  });

  test("without -b, requires --principal and --revoke", async () => {
    const t = testCtx("http://unused");
    expect(await runTest(["gov", "revoke-principal-access"], t.ctx)).not.toBe(0);
    expect(t.err.join("")).toContain("Provide");
  });
});
