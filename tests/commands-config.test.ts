import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

// Test keys are always generated fresh here, never committed as literals.
function ecJwk(): Promise<JsonWebKey> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]).then((pair) => crypto.subtle.exportKey("jwk", pair.privateKey));
}

describe("config commands", () => {
  let file: string;
  let t: ReturnType<typeof testCtx>;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    t = testCtx("http://127.0.0.1:1");
    t.ctx.env = { OKTA_CLI_CONFIG: file };
  });

  test("new/list/use-context/current-context/delete/file", async () => {
    expect(await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "-t", "abcd1234"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Profile 'p1' added.\n");
    t.answers.push("p2", "https://b.okta.com", "zzzz9999");
    await runTest(["config", "new"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' added.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toBe("p1  https://a.okta.com  ***1234  (CURRENT)\np2  https://b.okta.com  ***9999\n");
    await runTest(["config", "use-context", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Default profile set to 'p2'.\n");
    await runTest(["config", "current-context"], t.ctx);
    expect(t.out.at(-1)).toBe("Current profile set to 'p2'.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toContain("***9999  (CURRENT)\n");
    await runTest(["config", "delete", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' deleted.\nNew default profile: p1\n");
    await runTest(["config", "delete", "p1"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p1' deleted.\nNo more profiles left.\n");
    await runTest(["config", "file"], t.ctx);
    expect(t.out.at(-1)).toBe(file + "\n");
  });

  test("new infers default: fresh file gets it, second profile leaves first as default", async () => {
    await Bun.write(file, JSON.stringify({ profiles: { p1: { url: "https://a.okta.com", token: "abcd1234" } } }));
    expect(await runTest(["config", "new", "-n", "p2", "-u", "https://b.okta.com", "-t", "zzzz9999"], t.ctx)).toBe(0);
    expect((await Bun.file(file).json()).default).toBe("p1");

    const fresh = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    t.ctx.env = { OKTA_CLI_CONFIG: fresh };
    expect(await runTest(["config", "new", "-n", "p3", "-u", "https://c.okta.com", "-t", "cccc0000"], t.ctx)).toBe(0);
    expect((await Bun.file(fresh).json()).default).toBe("p3");
  });

  test("errors", async () => {
    expect(await runTest(["config", "new", "-n", "x", "-u", "http://nope", "-t", "t"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("url must start with 'https://'");
    expect(await runTest(["config", "use-context", "nope"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("okta-cli was not configured");
  });

  test("new --client-id: -t and --client-id are mutually exclusive", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "key.jwk.json");
    await Bun.write(keyFile, JSON.stringify(await ecJwk()));
    expect(
      await runTest(
        ["config", "new", "-n", "p1", "-u", "https://a.okta.com", "-t", "abcd1234", "--client-id", "cid1", "--private-key-file", keyFile, "--scopes", "okta.users.read"],
        t.ctx,
      ),
    ).toBe(255);
    expect(t.err.join("")).toContain("Use either -t or --client-id");
  });

  test("new --client-id: stores a JWK private key inline, plus kid/dpop", async () => {
    const jwk = await ecJwk();
    const keyFile = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "key.jwk.json");
    await Bun.write(keyFile, JSON.stringify(jwk));
    expect(
      await runTest(
        ["config", "new", "-n", "p1", "-u", "https://a.okta.com", "--client-id", "cid1", "--private-key-file", keyFile, "--kid", "k1", "--scopes", "okta.users.read okta.groups.read", "--dpop"],
        t.ctx,
      ),
    ).toBe(0);
    const cfg = await Bun.file(file).json();
    expect(cfg.profiles.p1).toEqual({
      url: "https://a.okta.com",
      auth: "oauth",
      clientId: "cid1",
      kid: "k1",
      privateKey: jwk,
      scopes: ["okta.users.read", "okta.groups.read"],
      dpop: true,
    });
  });

  test("new --client-id: a non-JSON key file is stored inline as a PEM string", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "key.pem");
    const pemText = "not-actually-pem-but-not-json-either";
    await Bun.write(keyFile, pemText);
    expect(
      await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "--client-id", "cid1", "--private-key-file", keyFile, "--scopes", "okta.users.read"], t.ctx),
    ).toBe(0);
    const cfg = await Bun.file(file).json();
    expect(cfg.profiles.p1.privateKey).toBe(pemText);
    expect(cfg.profiles.p1.privateKeyFile).toBeUndefined();
  });

  test("new --client-id --keep-file-ref: stores only the path, not the key contents", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "key.jwk.json");
    await Bun.write(keyFile, JSON.stringify(await ecJwk()));
    expect(
      await runTest(
        ["config", "new", "-n", "p1", "-u", "https://a.okta.com", "--client-id", "cid1", "--private-key-file", keyFile, "--scopes", "okta.users.read", "--keep-file-ref"],
        t.ctx,
      ),
    ).toBe(0);
    const cfg = await Bun.file(file).json();
    expect(cfg.profiles.p1.privateKeyFile).toBe(keyFile);
    expect(cfg.profiles.p1.privateKey).toBeUndefined();
  });

  test("new --client-id: requires --private-key-file and --scopes", async () => {
    expect(await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "--client-id", "cid1", "--scopes", "okta.users.read"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("--private-key-file");
    const keyFile = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "key.jwk.json");
    await Bun.write(keyFile, JSON.stringify(await ecJwk()));
    expect(await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "--client-id", "cid1", "--private-key-file", keyFile], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("--scopes");
  });
});

describe("config test", () => {
  let srv: ReturnType<typeof startServer>;
  afterEach(() => srv?.stop());

  // Uses OKTA_* env overrides (see activeProfile, src/config.ts) rather than a config.json
  // profile, since the mock server is plain http and resolveProfile's https guard - a real
  // safeguard against sending SSWS tokens in cleartext - rightly refuses a config-file
  // profile that isn't https. The env-var path is the same one `ctx.getClient` uses in
  // production and skips that guard by design (a caller explicit about OKTA_URL knows what
  // they're pointing at), so it exercises the exact same activeProfile -> buildClient ->
  // client.get("/org") path `config test` runs for a real https profile.
  test("ssws profile (OKTA_URL/OKTA_TOKEN): prints OK <companyName> (ssws)", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/org", body: { companyName: "Acme Inc" } }]);
    const t = testCtx(srv.url);
    t.ctx.env = { OKTA_URL: srv.url, OKTA_TOKEN: "tok" };
    expect(await runTest(["config", "test"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("OK Acme Inc (ssws)\n");
  });

  test("oauth profile (OKTA_CLIENT_ID/OKTA_PRIVATE_KEY/OKTA_SCOPES): prints OK <companyName> (oauth)", async () => {
    srv = startServer([
      { method: "POST", path: "/oauth2/v1/token", body: { token_type: "Bearer", access_token: "tok", expires_in: 3600 } },
      { method: "GET", path: "/api/v1/org", body: { companyName: "Acme Inc" } },
    ]);
    const t = testCtx(srv.url);
    t.ctx.env = { OKTA_URL: srv.url, OKTA_CLIENT_ID: "cid1", OKTA_PRIVATE_KEY: JSON.stringify(await ecJwk()), OKTA_SCOPES: "okta.users.read" };
    expect(await runTest(["config", "test"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("OK Acme Inc (oauth)\n");
  });

  test("an API error surfaces with the usual OktaApiError exit code", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/org", status: 400, body: { errorCode: "E0000001", errorSummary: "bad request", errorCauses: [] } }]);
    const t = testCtx(srv.url);
    t.ctx.env = { OKTA_URL: srv.url, OKTA_TOKEN: "tok" };
    expect(await runTest(["config", "test"], t.ctx)).toBe(253);
    expect(t.out.join("")).toContain("OKTA_API_ERROR: E0000001: bad request");
  });
});
