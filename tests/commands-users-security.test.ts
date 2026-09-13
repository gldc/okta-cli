import { afterEach, describe, expect, test } from "bun:test";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";
import { knownPath } from "../src/okta/spec-paths";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const uid = users[0]!.id;
const login = users[0]!.profile.login;

test("spec paths", () => {
  for (const p of [
    "/users/x/credentials/change_password", "/users/x/credentials/forgot_password", "/users/x/credentials/forgot_password_recovery_question",
    "/users/x/credentials/change_recovery_question", "/users/x/lifecycle/expire_password_with_temp_password",
    "/users/x/factors", "/users/x/factors/y", "/users/x/factors/y/lifecycle/activate", "/users/x/factors/y/verify", "/users/x/factors/y/resend",
    "/users/x/factors/y/transactions/z", "/users/x/factors/questions",
    "/users/x/authenticator-enrollments", "/users/x/authenticator-enrollments/y", "/users/x/authenticator-enrollments/phone", "/users/x/authenticator-enrollments/tac",
    "/users/x/risk", "/users/x/classification",
    "/users/x/clients/y/tokens", "/users/x/clients/y/tokens/z",
    "/idps/x/users/y/credentials/tokens",
    "/webauthn-registration/api/v1/users/x/enrollments/y",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("credential flows", () => {
  test("change-password sends oldPassword/newPassword and strict query", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/credentials/change_password`, body: { password: {} } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "change-password", login, "--old", "old1", "--new", "new1", "--strict"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ oldPassword: { value: "old1" }, newPassword: { value: "new1" } });
    expect(srv.calls.at(-1)!.query).toEqual({ strict: "true" });
  });

  test("forgot-password without --new sends sendEmail query", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/credentials/forgot_password`, body: { resetPasswordUrl: "https://x/reset" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "forgot-password", login, "-j"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "true" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ resetPasswordUrl: "https://x/reset" });
  });

  test("forgot-password --no-send-email sends sendEmail=false", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/credentials/forgot_password`, body: {} }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "forgot-password", login, "--no-send-email"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "false" });
  });

  test("forgot-password --new completes via recovery question", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/credentials/forgot_password_recovery_question`, body: {} }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "forgot-password", login, "--new", "newpw1", "--answer", "blue"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ recovery_question: { answer: "blue" }, password: { value: "newpw1" } });
  });

  test("change-recovery-question sends password + recovery_question", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/credentials/change_recovery_question`, body: {} }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "change-recovery-question", login, "--pw", "pw1", "--question", "Favorite color?", "--answer", "blue"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ recovery_question: { question: "Favorite color?", answer: "blue" }, password: { value: "pw1" } });
  });

  test("expire-password-temp prints the temp password and sends revokeSessions", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/lifecycle/expire_password_with_temp_password`, body: { tempPassword: "********" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "expire-password-temp", login, "--revoke-sessions"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ revokeSessions: "true" });
    expect(t.out.at(-1)).toBe("TEMP_PASSWORD: ********\n");
  });
});

describe("factors", () => {
  const factor = { id: "fac1", factorType: "sms", provider: "OKTA", status: "PENDING_ACTIVATION", created: "2024-01-01T00:00:00.000Z" };

  test("factor-enroll sends body and query flags", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/factors`, body: factor }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor-enroll", login, "-s", "factorType=sms", "--activate", "--update-phone", "--template-id", "tmpl1", "--token-lifetime-seconds", "60"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ factorType: "sms" });
    expect(srv.calls.at(-1)!.query).toEqual({ activate: "true", updatePhone: "true", templateId: "tmpl1", tokenLifetimeSeconds: "60" });
  });

  test("factor-activate posts optional body", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/factors/fac1/lifecycle/activate`, body: factor }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor-activate", login, "fac1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toBeUndefined();
    await runTest(["users", "factor-activate", login, "fac1", "-s", "passCode=123456"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ passCode: "123456" });
  });

  test("factor-verify sends query and headers", async () => {
    let seenHeaders: Headers | undefined;
    srv = startServer([
      { method: "POST", path: `/api/v1/users/${uid}/factors/fac1/verify`, handler: (req) => { seenHeaders = req.headers; return Response.json({ factorResult: "SUCCESS" }); } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor-verify", login, "fac1", "--template-id", "tmpl1", "--token-lifetime-seconds", "30", "--accept-language", "en", "--x-forwarded-for", "1.2.3.4", "--user-agent", "curl", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ templateId: "tmpl1", tokenLifetimeSeconds: "30" });
    expect(seenHeaders?.get("accept-language")).toBe("en");
    expect(seenHeaders?.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(seenHeaders?.get("user-agent")).toBe("curl");
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ factorResult: "SUCCESS" });
  });

  test("factor-resend requires -b/-s and sends templateId", async () => {
    srv = startServer([{ method: "POST", path: `/api/v1/users/${uid}/factors/fac1/resend`, body: factor }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    const code = await runTest(["users", "factor-resend", login, "fac1"], t.ctx);
    expect(code).toBe(255);
    await runTest(["users", "factor-resend", login, "fac1", "-s", "factorType=sms", "--template-id", "tmpl1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ factorType: "sms" });
    expect(srv.calls.at(-1)!.query).toEqual({ templateId: "tmpl1" });
  });

  test("factor-transaction retrieves transaction status", async () => {
    srv = startServer([{ method: "GET", path: `/api/v1/users/${uid}/factors/fac1/transactions/tx1`, body: { factorResult: "WAITING" } }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor-transaction", login, "fac1", "tx1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ factorResult: "WAITING" });
  });

  test("factor retrieves a single factor", async () => {
    srv = startServer([{ method: "GET", path: `/api/v1/users/${uid}/factors/fac1`, body: factor }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factor", login, "fac1"], t.ctx);
    expect(t.out.at(-1)).toBe("fac1  sms  OKTA  PENDING_ACTIVATION  2024-01-01T00:00:00.000Z  \n");
  });

  test("factors-questions lists security questions", async () => {
    srv = startServer([{ method: "GET", path: `/api/v1/users/${uid}/factors/questions`, body: [{ question: "q1", questionText: "What?" }] }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "factors-questions", login], t.ctx);
    expect(t.out.at(-1)).toBe("q1  What?  \n");
  });
});

describe("authenticator enrollments", () => {
  const enrollment = { id: "ae1", type: "phone", key: "phone_number", status: "ACTIVE", created: "2024-01-01T00:00:00.000Z" };

  test("list/get/delete", async () => {
    srv = startServer([
      { method: "GET", path: `/api/v1/users/${uid}/authenticator-enrollments`, body: [enrollment] },
      { method: "GET", path: `/api/v1/users/${uid}/authenticator-enrollments/ae1`, body: enrollment },
      { method: "DELETE", path: `/api/v1/users/${uid}/authenticator-enrollments/ae1` },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "authenticator-enrollments", login], t.ctx);
    expect(t.out.at(-1)).toBe("ae1  phone  phone_number  ACTIVE  2024-01-01T00:00:00.000Z  \n");
    await runTest(["users", "authenticator-enrollment", login, "ae1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(enrollment);
    await runTest(["users", "authenticator-enrollment-delete", login, "ae1"], t.ctx);
    expect(t.out.at(-1)).toBe(`authenticator enrollment ae1 deleted from user ${uid} (${login})\n`);
  });

  test("authenticator-enroll-phone and authenticator-enroll-tac require -b/-s", async () => {
    srv = startServer([
      { method: "POST", path: `/api/v1/users/${uid}/authenticator-enrollments/phone`, body: enrollment },
      { method: "POST", path: `/api/v1/users/${uid}/authenticator-enrollments/tac`, body: enrollment },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    const code = await runTest(["users", "authenticator-enroll-tac", login], t.ctx);
    expect(code).toBe(255);
    await runTest(["users", "authenticator-enroll-phone", login, "-s", "profile.phoneNumber=+15551234567"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ profile: { phoneNumber: "+15551234567" } });
    await runTest(["users", "authenticator-enroll-tac", login, "-s", "authenticatorId=aut1"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ authenticatorId: "aut1" });
  });
});

describe("risk and classification", () => {
  test("risk get/set", async () => {
    srv = startServer([
      { method: "GET", path: `/api/v1/users/${uid}/risk`, body: { riskLevel: "LOW" } },
      { method: "PUT", path: `/api/v1/users/${uid}/risk`, body: { riskLevel: "HIGH" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "risk", login], t.ctx);
    expect(t.out.at(-1)).toBe("LOW   \n");
    await runTest(["users", "risk-set", login, "--level", "HIGH"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ riskLevel: "HIGH" });
  });

  test("classification get/set", async () => {
    srv = startServer([
      { method: "GET", path: `/api/v1/users/${uid}/classification`, body: { type: "STANDARD", lastUpdated: "2024-01-01T00:00:00.000Z" } },
      { method: "PUT", path: `/api/v1/users/${uid}/classification`, body: { type: "LITE" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "classification", login], t.ctx);
    expect(t.out.at(-1)).toBe("STANDARD  2024-01-01T00:00:00.000Z  \n");
    await runTest(["users", "classification-set", login, "--type", "LITE"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "LITE" });
  });
});

describe("client tokens", () => {
  const token = { id: "tok1", status: "ACTIVE", created: "2024-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z", scopes: ["openid"] };

  test("list/get/revoke one/revoke all", async () => {
    srv = startServer([
      { method: "GET", path: `/api/v1/users/${uid}/clients/cli1/tokens`, body: [token] },
      { method: "GET", path: `/api/v1/users/${uid}/clients/cli1/tokens/tok1`, body: token },
      { method: "DELETE", path: `/api/v1/users/${uid}/clients/cli1/tokens/tok1` },
      { method: "DELETE", path: `/api/v1/users/${uid}/clients/cli1/tokens` },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "client-tokens", login, "--client", "cli1"], t.ctx);
    expect(t.out.at(-1)).toBe('tok1  ACTIVE  2024-01-01T00:00:00.000Z  2026-01-01T00:00:00.000Z  ["openid"]  \n');
    await runTest(["users", "client-token", login, "tok1", "--client", "cli1", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(token);
    await runTest(["users", "client-tokens-revoke", login, "tok1", "--client", "cli1"], t.ctx);
    expect(t.out.at(-1)).toBe(`token tok1 revoked for client cli1 from user ${uid} (${login})\n`);
    await runTest(["users", "client-tokens-revoke", login, "--client", "cli1"], t.ctx);
    expect(t.out.at(-1)).toBe(`all tokens revoked for client cli1 from user ${uid} (${login})\n`);
  });
});

describe("idp tokens", () => {
  test("resolves the idp and lists tokens", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/idps/idp1", body: { id: "idp1", status: "ACTIVE", type: "OIDC", name: "MyIdp" } },
      { method: "GET", path: `/api/v1/idps/idp1/users/${uid}/credentials/tokens`, body: [{ id: "t1", tokenType: "urn:ietf:params:oauth:token-type:access_token", tokenAuthScheme: "Bearer", expiresAt: "2026-01-01T00:00:00.000Z", scopes: ["openid"] }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "idp-tokens", login, "--idp", "idp1"], t.ctx);
    expect(t.out.at(-1)).toBe('t1  urn:ietf:params:oauth:token-type:access_token  Bearer  2026-01-01T00:00:00.000Z  ["openid"]  \n');
  });
});

describe("webauthn-enrollment-delete", () => {
  test("deletes a webauthn preregistration factor", async () => {
    srv = startServer([{ method: "DELETE", path: `/webauthn-registration/api/v1/users/${uid}/enrollments/en1` }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["users", "webauthn-enrollment-delete", login, "en1"], t.ctx);
    expect(t.out.at(-1)).toBe(`webauthn enrollment en1 deleted from user ${uid} (${login})\n`);
  });
});
