import { afterEach, describe, expect, test } from "bun:test";
import { groups, standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("groups", () => {
  test("list excludes APP_GROUP unless -a, supports partial name", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["groups", "list"], t.ctx);
    expect(t.out.join("")).toBe("00g1  OKTA_GROUP  Engineering  \n00g3  OKTA_GROUP  Sales        \n");
    t.out.length = 0;
    await runTest(["groups", "list", "-a", "eng", "--output-fields", "id"], t.ctx);
    expect(t.out.join("")).toBe("00g1  \n00g2  \n");
  });

  test("adduser resolves group by name and user by login", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/groups/00g1/users/00u00000000000000001" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    expect(await runTest(["groups", "adduser", "-g", "engineering", "-u", "bob@x.com"], t.ctx)).toBe(0);
    expect(t.out.join("")).toBe("User 00u00000000000000001 (bob@x.com) added to group 00g1 (Engineering)\n");
    expect(srv.calls.some((c) => c.method === "PUT" && c.path === "/api/v1/groups/00g1/users/00u00000000000000001")).toBe(true);
  });

  test("removeuser with -f email; users lists sorted by login; clear deletes each member", async () => {
    srv = startServer([
      { method: "DELETE", path: /^\/api\/v1\/groups\/00g1\/users\/.+/ },
      { method: "GET", path: "/api/v1/groups/00g1/users", body: [users[0], users[1]] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "removeuser", "-g", "00g1", "-u", "alice@x.com", "-f", "email"], t.ctx);
    expect(t.out.at(-1)).toBe("User 00u00000000000000002 (alice@x.com) removed from group 00g1 (Engineering)\n");
    t.out.length = 0;
    await runTest(["groups", "users", "00g1", "--output-fields", "profile.login"], t.ctx);
    expect(t.out.join("")).toBe("alice@x.com  \nbob@x.com    \n");
    await runTest(["groups", "clear", "Engineering"], t.ctx);
    expect(t.out.at(-1)).toBe("All users removed from group 00g1 (Engineering)\n");
    expect(srv.calls.filter((c) => c.method === "DELETE").map((c) => c.path).sort()).toEqual([
      "/api/v1/groups/00g1/users/00u00000000000000001", "/api/v1/groups/00g1/users/00u00000000000000002", "/api/v1/groups/00g1/users/00u00000000000000002",
    ].sort());
  });

  test("add posts profile; get; delete; apps sorted by label", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/groups", body: { id: "00g9", type: "OKTA_GROUP", profile: { name: "New", description: "d" } } },
      { method: "DELETE", path: "/api/v1/groups/00g3" },
      { method: "GET", path: "/api/v1/groups/00g1/apps", body: [{ id: "0oa2", name: "slack", label: "Slack" }, { id: "0oa1", name: "bookmark", label: "Aaa" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "add", "-n", "New", "-d", "d"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ profile: { name: "New", description: "d" } });
    expect(t.out.at(-1)).toBe("00g9  OKTA_GROUP  New  \n");
    await runTest(["groups", "get", "sales", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(groups[2]);
    await runTest(["groups", "delete", "Sales"], t.ctx);
    expect(t.out.at(-1)).toBe("group 00g3 deleted\n");
    await runTest(["groups", "apps", "00g1", "--output-fields", "label"], t.ctx);
    expect(t.out.at(-1)).toBe("Aaa    \nSlack  \n");
  });
});
