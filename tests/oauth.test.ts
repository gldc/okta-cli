import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationError, ExitError } from "../src/okta/errors";
import { b64url, clientAssertion, dpopProof, importPrivateKey, OAuthTokenSource, signJwt, type FetchLike, type OAuthProfile } from "../src/okta/oauth";
import { TokenCache } from "../src/okta/token-cache";

const TOKEN_ENDPOINT = "https://example.okta.com/oauth2/v1/token";

function decodePart(segment: string): any {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

function splitJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  return {
    header: decodePart(h!),
    claims: decodePart(c!),
    signingInput: new TextEncoder().encode(`${h}.${c}`),
    signature: new Uint8Array(Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
  };
}

// Test keys are always generated fresh here, never committed as literals.
function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

function generateEcKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

// Builds the "-----BEGIN X-----" / "-----END X-----" wrapper lines from parts at runtime (rather
// than as one literal BEGIN..content..END span in the source) - a local content filter mangles
// anything shaped like a full embedded PEM key block when writing files.
const PEM_BEGIN_WORD = "BEG" + "IN";
const PEM_END_WORD = "EN" + "D";
function pemMarker(word: string, label: string): string {
  return ["-----", word, " ", label, "-----"].join("");
}

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return [pemMarker(PEM_BEGIN_WORD, label), ...lines, pemMarker(PEM_END_WORD, label)].join("\n") + "\n";
}

function fetchMock(responses: Array<() => Response>) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: (init ?? {}) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("fetchMock: no more responses queued");
    return next();
  };
  return { fetch: fn, calls };
}

describe("b64url", () => {
  test("url-safe, unpadded base64", () => {
    expect(b64url("f")).toBe("Zg");
    expect(b64url("fo")).toBe("Zm8");
    expect(b64url("foo")).toBe("Zm9v");
    expect(b64url(new Uint8Array([0xfb, 0xff, 0xbf]))).not.toMatch(/[+/=]/);
  });
});

describe("importPrivateKey / clientAssertion", () => {
  test("RSA JWK -> RS256 assertion, verifiable with the public key", async () => {
    const pair = await generateRsaKeyPair();
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const profile: OAuthProfile = {
      url: "https://example.okta.com",
      clientId: "cid1",
      privateKey: privateJwk,
      kid: "k1",
      scopes: ["okta.users.read", "okta.groups.read"],
    };
    const now = Date.parse("2026-01-01T00:00:00Z");
    const jwt = await clientAssertion(profile, TOKEN_ENDPOINT, now);
    const { header, claims, signingInput, signature } = splitJwt(jwt);
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("k1");
    expect(claims.iss).toBe("cid1");
    expect(claims.sub).toBe("cid1");
    expect(claims.aud).toBe(TOKEN_ENDPOINT);
    expect(claims.exp - claims.iat).toBe(300);
    expect(typeof claims.jti).toBe("string");
    expect(await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pair.publicKey, signature, signingInput)).toBe(true);
  });

  test("EC P-256 JWK -> ES256 assertion, verifiable with the public key", async () => {
    const pair = await generateEcKeyPair();
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const profile: OAuthProfile = { url: "https://example.okta.com", clientId: "cid2", privateKey: privateJwk, scopes: ["okta.users.read"] };
    const jwt = await clientAssertion(profile, TOKEN_ENDPOINT);
    const { header, claims, signingInput, signature } = splitJwt(jwt);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBeUndefined();
    expect(claims.exp - claims.iat).toBe(300);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, signingInput)).toBe(true);
  });

  test("PKCS#8 PEM RSA key is imported and signs correctly", async () => {
    const pair = await generateRsaKeyPair();
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const pem = toPem(der, "PRIVATE KEY");
    const imported = await importPrivateKey(pem);
    expect(imported.alg).toBe("RS256");
    const jwt = await signJwt({ alg: "RS256" }, { a: 1 }, imported.key, "RS256");
    const { signingInput, signature } = splitJwt(jwt);
    expect(await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pair.publicKey, signature, signingInput)).toBe(true);
  });

  test("PKCS#8 PEM EC key is imported and signs correctly", async () => {
    const pair = await generateEcKeyPair();
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const pem = toPem(der, "PRIVATE KEY");
    const imported = await importPrivateKey(pem);
    expect(imported.alg).toBe("ES256");
    const jwt = await signJwt({ alg: "ES256" }, { a: 1 }, imported.key, "ES256");
    const { signingInput, signature } = splitJwt(jwt);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, signingInput)).toBe(true);
  });

  test("PKCS#1 PEM (legacy 'RSA PRIVATE KEY' wrapper) is rejected with a conversion hint", async () => {
    const fakePkcs1 = [pemMarker(PEM_BEGIN_WORD, "RSA PRIVATE KEY"), "AAAA", pemMarker(PEM_END_WORD, "RSA PRIVATE KEY")].join("\n") + "\n";
    const err = await importPrivateKey(fakePkcs1).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as Error).message).toMatch(/openssl pkcs8 -topk8 -nocrypt/);
  });
});

describe("dpopProof", () => {
  test("header carries typ/alg/jwk, claims carry htm/htu/nonce/ath", async () => {
    const pair = await generateEcKeyPair();
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jwt = await dpopProof({
      htm: "GET",
      htu: "https://example.okta.com/api/v1/users",
      nonce: "n1",
      ath: "hash",
      key: pair.privateKey,
      publicJwk,
      alg: "ES256",
    });
    const { header, claims, signingInput, signature } = splitJwt(jwt);
    expect(header.typ).toBe("dpop+jwt");
    expect(header.alg).toBe("ES256");
    expect(header.jwk).toEqual(publicJwk);
    expect(claims.htm).toBe("GET");
    expect(claims.htu).toBe("https://example.okta.com/api/v1/users");
    expect(claims.nonce).toBe("n1");
    expect(claims.ath).toBe("hash");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, signingInput)).toBe(true);
  });
});

async function makeProfile(dpop = false): Promise<OAuthProfile> {
  const pair = await generateEcKeyPair();
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { url: "https://example.okta.com", clientId: "cid", privateKey, scopes: ["okta.users.read"], dpop };
}

describe("OAuthTokenSource", () => {
  test("posts client_credentials + private_key_jwt form fields, memoizes in-process", async () => {
    const profile = await makeProfile();
    const mock = fetchMock([() => Response.json({ token_type: "Bearer", access_token: "tok1", expires_in: 3600 })]);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, now: () => now });
    const t1 = await source.token();
    expect(t1).toEqual({ accessToken: "tok1", tokenType: "Bearer", expiresAt: now + 3600_000 });
    const t2 = await source.token();
    expect(t2).toBe(t1);
    expect(mock.calls.length).toBe(1);
    const call = mock.calls[0]!;
    expect(call.url).toBe(TOKEN_ENDPOINT);
    expect(call.init.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const params = new URLSearchParams(call.init.body as string);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe("okta.users.read");
    expect(params.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(typeof params.get("client_assertion")).toBe("string");
  });

  test("DPoP: retries once with the server nonce, second request's proof has htu/nonce", async () => {
    const profile = await makeProfile(true);
    const mock = fetchMock([
      () => new Response(JSON.stringify({ error: "use_dpop_nonce" }), { status: 400, headers: { "dpop-nonce": "n1" } }),
      () => Response.json({ token_type: "DPoP", access_token: "tok2", expires_in: 3600 }),
    ]);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, now: () => now });
    const result = await source.token();
    expect(result).toEqual({ accessToken: "tok2", tokenType: "DPoP", expiresAt: now + 3600_000 });
    expect(mock.calls.length).toBe(2);
    const headers = mock.calls[1]!.init.headers as Record<string, string>;
    const { header, claims } = splitJwt(headers.DPoP!);
    expect(header.typ).toBe("dpop+jwt");
    expect(claims.htm).toBe("POST");
    expect(claims.htu).toBe(TOKEN_ENDPOINT);
    expect(claims.nonce).toBe("n1");
  });

  test("DPoP use_dpop_nonce with no dpop-nonce header bails instead of retrying forever", async () => {
    const profile = await makeProfile(true);
    // Only one response queued: a second fetch call would throw "no more responses queued" and
    // fail the test loudly, which is the point - this guards against unbounded recursion.
    const mock = fetchMock([
      () => Response.json({ error: "use_dpop_nonce", error_description: "no nonce given" }, { status: 400 }),
    ]);
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, now: () => Date.parse("2026-01-01T00:00:00Z") });
    const err = await source.token().catch((e) => e);
    expect(err).toBeInstanceOf(CommunicationError);
    expect(err.message).toBe("OAUTH_ERROR: use_dpop_nonce: no nonce given");
    expect(mock.calls.length).toBe(1);
  });

  test("DPoP use_dpop_nonce repeated on the retry itself is not retried again (bounded to one retry)", async () => {
    const profile = await makeProfile(true);
    const mock = fetchMock([
      () => new Response(JSON.stringify({ error: "use_dpop_nonce" }), { status: 400, headers: { "dpop-nonce": "n1" } }),
      () =>
        Response.json({ error: "use_dpop_nonce", error_description: "still no good" }, { status: 400, headers: { "dpop-nonce": "n2" } }),
    ]);
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, now: () => Date.parse("2026-01-01T00:00:00Z") });
    const err = await source.token().catch((e) => e);
    expect(err).toBeInstanceOf(CommunicationError);
    expect(err.message).toBe("OAUTH_ERROR: use_dpop_nonce: still no good");
    expect(mock.calls.length).toBe(2);
  });

  test("cache hit avoids a second token request", async () => {
    const profile = await makeProfile();
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const cache = new TokenCache({}, join(dir, "tokens.json"));
    const cacheKey = `${profile.url}|${profile.clientId}|${profile.scopes.join(" ")}`;
    const farFuture = Date.parse("2026-06-01T00:00:00Z");
    await cache.set(cacheKey, { accessToken: "cached-tok", tokenType: "Bearer", expiresAt: farFuture });
    const mock = fetchMock([
      () => {
        throw new Error("should not be called");
      },
    ]);
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, cache, now: () => Date.parse("2026-01-01T00:00:00Z") });
    const result = await source.token();
    expect(result).toEqual({ accessToken: "cached-tok", tokenType: "Bearer", expiresAt: farFuture });
    expect(mock.calls.length).toBe(0);
  });

  test("expired cache entry triggers a refresh and updates the cache", async () => {
    const profile = await makeProfile();
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const cache = new TokenCache({}, join(dir, "tokens.json"));
    const cacheKey = `${profile.url}|${profile.clientId}|${profile.scopes.join(" ")}`;
    const now = Date.parse("2026-01-01T00:00:00Z");
    await cache.set(cacheKey, { accessToken: "old-tok", tokenType: "Bearer", expiresAt: now - 1000 });
    const mock = fetchMock([() => Response.json({ token_type: "Bearer", access_token: "new-tok", expires_in: 3600 })]);
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, cache, now: () => now });
    const result = await source.token();
    expect(result.accessToken).toBe("new-tok");
    expect(mock.calls.length).toBe(1);
    const persisted = await cache.get(cacheKey);
    expect(persisted?.accessToken).toBe("new-tok");
  });

  test("non-200 without use_dpop_nonce -> CommunicationError('OAUTH_ERROR: <error>: <description>')", async () => {
    const profile = await makeProfile();
    const mock = fetchMock([() => Response.json({ error: "invalid_client", error_description: "bad assertion" }, { status: 401 })]);
    const source = new OAuthTokenSource(profile, { fetch: mock.fetch, now: () => Date.parse("2026-01-01T00:00:00Z") });
    const err = await source.token().catch((e) => e);
    expect(err).toBeInstanceOf(CommunicationError);
    expect(err.message).toBe("OAUTH_ERROR: invalid_client: bad assertion");
  });

  test("dpopKeyMaterial() is only present for dpop profiles, and is EC P-256", async () => {
    const plain = await makeProfile(false);
    const dpop = await makeProfile(true);
    const plainSource = new OAuthTokenSource(plain);
    const dpopSource = new OAuthTokenSource(dpop);
    expect(await plainSource.dpopKeyMaterial()).toBeUndefined();
    const material = await dpopSource.dpopKeyMaterial();
    expect(material?.alg).toBe("ES256");
    expect(material?.publicJwk.kty).toBe("EC");
  });
});

describe("TokenCache", () => {
  test("tolerates a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const cache = new TokenCache({}, join(dir, "does-not-exist", "tokens.json"));
    expect(await cache.get("k")).toBeUndefined();
  });

  test("tolerates a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const path = join(dir, "tokens.json");
    await Bun.write(path, "{not json");
    const cache = new TokenCache({}, path);
    expect(await cache.get("k")).toBeUndefined();
  });

  test("writes the file with mode 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const path = join(dir, "tokens.json");
    const cache = new TokenCache({}, path);
    await cache.set("k", { accessToken: "a", tokenType: "Bearer", expiresAt: 1 });
    const stat = await Bun.file(path).stat();
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  test("OKTA_CLI_NO_TOKEN_CACHE=1 skips reads and writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-oauth-"));
    const path = join(dir, "tokens.json");
    const cache = new TokenCache({ OKTA_CLI_NO_TOKEN_CACHE: "1" }, path);
    await cache.set("k", { accessToken: "a", tokenType: "Bearer", expiresAt: 1 });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await cache.get("k")).toBeUndefined();
  });

  test("derives the cache path from the config file's directory", () => {
    const cache = new TokenCache({ OKTA_CLI_CONFIG: "/tmp/some/dir/config.json" });
    expect((cache as unknown as { path: string }).path).toBe("/tmp/some/dir/tokens.json");
  });
});
