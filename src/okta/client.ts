import { isPlainObject } from "../lib/dotted";
import { CommunicationError, OktaApiError, type OktaErrorBody } from "./errors";

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type Query = Record<string, string | number | boolean | undefined>;
export interface RequestOptions { query?: Query; body?: unknown; basePath?: string; headers?: Record<string, string> }
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  verbosity?: number;
}

const MAX_RETRIES = 10;

export function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = part.trim().match(/^<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

// A page's next-page hint: a Link header, falling back to a body `_links.next.href`
// (some list endpoints, e.g. roles/resource-sets/assignees, only expose the latter).
function nextLinkFallback(linkHeader: string | null, raw: unknown): string | undefined {
  return parseNextLink(linkHeader) ?? (isPlainObject(raw) ? (raw as any)._links?.next?.href : undefined);
}

// Mirrors json()'s empty-body guard: a 200 with an empty body on a list endpoint is `[]`,
// not a JSON parse error.
async function readJsonPage(rsp: Response): Promise<unknown> {
  const text = await rsp.text();
  return text.length === 0 ? [] : JSON.parse(text);
}

export function stripLinks<T extends object>(v: T[]): Omit<T, "_links">[];
export function stripLinks<T extends object>(v: T): Omit<T, "_links">;
export function stripLinks(v: unknown): unknown;
export function stripLinks(v: any): any {
  if (Array.isArray(v)) return v.map(stripLinks);
  if (typeof v === "object" && v !== null) {
    const { _links, ...rest } = v;
    return rest;
  }
  return v;
}

export class OktaClient {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly verbosity: number;

  constructor(url: string, token: string, opts: ClientOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: `SSWS ${token}` };
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
    this.verbosity = opts.verbosity ?? 0;
  }

  buildUrl(path: string, query?: Query, basePath = "/api/v1"): string {
    let full: URL;
    if (/^https?:\/\//.test(path)) full = new URL(path);
    else {
      const base = basePath.replace(/^\/+|\/+$/g, "");
      const p = path.replace(/^\/+/, "");
      full = new URL(`${this.url}/${[base, p].filter(Boolean).join("/")}`);
    }
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) full.searchParams.set(k, String(v));
    return full.toString();
  }

  async request(method: Method, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, opts.query, opts.basePath);
    const init: RequestInit = { method, headers: opts.headers ? { ...this.headers, ...opts.headers } : this.headers };
    if (opts.body !== undefined && method !== "GET") init.body = JSON.stringify(opts.body);
    if (this.verbosity >= 1) this.log(`> ${method} ${url}`);
    if (this.verbosity >= 3 && init.body) this.log(`> ${init.body}`);
    for (let attempt = 0; ; attempt++) {
      let rsp: Response;
      try {
        rsp = await this.fetchImpl(url, init);
      } catch (e) {
        throw new CommunicationError((e as Error).message);
      }
      if (this.verbosity >= 2) this.log(`< ${rsp.status}`);
      if (this.verbosity >= 3) this.log(`< ${JSON.stringify(Object.fromEntries(rsp.headers))}`);
      if (rsp.status === 429) {
        if (attempt >= MAX_RETRIES) throw new CommunicationError(`rate limited: gave up after ${MAX_RETRIES} retries`);
        const reset = Number(rsp.headers.get("X-Rate-Limit-Reset") ?? 0);
        const delaySec = Math.max(1, Math.floor(reset - Date.now() / 1000));
        await this.sleep(delaySec * 1000);
        continue;
      }
      if (rsp.status >= 500) throw new CommunicationError(`HTTP ${rsp.status} ${rsp.statusText} for ${method} ${url}`);
      if (rsp.status >= 400) {
        const text = await rsp.text();
        let body: OktaErrorBody;
        try { body = JSON.parse(text); } catch { body = { errorSummary: text || rsp.statusText }; }
        throw new OktaApiError(body, rsp.status);
      }
      return rsp;
    }
  }

  json(method: Method, path: string, opts?: RequestOptions): Promise<any>;
  json<T>(method: Method, path: string, opts?: RequestOptions): Promise<T>;
  async json<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const rsp = await this.request(method, path, opts);
    const text = await rsp.text();
    if (rsp.status === 204 || text.length === 0) return undefined as T;
    return stripLinks(JSON.parse(text)) as T;
  }

  get(path: string, query?: Query): Promise<any>;
  get<T>(path: string, query?: Query): Promise<T>;
  get<T>(path: string, query?: Query): Promise<T> {
    return this.json<T>("GET", path, { query });
  }

  getAll(path: string, opts?: RequestOptions & { max?: number; listKey?: string }): Promise<any[]>;
  getAll<T>(path: string, opts?: RequestOptions & { max?: number; listKey?: string }): Promise<T[]>;
  async getAll<T>(path: string, opts: RequestOptions & { max?: number; listKey?: string } = {}): Promise<T[]> {
    const out: T[] = [];
    let rsp = await this.request("GET", path, opts);
    let lastUrl: string | undefined;
    for (;;) {
      const raw = await readJsonPage(rsp);
      const page = (opts.listKey ? (raw as Record<string, unknown>)[opts.listKey] : raw) as T[] | undefined;
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...((page as unknown[]).map(stripLinks) as T[]));
      if (opts.max !== undefined && out.length >= opts.max) break;
      const next = nextLinkFallback(rsp.headers.get("link"), raw);
      if (!next || next === lastUrl) break;
      lastUrl = next;
      rsp = await this.request("GET", next);
    }
    return opts.max !== undefined ? out.slice(0, opts.max) : out;
  }

  getAuto(path: string, opts?: RequestOptions): Promise<any>;
  getAuto<T>(path: string, opts?: RequestOptions): Promise<T>;
  async getAuto<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const rsp = await this.request("GET", path, opts);
    const text = await rsp.text();
    if (!text) return undefined as T;
    const first = JSON.parse(text);
    if (!Array.isArray(first)) return stripLinks(first) as T;
    const out: unknown[] = first.map(stripLinks);
    let next = nextLinkFallback(rsp.headers.get("link"), first);
    let last: string | undefined;
    while (next && next !== last && out.length) {
      last = next;
      const r = await this.request("GET", next);
      const page = (await readJsonPage(r)) as unknown[];
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page.map(stripLinks));
      next = nextLinkFallback(r.headers.get("link"), page);
    }
    return out as T;
  }
}
