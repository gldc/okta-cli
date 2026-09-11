import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { USER_FIELDS } from "../src/commands/users";
import { toTable } from "../src/lib/output";
import { startServer } from "./fixtures/server";

// Regression test for a real bug: main.ts used to do `process.exit(await runCli(...))`.
// process.exit() terminates the process immediately, discarding any output Bun/Node
// still has buffered for an async destination like a pipe — silently truncating piped
// output at exactly 64 KiB (the size of the OS pipe buffer). This has to go through a
// real shell pipe (`| wc -c`), not an in-process Bun.spawn stdout reader: a fast
// same-process reader drains the pipe quickly enough that the bug doesn't reproduce
// there, exactly like the review's own repro used a shell pipe.
describe("main.ts piped output", () => {
  test("a table > 64 KiB survives fully through a pipe", async () => {
    const users = Array.from({ length: 2000 }, (_, i) => {
      const n = String(i).padStart(5, "0");
      return {
        id: `00u${String(i).padStart(17, "0")}`,
        status: "ACTIVE",
        profile: { login: `user${n}@example.com`, firstName: "First", lastName: "Last", email: `user${n}@example.com` },
      };
    });
    const srv = startServer([{ method: "GET", path: "/api/v1/users", body: users }]);
    try {
      const expected = toTable(users, USER_FIELDS, undefined, () => {});
      // Sanity check that this scenario actually exceeds the 64 KiB pipe-buffer boundary
      // the bug truncated at — otherwise this test wouldn't exercise the regression.
      expect(expected.length).toBeGreaterThan(65536);

      const mainPath = join(import.meta.dir, "..", "src", "main.ts");
      const proc = Bun.spawn({
        cmd: ["sh", "-c", `bun ${JSON.stringify(mainPath)} users list | wc -c`],
        env: { ...process.env, OKTA_URL: srv.url, OKTA_TOKEN: "tok" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(Number(stdout.trim())).toBe(expected.length);
    } finally {
      srv.stop();
    }
  }, 20000);

  // Same hazard, second call site (audited per review): defaultCtx().io.exit used to call
  // process.exit(code) right after writing the OKTA_API_ERROR body via ctx.io.out, on a
  // path independent of the main.ts fix above. Many small io.out() writes don't reliably
  // reproduce the truncation race the way one large write does (the kernel pipe buffer
  // rarely fills mid-loop), so this doesn't prove the race is gone — it locks in that the
  // real defaultCtx exit path still produces the right content and no longer needs
  // process.exit to do so (io.exit now throws instead, see context.ts).
  test("a large OKTA_API_ERROR body survives fully through a pipe; exit code is 253", async () => {
    const causes = Array.from({ length: 3000 }, (_, i) => ({ errorSummary: `cause number ${i} is not valid for this request` }));
    const srv = startServer([{ method: "POST", path: /lifecycle\/reset_password$/, status: 400, body: { errorCode: "E1", errorSummary: "bad", errorCauses: causes } }]);
    try {
      const expectedLines = [`OKTA_API_ERROR: E1: bad`, ...causes.map((c) => `errorSummary: ${c.errorSummary}`)];
      const expected = expectedLines.join("\n") + "\n";
      expect(expected.length).toBeGreaterThan(65536);

      const mainPath = join(import.meta.dir, "..", "src", "main.ts");
      const env = { ...process.env, OKTA_URL: srv.url, OKTA_TOKEN: "tok" };

      // Exit code, checked directly (no pipe involved, so no truncation risk here).
      const direct = Bun.spawn({ cmd: ["bun", mainPath, "pw", "reset", "bob@x.com"], env, stdout: "pipe", stderr: "pipe" });
      await new Response(direct.stdout).text();
      await new Response(direct.stderr).text();
      expect(await direct.exited).toBe(253);

      // Content, checked through a real shell pipe.
      const piped = Bun.spawn({ cmd: ["sh", "-c", `bun ${JSON.stringify(mainPath)} pw reset bob@x.com | wc -c`], env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(piped.stdout).text(), new Response(piped.stderr).text(), piped.exited]);
      expect(stderr).toBe("");
      expect(Number(stdout.trim())).toBe(expected.length);
    } finally {
      srv.stop();
    }
  }, 20000);
});
