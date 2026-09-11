import { afterEach, describe, expect, test } from "bun:test";
import { buildAppBody } from "../src/commands/apps";
import { apps, standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("apps", () => {
  test("buildAppBody applies shortcuts, defaults, signOnMode", () => {
    expect(buildAppBody("bookmark", undefined, "My", ["sa.url=http://x", "v.hide.web=true"])).toEqual({
      name: "bookmark", label: "My", signOnMode: "BOOKMARK",
      settings: { app: { requestIntegration: "false", url: "http://x" } }, visibility: { hide: { web: "true" } },
    });
    expect(buildAppBody(undefined, "SAML_2_0", undefined, [])).toEqual({ signOnMode: "SAML_2_0" });
  });
  test("list sorted by label with partial filter; get; users sorted", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/apps/0oa2/users", body: [{ id: "u2", credentials: { userName: "z" } }, { id: "u1", credentials: { userName: "a" } }] }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["apps", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa2  Slack  \n0oa1  Zoom   \n");
    await runTest(["apps", "list", "zoo", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa1  \n");
    await runTest(["apps", "get", "slack", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(apps[1]);
    await runTest(["apps", "users", "Slack", "--output-fields", "credentials.userName"], t.ctx);
    expect(t.out.at(-1)).toBe("a  \nz  \n");
  });
  test("adduser/removeuser/addgroup/removegroup/lifecycle/delete", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/apps/0oa2/users", body: { id: "00u00000000000000001", scope: "USER", status: "ACTIVE", credentials: { userName: "bob@x.com" } } },
      { method: "DELETE", path: /^\/api\/v1\/apps\/0oa2\/(users|groups)\/.+/ },
      { method: "PUT", path: "/api/v1/apps/0oa2/groups/00g1", body: { id: "00g1", priority: 0 } },
      { method: "POST", path: /^\/api\/v1\/apps\/0oa2\/lifecycle\/(activate|deactivate)$/ },
      { method: "DELETE", path: "/api/v1/apps/0oa2" },
      { method: "POST", path: "/api/v1/apps", body: { id: "0oa9", label: "New" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "adduser", "-a", "slack", "-u", "bob@x.com", "-s", "credentials.userName=bob@x.com"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ id: "00u00000000000000001", credentials: { userName: "bob@x.com" } });
    expect(t.out.at(-1)).toBe("00u00000000000000001  bob@x.com  USER  ACTIVE   \n");
    await runTest(["apps", "removeuser", "-a", "slack", "-u", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe("User 00u00000000000000001 (bob@x.com) removed from app 0oa2 (Slack)\n");
    await runTest(["apps", "addgroup", "-a", "slack", "-g", "engineering"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ id: "00g1", priority: 0 });
    await runTest(["apps", "removegroup", "-a", "slack", "-g", "engineering"], t.ctx);
    expect(t.out.at(-1)).toBe("App 0oa2 (Slack) removed from group 00g1 (Engineering)\n");
    await runTest(["apps", "activate", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) activated\n");
    await runTest(["apps", "deactivate", "0oa2"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) deactivated\n");
    await runTest(["apps", "delete", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) deleted\n");
    await runTest(["apps", "add", "-n", "bookmark", "-l", "New", "-s", "sa.url=http://x"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "bookmark", label: "New", signOnMode: "BOOKMARK", settings: { app: { requestIntegration: "false", url: "http://x" } } });
  });
});
