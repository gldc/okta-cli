import { afterEach, describe, expect, test } from "bun:test";
import { IDPS } from "../src/commands/idps";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const idp = { id: "0oa1idp", status: "ACTIVE", type: "SAML2", name: "Corp SSO" };
const idpByIdRoute = { method: "GET" as const, path: "/api/v1/idps/0oa1idp", body: idp };

test("spec paths", () => {
  for (const p of [
    IDPS.path, `${IDPS.path}/x`, `${IDPS.path}/x/lifecycle/activate`, `${IDPS.path}/x/lifecycle/deactivate`, `${IDPS.path}/x/users`, `${IDPS.path}/x/users/y`, `${IDPS.path}/x/users/y/credentials/tokens`,
    `${IDPS.path}/credentials/keys`, `${IDPS.path}/credentials/keys/k1`,
    `${IDPS.path}/x/credentials/keys`, `${IDPS.path}/x/credentials/keys/k1`, `${IDPS.path}/x/credentials/keys/active`, `${IDPS.path}/x/credentials/keys/generate`, `${IDPS.path}/x/credentials/keys/k1/clone`,
    `${IDPS.path}/x/credentials/csrs`, `${IDPS.path}/x/credentials/csrs/y`, `${IDPS.path}/x/credentials/csrs/y/lifecycle/publish`,
  ]) {
    expect(knownPath(p), p).toBe(true);
  }
});

describe("idps list", () => {
  test("-t sends type query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/idps", body: [idp] }]);
    const t = testCtx(srv.url);
    await runTest(["idps", "list", "-t", "SAML2"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ type: "SAML2" });
  });
});

describe("idps link/unlink/keys", () => {
  test("link posts externalId to the idp/user path", async () => {
    srv = startServer([idpByIdRoute, { method: "POST", path: "/api/v1/idps/0oa1idp/users/00u00000000000000001", body: { id: "00u00000000000000001", externalId: "ext1" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["idps", "link", "0oa1idp", "-u", "bob@x.com", "-e", "ext1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/idps/0oa1idp/users/00u00000000000000001");
    expect(srv.calls.at(-1)!.body).toEqual({ externalId: "ext1" });
  });

  test("unlink deletes and reports user + idp names", async () => {
    srv = startServer([idpByIdRoute, { method: "DELETE", path: "/api/v1/idps/0oa1idp/users/00u00000000000000001" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["idps", "unlink", "0oa1idp", "-u", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe(`user ${users[0]!.id} (bob@x.com) unlinked from idp 0oa1idp (Corp SSO)\n`);
  });

  test("keys lists idp credential keys", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/idps/credentials/keys", body: [{ kid: "k1", kty: "RSA", use: "sig", created: "2026-01-01", expiresAt: "2027-01-01" }] }]);
    const t = testCtx(srv.url);
    await runTest(["idps", "keys", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/idps/credentials/keys");
    expect(JSON.parse(t.out.join(""))[0].kid).toBe("k1");
  });
});

describe("idps key credentials (org-wide)", () => {
  const key = { kid: "k1", kty: "RSA", use: "sig", created: "2026-01-01", expiresAt: "2027-01-01" };

  test("key/key-add/key-replace/key-delete", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/idps/credentials/keys/k1", body: key },
      { method: "POST", path: "/api/v1/idps/credentials/keys", body: key },
      { method: "PUT", path: "/api/v1/idps/credentials/keys/k1", body: key },
      { method: "DELETE", path: "/api/v1/idps/credentials/keys/k1" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["idps", "key", "k1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
    await runTest(["idps", "key-add", "-s", "x5c=abc", "-j"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ x5c: "abc" });
    await runTest(["idps", "key-replace", "k1", "-s", "x5c=def", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    await runTest(["idps", "key-delete", "k1"], t.ctx);
    expect(t.out.at(-1)).toBe("key k1 deleted\n");
  });
});

describe("idps signing keys", () => {
  const key = { kid: "sk1", kty: "RSA", use: "sig", created: "2026-01-01", expiresAt: "2027-01-01" };

  test("signing-keys/signing-key/signing-key-active/signing-key-generate/signing-key-clone", async () => {
    srv = startServer([
      idpByIdRoute,
      { method: "GET", path: "/api/v1/idps/0oa1idp/credentials/keys", body: [key] },
      { method: "GET", path: "/api/v1/idps/0oa1idp/credentials/keys/sk1", body: key },
      { method: "GET", path: "/api/v1/idps/0oa1idp/credentials/keys/active", body: [key] },
      { method: "POST", path: "/api/v1/idps/0oa1idp/credentials/keys/generate", body: key },
      { method: "POST", path: "/api/v1/idps/0oa1idp/credentials/keys/sk1/clone", body: key },
      { method: "GET", path: "/api/v1/idps/0oa2idp", body: { id: "0oa2idp", status: "ACTIVE", type: "SAML2", name: "Other IdP" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["idps", "signing-keys", "0oa1idp", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].kid).toBe("sk1");
    await runTest(["idps", "signing-key", "0oa1idp", "sk1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
    await runTest(["idps", "signing-key-active", "0oa1idp", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].kid).toBe("sk1");
    await runTest(["idps", "signing-key-generate", "0oa1idp", "--validity-years", "2", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ validityYears: "2" });
    await runTest(["idps", "signing-key-clone", "0oa1idp", "sk1", "--target-idp", "0oa2idp", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ targetIdpId: "0oa2idp" });
  });

  test("signing-key-generate requires --validity-years", async () => {
    srv = startServer([idpByIdRoute]);
    const t = testCtx(srv.url);
    expect(await runTest(["idps", "signing-key-generate", "0oa1idp"], t.ctx)).not.toBe(0);
  });
});

describe("idps csrs", () => {
  test("csrs/csr/csr-add/csr-delete/csr-publish", async () => {
    const csr = { id: "c1", created: "2026-01-01", kty: "RSA" };
    const key = { kid: "pk1", kty: "RSA", use: "sig", created: "2026-01-01", expiresAt: "2027-01-01" };
    const f = `${import.meta.dir}/tmp-idps-cert.pem`;
    await Bun.write(f, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
    let seenContentType = "";
    srv = startServer([
      idpByIdRoute,
      { method: "GET", path: "/api/v1/idps/0oa1idp/credentials/csrs", body: [csr] },
      { method: "POST", path: "/api/v1/idps/0oa1idp/credentials/csrs", body: csr },
      { method: "GET", path: "/api/v1/idps/0oa1idp/credentials/csrs/c1", body: csr },
      { method: "DELETE", path: "/api/v1/idps/0oa1idp/credentials/csrs/c1" },
      {
        method: "POST", path: "/api/v1/idps/0oa1idp/credentials/csrs/c1/lifecycle/publish",
        handler: (req) => { seenContentType = req.headers.get("content-type") ?? ""; return Response.json(key, { status: 201 }); },
      },
    ]);
    const t = testCtx(srv.url);
    await runTest(["idps", "csrs", "0oa1idp", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("c1");
    await runTest(["idps", "csr", "0oa1idp", "c1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(csr);
    await runTest(["idps", "csr-add", "0oa1idp", "-s", "subject.commonName=SP"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST" && c.path.endsWith("/csrs"))!.body).toEqual({ subject: { commonName: "SP" } });
    await runTest(["idps", "csr-delete", "0oa1idp", "c1"], t.ctx);
    expect(t.out.at(-1)).toBe("csr c1 revoked from idp 0oa1idp (Corp SSO)\n");
    await runTest(["idps", "csr-publish", "0oa1idp", "c1", "--file", f, "-j"], t.ctx);
    expect(seenContentType).toBe("application/x-pem-file");
    expect(JSON.parse(t.out.at(-1)!)).toEqual(key);
  });
});
