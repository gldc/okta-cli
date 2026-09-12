import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTest, testCtx } from "./fixtures/ctx";

describe("config commands", () => {
  let file: string;
  let t: ReturnType<typeof testCtx>;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    t = testCtx("http://127.0.0.1:1");
    t.ctx.env = { OKTA_CLI_CONFIG: file };
  });

  test("new/list/use-context/current-context/delete/file", async () => {
    expect(await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "-t", "abcd1234"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Profile 'p1' added.\n");
    t.answers.push("p2", "https://b.okta.com", "zzzz9999");
    await runTest(["config", "new"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' added.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toBe("p1  https://a.okta.com  ***1234  (CURRENT)\np2  https://b.okta.com  ***9999\n");
    await runTest(["config", "use-context", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Default profile set to 'p2'.\n");
    await runTest(["config", "current-context"], t.ctx);
    expect(t.out.at(-1)).toBe("Current profile set to 'p2'.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toContain("***9999  (CURRENT)\n");
    await runTest(["config", "delete", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' deleted.\nNew default profile: p1\n");
    await runTest(["config", "delete", "p1"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p1' deleted.\nNo more profiles left.\n");
    await runTest(["config", "file"], t.ctx);
    expect(t.out.at(-1)).toBe(file + "\n");
  });

  test("new infers default: fresh file gets it, second profile leaves first as default", async () => {
    await Bun.write(file, JSON.stringify({ profiles: { p1: { url: "https://a.okta.com", token: "abcd1234" } } }));
    expect(await runTest(["config", "new", "-n", "p2", "-u", "https://b.okta.com", "-t", "zzzz9999"], t.ctx)).toBe(0);
    expect((await Bun.file(file).json()).default).toBe("p1");

    const fresh = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    t.ctx.env = { OKTA_CLI_CONFIG: fresh };
    expect(await runTest(["config", "new", "-n", "p3", "-u", "https://c.okta.com", "-t", "cccc0000"], t.ctx)).toBe(0);
    expect((await Bun.file(fresh).json()).default).toBe("p3");
  });

  test("errors", async () => {
    expect(await runTest(["config", "new", "-n", "x", "-u", "http://nope", "-t", "t"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("url must start with 'https://'");
    expect(await runTest(["config", "use-context", "nope"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("okta-cli was not configured");
  });
});
