import { afterEach, describe, expect, test } from "bun:test";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("users update/replace/profile/schema-check", () => {
  test("update --from-json merges under -s (set wins)", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/users/00u1", body: { ok: 1 } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "update", "00u1", "--from-json", '{"profile":{"firstName":"FromJson","nickName":"nick"}}', "-s", "profile.firstName=FromSet"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ profile: { firstName: "FromSet", nickName: "nick" } });
  });

  test("replace with only -s fetches the existing user then PUTs the merge", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001", body: { id: "00u00000000000000001", status: "ACTIVE", profile: { login: "bob@x.com", email: "bob@x.com", firstName: "Bob", lastName: "B" } } },
      { method: "PUT", path: "/api/v1/users/00u00000000000000001", body: { ok: 1 } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "replace", "00u00000000000000001", "-s", "profile.firstName=New", "--output-fields", "id"], t.ctx);
    expect(srv.calls[0]!.method).toBe("GET");
    expect(srv.calls[1]!.method).toBe("PUT");
    expect(srv.calls[1]!.body).toEqual({ id: "00u00000000000000001", status: "ACTIVE", profile: { login: "bob@x.com", email: "bob@x.com", firstName: "New", lastName: "B" } });
  });

  test("replace with neither --from-json nor -s/-S/-c errors", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["users", "replace", "00u00000000000000001"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Provide --from-json and/or -s\n");
  });

  test("profile: rows sorted by field, arrays JSON-stringified", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001", body: { id: "00u00000000000000001", profile: { login: "bob@x.com", zeta: "z", alpha: "a", tags: ["a", "b"] } } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "profile", "00u00000000000000001", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual([
      { field: "alpha", value: "a" },
      { field: "login", value: "bob@x.com" },
      { field: "tags", value: '["a","b"]' },
      { field: "zeta", value: "z" },
    ]);
  });

  test("schema-check flags a profile field not present in the schema", async () => {
    const schema = {
      definitions: {
        base: { id: "#base", type: "object", properties: { login: { title: "Username", type: "string", required: true, mutability: "READ_ONLY", scope: "NONE" } } },
        custom: { id: "#custom", type: "object", properties: {} },
      },
    };
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001", body: { id: "00u00000000000000001", profile: { login: "bob@x.com", ghost: "x" } } },
      { method: "GET", path: "/api/v1/meta/schemas/user/default", body: schema },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "schema-check", "00u00000000000000001", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual([
      { field: "ghost", value: "x", status: "not-in-schema" },
      { field: "login", value: "bob@x.com", status: "ok" },
    ]);
  });
});
