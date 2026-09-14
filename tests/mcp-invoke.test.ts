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
});
