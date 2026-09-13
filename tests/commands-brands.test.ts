import { afterEach, describe, expect, test } from "bun:test";
import { BRANDS } from "../src/commands/brands";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const brand = { id: "b1", name: "default", isDefault: true, removePoweredByOkta: false, locale: "en" };
const brandByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/brands\/b1$/, body: brand };

test("spec paths", () => {
  for (const p of [
    BRANDS.path, `${BRANDS.path}/x`, `${BRANDS.path}/x/domains`,
    `${BRANDS.path}/x/themes`, `${BRANDS.path}/x/themes/y`,
    `${BRANDS.path}/x/themes/y/logo`, `${BRANDS.path}/x/themes/y/favicon`, `${BRANDS.path}/x/themes/y/background-image`,
    `${BRANDS.path}/x/templates/email`, `${BRANDS.path}/x/templates/email/y`,
    `${BRANDS.path}/x/templates/email/y/customizations`, `${BRANDS.path}/x/templates/email/y/customizations/z`,
    `${BRANDS.path}/x/templates/email/y/customizations/z/preview`,
    `${BRANDS.path}/x/templates/email/y/default-content`, `${BRANDS.path}/x/templates/email/y/default-content/preview`,
    `${BRANDS.path}/x/templates/email/y/settings`, `${BRANDS.path}/x/templates/email/y/test`,
    `${BRANDS.path}/x/pages/sign-in`, `${BRANDS.path}/x/pages/sign-in/customized`, `${BRANDS.path}/x/pages/sign-in/default`,
    `${BRANDS.path}/x/pages/sign-in/preview`, `${BRANDS.path}/x/pages/sign-in/widget-versions`,
    `${BRANDS.path}/x/pages/error`, `${BRANDS.path}/x/pages/error/customized`, `${BRANDS.path}/x/pages/error/default`, `${BRANDS.path}/x/pages/error/preview`,
    `${BRANDS.path}/x/pages/sign-out/customized`,
    `${BRANDS.path}/x/well-known-uris`, `${BRANDS.path}/x/well-known-uris/y`, `${BRANDS.path}/x/well-known-uris/y/customized`,
  ]) expect(knownPath(p), p).toBe(true);
});

describe("brands resource", () => {
  test("list returns brands", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/brands", body: [brand] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "list", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("b1");
  });

  test("add posts the body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/brands", body: brand }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "add", "-s", "name=default"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("POST");
    expect(srv.calls.at(-1)!.body).toEqual({ name: "default" });
  });

  test("delete resolves by name and deletes by id", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/brands/default", status: 404, body: {} }, { method: "GET", path: "/api/v1/brands", body: [brand] }, { method: "DELETE", path: "/api/v1/brands/b1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "delete", "default"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1");
  });
});

describe("brands domains", () => {
  test("domains unwraps the domains key", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/domains", body: { domains: [{ id: "d1", domain: "id.example.com", validationStatus: "VERIFIED", certificateSourceType: "OKTA_MANAGED" }] } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "domains", "b1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].domain).toBe("id.example.com");
  });
});

describe("brands themes", () => {
  const theme = { id: "t1", primaryColorHex: "#123456", secondaryColorHex: "#654321", signInPageTouchPointVariant: "OKTA_DEFAULT", endUserDashboardTouchPointVariant: "OKTA_DEFAULT" };

  test("themes lists a brand's themes", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/themes", body: [theme] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "themes", "b1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("t1");
  });

  test("theme gets one theme", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/themes/t1", body: theme }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme", "b1", "t1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).primaryColorHex).toBe("#123456");
  });

  test("theme-update with only -s fetches and merges", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/themes/t1", body: theme }, { method: "PUT", path: "/api/v1/brands/b1/themes/t1", body: { ...theme, primaryColorHex: "#abcdef" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme-update", "b1", "t1", "-s", "primaryColorHex=#abcdef"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.body).toEqual({ ...theme, primaryColorHex: "#abcdef" });
  });

  test("theme-logo requires exactly one of --file/--delete", async () => {
    srv = startServer([brandByIdRoute]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme-logo", "b1", "t1"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("Provide exactly one of --file or --delete");
  });

  test("theme-logo uploads a multipart file", async () => {
    const f = `${import.meta.dir}/tmp-brand-logo.png`;
    await Bun.write(f, "logo-bytes");
    srv = startServer([brandByIdRoute]);
    let seenField = "";
    srv.add({
      method: "POST", path: "/api/v1/brands/b1/themes/t1/logo",
      handler: async (req) => {
        const form = await req.formData();
        seenField = [...form.keys()][0] ?? "";
        return Response.json({ url: "https://example.okta.com/logo.png" }, { status: 201 });
      },
    });
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme-logo", "b1", "t1", "--file", f, "-j"], t.ctx)).toBe(0);
    expect(seenField).toBe("file");
    expect(JSON.parse(t.out.join("")).url).toBe("https://example.okta.com/logo.png");
  });

  test("theme-favicon --delete deletes the asset", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/themes/t1/favicon" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme-favicon", "b1", "t1", "--delete"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
    expect(t.out.at(-1)).toBe("favicon deleted from theme t1 on brand b1\n");
  });

  test("theme-background --delete deletes the asset", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/themes/t1/background-image" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "theme-background", "b1", "t1", "--delete"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/themes/t1/background-image");
  });
});

describe("brands email templates", () => {
  test("email-templates lists templates", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email", body: [{ name: "UserActivation" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-templates", "b1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].name).toBe("UserActivation");
  });

  test("email-template gets one template", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation", body: { name: "UserActivation" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-template", "b1", "UserActivation", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/templates/email/UserActivation");
  });

  test("email-customizations lists customizations", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations", body: [{ id: "c1", language: "en", isDefault: true, subject: "Welcome" }] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customizations", "b1", "UserActivation", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))[0].id).toBe("c1");
  });

  test("email-customization-add posts the body", async () => {
    srv = startServer([brandByIdRoute, { method: "POST", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations", body: { id: "c2" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customization-add", "b1", "UserActivation", "-s", "language=en", "-s", "subject=Hi", "-s", "body=<p>hi</p>"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ language: "en", subject: "Hi", body: "<p>hi</p>" });
  });

  test("email-customization-replace puts the body", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations/c1", body: { id: "c1" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customization-replace", "b1", "UserActivation", "c1", "-s", "subject=New"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });

  test("email-customization-delete with an id deletes just that one", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations/c1" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customization-delete", "b1", "UserActivation", "c1"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/templates/email/UserActivation/customizations/c1");
    expect(t.out.at(-1)).toBe("email customization c1 deleted for template UserActivation on brand b1\n");
  });

  test("email-customization-delete with no id deletes all", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customization-delete", "b1", "UserActivation"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/templates/email/UserActivation/customizations");
    expect(t.out.at(-1)).toBe("all email customizations deleted for template UserActivation on brand b1\n");
  });

  test("email-customization-preview gets the preview", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation/customizations/c1/preview", body: { subject: "Hi", body: "<p>hi</p>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-customization-preview", "b1", "UserActivation", "c1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).subject).toBe("Hi");
  });

  test("email-default-content passes the language query param", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation/default-content", body: { subject: "Hi", body: "<p>hi</p>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-default-content", "b1", "UserActivation", "--language", "fr"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.query).toEqual({ language: "fr" });
  });

  test("email-default-preview gets the default preview", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation/default-content/preview", body: { subject: "Hi", body: "<p>hi</p>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-default-preview", "b1", "UserActivation", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/templates/email/UserActivation/default-content/preview");
  });

  test("email-settings gets the settings", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/templates/email/UserActivation/settings", body: { recipients: "ALL_USERS" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-settings", "b1", "UserActivation", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).recipients).toBe("ALL_USERS");
  });

  test("email-settings-set puts the recipients body", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/templates/email/UserActivation/settings", body: { recipients: "ADMINS_ONLY" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-settings-set", "b1", "UserActivation", "--recipients", "ADMINS_ONLY"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.body).toEqual({ recipients: "ADMINS_ONLY" });
  });

  test("email-test posts and returns a confirmation string", async () => {
    srv = startServer([brandByIdRoute, { method: "POST", path: "/api/v1/brands/b1/templates/email/UserActivation/test" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "email-test", "b1", "UserActivation"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("test email sent\n");
  });
});

describe("brands pages", () => {
  test("sign-in-page with no --variant gets the page root", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/pages/sign-in", body: { _embedded: { default: { pageContent: "<html/>" } } } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-in-page", "b1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/pages/sign-in");
  });

  test("sign-in-page with --variant gets that variant", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/pages/sign-in/preview", body: { pageContent: "<html/>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-in-page", "b1", "--variant", "preview", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/pages/sign-in/preview");
  });

  test("sign-in-page-set puts the customized page", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/pages/sign-in/customized", body: { pageContent: "<html/>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-in-page-set", "b1", "-s", "pageContent=<html/>"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });

  test("sign-in-page-delete deletes the customized page", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/pages/sign-in/customized" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-in-page-delete", "b1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("customized sign-in page deleted from brand b1\n");
  });

  test("sign-in-preview-set puts the preview page", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/pages/sign-in/preview", body: { pageContent: "<html/>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-in-preview-set", "b1", "-s", "pageContent=<html/>"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/pages/sign-in/preview");
  });

  test("widget-versions transforms strings into rows", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/pages/sign-in/widget-versions", body: ["^5", "^6"] }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "widget-versions", "b1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toEqual([{ version: "^5" }, { version: "^6" }]);
  });

  test("error-page with no --variant gets the page root", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/pages/error", body: { _embedded: {} } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "error-page", "b1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/pages/error");
  });

  test("error-page-set puts the customized error page", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/pages/error/customized", body: { pageContent: "<html/>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "error-page-set", "b1", "-s", "pageContent=<html/>"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });

  test("error-page-delete deletes the customized error page", async () => {
    srv = startServer([brandByIdRoute, { method: "DELETE", path: "/api/v1/brands/b1/pages/error/customized" }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "error-page-delete", "b1"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("customized error page deleted from brand b1\n");
  });

  test("error-preview-set puts the preview error page", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/pages/error/preview", body: { pageContent: "<html/>" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "error-preview-set", "b1", "-s", "pageContent=<html/>"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/pages/error/preview");
  });

  test("sign-out-page gets the sign-out page settings", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/pages/sign-out/customized", body: { type: "OKTA_DEFAULT" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-out-page", "b1", "-j"], t.ctx)).toBe(0);
    expect(JSON.parse(t.out.join("")).type).toBe("OKTA_DEFAULT");
  });

  test("sign-out-page-set puts the sign-out page settings", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/pages/sign-out/customized", body: { type: "EXTERNALLY_HOSTED", url: "https://x" } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "sign-out-page-set", "b1", "-s", "type=EXTERNALLY_HOSTED", "-s", "url=https://x"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
  });
});

describe("brands well-known-uris", () => {
  test("well-known-uris gets the root object", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/well-known-uris", body: { _embedded: { webauthn: { customized: { representation: {} } } } } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "well-known-uris", "b1", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/well-known-uris");
  });

  test("well-known-uri gets one path", async () => {
    srv = startServer([brandByIdRoute, { method: "GET", path: "/api/v1/brands/b1/well-known-uris/webauthn", body: { representation: {} } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "well-known-uri", "b1", "webauthn", "-j"], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/brands/b1/well-known-uris/webauthn");
  });

  test("well-known-uri-set puts the customized content", async () => {
    srv = startServer([brandByIdRoute, { method: "PUT", path: "/api/v1/brands/b1/well-known-uris/webauthn/customized", body: { representation: { rpId: "example.com" } } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["brands", "well-known-uri-set", "b1", "webauthn", "-b", '{"representation":{"rpId":"example.com"}}'], t.ctx)).toBe(0);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.body).toEqual({ representation: { rpId: "example.com" } });
  });
});
