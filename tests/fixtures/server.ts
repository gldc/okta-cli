export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export interface Route {
  method: Method;
  path: string | RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  handler?: (req: Request, url: URL, bodyJson: unknown) => Response | Promise<Response>;
}
export interface Call { method: string; path: string; query: Record<string, string>; body: unknown }

export function startServer(routes: Route[]) {
  const table = [...routes];
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let bodyJson: unknown = undefined;
      if (text) { try { bodyJson = JSON.parse(text); } catch { bodyJson = text; } }
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: bodyJson });
      const route = table.find((r) => r.method === req.method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
      if (!route) return Response.json({ errorSummary: `no route for ${req.method} ${url.pathname}` }, { status: 500 });
      if (route.handler) return route.handler(req, url, bodyJson);
      const status = route.status ?? (route.body === undefined ? 204 : 200);
      const headers = { ...(route.headers ?? {}) };
      if (route.body === undefined) return new Response(null, { status, headers });
      return Response.json(route.body, { status, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    add(route: Route) { table.unshift(route); },
    stop() { server.stop(true); },
  };
}
