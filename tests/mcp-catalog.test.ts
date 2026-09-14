import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { testCtx } from "./fixtures/ctx";
import { buildCatalog, filterCatalog, globToRegExp, toolName } from "../src/mcp/catalog";
import { buildArgv } from "../src/mcp/invoke";

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
  test("known-mutating leaves are never classified read-only", () => {
    const mutating = [
      "users_change_password", "users_forgot_password", "users_change_recovery_question",
      "apps_addgroup", "brands_theme_favicon", "brands_theme_background", "brands_theme_logo",
      "org_support_extend", "governance_tasks_resolve", "sessions_refresh",
      "governance_request_types_unpublish", "governance_security_access_reviews_access_summary",
      "governance_security_access_reviews_summary", "policies_map",
    ];
    for (const name of mutating) {
      const d = byName.get(name)!;
      expect(d.readOnly).toBe(false);
      expect(d.annotations.readOnlyHint).toBe(false);
    }
  });
  test("org footer mutates the dashboard footer setting via --show/--hide, not a write verb", () => {
    const d = byName.get("org_footer")!;
    expect(d.readOnly).toBe(false);
    expect(d.annotations.readOnlyHint).toBe(false);
  });
  test("logs_list --limit/--page-size are integers, not strings", () => {
    const d = byName.get("logs_list")!;
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.limit.type).toBe("integer");
    expect(p.pageSize.type).toBe("integer");
    expect(buildArgv(d, { limit: 5 })).toContain("--limit=5");
  });
  test("users_add merges --activate/--no-activate into one boolean property", () => {
    const d = byName.get("users_add")!;
    expect(d.opts.filter((o) => o.attr === "activate")).toHaveLength(1);
    const activate = d.opts.find((o) => o.attr === "activate")!;
    expect(activate.negatedLong).toBe("--no-activate");
    expect(activate.description.length).toBeGreaterThan(0);
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.activate).toEqual({ type: "boolean", description: activate.description });
    expect(buildArgv(d, { activate: true })).toContain("--activate");
    expect(buildArgv(d, { activate: false })).toContain("--no-activate");
  });
  test("no positional arg's schema key collides with an option attr", () => {
    for (const d of defs) {
      const optAttrs = new Set(d.opts.map((o) => o.attr));
      for (const arg of d.args) expect(optAttrs.has(arg.key)).toBe(false);
    }
    // These three used to collide (arg.name === opt.attr) before disambiguation.
    expect(byName.get("groups_role_target_add")!.args[0]!.key).toBe("arg_group");
    expect(byName.get("groups_role_target_delete")!.args[0]!.key).toBe("arg_group");
    expect(byName.get("auth_servers_associated_add")!.args[0]!.key).toBe("arg_server");
  });
  test("buildArgv emits the disambiguated positional's value exactly once", () => {
    const add = byName.get("groups_role_target_add")!;
    const argv1 = buildArgv(add, { arg_group: "Everyone", assignmentId: "ra1", group: "OtherGroup" });
    expect(argv1.filter((t) => t === "Everyone")).toHaveLength(1);
    expect(argv1).toContain("--group=OtherGroup");

    const del = byName.get("groups_role_target_delete")!;
    const argv2 = buildArgv(del, { arg_group: "Everyone", assignmentId: "ra1", group: "OtherGroup" });
    expect(argv2.filter((t) => t === "Everyone")).toHaveLength(1);
    expect(argv2).toContain("--group=OtherGroup");

    const assoc = byName.get("auth_servers_associated_add")!;
    const argv3 = buildArgv(assoc, { arg_server: "server1", server: "server2" });
    expect(argv3.filter((t) => t === "server1")).toHaveLength(1);
    expect(argv3).toContain("--server=server2");
  });
  test("local file paths are marked and rejected in the schema description", () => {
    const d = byName.get("apps_logo")!;
    const fileOpt = d.opts.find((o) => o.attr === "file")!;
    expect(fileOpt.isPath).toBe(true);
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.file.description).toContain("Rejected in MCP mode");
    const bulk = byName.get("users_bulk_add")!;
    expect(bulk.args[0]!.isPath).toBe(true);
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
