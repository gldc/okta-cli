import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildProgram } from "../src/cli/program";
import { buildCatalog, filterCatalog } from "../src/mcp/catalog";
import { invokeTool } from "../src/mcp/invoke";
import { serveHttp } from "../src/mcp/server";
import { OktaClient } from "../src/okta/client";
import { testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

const okta = startServer([{ method: "GET", path: "/api/v1/groups", body: [{ id: "00g1", type: "OKTA_GROUP", profile: { name: "Everyone", description: "" } }] }]);
const client = new OktaClient(okta.url, "tok", { sleep: async () => {} });
const defs = filterCatalog(buildCatalog(buildProgram(testCtx(okta.url).ctx)), { include: ["groups_*", "users_list"] });
const logs: string[] = [];
const http = serveHttp({ defs, version: "test", log: (l) => logs.push(l), invoke: (d, i) => invokeTool(d, i, { getClient: async () => client, env: {} }) }, { host: "127.0.0.1", port: 0, path: "/mcp" });
afterAll(() => { http.stop(); okta.stop(); });

async function connect() {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`)));
  return c;
}

describe("mcp http server", () => {
  test("healthz", async () => {
    const r = await fetch(`${http.url}/healthz`);
    expect(r.status).toBe(200);
    expect((await r.json()).tools).toBe(defs.length);
  });
  test("unknown path 404", async () => { expect((await fetch(`${http.url}/nope`, { method: "POST" })).status).toBe(404); });
  test("initialize + tools/list + tools/call", async () => {
    const c = await connect();
    const tools = await c.listTools();
    expect(tools.tools.length).toBe(defs.length);
    const gl = tools.tools.find((t) => t.name === "groups_list")!;
    expect(gl.inputSchema.type).toBe("object");
    expect(gl.annotations?.readOnlyHint).toBe(true);
    const r = await c.callTool({ name: "groups_list", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.content as any[])[0].text).toContain("00g1");
    expect(logs.some((l) => l.startsWith("mcp tool=groups_list code=0"))).toBe(true);
    await c.close();
  });
  test("tool error surfaces as isError", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "groups_get", arguments: { [defs.find((d) => d.name === "groups_get")!.args[0]!.name]: "nomatch" } });
    expect(r.isError).toBe(true);
    await c.close();
  });
  test("unknown tool", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "nope", arguments: {} });
    expect(r.isError).toBe(true);
    await c.close();
  });
  test("two concurrent calls (stateless)", async () => {
    const c = await connect();
    const [a, b] = await Promise.all([c.callTool({ name: "groups_list", arguments: {} }), c.callTool({ name: "groups_list", arguments: {} })]);
    expect(a.isError).toBeFalsy(); expect(b.isError).toBeFalsy();
    await c.close();
  });
});
