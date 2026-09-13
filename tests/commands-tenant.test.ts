import { afterEach, describe, expect, test } from "bun:test";
import { BEHAVIORS, CAPTCHAS, EMAIL_DOMAINS, MAPPINGS, REALM_ASSIGNMENTS, REALMS, SMS_TEMPLATES, TELEPHONY_PROVIDERS } from "../src/commands/tenant";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const mapping = { id: "m1", source: { name: "user", type: "user" }, target: { name: "app1", type: "app" }, properties: { firstName: { expression: "user.firstName", pushStatus: "PUSH" }, lastName: { expression: "user.lastName", pushStatus: "DONT_PUSH" } } };
const mappingByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/mappings\/m1$/, body: mapping };
const emailDomain = { id: "eds1", domain: "mail.example.com", displayName: "Example", userName: "no-reply", validationStatus: "VERIFIED", dnsValidationRecords: [{ recordType: "TXT", fqdn: "mail.example.com", verificationValue: "abc123" }] };
const emailDomainByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/email-domains\/eds1$/, body: emailDomain };

test("spec paths", () => {
  for (const p of [
    MAPPINGS.path, `${MAPPINGS.path}/x`,
    EMAIL_DOMAINS.path, `${EMAIL_DOMAINS.path}/x`, `${EMAIL_DOMAINS.path}/x/verify`,
    BEHAVIORS.path, `${BEHAVIORS.path}/x`, `${BEHAVIORS.path}/x/lifecycle/activate`, `${BEHAVIORS.path}/x/lifecycle/deactivate`,
    SMS_TEMPLATES.path, `${SMS_TEMPLATES.path}/x`,
    REALMS.path, `${REALMS.path}/x`,
    REALM_ASSIGNMENTS.path, `${REALM_ASSIGNMENTS.path}/x`, `${REALM_ASSIGNMENTS.path}/x/lifecycle/activate`, `${REALM_ASSIGNMENTS.path}/x/lifecycle/deactivate`,
    CAPTCHAS.path, `${CAPTCHAS.path}/x`,
    TELEPHONY_PROVIDERS.path, `${TELEPHONY_PROVIDERS.path}/x`, `${TELEPHONY_PROVIDERS.path}/x/lifecycle/activate`, `${TELEPHONY_PROVIDERS.path}/x/lifecycle/deactivate`,
    `${TELEPHONY_PROVIDERS.path}/x/setAsPrimary`, `${TELEPHONY_PROVIDERS.path}/x/test`,
    "/rate-limit-settings/admin-notifications", "/rate-limit-settings/per-client", "/rate-limit-settings/warning-threshold",
    "/principal-rate-limits", "/principal-rate-limits/x",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("mappings", () => {
  test("list sends sourceId/targetId query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/mappings", body: [mapping] }]);
    const t = testCtx(srv.url);
    await runTest(["mappings", "list", "--source-id", "0oa1", "--target-id", "0oa2", "-j"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ sourceId: "0oa1", targetId: "0oa2" });
    expect(JSON.parse(t.out.join(""))[0].id).toBe("m1");
  });

  test("update posts the body to /mappings/{id}", async () => {
    srv = startServer([mappingByIdRoute, { method: "POST", path: "/api/v1/mappings/m1", body: mapping }]);
    const t = testCtx(srv.url);
    await runTest(["mappings", "update", "m1", "-s", "properties.firstName.pushStatus=PUSH"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/mappings/m1");
    expect(srv.calls.at(-1)!.body).toEqual({ properties: { firstName: { pushStatus: "PUSH" } } });
  });

  test("properties lists property expressions sorted by property", async () => {
    srv = startServer([mappingByIdRoute]);
    const t = testCtx(srv.url);
    await runTest(["mappings", "properties", "m1", "-j"], t.ctx);
    expect(JSON.parse(t.out.join(""))).toEqual([
      { property: "firstName", expression: "user.firstName", pushStatus: "PUSH" },
      { property: "lastName", expression: "user.lastName", pushStatus: "DONT_PUSH" },
    ]);
  });
});

describe("email-domains", () => {
  test("list prints the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/email-domains", body: [emailDomain] }]);
    const t = testCtx(srv.url);
    await runTest(["email-domains", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("eds1  mail.example.com  Example  no-reply  VERIFIED  \n");
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/email-domains", body: emailDomain }]);
    const t = testCtx(srv.url);
    await runTest(["email-domains", "add", "-s", "domain=mail.example.com", "-s", "displayName=Example", "-s", "userName=no-reply"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ domain: "mail.example.com", displayName: "Example", userName: "no-reply" });
  });

  test("verify resolves by domain and posts /verify", async () => {
    srv = startServer([emailDomainByIdRoute, { method: "POST", path: "/api/v1/email-domains/eds1/verify", body: emailDomain }]);
    const t = testCtx(srv.url);
    await runTest(["email-domains", "verify", "eds1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/email-domains/eds1/verify");
    expect(JSON.parse(t.out.join("")).id).toBe("eds1");
  });

  test("dns prints the dnsValidationRecords rows", async () => {
    srv = startServer([emailDomainByIdRoute]);
    const t = testCtx(srv.url);
    await runTest(["email-domains", "dns", "eds1"], t.ctx);
    expect(t.out.at(-1)).toBe("TXT  mail.example.com  abc123  \n");
  });
});

describe("behaviors", () => {
  test("list prints the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/behaviors", body: [{ id: "bhr1", status: "ACTIVE", type: "ANOMALOUS_LOCATION", name: "New location" }] }]);
    const t = testCtx(srv.url);
    await runTest(["behaviors", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("bhr1  ACTIVE  ANOMALOUS_LOCATION  New location  \n");
  });

  test("activate resolves by name and posts lifecycle/activate", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/behaviors\/[^/]+$/, status: 404, body: { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] } },
      { method: "GET", path: "/api/v1/behaviors", body: [{ id: "bhr1", status: "INACTIVE", name: "New location" }] },
      { method: "POST", path: "/api/v1/behaviors/bhr1/lifecycle/activate", body: { id: "bhr1", status: "ACTIVE", name: "New location" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["behaviors", "activate", "New location", "-j"], t.ctx);
    expect(JSON.parse(t.out.join("")).status).toBe("ACTIVE");
  });
});

describe("sms-templates", () => {
  test("list sends templateType query and prints the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/templates/sms", body: [{ id: "tpl1", type: "SMS_VERIFY_CODE", name: "Default", template: "Your code is ${code}" }] }]);
    const t = testCtx(srv.url);
    await runTest(["sms-templates", "list", "--template-type", "SMS_VERIFY_CODE"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ templateType: "SMS_VERIFY_CODE" });
    expect(t.out.at(-1)).toBe("tpl1  SMS_VERIFY_CODE  Default  Your code is ${code}  \n");
  });
});

describe("realms", () => {
  test("list sends search query and prints the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/realms", body: [{ id: "rlm1", profile: { name: "Partners", realmType: "PARTNER" }, isDefault: false, created: "2026-01-01T00:00:00.000Z" }] }]);
    const t = testCtx(srv.url);
    await runTest(["realms", "list", "--search", 'profile.name co "Partners"'], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ search: 'profile.name co "Partners"' });
    expect(t.out.at(-1)).toBe("rlm1  Partners  false  2026-01-01T00:00:00.000Z  \n");
  });
});

describe("realm-assignments", () => {
  test("list sorted by priority", async () => {
    srv = startServer([{
      method: "GET", path: "/api/v1/realm-assignments",
      body: [{ id: "ra2", status: "ACTIVE", priority: 2, name: "b", isDefault: false }, { id: "ra1", status: "ACTIVE", priority: 1, name: "a", isDefault: true }],
    }]);
    const t = testCtx(srv.url);
    await runTest(["realm-assignments", "list", "-j"], t.ctx);
    expect(JSON.parse(t.out.join("")).map((r: any) => r.id)).toEqual(["ra1", "ra2"]);
  });
});

describe("captchas", () => {
  test("list prints the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/captchas", body: [{ id: "cap1", name: "Org CAPTCHA", type: "HCAPTCHA", siteKey: "site123" }] }]);
    const t = testCtx(srv.url);
    await runTest(["captchas", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("cap1  Org CAPTCHA  HCAPTCHA  site123  \n");
  });
});

describe("rate-limits", () => {
  test("settings fetches all three endpoints and prints combined JSON", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/rate-limit-settings/admin-notifications", body: { notificationsEnabled: true } },
      { method: "GET", path: "/api/v1/rate-limit-settings/per-client", body: { defaultMode: "ENFORCE" } },
      { method: "GET", path: "/api/v1/rate-limit-settings/warning-threshold", body: { warningThreshold: 90 } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "settings"], t.ctx);
    expect(JSON.parse(t.out.join(""))).toEqual({
      adminNotifications: { notificationsEnabled: true },
      perClient: { defaultMode: "ENFORCE" },
      warningThreshold: { warningThreshold: 90 },
    });
  });

  test("set-warning-threshold PUTs the parsed integer", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/rate-limit-settings/warning-threshold", body: { warningThreshold: 75 } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "set-warning-threshold", "75"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ warningThreshold: 75 });
  });

  test("set-warning-threshold rejects a non-integer locally", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["rate-limits", "set-warning-threshold", "abc"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("set-admin-notifications --enabled PUTs notificationsEnabled true", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/rate-limit-settings/admin-notifications", body: { notificationsEnabled: true } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "set-admin-notifications", "--enabled"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ notificationsEnabled: true });
  });

  test("set-admin-notifications --disabled PUTs notificationsEnabled false", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/rate-limit-settings/admin-notifications", body: { notificationsEnabled: false } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "set-admin-notifications", "--disabled"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ notificationsEnabled: false });
  });

  test("set-admin-notifications with neither flag fails locally", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["rate-limits", "set-admin-notifications"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("set-per-client PUTs the body", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/rate-limit-settings/per-client", body: { defaultMode: "PREVIEW" } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "set-per-client", "-s", "defaultMode=PREVIEW"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ defaultMode: "PREVIEW" });
  });

  test("principals requires --filter", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["rate-limits", "principals"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });

  test("principals sends the filter query and prints the default fields", async () => {
    srv = startServer([{
      method: "GET", path: "/api/v1/principal-rate-limits",
      body: [{ id: "prl1", principalType: "SSWS_TOKEN", principalId: "00Tok1", defaultPercentage: 50, defaultConcurrencyPercentage: 50 }],
    }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "principals", "--filter", 'principalType eq "SSWS_TOKEN"'], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'principalType eq "SSWS_TOKEN"' });
    expect(t.out.at(-1)).toBe("prl1  SSWS_TOKEN  00Tok1  50  50  \n");
  });

  test("principal-add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/principal-rate-limits", body: { id: "prl2", principalType: "OAUTH_CLIENT", principalId: "0oa1", defaultPercentage: 50, defaultConcurrencyPercentage: 50 } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "principal-add", "-s", "principalType=OAUTH_CLIENT", "-s", "principalId=0oa1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ principalType: "OAUTH_CLIENT", principalId: "0oa1" });
  });

  test("principal-update PUTs the body to /principal-rate-limits/{id}", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/principal-rate-limits/prl1", body: { id: "prl1", defaultPercentage: 75 } }]);
    const t = testCtx(srv.url);
    await runTest(["rate-limits", "principal-update", "prl1", "-s", "defaultPercentage=75"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/principal-rate-limits/prl1");
    expect(srv.calls.at(-1)!.body).toEqual({ defaultPercentage: "75" });
  });
});

describe("telephony-providers", () => {
  const provider = { id: "tel1", providerName: "TWILIO", providerCapability: "ALL", enabled: true, isPrimaryProvider: false };
  const providerByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/telephony-providers\/tel1$/, body: provider };

  test("list/get/add/delete/activate/deactivate/update/set-primary/test", async () => {
    srv = startServer([
      providerByIdRoute,
      { method: "GET", path: "/api/v1/telephony-providers", body: [provider] },
      { method: "POST", path: "/api/v1/telephony-providers", body: provider },
      { method: "DELETE", path: "/api/v1/telephony-providers/tel1" },
      { method: "POST", path: /^\/api\/v1\/telephony-providers\/tel1\/lifecycle\/(activate|deactivate)$/, body: provider },
      { method: "PATCH", path: "/api/v1/telephony-providers/tel1", body: provider },
      { method: "POST", path: "/api/v1/telephony-providers/tel1/setAsPrimary", body: { ...provider, isPrimaryProvider: true } },
      { method: "POST", path: "/api/v1/telephony-providers/tel1/test" },
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["telephony-providers", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!)[0].id).toBe("tel1");
    expect(await runTest(["telephony-providers", "get", "tel1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("tel1");
    expect(await runTest(["telephony-providers", "add", "-s", "providerName=TWILIO", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ providerName: "TWILIO" });
    expect(await runTest(["telephony-providers", "activate", "tel1", "-j"], t.ctx)).toBe(0);
    expect(await runTest(["telephony-providers", "deactivate", "tel1", "-j"], t.ctx)).toBe(0);
    expect(await runTest(["telephony-providers", "update", "tel1", "-s", "providerSid=SID1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PATCH");
    expect(srv.calls.at(-1)!.body).toEqual({ providerSid: "SID1" });
    expect(await runTest(["telephony-providers", "set-primary", "tel1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).isPrimaryProvider).toBe(true);
    expect(await runTest(["telephony-providers", "test", "tel1", "-s", "factor=SMS", "-s", "phoneNumber=+15551234567"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ factor: "SMS", phoneNumber: "+15551234567" });
    expect(t.out.at(-1)).toBe("test message sent from custom telephony provider tel1\n");
    expect(await runTest(["telephony-providers", "delete", "tel1"], t.ctx)).toBe(0);
  });

  test("replace is not registered (PATCH, not PUT, per spec)", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["telephony-providers", "replace", "tel1", "-s", "x=1"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
});
