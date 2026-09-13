import { afterEach, describe, expect, test } from "bun:test";
import { DOMAINS, LOG_STREAMS, TRUSTED_ORIGINS, ZONES } from "../src/commands/platform";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const s of [TRUSTED_ORIGINS, DOMAINS, ZONES, LOG_STREAMS]) {
    expect(knownPath(s.path), s.path).toBe(true);
    expect(knownPath(`${s.path}/x`), s.path).toBe(true);
    if (s.lifecycle) expect(knownPath(`${s.path}/x/lifecycle/activate`), s.path).toBe(true);
  }
  expect(knownPath("/domains/x/verify")).toBe(true);
  expect(knownPath("/domains/x/certificate")).toBe(true);
  expect(knownPath("/meta/schemas/logStream")).toBe(true);
  expect(knownPath("/meta/schemas/logStream/aws_eventbridge")).toBe(true);
});

describe("platform resources", () => {
  test("trusted-origins add builds scopes", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/trustedOrigins", body: { id: "tos1", status: "ACTIVE", name: "app", origin: "https://app" } }]);
    const t = testCtx(srv.url);
    await runTest(["trusted-origins", "add", "-n", "app", "-o", "https://app", "--scope", "CORS"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ name: "app", origin: "https://app", scopes: [{ type: "CORS" }] });
    expect(t.out.at(-1)).toBe("tos1  ACTIVE  app  https://app  \n");
    await runTest(["trusted-origins", "add", "-n", "b", "-o", "https://b"], t.ctx);
    expect((srv.calls[1]!.body as any).scopes).toEqual([{ type: "CORS" }, { type: "REDIRECT" }]);
  });
  test("trusted-origins add rejects an invalid --scope locally", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["trusted-origins", "add", "-n", "x", "-o", "https://x", "--scope", "BOGUS"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
  test("domains list unwraps, add, verify", async () => {
    const d = { id: "d1", domain: "login.acme.com", validationStatus: "NOT_STARTED", certificateSourceType: "OKTA_MANAGED" };
    srv = startServer([
      { method: "GET", path: "/api/v1/domains", body: { domains: [d] } },
      { method: "GET", path: /^\/api\/v1\/domains\/[^/]+$/, status: 404, body: { errorSummary: "nf" } },
      { method: "POST", path: "/api/v1/domains", body: d },
      { method: "POST", path: "/api/v1/domains/d1/verify", body: { ...d, validationStatus: "VERIFIED" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["domains", "list", "--output-fields", "domain"], t.ctx);
    expect(t.out.at(-1)).toBe("login.acme.com  \n");
    await runTest(["domains", "add", "-d", "login.acme.com"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ domain: "login.acme.com", certificateSourceType: "OKTA_MANAGED" });
    await runTest(["domains", "verify", "acme", "--output-fields", "validationStatus"], t.ctx);
    expect(t.out.at(-1)).toBe("VERIFIED  \n");
  });
  test("log-streams -t becomes filter", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/logStreams", body: [] }]);
    const t = testCtx(srv.url);
    await runTest(["log-streams", "list", "-t", "splunk_cloud_logstreaming"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'type eq "splunk_cloud_logstreaming"' });
  });

  test("domains certificate reads cert/key/chain files and PUTs the certificate body", async () => {
    const d = { id: "d1", domain: "login.acme.com", validationStatus: "VERIFIED", certificateSourceType: "OKTA_MANAGED" };
    const certFile = `${import.meta.dir}/tmp-platform-cert.pem`;
    const keyFile = `${import.meta.dir}/tmp-platform-key.pem`;
    await Bun.write(certFile, "CERT");
    await Bun.write(keyFile, "KEY");
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/domains\/d1$/, body: d },
      { method: "PUT", path: "/api/v1/domains/d1/certificate" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["domains", "certificate", "d1", "--cert", certFile, "--key", keyFile], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "PEM", certificate: "CERT", privateKey: "KEY", certificateChain: undefined });
    expect(t.out.at(-1)).toBe("certificate updated for domain d1 (login.acme.com)\n");
  });

  test("log-streams schemas/schema", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/meta/schemas/logStream", body: [{ id: "aws_eventbridge", title: "AWS EventBridge", type: "object" }] },
      { method: "GET", path: "/api/v1/meta/schemas/logStream/aws_eventbridge", body: { id: "aws_eventbridge", title: "AWS EventBridge", type: "object" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["log-streams", "schemas", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)[0].title).toBe("AWS EventBridge");
    await runTest(["log-streams", "schema", "aws_eventbridge", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).title).toBe("AWS EventBridge");
  });
});
