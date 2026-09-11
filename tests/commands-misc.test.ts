import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseBody } from "../src/lib/body";
import { apps, groups, standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => { srv?.stop(); if (existsSync("okta-dump-20260102030405")) rmSync("okta-dump-20260102030405", { recursive: true }); });

describe("parseBody", () => {
  test("json, FILE:, sets merge", async () => {
    expect(parseBody(undefined)).toBeUndefined();
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody('{"a":{"b":1}}', ["a.c=2", "d=x"])).toEqual({ a: { b: 1, c: "2" }, d: "x" });
    expect(parseBody(undefined, ["profile.name=n"])).toEqual({ profile: { name: "n" } });
    const f = `${import.meta.dir}/tmp-body.json`;
    await Bun.write(f, '{"z":true}');
    expect(parseBody(`FILE:${f}`)).toEqual({ z: true });
    expect(() => parseBody("{nope")).toThrow("Body is not valid JSON");
  });
});

describe("raw", () => {
  test("GET with query, POST with body, base path", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users", body: users }, { method: "POST", path: "/oauth2/v1/clients", body: { id: "c1" } }]);
    const t = testCtx(srv.url);
    await runTest(["raw", "/users", "-q", "limit=1", "-q", 'search=status eq "ACTIVE"', "--output-fields", "id"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ limit: "1", search: 'status eq "ACTIVE"' });
    expect(t.out.at(-1)).toBe("00u00000000000000001  \n00u00000000000000002  \n");
    await runTest(["raw", "clients", "-X", "post", "-b", '{"client_name":"x"}', "--base-path", "oauth2/v1"], t.ctx);
    expect(srv.calls[1]!.body).toEqual({ client_name: "x" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ id: "c1" });
  });
});

describe("dump", () => {
  test("writes five csv files", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/groups\/[^/]+\/users$/, body: [users[0]] },
      { method: "GET", path: /^\/api\/v1\/apps\/[^/]+\/users$/, body: [users[1]] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["dump"], t.ctx)).toBe(0);
    const dir = "okta-dump-20260102030405";
    expect(readFileSync(`${dir}/users.csv`, "utf8").split("\r\n").length).toBe(2 + users.length * 2);
    expect(readFileSync(`${dir}/groups.csv`, "utf8")).toStartWith("id,profile.description,profile.name,type\r\n");
    expect(readFileSync(`${dir}/apps.csv`, "utf8").split("\r\n").length).toBe(apps.length + 2);
    expect(readFileSync(`${dir}/group_users.csv`, "utf8")).toBe(`group,user\r\n${groups.map((g) => `${g.id},${users[0]!.id}`).join("\r\n")}\r\n`);
    expect(readFileSync(`${dir}/app_users.csv`, "utf8")).toBe(`app,user\r\n${apps.map((a) => `${a.id},${users[1]!.id}`).join("\r\n")}\r\n`);
    expect(t.out.join("")).toContain("Saving group users ... done.");
    const t2 = testCtx(srv.url);
    await runTest(["dump", "--no-user-list", "--no-app-users", "--no-group-users", "-d", "okta-dump-20260102030405"], t2.ctx);
    expect(t2.out.join("")).toContain("Skipping list of users.");
  });
});
