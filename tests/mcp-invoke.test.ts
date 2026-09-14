import { afterAll, describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { buildCatalog } from "../src/mcp/catalog";
import { buildArgv, invokeTool, readOnlyClient, toCallToolResult } from "../src/mcp/invoke";
import { OktaClient } from "../src/okta/client";
import { testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

const defs = buildCatalog(buildProgram(testCtx("http://127.0.0.1:1").ctx));
const byName = new Map(defs.map((d) => [d.name, d]));

describe("buildArgv", () => {
  test("options first, -- before positionals, --json appended", () => {
    const d = byName.get("users_get")!;
    const argv = buildArgv(d, { [d.args[0]!.name]: "-weird" });
    expect(argv.slice(0, 2)).toEqual(["users", "get"]);
    expect(argv).toContain("--json");
    expect(argv.slice(-2)).toEqual(["--", "-weird"]);
  });
  test("string, boolean, array, integer options", () => {
    const d = byName.get("users_list")!;
    // Declared option order on the leaf is match, partial, filter, search, query, deprovisioned.
    const argv = buildArgv(d, { filter: 'status eq "ACTIVE"', partial: true, match: ["a=b", "c=d"] });
    expect(argv).toEqual(["users", "list", "--match=a=b", "--match=c=d", "--partial", '--filter=status eq "ACTIVE"', "--json"]);
  });
  test("non-string/number value for a string option is rejected, not coerced", () => {
    const d = byName.get("users_list")!;
    expect(() => buildArgv(d, { filter: { nope: true } })).toThrow(/must be a string/);
  });
  test("body object is stringified; FILE: rejected; unknown key rejected", () => {
    const d = byName.get("governance_requests_add")!;
    expect(buildArgv(d, { body: { profile: { name: "x" } } })).toContain('--body={"profile":{"name":"x"}}');
    expect(() => buildArgv(d, { body: "FILE:/etc/passwd" })).toThrow(/FILE:/);
    expect(() => buildArgv(d, { nope: 1 })).toThrow(/unknown argument/);
  });
  test("missing required positional rejected; --no-confirmation appended", () => {
    const d = byName.get("users_delete")!;
    expect(() => buildArgv(d, {})).toThrow(/missing positional/);
    expect(buildArgv(d, { [d.args[0]!.name]: "00u1" })).toContain("--no-confirmation");
  });
  test("positional/option name collision: both values are distinct and reachable", () => {
    const d = byName.get("groups_role_target_add")!;
    expect(d.args[0]!.key).toBe("arg_group");
    const argv = buildArgv(d, { arg_group: "Everyone", assignmentId: "ra1", group: "OtherGroup" });
    expect(argv).toContain("--group=OtherGroup");
    expect(argv.slice(-2)).toEqual(["Everyone", "ra1"]);

    const s = byName.get("auth_servers_associated_add")!;
    expect(s.args[0]!.key).toBe("arg_server");
    const argv2 = buildArgv(s, { arg_server: "server1", server: "server2" });
    expect(argv2).toContain("--server=server2");
    expect(argv2).toContain("server1");
  });
  test("local file path options/positionals are rejected, not read", () => {
    expect(() => buildArgv(byName.get("apps_logo")!, { app: "0oa1", file: "/etc/passwd" })).toThrow(/local file path/);
    expect(() => buildArgv(byName.get("users_bulk_add")!, { file: "/etc/passwd" })).toThrow(/local file path/);
    expect(() =>
      buildArgv(byName.get("domains_certificate")!, { "domain-or-id": "d1", cert: "/a", key: "/b" }),
    ).toThrow(/local file path/);
  });
});

describe("invokeTool", () => {
  const srv = startServer([
    { method: "GET", path: "/api/v1/users", body: [{ id: "00u1", status: "ACTIVE", profile: { login: "a@x.io", email: "a@x.io", firstName: "A", lastName: "B" } }] },
    { method: "DELETE", path: "/api/v1/users/00u1" },
    { method: "GET", path: "/api/v1/users/00u1", body: { id: "00u1", status: "DEPROVISIONED", profile: { login: "a@x.io" } } },
  ]);
  afterAll(() => srv.stop());
  const deps = (client: OktaClient) => ({ getClient: async () => client, env: {} });
  const client = new OktaClient(srv.url, "tok", { sleep: async () => {} });

  test("returns JSON stdout and exit 0", async () => {
    const r = await invokeTool(byName.get("users_list")!, {}, deps(client));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].id).toBe("00u1");
    const c = toCallToolResult(r);
    expect(c.isError).toBeUndefined();
    expect(c.content[0]!.text).toContain("00u1");
  });
  test("Okta API error → non-zero code, isError", async () => {
    srv.add({ method: "GET", path: "/api/v1/groups", status: 403, body: { errorCode: "E0000006", errorSummary: "denied", errorCauses: [] } });
    const r = await invokeTool(byName.get("groups_list")!, {}, deps(client));
    expect(r.code).toBe(253);
    const c = toCallToolResult(r);
    expect(c.isError).toBe(true);
    expect(c.content[0]!.text).toContain("E0000006");
  });
  test("argv error → 255 without network", async () => {
    const before = srv.calls.length;
    const r = await invokeTool(byName.get("users_list")!, { bogus: true }, deps(client));
    expect(r.code).toBe(255);
    expect(r.stderr).toContain("unknown argument");
    expect(srv.calls.length).toBe(before);
  });
  test("read-only client refuses non-GET at the HTTP layer", async () => {
    const ro = readOnlyClient(client);
    const d = byName.get("users_delete")!;
    const r = await invokeTool(d, { [d.args[0]!.name]: "00u1" }, deps(ro));
    expect(r.code).toBe(255);
    expect(r.stderr).toContain("read-only mode");
    expect(srv.calls.some((c) => c.method === "DELETE")).toBe(false);
    const ok = await invokeTool(byName.get("users_list")!, {}, deps(ro));
    expect(ok.code).toBe(0);
  });
  test("read-only client refuses upload()", async () => {
    const ro = readOnlyClient(client);
    await expect(ro.upload("/apps/0oa1/logo", "file", "/tmp/nope.png")).rejects.toThrow(/read-only mode/);
  });
});
