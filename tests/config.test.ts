import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
});
