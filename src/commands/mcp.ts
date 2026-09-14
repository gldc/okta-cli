import type { Command } from "commander";
import { action, addOutputOptions, addVerbose, collect, int, subgroup } from "../cli/options";
import type { Ctx } from "../cli/context";
import { buildCatalog, filterCatalog, type ToolDef } from "../mcp/catalog";
import { invokeTool, readOnlyClient } from "../mcp/invoke";
import { serveHttp, serveStdio } from "../mcp/server";
import type { OktaClient } from "../okta/client";
import { VERSION } from "../version";

function addCatalogOptions(cmd: Command): Command {
  return cmd
    .option("--read-only", "Only list/serve read-only tools; refuse every non-GET request")
    .option("--include <glob>", "Only include tools matching this glob (repeatable)", collect, [])
    .option("--exclude <glob>", "Exclude tools matching this glob (repeatable)", collect, []);
}

function splitEnvList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolvedFilter(ctx: Ctx, opts: Record<string, any>) {
  const readOnly = opts.readOnly ?? ctx.env.OKTA_MCP_READ_ONLY === "1";
  const include: string[] = opts.include && opts.include.length > 0 ? opts.include : splitEnvList(ctx.env.OKTA_MCP_INCLUDE);
  const exclude: string[] = opts.exclude && opts.exclude.length > 0 ? opts.exclude : splitEnvList(ctx.env.OKTA_MCP_EXCLUDE);
  return { readOnly, include, exclude };
}

function buildDefs(ctx: Ctx, buildProgramFn: () => Command, opts: Record<string, any>): ToolDef[] {
  const filter = resolvedFilter(ctx, opts);
  return filterCatalog(buildCatalog(buildProgramFn()), filter);
}

export function registerMcp(parent: Command, ctx: Ctx, buildProgramFn: () => Command): Command {
  const mcp = subgroup(parent, "mcp", "Serve the CLI as an MCP server (streamable HTTP or stdio)");

  addOutputOptions(addVerbose(addCatalogOptions(mcp.command("tools").description("List the MCP tool catalog"))), "name,readOnly,description")
    .action(action(ctx, (_client, opts) => buildDefs(ctx, buildProgramFn, opts).map((d) => ({ name: d.name, readOnly: d.readOnly, description: d.description })), { client: false }));

  addVerbose(addCatalogOptions(mcp.command("serve").description("Serve the CLI as an MCP server over streamable HTTP")
    .option("--host <host>", "Bind host")
    .option("--port <n>", "Bind port", int)
    .option("--path <path>", "HTTP path for the MCP endpoint")))
    .action(action(ctx, async (_client, opts) => {
      const defs = buildDefs(ctx, buildProgramFn, opts);
      const filter = resolvedFilter(ctx, opts);
      const host = opts.host ?? ctx.env.OKTA_MCP_HOST ?? "127.0.0.1";
      const port = opts.port ?? int(ctx.env.OKTA_MCP_PORT ?? "8000");
      const path = opts.path ?? "/mcp";
      let clientP: Promise<OktaClient> | undefined;
      const getClient = () => {
        clientP ??= ctx.getClient(0).then((c) => (filter.readOnly ? readOnlyClient(c) : c));
        clientP.catch(() => { clientP = undefined; });
        return clientP;
      };
      const deps = {
        defs,
        version: VERSION,
        log: (l: string) => ctx.io.err(l + "\n"),
        invoke: (d: ToolDef, i: Record<string, unknown>) => invokeTool(d, i, { getClient, env: ctx.env, now: ctx.now }),
      };
      const http = serveHttp(deps, { host, port, path });
      ctx.io.err(`okta-cli mcp: serving ${defs.length} tools at ${http.url}${path} (read-only: ${filter.readOnly ? "yes" : "no"})\n`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      http.stop();
      return undefined;
    }, { client: false }));

  addVerbose(addCatalogOptions(mcp.command("stdio").description("Serve the CLI as an MCP server over stdio")))
    .action(action(ctx, async (_client, opts) => {
      const defs = buildDefs(ctx, buildProgramFn, opts);
      const filter = resolvedFilter(ctx, opts);
      let clientP: Promise<OktaClient> | undefined;
      const getClient = () => {
        clientP ??= ctx.getClient(0).then((c) => (filter.readOnly ? readOnlyClient(c) : c));
        clientP.catch(() => { clientP = undefined; });
        return clientP;
      };
      const deps = {
        defs,
        version: VERSION,
        log: (l: string) => ctx.io.err(l + "\n"),
        invoke: (d: ToolDef, i: Record<string, unknown>) => invokeTool(d, i, { getClient, env: ctx.env, now: ctx.now }),
      };
      ctx.io.err(`okta-cli mcp: serving ${defs.length} tools over stdio (read-only: ${filter.readOnly ? "yes" : "no"})\n`);
      await serveStdio(deps);
      return undefined;
    }, { client: false }));

  return mcp;
}
