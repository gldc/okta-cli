import { afterEach, describe, expect, test } from "bun:test";
import { GROUP_RULES, groupRuleBody } from "../src/commands/group-rules";
import { USER_TYPES } from "../src/commands/user-types";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };
const rule = { id: "0pr1", status: "ACTIVE", type: "group_rule", name: "eng-rule" };
const userType = { id: "typ1", name: "custom", displayName: "Custom", default: false, description: "d" };

test("spec paths", () => {
  for (const s of [GROUP_RULES, USER_TYPES]) {
    expect(knownPath(s.path), s.path).toBe(true);
    expect(knownPath(`${s.path}/x`), s.path).toBe(true);
    if (s.lifecycle) {
      expect(knownPath(`${s.path}/x/lifecycle/activate`), s.path).toBe(true);
      expect(knownPath(`${s.path}/x/lifecycle/deactivate`), s.path).toBe(true);
    }
  }
});

test("groupRuleBody with and without excluded users", () => {
  expect(groupRuleBody({ name: "eng-rule", expression: 'String.startsWith(user.email, "eng-")', group: ["00g1"] })).toEqual({
    type: "group_rule", name: "eng-rule",
    conditions: { expression: { type: "urn:okta:expression:1.0", value: 'String.startsWith(user.email, "eng-")' } },
    actions: { assignUserToGroups: { groupIds: ["00g1"] } },
  });
  expect(groupRuleBody({ name: "eng-rule", expression: "true", group: ["00g1", "00g2"], excludeUser: ["00u1"] })).toEqual({
    type: "group_rule", name: "eng-rule",
    conditions: { expression: { type: "urn:okta:expression:1.0", value: "true" }, people: { users: { exclude: ["00u1"] } } },
    actions: { assignUserToGroups: { groupIds: ["00g1", "00g2"] } },
  });
});

describe("groups rules", () => {
  test("list --search sends search query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/groups/rules", body: [rule] }]);
    const t = testCtx(srv.url);
    await runTest(["groups", "rules", "list", "--search", "eng"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ search: "eng" });
  });

  test("add posts body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/groups/rules", body: rule }]);
    const t = testCtx(srv.url);
    await runTest(["groups", "rules", "add", "-n", "eng-rule", "-e", "true", "-g", "00g1", "-g", "00g2", "--exclude-user", "00u1"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({
      type: "group_rule", name: "eng-rule",
      conditions: { expression: { type: "urn:okta:expression:1.0", value: "true" }, people: { users: { exclude: ["00u1"] } } },
      actions: { assignUserToGroups: { groupIds: ["00g1", "00g2"] } },
    });
  });

  test("delete --remove-users sends removeUsers query", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/groups\/rules\/[^/]+$/, status: 404, body: notFound },
      { method: "GET", path: "/api/v1/groups/rules", body: [rule] },
      { method: "DELETE", path: "/api/v1/groups/rules/0pr1" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "rules", "delete", "eng", "--remove-users"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ removeUsers: "true" });
    expect(t.out.at(-1)).toBe("group rule 0pr1 (eng-rule) deleted\n");
  });
});

describe("user-types", () => {
  test("list, add posts body", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/meta/types/user", body: [userType] },
      { method: "POST", path: "/api/v1/meta/types/user", body: userType },
    ]);
    const t = testCtx(srv.url);
    await runTest(["user-types", "list", "--output-fields", "name"], t.ctx);
    expect(t.out.at(-1)).toBe("custom  \n");
    await runTest(["user-types", "add", "-n", "custom", "-d", "Custom", "--description", "d"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "custom", displayName: "Custom", description: "d" });
  });
});
