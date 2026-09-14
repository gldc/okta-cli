import { CommunicationError, ExitError } from "./errors";
import type { TokenCache } from "./token-cache";

export interface OAuthProfile {
  url: string;
  clientId: string;
  privateKey: JsonWebKey | string; // JWK object, or a PEM string
  kid?: string;
  scopes: string[];
  dpop?: boolean;
}

export type SigningAlg = "RS256" | "ES256";

export interface ImportedKey {
  key: CryptoKey;
  alg: SigningAlg;
  kid?: string;
  publicJwk?: JsonWebKey;
}

// base64url (no padding) of a UTF-8 string or raw bytes.
export function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base64 = Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const buf = Buffer.from(base64, "base64");
  // A fresh, non-shared ArrayBuffer - Buffer.from's own .buffer can be a pooled/shared backing
  // store that Web Crypto's BufferSource type refuses.
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

// Strips the private-only members of a JWK, leaving only the public ones.
function toPublicJwk(jwk: JsonWebKey): JsonWebKey {
  const { d, p, q, dp, dq, qi, oth, ...pub } = jwk as JsonWebKey & Record<string, unknown>;
  return pub as JsonWebKey;
}

async function importJwkPrivateKey(jwk: JsonWebKey): Promise<ImportedKey> {
  // `kid` isn't part of the standard-library JsonWebKey type (it's a JWK member the crypto
  // libs don't model) but Okta's own JWKS entries carry one, so read it defensively.
  const kid = (jwk as JsonWebKey & { kid?: string }).kid;
  if (jwk.kty === "EC") {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: jwk.crv ?? "P-256" }, false, ["sign"]);
    return { key, alg: "ES256", kid, publicJwk: toPublicJwk(jwk) };
  }
  if (jwk.kty === "RSA") {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    return { key, alg: "RS256", kid, publicJwk: toPublicJwk(jwk) };
  }
  throw new ExitError(`Unsupported private key type: '${jwk.kty}'. Expected an RSA or EC (P-256) JWK.`);
}

async function importPemPrivateKey(pem: string): Promise<ImportedKey> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new ExitError(
      "Private key is in PKCS#1 format ('-----BEGIN RSA PRIVATE KEY-----'), which is not supported. " +
        "Convert it to PKCS#8 first: openssl pkcs8 -topk8 -nocrypt -in <your-key.pem> -out <your-key-pkcs8.pem>",
    );
  }
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new ExitError("Unsupported private key PEM: expected a PKCS#8 '-----BEGIN PRIVATE KEY-----' block.");
  }
  const der = pemToDer(pem);
  try {
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    return { key, alg: "RS256", publicJwk: toPublicJwk(jwk) };
  } catch (e) {
    if (e instanceof ExitError) throw e;
  }
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { key, alg: "ES256", publicJwk: toPublicJwk(jwk) };
}

// Imports a service app's private key (JWK object or PEM string) for signing the client
// assertion / DPoP proofs. RSA -> RS256, EC P-256 -> ES256. PKCS#1 PEM ("BEGIN RSA PRIVATE
// KEY") is rejected with instructions to convert to PKCS#8 - Web Crypto's `pkcs8` importer
// only understands the newer container, and there is no reliable way to tell RSA from EC
// PKCS#1 apart without parsing ASN.1 by hand, so it is simplest (and matches what Okta's own
// docs recommend) to ask the user to convert once with openssl rather than us reimplementing
// a DER parser for a one-time setup step.
export async function importPrivateKey(key: JsonWebKey | string): Promise<ImportedKey> {
  return typeof key === "string" ? importPemPrivateKey(key) : importJwkPrivateKey(key);
}

// Signs a compact JWS (JWT): base64url(header) + "." + base64url(claims) + "." + base64url(signature).
export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey, alg: SigningAlg): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  const signature = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

// The private_key_jwt client assertion sent to the token endpoint (RFC 7523).
export async function clientAssertion(profile: OAuthProfile, tokenEndpoint: string, now: number = Date.now()): Promise<string> {
  const imported = await importPrivateKey(profile.privateKey);
  const iat = Math.floor(now / 1000);
  const kid = profile.kid ?? imported.kid;
  const header: Record<string, unknown> = { alg: imported.alg };
  if (kid) header.kid = kid;
  const claims = { iss: profile.clientId, sub: profile.clientId, aud: tokenEndpoint, iat, exp: iat + 300, jti: crypto.randomUUID() };
  return signJwt(header, claims, imported.key, imported.alg);
}

export interface DpopProofInput {
  htm: string;
  htu: string;
  nonce?: string;
  ath?: string;
  key: CryptoKey;
  publicJwk: JsonWebKey;
  alg: SigningAlg;
}

// A DPoP proof JWT (RFC 9449): header carries the ephemeral key's public JWK, claims carry the
// bound HTTP method/URL plus optional resource-server nonce and access-token hash (`ath`, only
// present once an access token exists to hash).
export async function dpopProof(input: DpopProofInput): Promise<string> {
  const header = { typ: "dpop+jwt", alg: input.alg, jwk: input.publicJwk };
  const claims: Record<string, unknown> = { htm: input.htm, htu: input.htu, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() };
  if (input.nonce) claims.nonce = input.nonce;
  if (input.ath) claims.ath = input.ath;
  return signJwt(header, claims, input.key, input.alg);
}

export interface DpopKeyMaterial {
  key: CryptoKey;
  alg: "ES256";
  publicJwk: JsonWebKey;
}

// The ephemeral DPoP key pair is generated once per process (crypto.subtle.generateKey, EC
// P-256) and reused for every proof - both the token endpoint's own DPoP dance and, later, the
// resource server's per-request proofs need the same key. Memoized at module scope so every
// OAuthTokenSource (and OktaClient, once it wires DPoP in) shares one key pair per process.
let dpopKeyMaterial: Promise<DpopKeyMaterial> | undefined;

export function getDpopKeyMaterial(): Promise<DpopKeyMaterial> {
  if (!dpopKeyMaterial) {
    dpopKeyMaterial = (async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const publicJwk: JsonWebKey = { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
      return { key: pair.privateKey, alg: "ES256" as const, publicJwk };
    })();
  }
  return dpopKeyMaterial;
}

// base64url(SHA-256(accessToken)) - the DPoP proof `ath` claim bound to a specific access token.
export async function dpopAth(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return b64url(new Uint8Array(digest));
}

export interface OAuthToken {
  accessToken: string;
  tokenType: "Bearer" | "DPoP";
  expiresAt: number; // epoch ms
}

// Looser than `typeof fetch`: Bun's global `fetch` also carries a required static `preconnect`
// property, which a plain mock function in tests has no reason to implement.
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OAuthTokenSourceOptions {
  fetch?: FetchLike;
  now?: () => number;
  cache?: TokenCache;
}

// Refresh this long before actual expiry so a slow request never races token expiry mid-flight.
const REFRESH_SKEW_MS = 60_000;

// Fetches (and caches) OAuth 2.0 client-credentials access tokens using private_key_jwt, with
// optional DPoP. Caches in memory for the life of the process and, when a TokenCache is given,
// on disk across processes - see token-cache.ts.
export class OAuthTokenSource {
  private readonly profile: OAuthProfile;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cache?: TokenCache;
  private readonly cacheKey: string;
  private memo?: OAuthToken;
  private inflight?: Promise<OAuthToken>;

  constructor(profile: OAuthProfile, opts: OAuthTokenSourceOptions = {}) {
    this.profile = profile;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.cache = opts.cache;
    this.cacheKey = `${profile.url}|${profile.clientId}|${profile.scopes.join(" ")}`;
  }

  private valid(token: OAuthToken | undefined, nowMs: number): token is OAuthToken {
    return !!token && token.expiresAt - REFRESH_SKEW_MS > nowMs;
  }

  async token(): Promise<OAuthToken> {
    const nowMs = this.now();
    if (this.valid(this.memo, nowMs)) return this.memo;
    if (this.cache) {
      const cached = await this.cache.get(this.cacheKey);
      if (this.valid(cached, nowMs)) {
        this.memo = cached;
        return cached;
      }
    }
    if (!this.inflight) {
      this.inflight = this.fetchToken(nowMs).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  // Exposes the process-wide ephemeral DPoP key pair for this profile, for callers (e.g.
  // OktaClient) that need to attach a DPoP proof to a resource-server request; undefined when
  // this profile doesn't use DPoP.
  async dpopKeyMaterial(): Promise<DpopKeyMaterial | undefined> {
    return this.profile.dpop ? getDpopKeyMaterial() : undefined;
  }

  // Forces a fresh token fetch, bypassing the in-memory memo and any on-disk cache - used by
  // OktaClient when the resource server rejects the current access token as invalid (401
  // invalid_token), which can happen before our own expiry-based refresh would have kicked in.
  async forceRefresh(): Promise<OAuthToken> {
    this.memo = undefined;
    if (!this.inflight) {
      this.inflight = this.fetchToken(this.now()).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetchToken(nowMs: number): Promise<OAuthToken> {
    const tokenEndpoint = `${this.profile.url.replace(/\/+$/, "")}/oauth2/v1/token`;
    const result = await this.requestToken(tokenEndpoint, nowMs);
    this.memo = result;
    if (this.cache) await this.cache.set(this.cacheKey, result);
    return result;
  }

  private async requestToken(tokenEndpoint: string, nowMs: number, dpopNonce?: string, retried = false): Promise<OAuthToken> {
    const assertion = await clientAssertion(this.profile, tokenEndpoint, nowMs);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: this.profile.scopes.join(" "),
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (this.profile.dpop) {
      const { key, alg, publicJwk } = await getDpopKeyMaterial();
      headers.DPoP = await dpopProof({ htm: "POST", htu: tokenEndpoint, nonce: dpopNonce, key, publicJwk, alg });
    }
    const rsp = await this.fetchImpl(tokenEndpoint, { method: "POST", headers, body: body.toString() });
    const text = await rsp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (rsp.status !== 200) {
      if (this.profile.dpop && !retried && parsed.error === "use_dpop_nonce") {
        const nonce = rsp.headers.get("dpop-nonce");
        // Only worth retrying if the server actually gave us a nonce to retry with - otherwise
        // it's the same request again, and `retried` alone would still bound this to one retry,
        // but there's no point spending it on a request we already know will fail the same way.
        if (nonce) return this.requestToken(tokenEndpoint, nowMs, nonce, true);
      }
      throw new CommunicationError(`OAUTH_ERROR: ${parsed.error ?? "unknown_error"}: ${parsed.error_description ?? rsp.statusText}`);
    }
    const tokenType: "Bearer" | "DPoP" = parsed.token_type === "DPoP" ? "DPoP" : "Bearer";
    const expiresIn = Number(parsed.expires_in ?? 3600);
    return { accessToken: String(parsed.access_token), tokenType, expiresAt: nowMs + expiresIn * 1000 };
  }
}
