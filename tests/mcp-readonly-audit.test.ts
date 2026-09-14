import { afterAll, describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { buildCatalog } from "../src/mcp/catalog";
import { invokeTool } from "../src/mcp/invoke";
import { OktaClient } from "../src/okta/client";
import { testCtx } from "./fixtures/ctx";

// Permanent regression test for an audit that ran every readOnly-classified tool against a
// permissive mock and found several issuing non-GET requests (org_support_extend,
// governance_request_types_unpublish, governance_tasks_resolve,
// governance_security_access_reviews_access_summary, governance_security_access_reviews_summary,
// sessions_refresh - all fixed by adding their verbs to WRITE_VERBS; org_footer via
// NEVER_READ_ONLY_OPT_LONGS). If this ever regresses again, the failure message below names the
// offending tool(s) and the request(s) they made.
const obj = {
  id: "00x", name: "x", status: "ACTIVE", type: "x",
  profile: { name: "x", login: "x", email: "x@x.io", firstName: "x", lastName: "x" },
  label: "x", credentials: {}, settings: {}, _links: {},
};

const calls: { tool: string; method: string; path: string }[] = [];
let current = "";

const srv = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    calls.push({ tool: current, method: req.method, path: u.pathname });
    const last = u.pathname.split("/").pop() ?? "";
    const asObject = last === "00x" || last === "x" || /^(settings|preferences|config|status|schema|default|current|me|organization|default-content|contacts)$/i.test(last);
    return Response.json(asObject ? obj : [obj]);
  },
});
afterAll(() => { srv.stop(true); });

const client = new OktaClient(`http://127.0.0.1:${srv.port}`, "tok", { sleep: async () => {} });
const defs = buildCatalog(buildProgram(testCtx("http://127.0.0.1:1").ctx)).filter((d) => d.readOnly);

describe("mcp read-only audit", () => {
  test("every readOnly-classified tool issues only GET requests against a permissive mock", async () => {
    // Guards against the readOnly filter silently returning an empty (or near-empty) set, which
    // would make the loop below a no-op that trivially passes.
    expect(defs.length).toBeGreaterThanOrEqual(300);

    for (const d of defs) {
      current = d.name;
      const input: Record<string, unknown> = {};
      for (const a of d.args) if (a.required) input[a.key] = a.variadic ? ["x"] : "x";
      for (const o of d.opts) {
        if (!o.required) continue;
        // A required enum option rejects "x" outright (commander's choice validation) before the
        // call ever reaches the mock - pass its first valid choice instead so the leaf actually runs
        // (policies_list, policies_map both have a required --type/--resource-type enum).
        input[o.attr] = o.choices && o.choices.length > 0
          ? o.choices[0]
          : o.kind === "integer" ? 1
          : o.kind === "string[]" ? ["x"]
          : o.kind === "boolean" ? true
          : "x";
      }
      await invokeTool(d, input, { getClient: async () => client, env: {} });
    }

    const bad = new Map<string, Set<string>>();
    for (const c of calls) {
      if (c.method !== "GET") bad.set(c.tool, new Set([...(bad.get(c.tool) ?? []), `${c.method} ${c.path}`]));
    }
    if (bad.size > 0) {
      const offenders = [...bad.entries()].map(([tool, reqs]) => `  ${tool}: ${[...reqs].join(", ")}`).join("\n");
      throw new Error(`${bad.size} readOnly tool(s) issued non-GET requests:\n${offenders}`);
    }
    expect(bad.size).toBe(0);
  }, 60_000); // ~317 sequential runCli invocations; the default 5 s budget is too tight on CI runners
});
