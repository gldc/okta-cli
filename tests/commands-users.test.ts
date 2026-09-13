import { afterEach, describe, expect, test } from "bun:test";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("users", () => {
  test("list sorted by login, -m filter, -d adds search", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["users", "list", "--output-fields", "profile.login"], t.ctx);
    expect(t.out.join("")).toBe("alice@x.com  \nbob@x.com    \n");
    t.out.length = 0;
    await runTest(["users", "list", "-m", "firstName=bo", "-p", "--output-fields", "id"], t.ctx);
    expect(t.out.join("")).toBe("00u00000000000000001  \n");
    await runTest(["users", "list", "-d", "-s", 'profile.x eq "1"'], t.ctx);
    expect(srv.calls.at(-1)!.query.search).toBe('profile.x eq "1" and status eq "DEPROVISIONED"');
  });

  test("get by 20-char id, by login, by -f, uniqueness errors", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["users", "get", "00u00000000000000002", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(users[1]);
    await runTest(["users", "get", "bob@x.com", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("00u00000000000000001  \n");
    expect(await runTest(["users", "get", "nobody@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: No user found with login=nobody@x.com\n");
  });

  test("groups/apps listing sorted", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/groups", body: [{ id: "g2", profile: { name: "Zeta" } }, { id: "g1", profile: { name: "Alpha" } }] },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/appLinks", body: [{ appInstanceId: "a", appName: "n", label: "Zoom" }, { appInstanceId: "b", appName: "m", label: "Box" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "groups", "bob@x.com", "--output-fields", "profile.name"], t.ctx);
    expect(t.out.at(-1)).toBe("Alpha  \nZeta   \n");
    await runTest(["users", "apps", "bob@x.com", "--output-fields", "label"], t.ctx);
    expect(t.out.at(-1)).toBe("Box   \nZoom  \n");
  });

  test("lifecycle commands and confirmation prompts", async () => {
    srv = startServer([
      { method: "POST", path: /^\/api\/v1\/users\/[^/]+\/lifecycle\/(activate|reactivate|suspend)$/, body: { activationUrl: "x" } },
      { method: "POST", path: /^\/api\/v1\/users\/[^/]+\/lifecycle\/(deactivate|unlock)$/ },
      { method: "DELETE", path: /^\/api\/v1\/users\/[^/]+$/ },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "activate", "bob@x.com", "-e"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "true" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ activationUrl: "x" });
    await runTest(["users", "reactivate", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({});
    await runTest(["users", "unlock", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe("User 'bob@x.com' unlocked.\n");
    await runTest(["users", "suspend", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.path).toEndWith("/lifecycle/suspend");
    t.answers.push("wrong");
    expect(await runTest(["users", "deactivate", "bob@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Aborted.\n");
    t.answers.push("bob@x.com");
    await runTest(["users", "deactivate", "bob@x.com", "-e"], t.ctx);
    expect(t.out.at(-1)).toBe("User bob@x.com deactivated.\n");
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "true" });
    await runTest(["users", "delete", "bob@x.com", "--no-confirmation"], t.ctx);
    expect(t.out.at(-1)).toBe("User bob@x.com deleted.\n");
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
  });

  test("update builds nested body with -s/-S/-c", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/users/012345", body: { ok: 1 } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "update", "012345", "-s", "lastName=Doe", "-S", "tags=a, b", "-c", "profile"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ profile: { lastName: "Doe", tags: ["a", "b"] } });
    await runTest(["users", "update", "012345", "-s", "credentials.password.value=S3cret!"], t.ctx);
    expect(srv.calls[1]!.body).toEqual({ credentials: { password: { value: "S3cret!" } } });
  });

  test("add merges -s/-p/-g and query flags", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/users", body: { id: "new" } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "add", "-s", "profile.login=x@y", "-s", "toplevel=ignored", "-p", "firstName=X", "-g", "00g1", "-g", "00g2", "--no-activate", "--nextlogin"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ activate: "False", provider: "False", nextlogin: "changePassword" });
    expect(srv.calls[0]!.body).toEqual({ profile: { login: "x@y", firstName: "X" }, groupIds: ["00g1", "00g2"] });
  });
});
