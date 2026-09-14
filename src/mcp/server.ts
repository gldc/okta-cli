import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toCallToolResult, type InvokeResult } from "./invoke";
import type { ToolDef } from "./catalog";

export interface ServerDeps {
  defs: ToolDef[];
  invoke: (def: ToolDef, input: Record<string, unknown>) => Promise<InvokeResult>;
  log: (line: string) => void;
  version: string;
}

export function createMcpServer(deps: ServerDeps): Server {
  const server = new Server({ name: "okta-cli", version: deps.version }, { capabilities: { tools: {} } });
  const byName = new Map(deps.defs.map((d) => [d.name, d]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      annotations: d.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const def = byName.get(name);
    if (!def) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    const t0 = performance.now();
    const r = await deps.invoke(def, (args ?? {}) as Record<string, unknown>);
    deps.log(`mcp tool=${def.name} code=${r.code} ms=${Math.round(performance.now() - t0)}`);
    return toCallToolResult(r);
  });

  return server;
}

export interface HttpOptions {
  host: string;
  port: number;
  path: string;
}

export function serveHttp(deps: ServerDeps, opts: HttpOptions): { url: string; port: number; stop(): void } {
  const bunServer = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true, tools: deps.defs.length, version: deps.version });
      }
      if (url.pathname !== opts.path) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = createMcpServer(deps);
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });

  const port = bunServer.port ?? opts.port;
  return {
    url: `http://${opts.host}:${port}`,
    port,
    stop: () => bunServer.stop(true),
  };
}

export async function serveStdio(deps: ServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
