import { isPlainObject } from "../lib/dotted";
import { CommunicationError, OktaApiError, type OktaErrorBody } from "./errors";
import { dpopAth, dpopProof, type OAuthTokenSource } from "./oauth";

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type Query = Record<string, string | number | boolean | undefined>;
export interface RequestOptions { query?: Query; body?: unknown; basePath?: string; headers?: Record<string, string> }
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  verbosity?: number;
}

// Either form the constructor accepts, once the bare-string SSWS shorthand is normalized away.
export type ClientAuth = { kind: "ssws"; token: string } | { kind: "oauth"; source: OAuthTokenSource };

const MAX_RETRIES = 10;

// Header names whose values must never reach the verbose (-vvv) request/response log.
const SENSITIVE_HEADERS = new Set(["authorization", "dpop"]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  return out;
}

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
  private readonly auth: ClientAuth;
  private readonly baseHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly verbosity: number;

  // `token` is shorthand for `{ kind: "ssws", token }` - every existing caller keeps working
  // unchanged; a config profile using an OAuth service app instead passes `{ kind: "oauth",
  // source }` (src/cli/client-factory.ts builds one from the profile).
  constructor(url: string, auth: string | ClientAuth, opts: ClientOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.auth = typeof auth === "string" ? { kind: "ssws", token: auth } : auth;
    this.baseHeaders = { "Content-Type": "application/json", Accept: "application/json" };
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

  // Authorization (+ DPoP proof, when the token is DPoP-bound) for one attempt at one request.
  // SSWS is static; OAuth fetches/caches a token per call (OAuthTokenSource memoizes) and, for
  // DPoP, signs a fresh proof every attempt since its `jti`/`iat`/`nonce` can't be reused.
  private async authHeaders(method: Method, url: string, dpopNonce?: string): Promise<Record<string, string>> {
    if (this.auth.kind === "ssws") return { Authorization: `SSWS ${this.auth.token}` };
    const { accessToken, tokenType } = await this.auth.source.token();
    if (tokenType !== "DPoP") return { Authorization: `Bearer ${accessToken}` };
    const material = await this.auth.source.dpopKeyMaterial();
    if (!material) return { Authorization: `Bearer ${accessToken}` };
    const htu = url.split("?")[0]!;
    const ath = await dpopAth(accessToken);
    const proof = await dpopProof({ htm: method, htu, nonce: dpopNonce, ath, key: material.key, publicJwk: material.publicJwk, alg: material.alg });
    return { Authorization: `DPoP ${accessToken}`, DPoP: proof };
  }

  // Shared fetch + retry/error-handling loop for both JSON (request()) and multipart (upload())
  // bodies - only the URL/init differ between callers. Auth headers are (re)computed every
  // attempt rather than by the caller, since an OAuth/DPoP retry needs a fresh token and/or proof.
  private async send(method: Method, url: string, init: RequestInit): Promise<Response> {
    const staticHeaders = (init.headers ?? {}) as Record<string, string>;
    let dpopNonce: string | undefined;
    let dpopNonceRetried = false;
    let invalidTokenRetried = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { ...staticHeaders, ...(await this.authHeaders(method, url, dpopNonce)) };
      if (this.verbosity >= 1) this.log(`> ${method} ${url}`);
      if (this.verbosity >= 3 && typeof init.body === "string") this.log(`> ${init.body}`);
      if (this.verbosity >= 3) this.log(`> ${JSON.stringify(redactHeaders(headers))}`);
      let rsp: Response;
      try {
        rsp = await this.fetchImpl(url, { ...init, headers });
      } catch (e) {
        throw new CommunicationError((e as Error).message);
      }
      if (this.verbosity >= 2) this.log(`< ${rsp.status}`);
      if (this.verbosity >= 3) this.log(`< ${JSON.stringify(redactHeaders(Object.fromEntries(rsp.headers)))}`);
      if (rsp.status === 429) {
        if (attempt >= MAX_RETRIES) throw new CommunicationError(`rate limited: gave up after ${MAX_RETRIES} retries`);
        const reset = Number(rsp.headers.get("X-Rate-Limit-Reset") ?? 0);
        const delaySec = Math.max(1, Math.floor(reset - Date.now() / 1000));
        await this.sleep(delaySec * 1000);
        continue;
      }
      if (rsp.status === 401 && this.auth.kind === "oauth") {
        const wwwAuth = rsp.headers.get("www-authenticate") ?? "";
        if (!dpopNonceRetried && /use_dpop_nonce/.test(wwwAuth)) {
          const nonce = rsp.headers.get("dpop-nonce");
          if (nonce) {
            dpopNonceRetried = true;
            dpopNonce = nonce;
            continue;
          }
        }
        if (!invalidTokenRetried && /invalid_token/.test(wwwAuth)) {
          invalidTokenRetried = true;
          await this.auth.source.forceRefresh();
          continue;
        }
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

  async request(method: Method, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, opts.query, opts.basePath);
    const init: RequestInit = { method, headers: opts.headers ? { ...this.baseHeaders, ...opts.headers } : this.baseHeaders };
    // A string body (e.g. a raw SET JWT for security-events send) or raw bytes (e.g. a
    // certificate file for csr-publish) is sent as-is rather than JSON-encoded - every
    // other caller's body is an object/array from parseBody/bodyFromOpts.
    if (opts.body !== undefined && method !== "GET") init.body = (typeof opts.body === "string" || opts.body instanceof Uint8Array ? opts.body : JSON.stringify(opts.body)) as BodyInit;
    return this.send(method, url, init);
  }

  // Multipart upload (brand/theme logos, favicons, OIN logos, ...): posts fieldName=Bun.file(filePath)
  // as a FormData body. Drops the JSON Content-Type header so fetch sets its own multipart boundary;
  // Authorization/Accept are kept.
  async upload(path: string, fieldName: string, filePath: string, opts: RequestOptions = {}): Promise<any> {
    const url = this.buildUrl(path, opts.query, opts.basePath);
    const { "Content-Type": _contentType, ...withoutContentType } = this.baseHeaders;
    const headers = opts.headers ? { ...withoutContentType, ...opts.headers } : withoutContentType;
    const form = new FormData();
    form.append(fieldName, Bun.file(filePath));
    const rsp = await this.send("POST", url, { method: "POST", headers, body: form });
    const text = await rsp.text();
    if (rsp.status === 204 || text.length === 0) return undefined;
    return stripLinks(JSON.parse(text));
  }

  // Shared JSON-response parsing (empty-body guard + stripLinks) - used by json() and by
  // publishCsr (resource.ts), which sends a raw byte body via request() directly but still
  // wants the response parsed the same way as every other JSON-returning call.
  async parseJson<T>(rsp: Response): Promise<T> {
    const text = await rsp.text();
    if (rsp.status === 204 || text.length === 0) return undefined as T;
    return stripLinks(JSON.parse(text)) as T;
  }

  json(method: Method, path: string, opts?: RequestOptions): Promise<any>;
  json<T>(method: Method, path: string, opts?: RequestOptions): Promise<T>;
  async json<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const rsp = await this.request(method, path, opts);
    return this.parseJson<T>(rsp);
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
