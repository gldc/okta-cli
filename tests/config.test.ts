import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProfile, configPath, loadConfig, resolveProfile, saveConfig } from "../src/config";
import { ExitError } from "../src/okta/errors";

describe("configPath", () => {
  test("matches python appdirs per platform", () => {
    expect(configPath({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/okta-cli/config.json");
    expect(configPath({}, "linux", "/home/me")).toBe("/home/me/.config/okta-cli/config.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/okta-cli/config.json");
    expect(configPath({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\Users\\me")).toBe(join("C:\\Users\\me\\AppData\\Local", "okta-cli", "okta-cli", "config.json"));
    expect(configPath({ OKTA_CLI_CONFIG: "/x/c.json" }, "darwin", "/Users/me")).toBe("/x/c.json");
  });
});

describe("load/save/resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "okta-cli-"));
  const file = join(dir, "sub", "config.json");

  test("missing file → ExitError", async () => {
    await expect(loadConfig(file)).rejects.toThrow("okta-cli was not configured");
  });
  test("round trip and single-profile default", async () => {
    await saveConfig({ profiles: { a: { url: "https://a.okta.com", token: "t" } } }, file);
    const cfg = await loadConfig(file);
    expect(cfg.default).toBe("a");
    expect(resolveProfile(cfg)).toEqual({ url: "https://a.okta.com", token: "t" });
  });
  test("resolveProfile errors", () => {
    expect(() => resolveProfile({ profiles: { a: { url: "https://a", token: "t" }, b: { url: "https://b", token: "t" } } })).toThrow("Default context not configured");
    expect(() => resolveProfile({ profiles: { a: { url: "https://a", token: "t" } }, default: "zz" })).toThrow("Default context 'zz' does not exist");
    expect(() => resolveProfile({ profiles: { a: { url: "http://a", token: "t" } }, default: "a" })).toThrow(ExitError);
  });
  test("env override", async () => {
    expect(await activeProfile({ OKTA_URL: "https://e.okta.com", OKTA_TOKEN: "et" })).toEqual({ url: "https://e.okta.com", token: "et" });
    expect(await activeProfile({ OKTA_CLI_CONFIG: file })).toEqual({ url: "https://a.okta.com", token: "t" });
  });

  test("saveConfig writes with mode 0600 (create-with-mode, not write-then-chmod)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-"));
    const fresh = join(dir, "config.json");
    const writeSpy = spyOn(Bun, "write");
    try {
      await saveConfig({ profiles: { a: { url: "https://a.okta.com", token: "t" } } }, fresh);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
    const stat = await Bun.file(fresh).stat();
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  test("saveConfig chmods a pre-existing, more permissive file to 0600 too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "okta-cli-"));
    const fresh = join(dir, "config.json");
    await Bun.write(fresh, "{}");
    await chmod(fresh, 0o644);
    await saveConfig({ profiles: { a: { url: "https://a.okta.com", token: "t" } } }, fresh);
    const stat = await Bun.file(fresh).stat();
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });
});

describe("activeProfile: incomplete OAuth env override", () => {
  test("OKTA_CLIENT_ID set but OKTA_SCOPES missing -> ExitError naming it", async () => {
    await expect(
      activeProfile({ OKTA_CLI_CONFIG: "/does/not/matter", OKTA_URL: "https://e.okta.com", OKTA_CLIENT_ID: "cid", OKTA_PRIVATE_KEY: "key-text" }),
    ).rejects.toThrow("OKTA_CLIENT_ID is set but OKTA_SCOPES is missing");
  });

  test("OKTA_URL + OKTA_SCOPES set (no OKTA_CLIENT_ID) -> ExitError naming every missing var", async () => {
    const err = await activeProfile({ OKTA_CLI_CONFIG: "/does/not/matter", OKTA_URL: "https://e.okta.com", OKTA_SCOPES: "okta.users.read" }).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as Error).message).toContain("OKTA_CLIENT_ID");
    expect((err as Error).message).toContain("OKTA_PRIVATE_KEY");
  });

  test("no OAuth vars set at all -> falls through to the config file (missing-file error, not a missing-var one)", async () => {
    await expect(activeProfile({ OKTA_CLI_CONFIG: "/does/not/matter" })).rejects.toThrow("okta-cli was not configured");
  });
});
