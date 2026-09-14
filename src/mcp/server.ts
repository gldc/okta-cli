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
  let port: number = opts.port;
  const bunServer = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true, tools: deps.defs.length, version: deps.version });
      }
      if (url.pathname !== opts.path) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      // DNS rebinding protection only makes sense for a loopback bind with a fixed Host header;
      // a 0.0.0.0 bind (Docker, behind a gateway) can see any Host a proxy forwards.
      const isLoopback = opts.host === "127.0.0.1" || opts.host === "localhost";
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(isLoopback ? { enableDnsRebindingProtection: true, allowedHosts: [`${opts.host}:${port}`] } : {}),
      });
      const server = createMcpServer(deps);
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      queueMicrotask(() => {
        transport.close();
        server.close();
      });
      return res;
    },
  });

  port = bunServer.port ?? opts.port;
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
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // The SDK's StdioServerTransport only wires 'data'/'error' on stdin - it never notices EOF,
    // so transport.onclose alone never fires when the client just closes its end. Watch stdin
    // directly, and chain (not clobber) whatever onclose the SDK/Protocol already installed.
    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      done();
    };
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
}
