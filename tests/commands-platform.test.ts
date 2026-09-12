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
});
