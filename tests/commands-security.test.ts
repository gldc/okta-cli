import { afterEach, describe, expect, test } from "bun:test";
import { DEVICE_INTEGRATIONS, DEVICE_POSTURE_CHECKS, EMAIL_SERVERS, PUSH_PROVIDERS, SECURITY_EVENTS_PROVIDERS } from "../src/commands/security";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const p of [
    SECURITY_EVENTS_PROVIDERS.path, `${SECURITY_EVENTS_PROVIDERS.path}/x`,
    `${SECURITY_EVENTS_PROVIDERS.path}/x/lifecycle/activate`, `${SECURITY_EVENTS_PROVIDERS.path}/x/lifecycle/deactivate`,
    "/api/v1/ssf/stream", "/api/v1/ssf/stream/status", "/api/v1/ssf/stream/verification",
    "/security/api/v1/security-events",
    "/api/v1/threats/configuration", "/api/v1/bot-protection/configuration",
    "/attack-protection/api/v1/authenticator-settings", "/attack-protection/api/v1/user-lockout-settings",
    PUSH_PROVIDERS.path, `${PUSH_PROVIDERS.path}/x`,
    DEVICE_INTEGRATIONS.path, `${DEVICE_INTEGRATIONS.path}/x`, `${DEVICE_INTEGRATIONS.path}/x/lifecycle/activate`, `${DEVICE_INTEGRATIONS.path}/x/lifecycle/deactivate`,
    DEVICE_POSTURE_CHECKS.path, `${DEVICE_POSTURE_CHECKS.path}/default`, `${DEVICE_POSTURE_CHECKS.path}/x`,
    EMAIL_SERVERS.path, `${EMAIL_SERVERS.path}/x`, `${EMAIL_SERVERS.path}/x/test`,
    "/api/v1/dr/status", "/api/v1/dr/status/x", "/api/v1/dr/failover", "/api/v1/dr/failback",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("security-events-providers", () => {
  test("list returns providers", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/security-events-providers", body: [{ id: "sse1", name: "Target", status: "ACTIVE", type: "okta" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["security-events-providers", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("sse1");
  });

  test("activate resolves by name and posts lifecycle/activate", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/security-events-providers/Target", status: 404, body: {} },
      { method: "GET", path: "/api/v1/security-events-providers", body: [{ id: "sse1", name: "Target", status: "INACTIVE", type: "okta" }] },
      { method: "POST", path: "/api/v1/security-events-providers/sse1/lifecycle/activate", body: { id: "sse1", name: "Target", status: "ACTIVE", type: "okta" } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["security-events-providers", "activate", "Target"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/security-events-providers/sse1/lifecycle/activate");
  });
});

describe("ssf stream", () => {
  test("stream with no --stream-id lists all", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/ssf/stream", body: [{ stream_id: "s1", events_requested: ["a"] }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({});
    expect(JSON.parse(t.out.join(""))[0].stream_id).toBe("s1");
  });

  test("stream --stream-id passes the query param", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/ssf/stream", body: { stream_id: "s1", events_requested: ["a"] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream", "--stream-id", "s1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ stream_id: "s1" });
  });

  test("stream-add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/ssf/stream", body: { stream_id: "s1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-add", "-s", "events_requested=[]", "-s", "delivery.endpoint_url=https://x", "-s", "delivery.method=urn:ietf:rfc:8935"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
  });

  test("stream-replace puts the body", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/ssf/stream", body: { stream_id: "s1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-replace", "-s", "stream_id=s1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });

  test("stream-update patches the body", async () => {
    srv = startServer([{ method: "PATCH", path: "/api/v1/ssf/stream", body: { stream_id: "s1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-update", "-s", "stream_id=s1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
  });

  test("stream-delete with --stream-id deletes that stream", async () => {
    srv = startServer([{ method: "DELETE", path: "/api/v1/ssf/stream" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-delete", "--stream-id", "s1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ stream_id: "s1" });
  });

  test("stream-status requires --stream-id", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-status"], t.ctx)).not.toBe(0);
  });

  test("stream-status gets the status for a stream id", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/ssf/stream/status", body: { status: "enabled", stream_id: "s1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-status", "--stream-id", "s1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ stream_id: "s1" });
  });

  test("stream-verify posts stream_id and state", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/ssf/stream/verification" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["ssf", "stream-verify", "--stream-id", "s1", "--state", "abc"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ stream_id: "s1", state: "abc" });
  });
});

describe("security-events send", () => {
  test("posts the raw SET JWT with the secevent content type, unmodified", async () => {
    let seenContentType = "";
    srv = startServer([]);
    srv.add({
      method: "POST", path: "/security/api/v1/security-events",
      handler: (req) => { seenContentType = req.headers.get("content-type") ?? ""; return new Response(null, { status: 202 }); },
    });
    const t = testCtx(srv.url);
    expect(await runTest(["security-events", "send", "-b", "header.payload.signature"], t.ctx)).toBe(0);
    expect(seenContentType).toBe("application/secevent+jwt");
    expect(srv.calls.at(-1)!.body).toBe("header.payload.signature");
    expect(t.out.at(-1)).toBe("security event token published\n");
  });
});

describe("threats", () => {
  test("config gets the ThreatInsight configuration", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/threats/configuration", body: { action: "audit" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["threats", "config", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).action).toBe("audit");
  });

  test("config-set posts (not puts) the configuration", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/threats/configuration", body: { action: "enforce_and_log" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["threats", "config-set", "-s", "action=enforce_and_log"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
  });
});

describe("bot-protection", () => {
  test("config gets the bot protection configuration", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/bot-protection/configuration", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["bot-protection", "config", "-j"], t.ctx)).toBe(0);
  });

  test("config-set posts (not puts) the configuration", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/bot-protection/configuration", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["bot-protection", "config-set", "-s", "x=y"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
  });
});

describe("attack-protection", () => {
  test("authenticator-settings gets the settings from the attack-protection base path", async () => {
    srv = startServer([{ method: "GET", path: "/attack-protection/api/v1/authenticator-settings", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["attack-protection", "authenticator-settings", "-j"], t.ctx)).toBe(0);
  });

  test("authenticator-settings-set puts the settings", async () => {
    srv = startServer([{ method: "PUT", path: "/attack-protection/api/v1/authenticator-settings", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["attack-protection", "authenticator-settings-set", "-s", "x=y"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });

  test("lockout-settings gets the user-lockout-settings", async () => {
    srv = startServer([{ method: "GET", path: "/attack-protection/api/v1/user-lockout-settings", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["attack-protection", "lockout-settings", "-j"], t.ctx)).toBe(0);
  });

  test("lockout-settings-set puts the user-lockout-settings", async () => {
    srv = startServer([{ method: "PUT", path: "/attack-protection/api/v1/user-lockout-settings", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["attack-protection", "lockout-settings-set", "-s", "x=y"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });
});

describe("push-providers", () => {
  test("list passes --type as a query filter", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/push-providers", body: [{ id: "ppc1", name: "P1", providerType: "APNS" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["push-providers", "list", "--type", "APNS", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ type: "APNS" });
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/push-providers", body: { id: "ppc1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["push-providers", "add", "-s", "name=P1", "-s", "providerType=FCM"], t.ctx)).toBe(0);
  });

  test("delete resolves by name and deletes by id", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/push-providers/P1", status: 404, body: {} },
      { method: "GET", path: "/api/v1/push-providers", body: [{ id: "ppc1", name: "P1", providerType: "APNS" }] },
      { method: "DELETE", path: "/api/v1/push-providers/ppc1" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["push-providers", "delete", "P1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/push-providers/ppc1");
  });
});

describe("device-integrations", () => {
  test("list returns device integrations", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/device-integrations", body: [{ id: "di1", displayName: "Chrome", name: "com.google.dtc", status: "ACTIVE", platform: "CHROMEOS" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-integrations", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("di1");
  });

  test("has no add/delete/replace commands", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-integrations", "add"], t.ctx)).not.toBe(0);
    expect(await runTest(["device-integrations", "delete", "di1"], t.ctx)).not.toBe(0);
  });

  test("activate resolves by id and posts lifecycle/activate", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/device-integrations/di1", body: { id: "di1", name: "com.google.dtc", displayName: "Chrome" } },
      { method: "POST", path: "/api/v1/device-integrations/di1/lifecycle/activate", body: { id: "di1" } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-integrations", "activate", "di1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/device-integrations/di1/lifecycle/activate");
  });
});

describe("device-posture-checks", () => {
  test("list returns posture checks", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/device-posture-checks", body: [{ id: "dch1", name: "macOSFirewall", platform: "MACOS", type: "BUILTIN", variableName: "macOSFirewall" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-posture-checks", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("dch1");
  });

  test("defaults lists the default (BUILTIN) checks", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/device-posture-checks/default", body: [{ id: "dch1", name: "macOSFirewall" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-posture-checks", "defaults", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/device-posture-checks/default");
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/device-posture-checks", body: { id: "dch2" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-posture-checks", "add", "-s", "name=Foo", "-s", "platform=MACOS"], t.ctx)).toBe(0);
  });

  test("delete resolves by name and deletes by id", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/device-posture-checks/Foo", status: 404, body: {} },
      { method: "GET", path: "/api/v1/device-posture-checks", body: [{ id: "dch2", name: "Foo" }] },
      { method: "DELETE", path: "/api/v1/device-posture-checks/dch2" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["device-posture-checks", "delete", "Foo"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/device-posture-checks/dch2");
  });
});

describe("email-servers", () => {
  const server = { id: "es1", alias: "CustomServer1", host: "192.168.160.1", port: 587, username: "u@d.com", enabled: true };

  test("list unwraps the email-servers key", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/email-servers", body: { "email-servers": [server] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["email-servers", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("es1");
  });

  test("has no replace command", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["email-servers", "replace", "es1"], t.ctx)).not.toBe(0);
  });

  test("update patches the body", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/email-servers/es1", body: server },
      { method: "PATCH", path: "/api/v1/email-servers/es1", body: { ...server, host: "10.0.0.1" } },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["email-servers", "update", "es1", "-s", "host=10.0.0.1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
  });

  test("test posts fromAddress/toAddress and reports a confirmation string", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/email-servers/es1", body: server },
      { method: "POST", path: "/api/v1/email-servers/es1/test" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["email-servers", "test", "es1", "--from", "a@x.com", "--to", "b@x.com"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ fromAddress: "a@x.com", toAddress: "b@x.com" });
    expect(t.out.at(-1)).toContain("test");
  });
});

describe("dr", () => {
  test("status with no domain gets /dr/status and unwraps the status key", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/dr/status", body: { status: [{ domain: "example.okta.com", isFailedOver: false }] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["dr", "status", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].domain).toBe("example.okta.com");
  });

  test("status with a domain gets /dr/status/{domain}", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/dr/status/example.okta.com", body: { status: [{ domain: "example.okta.com", isFailedOver: true }] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["dr", "status", "example.okta.com", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/dr/status/example.okta.com");
  });

  test("failover posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/dr/failover", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["dr", "failover", "-b", "{}"], t.ctx)).toBe(0);
  });

  test("failback posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/dr/failback", body: {} }]);
    const t = testCtx(srv.url);
    expect(await runTest(["dr", "failback", "-b", "{}"], t.ctx)).toBe(0);
  });
});
