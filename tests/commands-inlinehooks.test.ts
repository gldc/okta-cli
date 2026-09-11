import { afterEach, describe, expect, test } from "bun:test";
import { inlineHookBody } from "../src/commands/inlinehooks";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };
const hooks = [{ id: "ih1", status: "ACTIVE", type: "com.okta.oauth2.tokens.transform", version: "1.0.0", name: "token-transform" }];

test("spec paths", () => {
  for (const p of ["/inlineHooks", "/inlineHooks/x", "/inlineHooks/x/lifecycle/activate", "/inlineHooks/x/lifecycle/deactivate", "/inlineHooks/x/execute", "/hook-keys", "/hook-keys/x", "/hook-keys/public/x"]) {
    expect(knownPath(p), p).toBe(true);
  }
});

test("inlineHookBody with and without authScheme", () => {
  expect(inlineHookBody({ name: "n", type: "t", url: "https://h" })).toEqual({
    name: "n", type: "t", version: "1.0.0",
    channel: { type: "HTTP", version: "1.0.0", config: { uri: "https://h", method: "POST", headers: [] } },
  });
  expect(inlineHookBody({ name: "n", type: "t", url: "https://h", version: "2.0.0", method: "PUT", authHeader: "X-Key", authValue: "s3cr3t" })).toEqual({
    name: "n", type: "t", version: "2.0.0",
    channel: { type: "HTTP", version: "1.0.0", config: { uri: "https://h", method: "PUT", headers: [], authScheme: { type: "HEADER", key: "X-Key", value: "s3cr3t" } } },
  });
});

describe("inlinehooks", () => {
  test("list -t sends type query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/inlineHooks", body: hooks }]);
    const t = testCtx(srv.url);
    await runTest(["inlinehooks", "list", "-t", "com.okta.oauth2.tokens.transform"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ type: "com.okta.oauth2.tokens.transform" });
  });

  test("add posts body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/inlineHooks", body: hooks[0] }]);
    const t = testCtx(srv.url);
    await runTest(["inlinehooks", "add", "-n", "token-transform", "-t", "com.okta.oauth2.tokens.transform", "-u", "https://h"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({
      name: "token-transform", type: "com.okta.oauth2.tokens.transform", version: "1.0.0",
      channel: { type: "HTTP", version: "1.0.0", config: { uri: "https://h", method: "POST", headers: [] } },
    });
  });

  test("execute posts body to the resolved hook", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/inlineHooks\/[^/]+$/, status: 404, body: notFound },
      { method: "GET", path: "/api/v1/inlineHooks", body: hooks },
      { method: "POST", path: "/api/v1/inlineHooks/ih1/execute", body: { commands: [] } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["inlinehooks", "execute", "token-transform", "-b", '{"data":{"context":{}}}'], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/inlineHooks/ih1/execute");
    expect(srv.calls.at(-1)!.body).toEqual({ data: { context: {} } });
  });
});

describe("hook-keys", () => {
  test("add posts body; public gets by keyId", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/hook-keys", body: { id: "hk1", name: "k1", keyId: "kid1" } },
      { method: "GET", path: "/api/v1/hook-keys/public/kid1", body: { kid: "kid1", kty: "RSA" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["hook-keys", "add", "-n", "k1"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ name: "k1" });
    await runTest(["hook-keys", "public", "kid1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/hook-keys/public/kid1");
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ kid: "kid1", kty: "RSA" });
  });
});
