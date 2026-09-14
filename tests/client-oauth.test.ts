import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient, profileKind } from "../src/cli/client-factory";
import { activeProfile, type OAuthProfileConfig } from "../src/config";
import { OktaClient } from "../src/okta/client";
import { ExitError } from "../src/okta/errors";
import { OAuthTokenSource, type FetchLike, type OAuthProfile } from "../src/okta/oauth";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

// Test keys are always generated fresh here, never committed as literals.
async function ecJwk(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

function decodePart(segment: string): any {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

// A stand-in for the Okta token endpoint: always returns the same canned response, regardless
// of the client assertion sent - only OktaClient's use of the resulting token is under test here.
function tokenFetch(response: Record<string, unknown>): FetchLike {
  return async () => Response.json(response);
}

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());
const noSleep = async () => {};

describe("OktaClient OAuth/DPoP auth", () => {
  test("a bare string is shorthand for {kind: 'ssws'}", async () => {
    srv = startServer([]);
    let seenAuth = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => { seenAuth = req.headers.get("authorization") ?? ""; return Response.json([]); } });
    await new OktaClient(srv.url, "tok", { sleep: noSleep }).get("/users");
    expect(seenAuth).toBe("SSWS tok");
    seenAuth = "";
    await new OktaClient(srv.url, { kind: "ssws", token: "tok" }, { sleep: noSleep }).get("/users");
    expect(seenAuth).toBe("SSWS tok");
  });

  test("oauth source with a Bearer token sets Authorization: Bearer <token>", async () => {
    srv = startServer([]);
    let seenAuth = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => { seenAuth = req.headers.get("authorization") ?? ""; return Response.json([]); } });
    const profile: OAuthProfile = { url: "https://example.okta.com", clientId: "c1", privateKey: await ecJwk(), scopes: ["okta.users.read"] };
    const source = new OAuthTokenSource(profile, { fetch: tokenFetch({ token_type: "Bearer", access_token: "tok", expires_in: 3600 }), now: () => 0 });
    const c = new OktaClient(srv.url, { kind: "oauth", source }, { sleep: noSleep });
    await c.get("/users");
    expect(seenAuth).toBe("Bearer tok");
  });

  test("oauth DPoP: a resource-server use_dpop_nonce challenge is retried once with the nonce", async () => {
    srv = startServer([]);
    let hits = 0;
    let secondAuth = "";
    let secondDpop = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => {
      hits++;
      if (hits === 1) return new Response("", { status: 401, headers: { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "dpop-nonce": "n1" } });
      secondAuth = req.headers.get("authorization") ?? "";
      secondDpop = req.headers.get("dpop") ?? "";
      return Response.json([]);
    } });
    const profile: OAuthProfile = { url: "https://example.okta.com", clientId: "c1", privateKey: await ecJwk(), scopes: ["okta.users.read"], dpop: true };
    const source = new OAuthTokenSource(profile, { fetch: tokenFetch({ token_type: "DPoP", access_token: "tok", expires_in: 3600 }), now: () => 0 });
    const c = new OktaClient(srv.url, { kind: "oauth", source }, { sleep: noSleep });
    await c.get("/users", { limit: 5 });
    expect(hits).toBe(2);
    expect(secondAuth).toBe("DPoP tok");
    expect(secondDpop).not.toBe("");
    const claims = decodePart(secondDpop.split(".")[1]!);
    expect(claims.nonce).toBe("n1");
    expect(claims.htm).toBe("GET");
    expect(claims.htu).toBe(`${srv.url}/api/v1/users`);
    expect(typeof claims.ath).toBe("string");
    expect(claims.ath.length).toBeGreaterThan(0);
  });

  test("oauth 401 invalid_token: cached token is dropped, a fresh one fetched, request retried once", async () => {
    srv = startServer([]);
    let hits = 0;
    let secondAuth = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => {
      hits++;
      if (hits === 1) return new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
      secondAuth = req.headers.get("authorization") ?? "";
      return Response.json([]);
    } });
    let tokenHits = 0;
    const fetchToken: FetchLike = async () => {
      tokenHits++;
      return Response.json({ token_type: "Bearer", access_token: `tok${tokenHits}`, expires_in: 3600 });
    };
    const profile: OAuthProfile = { url: "https://example.okta.com", clientId: "c1", privateKey: await ecJwk(), scopes: ["okta.users.read"] };
    const source = new OAuthTokenSource(profile, { fetch: fetchToken, now: () => 0 });
    const c = new OktaClient(srv.url, { kind: "oauth", source }, { sleep: noSleep });
    await c.get("/users");
    expect(hits).toBe(2);
    expect(tokenHits).toBe(2);
    expect(secondAuth).toBe("Bearer tok2");
  });

  test("-vvv logging redacts Authorization and DPoP header values", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users", body: [] }]);
    const lines: string[] = [];
    const profile: OAuthProfile = { url: "https://example.okta.com", clientId: "c1", privateKey: await ecJwk(), scopes: ["okta.users.read"], dpop: true };
    const secretToken = "super-secret-access-token";
    const source = new OAuthTokenSource(profile, { fetch: tokenFetch({ token_type: "DPoP", access_token: secretToken, expires_in: 3600 }), now: () => 0 });
    const c = new OktaClient(srv.url, { kind: "oauth", source }, { sleep: noSleep, verbosity: 3, log: (l) => lines.push(l) });
    await c.get("/users");
    const logged = lines.join("\n");
    expect(logged).not.toContain(secretToken);
    expect(logged).toContain("[REDACTED]");
  });
});

describe("profileKind / activeProfile / buildClient", () => {
  test("profileKind distinguishes ssws from oauth profiles", () => {
    expect(profileKind({ url: "https://a.okta.com", token: "t" })).toBe("ssws");
    expect(profileKind({ url: "https://a.okta.com", auth: "oauth", clientId: "c1", scopes: [] })).toBe("oauth");
  });

  test("activeProfile builds an OAuth profile from env vars", async () => {
    const p = await activeProfile({
      OKTA_URL: "https://a.okta.com",
      OKTA_CLIENT_ID: "c1",
      OKTA_PRIVATE_KEY: "pem-or-jwk-text",
      OKTA_SCOPES: "okta.users.read okta.groups.read",
      OKTA_KID: "k1",
      OKTA_DPOP: "1",
    });
    expect(p).toEqual({
      url: "https://a.okta.com",
      auth: "oauth",
      clientId: "c1",
      kid: "k1",
      privateKey: "pem-or-jwk-text",
      scopes: ["okta.users.read", "okta.groups.read"],
      dpop: true,
    });
  });

  test("activeProfile accepts OKTA_PRIVATE_KEY_FILE in place of OKTA_PRIVATE_KEY", async () => {
    const p = (await activeProfile({
      OKTA_URL: "https://a.okta.com",
      OKTA_CLIENT_ID: "c1",
      OKTA_PRIVATE_KEY_FILE: "/tmp/key.pem",
      OKTA_SCOPES: "okta.users.read",
    })) as OAuthProfileConfig;
    expect(p.privateKeyFile).toBe("/tmp/key.pem");
    expect(p.privateKey).toBeUndefined();
    expect(p.dpop).toBeUndefined();
    expect(p.kid).toBeUndefined();
  });

  test("buildClient throws ExitError when an OAuth profile has no key material", async () => {
    await expect(buildClient({ url: "https://a.okta.com", auth: "oauth", clientId: "c1", scopes: [] })).rejects.toBeInstanceOf(ExitError);
  });

  test("buildClient resolves privateKeyFile at build time, parsing JSON as a JWK and anything else as PEM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-"));
    const jwkFile = join(dir, "key.jwk.json");
    const pemFile = join(dir, "key.pem");
    await Bun.write(jwkFile, JSON.stringify(await ecJwk()));
    await Bun.write(pemFile, "not-actually-pem-but-not-json-either");
    await expect(
      buildClient({ url: "https://a.okta.com", auth: "oauth", clientId: "c1", scopes: ["okta.users.read"], privateKeyFile: jwkFile }),
    ).resolves.toBeInstanceOf(OktaClient);
    await expect(
      buildClient({ url: "https://a.okta.com", auth: "oauth", clientId: "c1", scopes: ["okta.users.read"], privateKeyFile: pemFile }),
    ).resolves.toBeInstanceOf(OktaClient);
  });

  test("buildClient builds an SSWS client from the legacy {url, token} shape", async () => {
    const c = await buildClient({ url: "https://a.okta.com", token: "tok" });
    expect(c).toBeInstanceOf(OktaClient);
  });
});

describe("config list with an OAuth profile", () => {
  test("shows oauth:<clientId> instead of a masked token", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    await Bun.write(
      file,
      JSON.stringify({
        profiles: {
          p1: { url: "https://a.okta.com", token: "abcd1234" },
          p2: { url: "https://b.okta.com", auth: "oauth", clientId: "cli123", scopes: ["okta.users.read"] },
        },
        default: "p1",
      }),
    );
    const t = testCtx("http://127.0.0.1:1");
    t.ctx.env = { OKTA_CLI_CONFIG: file };
    expect(await runTest(["config", "list"], t.ctx)).toBe(0);
    expect(t.out.join("")).toBe("p1  https://a.okta.com  ***1234  (CURRENT)\np2  https://b.okta.com  oauth:cli123\n");
  });
});
