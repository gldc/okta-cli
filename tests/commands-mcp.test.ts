import { describe, expect, test } from "bun:test";
import { runTest, testCtx } from "./fixtures/ctx";

describe("mcp tools", () => {
  test("lists tools as JSON, read-only filter, include glob", async () => {
    const { ctx, out } = testCtx("http://127.0.0.1:1");
    expect(await runTest(["mcp", "tools", "-j"], ctx)).toBe(0);
    const all = JSON.parse(out.join(""));
    expect(all.length).toBeGreaterThan(700);
    expect(all.some((t: any) => t.name.startsWith("mcp_"))).toBe(false);
    out.length = 0;
    expect(await runTest(["mcp", "tools", "-j", "--read-only", "--include", "users_*"], ctx)).toBe(0);
    const ro = JSON.parse(out.join(""));
    expect(ro.length).toBeGreaterThan(5);
    expect(ro.every((t: any) => t.readOnly && t.name.startsWith("users_"))).toBe(true);
  });
  test("env defaults: OKTA_MCP_READ_ONLY=1 and OKTA_MCP_INCLUDE", async () => {
    const { ctx, out } = testCtx("http://127.0.0.1:1");
    ctx.env = { OKTA_MCP_READ_ONLY: "1", OKTA_MCP_INCLUDE: "groups_*,users_list" };
    expect(await runTest(["mcp", "tools", "-j"], ctx)).toBe(0);
    const t = JSON.parse(out.join(""));
    expect(t.every((x: any) => x.readOnly)).toBe(true);
    expect(t.some((x: any) => x.name === "users_list")).toBe(true);
    expect(t.some((x: any) => x.name === "users_get")).toBe(false);
  });
  test("table mode (no -j) prints a real table, not a field-not-found warning", async () => {
    const { ctx, out, err } = testCtx("http://127.0.0.1:1");
    expect(await runTest(["mcp", "tools", "--include", "groups_list"], ctx)).toBe(0);
    const stdout = out.join("");
    expect(stdout).toContain("groups_list");
    expect(err.join("")).not.toContain("never filled or non-existant");
  });
  test("mcp serve is registered with host/port/path options", async () => {
    const { ctx, out, err } = testCtx("http://127.0.0.1:1");
    await runTest(["mcp", "serve", "--help"], ctx);
    const help = out.join("") + err.join("");
    expect(help).toContain("--host");
    expect(help).toContain("--port");
    expect(help).toContain("--read-only");
  });
});
