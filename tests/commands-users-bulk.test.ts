import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => {
  srv?.stop();
  for (const f of readdirSync(".")) if (f.startsWith("okta-bulk-")) rmSync(f);
});

describe("users bulk", () => {
  test("bulk-add posts one user per row, writes result files, summary", async () => {
    let n = 0;
    srv = startServer([{ method: "POST", path: "/api/v1/users", handler: (_r, _u, body: any) => {
      n++;
      return n === 2 ? Response.json({ errorCode: "E0000001", errorSummary: "dup", errorCauses: [] }, { status: 400 }) : Response.json({ id: `u${n}`, profile: body.profile });
    } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "bulk-add", "testdata/mock_users_0010.csv", "-l", "3", "-w", "1", "-s", "profile.site=HQ", "-g", "00g1", "--no-activate"], t.ctx)).toBe(0);
    expect(srv.calls.length).toBe(3);
    expect(srv.calls[0]!.query.activate).toBe("False");
    expect((srv.calls[0]!.body as any).profile.site).toBe("HQ");
    expect((srv.calls[0]!.body as any).groupIds).toEqual(["00g1"]);
    const out = t.out.join("");
    expect(out).toContain("   2 added  - okta-bulk-add-20260102_030405-added.json");
    expect(out).toContain("   1 errors - okta-bulk-add-20260102_030405-errors.json");
    expect(out).toEndWith("3 total\n");
    const errors = await Bun.file("okta-bulk-add-20260102_030405-errors.json").json();
    expect(errors[0][0]).toBe(1);
    expect(errors[0][2].errorCode).toBe("E0000001");
  });

  test("bulk-update prefers id column, applies -s defaults, jump-to-index offsets error index", async () => {
    const f = `${import.meta.dir}/tmp-upd.csv`;
    await Bun.write(f, "id,profile.login,profile.title,ignored\n00u1,a@x,Eng,zz\n,b@x,Ops,zz\n,,Nope,zz\n");
    srv = startServer([{ method: "POST", path: /^\/api\/v1\/users\/.+/, body: { ok: true } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "bulk-update", f, "-s", "profile.dept=X", "-w", "2", "-i", "0"], t.ctx)).toBe(0);
    const paths = srv.calls.map((c) => c.path).sort();
    expect(paths).toEqual(["/api/v1/users/00u1", "/api/v1/users/b@x"]);
    expect(srv.calls.find((c) => c.path.endsWith("00u1"))!.body).toEqual({ profile: { login: "a@x", title: "Eng", dept: "X" } });
    expect(t.out.join("")).toContain("   2 updated");
    const errors = await Bun.file("okta-bulk-update-20260102_030405-errors.json").json();
    expect(errors).toEqual([[2, "missing id or profile.login column", null]]);
  });

  test("bulk-update keyed by id keeps profile.login in the body", async () => {
    const f = `${import.meta.dir}/tmp-upd-idlogin.csv`;
    await Bun.write(f, "id,profile.login,profile.title\n00u9,c@x,Sales\n");
    srv = startServer([{ method: "POST", path: "/api/v1/users/00u9", body: { ok: true } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "bulk-update", f, "-w", "1"], t.ctx)).toBe(0);
    expect(srv.calls[0]!.path).toBe("/api/v1/users/00u9");
    expect(srv.calls[0]!.body).toEqual({ profile: { login: "c@x", title: "Sales" } });
    rmSync(f);
  });
});
