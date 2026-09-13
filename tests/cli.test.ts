import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { action, addOutputOptions, addVerbose } from "../src/cli/options";
import { buildProgram, runCli } from "../src/cli/program";
import { ExitError, OktaApiError } from "../src/okta/errors";
import { startServer } from "./fixtures/server";
import { runTest, testCtx } from "./fixtures/ctx";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

function programWith(ctx: ReturnType<typeof testCtx>["ctx"], handler: (...a: any[]) => unknown, fields: string | null = "id,name") {
  const p = buildProgram(ctx);
  const cmd = p.command("probe").argument("[arg]");
  addOutputOptions(addVerbose(cmd), fields).action(action(ctx, handler));
  return p;
}

describe("cli framework", () => {
  test("version", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runCli(["version"], t.ctx)).toBe(0);
    expect(t.out.join("")).toBe("19.1.0\n");
    expect(await runCli(["--version"], t.ctx)).toBe(0);
  });

  test("table output by default, json with -j, string passthrough", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    const p = programWith(t.ctx, async () => [{ id: "1", name: "a" }]);
    await p.parseAsync(["probe"], { from: "user" });
    expect(t.out.join("")).toBe("1  a  \n");
    t.out.length = 0;
    await p.parseAsync(["probe", "-j"], { from: "user" });
    expect(t.out.join("")).toBe('[\n  {\n    "id": "1",\n    "name": "a"\n  }\n]\n');
    const p2 = programWith(t.ctx, async () => "done");
    t.out.length = 0;
    await p2.parseAsync(["probe"], { from: "user" });
    expect(t.out.join("")).toBe("done\n");
  });

  test("handler receives client, opts, args", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/ping", body: { pong: true } }]);
    const t = testCtx(srv.url);
    const p = programWith(t.ctx, async (client, opts, arg) => ({ ...(await client.get("/ping")), arg, v: opts.verbose }), null);
    await p.parseAsync(["probe", "hello", "-vv"], { from: "user" });
    expect(JSON.parse(t.out.join(""))).toEqual({ pong: true, arg: "hello", v: 2 });
    expect(t.err.some((l) => l.startsWith("> GET"))).toBe(true);
  });

  test("error mapping and exit codes", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    await programWith(t.ctx, async () => { throw new ExitError("nope"); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t.err.join("")).toBe("ERROR: nope\n");
    expect(t.exits).toEqual([255]);
    const t2 = testCtx(srv.url);
    await programWith(t2.ctx, async () => { throw new OktaApiError({ errorCode: "E1", errorSummary: "bad", errorCauses: [{ errorSummary: "c" }] }, 400); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t2.out.join("")).toBe("OKTA_API_ERROR: E1: bad\nerrorSummary: c\n");
    expect(t2.exits).toEqual([253]);
    const t3 = testCtx(srv.url);
    await programWith(t3.ctx, async () => { throw new TypeError("boom"); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t3.err.join("")).toContain("CRITICAL_ERROR: TypeError");
    expect(t3.exits).toEqual([254]);
  });

  test("runTest returns exit code and unknown command exits non-zero", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["nonexistent"], t.ctx)).not.toBe(0);
  });

  test("a custom option parser (int) throwing during commander's own argument parsing is still mapped to ERROR/255", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["users", "list", "--colwidth", "abc"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Expected an integer, got 'abc'\n");
  });
});
