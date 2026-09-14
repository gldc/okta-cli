import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { testCtx } from "./fixtures/ctx";
import { buildCatalog, filterCatalog, globToRegExp, toolName } from "../src/mcp/catalog";

const program = buildProgram(testCtx("http://127.0.0.1:1").ctx);
const defs = buildCatalog(program);
const byName = new Map(defs.map((d) => [d.name, d]));

describe("mcp catalog", () => {
  test("covers every leaf except config/version/mcp with unique valid names", () => {
    expect(defs.length).toBeGreaterThan(700);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) expect(d.name).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
    expect(defs.some((d) => d.path[0] === "config")).toBe(false);
    expect(byName.has("version")).toBe(false);
    expect(defs.some((d) => d.path[0] === "mcp")).toBe(false);
  });
  test("toolName joins with underscores", () => {
    expect(toolName(["governance", "entitlement-bundles", "get"])).toBe("governance_entitlement_bundles_get");
  });
  test("users list schema: options typed, output options excluded", () => {
    const d = byName.get("users_list")!;
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.filter).toEqual({ type: "string", description: expect.any(String) });
    expect(p.match).toEqual({ type: "array", items: { type: "string" }, description: expect.any(String) });
    expect(p.partial).toEqual({ type: "boolean", description: expect.any(String) });
    expect(p.json).toBeUndefined(); expect(p.outputFields).toBeUndefined(); expect(p.verbose).toBeUndefined();
    expect(d.inputSchema.additionalProperties).toBe(false);
    expect(d.hasJson).toBe(true);
    expect(d.readOnly).toBe(true);
    expect(d.annotations.readOnlyHint).toBe(true);
  });
  test("positional arguments become required string properties", () => {
    const d = byName.get("users_get")!;
    const p = d.inputSchema.properties as Record<string, any>;
    const argName = d.args[0]!.name;
    expect(p[argName].type).toBe("string");
    expect(d.inputSchema.required).toContain(argName);
    expect(d.description).toContain(`<${argName}>`);
  });
  test("body option accepts object or string; --set is string[]", () => {
    const d = byName.get("apps_jwks_add")!;
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.body.anyOf.map((s: any) => s.type)).toEqual(["object", "array", "string"]);
    expect(p.set).toEqual({ type: "array", items: { type: "string" }, description: expect.any(String) });
    expect(d.readOnly).toBe(false);
  });
  test("write classification", () => {
    expect(byName.get("users_delete")!.readOnly).toBe(false);
    expect(byName.get("users_delete")!.annotations.destructiveHint).toBe(true);
    expect(byName.get("users_delete")!.hasNoConfirmation).toBe(true);
    expect(byName.get("groups_adduser")!.readOnly).toBe(false);
    expect(byName.get("apps_keys")!.readOnly).toBe(true);
    expect(byName.get("roles_permissions")!.readOnly).toBe(true);
    expect(byName.get("groups_list")!.annotations.destructiveHint).toBe(false);
  });
  test("integer options", () => {
    const d = defs.find((x) => (x.inputSchema.properties as any).limit)!;
    expect((d.inputSchema.properties as any).limit.type).toBe("integer");
  });
  test("filterCatalog read-only / include / exclude", () => {
    const ro = filterCatalog(defs, { readOnly: true });
    expect(ro.every((d) => d.readOnly)).toBe(true);
    expect(ro.length).toBeGreaterThan(200);
    const inc = filterCatalog(defs, { include: ["users_*", "groups_list"] });
    expect(inc.every((d) => d.name.startsWith("users_") || d.name === "groups_list")).toBe(true);
    expect(inc.some((d) => d.name === "groups_list")).toBe(true);
    const exc = filterCatalog(defs, { exclude: ["*_delete"] });
    expect(exc.some((d) => d.name.endsWith("_delete"))).toBe(false);
    expect(globToRegExp("users_*").test("users_list")).toBe(true);
    expect(globToRegExp("users_*").test("xusers_list")).toBe(false);
  });
});
