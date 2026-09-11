import { afterEach, describe, expect, test } from "bun:test";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("pw", () => {
  test("reset / expire query params", async () => {
    srv = startServer([{ method: "POST", path: /lifecycle\/(reset_password|expire_password)$/, body: { ok: 1 } }]);
    const t = testCtx(srv.url);
    await runTest(["pw", "reset", "bob@x.com"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ sendEmail: "true" });
    await runTest(["pw", "reset", "bob@x.com", "-n"], t.ctx);
    expect(srv.calls[1]!.query).toEqual({ sendEmail: "false" });
    await runTest(["pw", "expire", "bob@x.com", "-t"], t.ctx);
    expect(srv.calls[2]!.query).toEqual({ tempPassword: "true" });
  });
  test("set -s expires by default, --no-expire skips, -g generates", async () => {
    srv = startServer([{ method: "POST", path: /^\/api\/v1\/users\/[^/]+$/, body: {} }, { method: "POST", path: /expire_password$/, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["pw", "set", "bob@x.com", "-s", "Hunter2!"], t.ctx);
    expect(srv.calls.map((c) => c.path)).toEqual(["/api/v1/users/bob@x.com", "/api/v1/users/bob@x.com/lifecycle/expire_password"]);
    expect(srv.calls[0]!.body).toEqual({ credentials: { password: { value: "Hunter2!" } } });
    expect(t.out.at(-1)).toBe("PASSWORD_EXPIRED: Hunter2!\n");
    srv.calls.length = 0;
    await runTest(["pw", "set", "bob@x.com", "-s", "Hunter2!", "--no-expire"], t.ctx);
    expect(srv.calls.length).toBe(1);
    expect(t.out.at(-1)).toBe("PASSWORD: ********\n");
    await runTest(["pw", "set", "bob@x.com", "-g", "-m", "20"], t.ctx);
    const pw = (srv.calls.at(-2)!.body as any).credentials.password.value as string;
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(pw.split(" ").length).toBeGreaterThanOrEqual(3);
    expect(await runTest(["pw", "set", "bob@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Either use -s or -g!\n");
  });
});
